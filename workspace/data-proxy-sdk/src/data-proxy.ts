import { CosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { keccak256 } from "@cosmjs/crypto";
import {
	type ProtobufRpcClient,
	QueryClient,
	createProtobufRpcClient,
} from "@cosmjs/stargate";
import { Comet38Client } from "@cosmjs/tendermint-rpc";
import type { sedachain } from "@seda-protocol/proto-messages";
import { tryAsync } from "@seda-protocol/utils";
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
		Result<{ isValid: boolean; status: string; currentHeight: number }, string>
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
				currentHeight: v.block_height,
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
}
