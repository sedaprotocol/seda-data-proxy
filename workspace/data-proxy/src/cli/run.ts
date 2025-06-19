import { readFile } from "node:fs/promises";
import { Command, Option } from "@commander-js/extra-typings";
import { DataProxy, Environment } from "@seda-protocol/data-proxy-sdk";
import { defaultConfig } from "@seda-protocol/data-proxy-sdk/src/config";
import { tryAsync, trySync } from "@seda-protocol/utils";
import { Maybe } from "true-myth";
import { parseConfig } from "../config-parser";
import {
	DEFAULT_ENVIRONMENT,
	DEFAULT_PRIVATE_KEY_JSON_FILE_NAME,
	PRIVATE_KEY_ENV_KEY,
	SERVER_PORT,
} from "../constants";
import logger, { setLogLevel } from "../logger";
import { startProxyServer } from "../proxy-server";
import { loadPrivateKey } from "./utils/private-key";

export const runCmd = addCommonOptions(new Command("run"))
	.description("Run the SEDA Data Proxy node")
	.option(
		"-dbg, --debug",
		"Runs the data proxy in debugging mode, this disables registration check and request verification. Same as --no-registration-check and --disable-proof",
		false,
	)
	.option(
		"-dp, --disable-proof",
		"Disables request verification mechanism, useful for testing and development",
		false,
	)
	.action(async (options) => {
		if (options.debug) {
			setLogLevel("debug");
		}

		const { config, dataProxy } = await configure(options, true);

		startProxyServer(config.value, dataProxy, {
			port: Number(options.port ?? SERVER_PORT),
			disableProof: options.debug || options.disableProof,
		});
	});

export const validateCmd = addCommonOptions(new Command("validate"))
	.description("Validate the SEDA Data Proxy node configuration")
	.option("-s, --silent", "Do not print the config", false)
	.action(async (options) => {
		const { hasWarnings } = await configure(options, options.silent);
		if (hasWarnings) {
			console.log(
				"⚠️ Configuration is valid but has warnings - check the logs above",
			);
		} else {
			console.log("✅ SEDA Data Proxy configuration is valid");
		}
	});

function addCommonOptions(command: Command) {
	return command
		.addOption(
			new Option("-c, --config <string>", "Path to config.json")
				.default("./config.json")
				.env("DATA_PROXY_CONFIG"),
		)
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
			"--skip-registration-check",
			"Runs the data proxy without checking registration, useful for testing and development",
			false,
		)
		.option(
			"-cca, --core-contract-address <string>",
			"Optional setting of the core contract address, fetches it automatically by default",
		)
		.option("-r, --rpc <rpc-url>", "Optional RPC URL to the SEDA network");
}

async function configure(
	options: {
		network: string;
		privateKeyFile?: string;
		config: string;
		rpc?: string;
		coreContractAddress?: string;
		skipRegistrationCheck: boolean;
		debug?: boolean;
		disableProof?: boolean;
	},
	silent = false,
) {
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

	logger.info(`Using config: ${options.config}`);
	const [config, hasWarnings] = parseConfig(parsedConfig.value);
	if (config.isErr) {
		console.error(`Invalid config: ${config.error}`);
		process.exit(1);
	}

	console.log(`🌐 Network: ${options.network}`);

	const dataProxy = new DataProxy(options.network as Environment, {
		privateKey: privateKey.value,
		rpcUrl: options.rpc,
		coreContract: options.coreContractAddress,
	});

	console.log(`🔐 Using public key: ${dataProxy.publicKey.toString("hex")}`);

	if (!options.skipRegistrationCheck) {
		const dataProxyRegistration = await dataProxy.getDataProxyRegistration();
		if (dataProxyRegistration.isErr) {
			console.error(
				`Failed to get data proxy registration: ${dataProxyRegistration.error}`,
			);
			process.exit(1);
		}

		if (!silent) {
			console.log(
				`🎟️ Registration info: ${JSON.stringify(dataProxyRegistration.value, null, 2)}`,
			);
		}
	}

	if (!silent) {
		console.log(`⚙️ Config: ${JSON.stringify(config.value, null, 2)}`);
	}

	if (options.debug || options.disableProof) {
		logger.warn(
			"Data Proxy will run without checking proofs, this is for development and testing only. Do not use in production",
		);
	}

	return { config, dataProxy, hasWarnings };
}
