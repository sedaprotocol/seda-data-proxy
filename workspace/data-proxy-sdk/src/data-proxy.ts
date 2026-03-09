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
import { Effect, Option } from "effect";
import * as Match from "effect/Match";
import { ecdsaSign, publicKeyCreate } from "secp256k1";
import { Maybe, Result } from "true-myth";
import {
	type DataProxyOptions,
	type Environment,
	defaultConfig,
} from "./config";
import { getDataProxyRegistration } from "./data-proxy-registration";
import {
	FailedToDecodeProofError,
	FailedToDecodeSedaFastProofError,
	FailedToGetCometClientError,
	FailedToGetCosmWasmClientError,
	FailedToVerifyCoreProofError,
} from "./errors";
import { getLatestCoreContractAddress } from "./latest-core-contract-address";
import { decodeSedaFastProof } from "./services/decode-seda-fast-proof";
import { verifyFastProof } from "./services/verify-fast-proof";

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
	private cometClient: Option.Option<Comet38Client> = Option.none();
	private rpcClient: Option.Option<ProtobufRpcClient> = Option.none();
	private cosmwasmClient: Option.Option<CosmWasmClient> = Option.none();
	private coreContractAddress: Option.Option<string> = Option.none();

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
			this.coreContractAddress = Option.some(this.options.coreContract);
		}

		// Trigger fetching of clients and address
		this.getCosmWasmClient();
		this.getCoreContractAddress();
	}

	private getCometClient = () =>
		Effect.gen(this, function* () {
			if (Option.isSome(this.cometClient)) {
				return this.cometClient.value;
			}

			const client = yield* Effect.tryPromise({
				try: () => Comet38Client.connect(this.options.rpcUrl),
				catch: (error) => new FailedToGetCometClientError({ error }),
			});

			this.cometClient = Option.some(client);
			return client;
		});

	private getProtobufRpcClient = () =>
		Effect.gen(this, function* () {
			if (Option.isSome(this.rpcClient)) {
				return this.rpcClient.value;
			}

			const cometClient = yield* this.getCometClient();
			const queryClient = new QueryClient(cometClient);
			const rpcClient = createProtobufRpcClient(queryClient);
			this.rpcClient = Option.some(rpcClient);
			return rpcClient;
		});

	private getCosmWasmClient = () =>
		Effect.gen(this, function* () {
			if (Option.isSome(this.cosmwasmClient)) {
				return yield* Effect.succeed(this.cosmwasmClient.value);
			}

			const cometClient = yield* this.getCometClient();
			const client = yield* Effect.tryPromise({
				try: () => CosmWasmClient.create(cometClient),
				catch: (error) => new FailedToGetCosmWasmClientError({ error }),
			});

			this.cosmwasmClient = Option.some(client);
			return client;
		});

	private getCoreContractAddress = () =>
		Effect.gen(this, function* () {
			if (Option.isSome(this.coreContractAddress)) {
				return this.coreContractAddress.value;
			}

			const rpcClientRes = yield* this.getProtobufRpcClient();
			const address = yield* getLatestCoreContractAddress(rpcClientRes);

			this.coreContractAddress = Option.some(address);
			return address;
		});

	/**
	 * Returns the data proxy registration for the public key of the data proxy instance. Returns an error
	 * if no registration is found.
	 */
	getDataProxyRegistration = () =>
		Effect.gen(this, function* () {
			const rpcClientRes = yield* this.getProtobufRpcClient();

			return yield* getDataProxyRegistration(
				rpcClientRes,
				this.publicKey.toString("hex"),
			);
		});

	/**
	 * Verifies if the executor is eligible or not
	 * proof is given by the executor through the header x-proof
	 * @param payload
	 */
	verify = (proof: string) =>
		Effect.gen(this, function* () {
			// Verify if eligible (right now is this one staked or not)
			const client = yield* this.getCosmWasmClient();
			const coreContractAddress = yield* this.getCoreContractAddress();

			const result = yield* Effect.tryPromise({
				try: () =>
					client.queryContractSmart(coreContractAddress, {
						get_executor_eligibility: {
							data: proof,
						},
					}),
				catch: (error) => new FailedToVerifyCoreProofError({ error }),
			});

			return {
				isValid: result.status === "eligible",
				status: result.status,
				currentHeight: BigInt(result.block_height),
			};
		}).pipe(
			Effect.catchAll((error) => {
				if (error._tag === "FailedToVerifyCoreProofError")
					return Effect.fail(error);
				return Effect.fail(
					new FailedToVerifyCoreProofError({ error: `${error}` }),
				);
			}),
		);

	/**
	 * Signs data and gives back a wrapped signed response
	 *
	 * @param data
	 */
	signData(
		requestUrl: string,
		requestMethod: string,
		requestBody: Buffer,
		responseBody: Buffer,
	) {
		const signResult = this.hashAndSign(
			this.generateMessage(
				requestUrl,
				requestMethod,
				requestBody,
				responseBody,
			),
		);

		return Effect.succeed({
			publicKey: this.publicKey.toString("hex"),
			signature: Buffer.from(signResult.signature).toString("hex"),
			recId: signResult.recid,
			version: this.version,
		});
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
	decodeProof = (
		proof: string,
	): Effect.Effect<
		{ publicKey: Buffer; drId: string; signature: Buffer },
		FailedToDecodeProofError
	> => {
		try {
			// The proof is a base64 encoded string
			const decoded = Buffer.from(proof, "base64");

			// The proof is a string of the form `${publicKey.toString("hex")}:${drId}:${signature.toString("hex")}`;
			const [publicKey, drId, signature] = decoded.toString("utf-8").split(":");

			return Effect.succeed({
				publicKey: Buffer.from(publicKey, "hex"),
				drId: drId,
				signature: Buffer.from(signature, "hex"),
			});
		} catch (error) {
			return Effect.fail(new FailedToDecodeProofError({ error }));
		}
	};

	/**
	 * Decodes a seda fast proof string into a public key, drId and signature
	 * This is usually in the header x-seda-fast-proof
	 *
	 * @param proof
	 * @returns
	 */
	decodeSedaFastProof(proof: string) {
		return decodeSedaFastProof(proof, this.options.chainId);
	}

	/**
	 * Verifies a SEDA Fast proof
	 * Also checks if the block height is not too old (So that proofs expire)
	 * @param proof
	 * @param blockHeight
	 * @returns
	 */
	verifyFastProof(proof: {
		unixTimestamp: bigint;
		signature: Buffer;
		publicKey: Buffer;
	}) {
		return verifyFastProof(
			proof,
			this.options.fastMaxProofAgeMs,
			this.options.fastAllowedClients,
		);
	}
}
