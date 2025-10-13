import { CosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import {
	ExtendedSecp256k1Signature,
	Secp256k1,
	keccak256,
} from "@cosmjs/crypto";
import {
	type ProtobufRpcClient,
	QueryClient,
	createProtobufRpcClient,
} from "@cosmjs/stargate";
import { Comet38Client } from "@cosmjs/tendermint-rpc";
import type { sedachain } from "@seda-protocol/proto-messages";
import { tryAsync } from "@seda-protocol/utils";
import * as Match from "effect/Match";
import { ecdsaSign, publicKeyCreate } from "secp256k1";
import { Maybe, Result } from "true-myth";
import {
	type DataProxyOptions,
	type Environment,
	defaultConfig,
} from "./config";
import { getDataProxyRegistration } from "./data-proxy-registration";
import { getLatestCoreContractAddress } from "./latest-core-contract-address";

export interface SignedData {
	// Hex encoded signature
	signature: string;

	// Hex encoded public key
	publicKey: string;

	// Signature recover id
	recId: number;

	// Version of the signature
	version: string;
}

export class DataProxy {
	public version = "0.1.0";
	public publicKey: Buffer;
	private privateKey: Buffer;
	public options: DataProxyOptions;
	private cometClient: Maybe<Comet38Client> = Maybe.nothing();
	private rpcClient: Maybe<ProtobufRpcClient> = Maybe.nothing();
	private cosmwasmClient: Maybe<CosmWasmClient> = Maybe.nothing();
	private coreContractAddress: Maybe<string> = Maybe.nothing();

	constructor(
		public environment: Environment,
		optionsOverride: Partial<DataProxyOptions> = {},
	) {
		// Remove undefined variables, so that the default config can override them
		for (const optionKey of Object.keys(optionsOverride)) {
			const key = optionKey as keyof DataProxyOptions;

			if (typeof optionsOverride[key] === "undefined") {
				delete optionsOverride[key];
			}
		}

		this.options = {
			...defaultConfig[environment],
			...optionsOverride,
		};

		this.privateKey = this.options.privateKey;
		this.publicKey = Buffer.from(publicKeyCreate(this.privateKey, true));

		if (this.options.coreContract) {
			this.coreContractAddress = Maybe.just(this.options.coreContract);
		}

		// Trigger fetching of clients and address
		this.getCosmWasmClient();
		this.getCoreContractAddress();
	}

	private async getCometClient(): Promise<Result<Comet38Client, Error>> {
		if (this.cometClient.isJust) {
			return Result.ok(this.cometClient.value);
		}

		const client = await tryAsync(Comet38Client.connect(this.options.rpcUrl));

		return client.map((t) => {
			this.cometClient = Maybe.just(t);
			return t;
		});
	}

	private async getProtobufRpcClient(): Promise<
		Result<ProtobufRpcClient, Error>
	> {
		if (this.rpcClient.isJust) {
			return Result.ok(this.rpcClient.value);
		}

		const cometClient = await this.getCometClient();

		return cometClient.map((t) => {
			const queryClient = new QueryClient(t);
			const rpcClient = createProtobufRpcClient(queryClient);
			this.rpcClient = Maybe.just(rpcClient);
			return rpcClient;
		});
	}

	private async getCosmWasmClient(): Promise<Result<CosmWasmClient, unknown>> {
		if (this.cosmwasmClient.isJust) {
			return Result.ok(this.cosmwasmClient.value);
		}

		const cometClientRes = await this.getCometClient();
		if (cometClientRes.isErr) {
			return Result.err(cometClientRes.error);
		}

		const client = await tryAsync(CosmWasmClient.create(cometClientRes.value));
		return client.map((t) => {
			this.cosmwasmClient = Maybe.just(t);
			return t;
		});
	}

	private async getCoreContractAddress(): Promise<Result<string, unknown>> {
		if (this.coreContractAddress.isJust) {
			return Result.ok(this.coreContractAddress.value);
		}

		const rpcClientRes = await this.getProtobufRpcClient();
		if (rpcClientRes.isErr) {
			return Result.err(rpcClientRes.error);
		}

		const address = await getLatestCoreContractAddress(rpcClientRes.value);

		return address.map((t) => {
			this.coreContractAddress = Maybe.just(t);
			return t;
		});
	}

	/**
	 * Returns the data proxy registration for the public key of the data proxy instance. Returns an error
	 * if no registration is found.
	 */
	async getDataProxyRegistration(): Promise<
		Result<sedachain.data_proxy.v1.ProxyConfig, Error>
	> {
		const rpcClientRes = await this.getProtobufRpcClient();
		if (rpcClientRes.isErr) {
			return Result.err(rpcClientRes.error);
		}

		return getDataProxyRegistration(
			rpcClientRes.value,
			this.publicKey.toString("hex"),
		);
	}

	/**
	 * Verifies if the executor is eligible or not
	 * proof is given by the executor through the header x-proof
	 * @param payload
	 */
	async verify(
		proof: string,
	): Promise<
		Result<{ isValid: boolean; status: string; currentHeight: bigint }, string>
	> {
		// Verify if eligible (right now is this one staked or not)
		const client = await this.getCosmWasmClient();
		if (client.isErr) {
			return Result.err(`Could not create client ${client.error}`);
		}

		const coreContractAddress = await this.getCoreContractAddress();
		if (coreContractAddress.isErr) {
			return Result.err(
				`Could not get contract address ${coreContractAddress.error}`,
			);
		}

		const result = await tryAsync(
			client.value.queryContractSmart(coreContractAddress.value, {
				get_executor_eligibility: {
					data: proof,
				},
			}),
		);

		return result
			.map((v) => ({
				isValid: v.status === "eligible",
				status: v.status,
				currentHeight: BigInt(v.block_height),
			}))
			.mapErr((err) => `Error while fetching verification: ${err}`);
	}

	/**
	 * Signs data and gives back a wrapped signed response
	 *
	 * @param data
	 */
	async signData(
		requestUrl: string,
		requestMethod: string,
		requestBody: Buffer,
		responseBody: Buffer,
	): Promise<SignedData> {
		const signResult = this.hashAndSign(
			this.generateMessage(
				requestUrl,
				requestMethod,
				requestBody,
				responseBody,
			),
		);

		return {
			publicKey: this.publicKey.toString("hex"),
			signature: Buffer.from(signResult.signature).toString("hex"),
			recId: signResult.recid,
			version: this.version,
		};
	}

	generateMessage(
		requestUrl: string,
		requestMethod: string,
		requestBody: Buffer,
		responseBody: Buffer,
	) {
		const requestUrlHash = keccak256(Buffer.from(requestUrl));
		const requestMethodHash = keccak256(
			Buffer.from(requestMethod.toUpperCase()),
		);
		const requestBodyHash = keccak256(requestBody);
		const responseBodyHash = keccak256(responseBody);

		return Buffer.concat([
			requestUrlHash,
			requestMethodHash,
			requestBodyHash,
			responseBodyHash,
		]);
	}

	hashAndSign(message: Buffer) {
		return ecdsaSign(keccak256(message), this.privateKey);
	}

	/**
	 * Decodes a proof string into a public key, drId and signature
	 * @param proof
	 * @returns
	 */
	decodeProof(
		proof: string,
	): Result<{ publicKey: Buffer; drId: string; signature: Buffer }, Error> {
		try {
			// The proof is a base64 encoded string
			const decoded = Buffer.from(proof, "base64");

			// The proof is a string of the form `${publicKey.toString("hex")}:${drId}:${signature.toString("hex")}`;
			const [publicKey, drId, signature] = decoded.toString("utf-8").split(":");

			return Result.ok({
				publicKey: Buffer.from(publicKey, "hex"),
				drId: drId,
				signature: Buffer.from(signature, "hex"),
			});
		} catch (error) {
			return Result.err(new Error(`Error while decoding proof: ${error}`));
		}
	}

	/**
	 * Decodes a seda fast proof string into a public key, drId and signature
	 * This is usually in the header x-seda-fast-proof
	 *
	 * @param proof
	 * @returns
	 */
	decodeSedaFastProof(proof: string): Result<
		{
			unixTimestamp: bigint;
			signature: Buffer;
			publicKey: Buffer;
		},
		Error
	> {
		try {
			// The format is "{unixTimestampMs}:{signatureAsHexString}:{clientChainId}"
			const decoded = Buffer.from(proof, "base64");
			const [unixTimestampMs, signature, clientChainId] = decoded
				.toString("utf-8")
				.split(":");

			if (clientChainId !== this.options.chainId) {
				return Result.err(
					new Error(
						`Invalid client chain id: ${clientChainId}, wanted: ${this.options.chainId}`,
					),
				);
			}

			const unixTimestampBuffer = Buffer.alloc(8); // 64-bit = 8 bytes
			unixTimestampBuffer.writeBigUInt64BE(BigInt(unixTimestampMs));
			const chainIdBytes = Buffer.from(this.options.chainId);

			const messageHash = keccak256(
				Buffer.concat([unixTimestampBuffer, chainIdBytes]),
			);

			const extendSignatures = ExtendedSecp256k1Signature.fromFixedLength(
				Buffer.from(signature, "hex"),
			);
			const pubKey = Secp256k1.recoverPubkey(extendSignatures, messageHash);
			const compressedPubKey = Secp256k1.compressPubkey(pubKey);

			return Result.ok({
				publicKey: Buffer.from(compressedPubKey),
				unixTimestamp: BigInt(unixTimestampMs),
				signature: Buffer.from(signature, "hex"),
			});
		} catch (error) {
			return Result.err(new Error(`Error while decoding proof: ${error}`));
		}
	}

	/**
	 * Verifies a SEDA Fast proof
	 * Also checks if the block height is not too old (So that proofs expire)
	 * @param proof
	 * @param blockHeight
	 * @returns
	 */
	async verifyFastProof(proof: {
		unixTimestamp: bigint;
		signature: Buffer;
		publicKey: Buffer;
	}): Promise<
		Result<
			{ isValid: boolean; status: string; currentUnixTimestamp: bigint },
			string
		>
	> {
		const now = BigInt(Date.now());
		const delta = now - proof.unixTimestamp;

		if (delta > this.options.fastMaxProofAgeMs) {
			return Result.ok({
				isValid: false,
				status: "unix_timestamp_too_old",
				currentUnixTimestamp: now,
			});
		}

		// Check if the client is allowed
		if (
			!this.options.fastAllowedClients.includes(proof.publicKey.toString("hex"))
		) {
			return Result.ok({
				isValid: false,
				status: "fast_client_not_allowed",
				currentUnixTimestamp: now,
			});
		}

		return Result.ok({
			isValid: true,
			status: "eligible",
			currentUnixTimestamp: now,
		});
	}
}
