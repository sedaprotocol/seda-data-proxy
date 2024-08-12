export enum Environment {
	Mainnet = "mainnet",
	Testnet = "testnet",
	Devnet = "devnet",
}

export interface DataProxyOptions {
	rpcUrl: string;

	// URL to the explorer page
	explorerUrl: string;

	privateKey: Buffer;

	coreContract?: string;
}

export const defaultConfig: Record<Environment, DataProxyOptions> = {
	mainnet: {
		rpcUrl: "https://rpc.seda.xyz",
		explorerUrl: "https://explorer.seda.xyz",
		privateKey: Buffer.from([]),
	},
	testnet: {
		rpcUrl: "https://rpc.testnet.seda.xyz",
		explorerUrl: "https://testnet.explorer.seda.xyz",
		privateKey: Buffer.from([]),
	},
	devnet: {
		rpcUrl: "https://rpc.devnet.seda.xyz",
		explorerUrl: "https://devnet.explorer.seda.xyz",
		privateKey: Buffer.from([]),
	},
};
