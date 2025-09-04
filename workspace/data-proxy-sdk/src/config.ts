export enum Environment {
	Mainnet = "mainnet",
	Testnet = "testnet",
	Devnet = "devnet",
}

export interface DataProxyOptions {
	chainId: string;
	rpcUrl: string;

	fastAllowedClients: string[];
	fastMaxProofAgeMs: number;

	// URL to the explorer page
	explorerUrl: string;

	privateKey: Buffer;

	coreContract?: string;
}

export const defaultConfig: Record<Environment, DataProxyOptions> = {
	mainnet: {
		chainId: "seda-1",
		rpcUrl: "https://rpc.seda.xyz",
		explorerUrl: "https://explorer.seda.xyz",
		privateKey: Buffer.from([]),
		fastMaxProofAgeMs: 1000 * 60 * 5, // 5 minutes
		fastAllowedClients: [],
	},
	testnet: {
		chainId: "seda-1-testnet",
		rpcUrl: "https://rpc.testnet.seda.xyz",
		explorerUrl: "https://testnet.explorer.seda.xyz",
		privateKey: Buffer.from([]),
		fastMaxProofAgeMs: 1000 * 60 * 5, // 5 minutes
		fastAllowedClients: [],
	},
	devnet: {
		chainId: "seda-1-devnet",
		rpcUrl: "https://rpc.devnet.seda.xyz",
		explorerUrl: "https://devnet.test.explorer.seda.xyz",
		privateKey: Buffer.from([]),
		fastMaxProofAgeMs: 1000 * 60 * 5, // 5 minutes
		fastAllowedClients: [],
	},
};
