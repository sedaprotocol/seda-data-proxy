import { CosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { keccak256 } from "@cosmjs/crypto";
import { ecdsaSign, publicKeyCreate } from "secp256k1";
import { Maybe, Result, ResultNS, type Unit } from "true-myth";
import { tryAsync, trySync } from "../../data-proxy/src/utils/try";
import {
	type DataProxyOptions,
	type Environment,
	defaultConfig,
} from "./config";
import { getLatestCoreContractAddress } from "./latest-core-contract-address";

export interface SignedData {
	// Hex encoded signature
	signature: string;

	// Hex encoded public key
	publicKey: string;

	// Signature recover id
	recId: number;
}

export class DataProxy {
	public publicKey: Buffer;
	private privateKey: Buffer;
	public options: DataProxyOptions;
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

		// Trigger fetching of client and address
		this.getCosmWasmClient();
		this.getCoreContractAddress();
	}

	private async getCosmWasmClient(): Promise<Result<CosmWasmClient, unknown>> {
		if (this.cosmwasmClient.isNothing) {
			const client = await tryAsync(async () =>
				CosmWasmClient.connect(this.options.rpcUrl),
			);

			if (client.isOk) {
				this.cosmwasmClient = Maybe.just(client.value);
				return Result.ok(client.value);
			}

			return client;
		}

		return Result.ok(this.cosmwasmClient.value);
	}

	private async getCoreContractAddress(): Promise<Result<string, unknown>> {
		if (this.coreContractAddress.isNothing) {
			const address = await getLatestCoreContractAddress(this.options.rpcUrl);

			if (address.isOk) {
				this.coreContractAddress = Maybe.just(address.value);
				return Result.ok(address.value);
			}

			return address;
		}

		return Result.ok(this.coreContractAddress.value);
	}

	/**
	 * Verifies if the executor is eligible or not
	 * proof is given by the executor through the header x-proof
	 * @param payload
	 */
	async verify(payload: string): Promise<Result<Unit, string>> {
		const proofData = trySync(() => atob(payload));

		if (proofData.isErr) {
			return Result.err(`Invalid base64: ${proofData.error}`);
		}

		if (!proofData.value.includes(":")) {
			return Result.err(
				`Invalid proof, does not include ':'. Received ${proofData}`,
			);
		}

		const [dataRequestId, proof] = proofData.value.split(":");
		// TODO: Get Data Request by Id
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

		const result = await tryAsync(async () =>
			client.value.queryContractSmart(coreContractAddress.value, {
				is_executor_eligible: {
					dr_id: dataRequestId,
					proof,
				},
			}),
		);

		return result.mapErr((err) => `Error while fetching verification: ${err}`);
	}

	/**
	 * Signs data and gives back a wrapped signed response
	 *
	 * @param data
	 */
	signData(data: string): SignedData {
		const signResult = this.sign(Buffer.from(data));

		return {
			publicKey: this.publicKey.toString("hex"),
			signature: Buffer.from(signResult.signature).toString("hex"),
			recId: signResult.recid,
		};
	}

	sign(data: Buffer) {
		return ecdsaSign(keccak256(data), this.privateKey);
	}
}
