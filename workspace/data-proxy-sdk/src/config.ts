export enum Environment {
	Mainnet = "mainnet",
	Testnet = "testnet",
	Devnet = "devnet",
}

export interface DataProxyOptions {
	chainId: string;
	rpcUrl: string;

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
	},
	testnet: {
		chainId: "seda-1-testnet",
		rpcUrl: "https://rpc.testnet.seda.xyz",
		explorerUrl: "https://testnet.explorer.seda.xyz",
		privateKey: Buffer.from([]),
	},
	devnet: {
		chainId: "seda-1-devnet",
		rpcUrl: "https://rpc.devnet.seda.xyz",
		explorerUrl: "https://devnet.test.explorer.seda.xyz",
		privateKey: Buffer.from([]),
	},
};
