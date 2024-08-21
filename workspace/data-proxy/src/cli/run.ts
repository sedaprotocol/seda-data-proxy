import { readFile } from "node:fs/promises";
import { Command } from "@commander-js/extra-typings";
import { DataProxy, Environment } from "@seda-protocol/data-proxy-sdk";
import { defaultConfig } from "@seda-protocol/data-proxy-sdk/src/config";
import { Maybe } from "true-myth";
import { parseConfig } from "../config-parser";
import {
	DEFAULT_ENVIRONMENT,
	DEFAULT_PRIVATE_KEY_JSON_FILE_NAME,
	PRIVATE_KEY_ENV_KEY,
	SERVER_PORT,
} from "../constants";
import logger from "../logger";
import { startProxyServer } from "../proxy-server";
import { tryAsync, trySync } from "../utils/try";
import { loadPrivateKey } from "./utils/private-key";

export const runCommand = new Command("run")
	.description("Run the Data Proxy node")
	.option("-c, --config <string>", "Path to config.json", "./config.json")
	.option("-p, --port <number>", "Port to run the server on", SERVER_PORT)
	.option(
		"-pkf, --private-key-file <string>",
		`Path where to find the private key json (Defaults to either env variable $${PRIVATE_KEY_ENV_KEY} or ${DEFAULT_PRIVATE_KEY_JSON_FILE_NAME})`,
	)
	.option(
		"-n, --network <network>",
		"The SEDA network to chose",
		DEFAULT_ENVIRONMENT,
	)
	.option(
		"-dp, --disable-proof",
		"Disables proofing mechanism, useful for debugging",
		false,
	)
	.option(
		"-cca, --core-contract-address <string>",
		"Optional setting of the core contract address, fetches it automatically by default",
	)
	.option("-r, --rpc <rpc-url>", "Optional RPC URL to the SEDA network")
	.action(async (options) => {
		const network = Maybe.of(defaultConfig[options.network as Environment]);

		if (network.isNothing) {
			console.error(
				`Given network ${options.network} does not exist, please select ${Environment.Devnet}, ${Environment.Testnet} or ${Environment.Mainnet}`,
			);
			process.exit(1);
		}

		const privateKey = await loadPrivateKey(options.privateKeyFile);

		if (privateKey.isErr) {
			console.error(privateKey.error);
			console.error(
				`Please make sure either the environment variable ${PRIVATE_KEY_ENV_KEY} is set or you pass in the -pkf argument`,
			);
			process.exit(1);
		}

		const configFile = await tryAsync(async () => readFile(options.config));
		if (configFile.isErr) {
			console.error(`Failed to read config: ${configFile.error}`);
			process.exit(1);
		}

		const parsedConfig = trySync(() => JSON.parse(configFile.value.toString()));
		if (parsedConfig.isErr) {
			console.error(`Parsing config failed: ${parsedConfig.error}`);
			process.exit(1);
		}

		const config = parseConfig(parsedConfig.value);
		if (config.isErr) {
			console.error(`Invalid config: ${config.error}`);
			process.exit(1);
		}

		logger.info(`Environment: "${options.network}" will be used`);

		const dataProxy = new DataProxy(options.network as Environment, {
			privateKey: privateKey.value,
			rpcUrl: options.rpc,
			coreContract: options.coreContractAddress,
		});

		startProxyServer(config.value, dataProxy, {
			port: Number(options.port ?? SERVER_PORT),
			disableProof: options.disableProof,
		});
	});
