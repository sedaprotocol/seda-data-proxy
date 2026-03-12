import { Command, Option } from "@commander-js/extra-typings";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem, NodePath, NodeRuntime } from "@effect/platform-node";
import { DataProxy, Environment } from "@seda-protocol/data-proxy-sdk";
import { defaultConfig } from "@seda-protocol/data-proxy-sdk/src/config";
import { parseJSON5 } from "confbox";
import { Clock, Effect, Either, LogLevel, Logger } from "effect";
import { parseConfig } from "../config/config-parser";
import {
	DEFAULT_PRIVATE_KEY_JSON_FILE_NAME,
	LOG_LEVEL,
	PRIVATE_KEY_ENV_KEY,
	SERVER_PORT,
} from "../constants";
import { FailedToParseConfigError } from "../errors";
import { logBootstrap, setEnvSecrets } from "../logger";
import { startProxyServer } from "../proxy-server";
import { HttpClientService } from "../services/http-client";
import { loadNetworkFromKeyFile, loadPrivateKey } from "./utils/private-key";

export const runCmd = addCommonOptions(new Command("run"))
	.description("Run the SEDA Data Proxy node")
	.option(
		"-dbg, --debug",
		"Sets log level at debug and runs the node without registration check and request verification",
		false,
	)
	.option(
		"-dp, --disable-proof",
		"Disables request verification mechanism, useful for testing and development",
		false,
	)
	.action((options) => {
		const program = Effect.gen(function* () {
			const { config, dataProxy } = yield* configure(options, true);

			setEnvSecrets(config.value.envSecrets);

			let disableProof = false;
			if (options.debug || options.disableProof) {
				disableProof = true;

				yield* Effect.logWarning(
					"Data Proxy will run without checking proofs, this is for development and testing only. Do not use in production",
				);
			}

			yield* startProxyServer(config.value.config, dataProxy, {
				port: Number(options.port ?? SERVER_PORT),
				disableProof: disableProof,
				enableKeepAliveFiber: true,
			});
		}).pipe(Effect.provide(HttpClientService.Default()));

		const bootstrap = Effect.gen(function* () {
			let logLevel = yield* LOG_LEVEL;

			if (options.debug) {
				logLevel = "Debug";
			}

			return yield* program.pipe(
				logBootstrap(options.debug),
				Effect.scoped,
				Effect.provide(NodeFileSystem.layer),
				Effect.provide(NodePath.layer),
				Logger.withMinimumLogLevel(LogLevel.fromLiteral(logLevel)),
			);
		});

		return NodeRuntime.runMain(bootstrap, {
			disablePrettyLogger: true,
		});
	});

export const validateCmd = addCommonOptions(new Command("validate"))
	.description("Validate the SEDA Data Proxy node configuration")
	.option("-s, --silent", "Do not print the config", false)
	.action((options) => {
		const program = Effect.gen(function* () {
			const { hasWarnings } = yield* configure(options, options.silent);

			if (hasWarnings) {
				yield* Effect.logWarning(
					"⚠️ Configuration is valid but has warnings - check the logs above",
				);
			} else {
				yield* Effect.logInfo("✅ SEDA Data Proxy configuration is valid");
			}
		}).pipe(Effect.provide(NodeFileSystem.layer));

		return NodeRuntime.runMain(program, {
			disablePrettyLogger: false,
		});
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
		.option("-n, --network <network>", "The SEDA network to chose")
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

const configure = (
	options: {
		network?: string;
		privateKeyFile?: string;
		config: string;
		rpc?: string;
		coreContractAddress?: string;
		skipRegistrationCheck: boolean;
	},
	silent = false,
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;

		let networkEnv: Environment;
		if (options.network) {
			// Validate network option
			const validNetworks = Object.values(Environment);
			if (!validNetworks.includes(options.network as Environment)) {
				const networkList = validNetworks.join(", ");
				yield* Effect.logError(
					`Invalid network '${options.network}'. Valid options: ${networkList}`,
				);
				process.exit(1);
			}
			networkEnv = options.network as Environment;
		} else {
			// Load network from private key file (defaults to Testnet if not provided)
			networkEnv = yield* loadNetworkFromKeyFile(options.privateKeyFile);
		}

		const network = defaultConfig[networkEnv];
		const privateKey = yield* Effect.either(
			loadPrivateKey(options.privateKeyFile),
		);

		if (Either.isLeft(privateKey)) {
			yield* Effect.logError(privateKey.left);
			yield* Effect.logError(
				`Please make sure either the environment variable ${PRIVATE_KEY_ENV_KEY} is set or you pass in the -pkf argument`,
			);
			process.exit(1);
		}

		const configFile = yield* Effect.either(fs.readFile(options.config));
		if (Either.isLeft(configFile)) {
			yield* Effect.logError(`Failed to read config: ${configFile.left}`);
			process.exit(1);
		}

		const parsedConfig = yield* Effect.either(
			Effect.try({
				try: () => parseJSON5(configFile.right.toString()),
				catch: (error) =>
					new FailedToParseConfigError({
						error: `Parsing config failed: ${error}`,
					}),
			}),
		);
		if (Either.isLeft(parsedConfig)) {
			yield* Effect.logError(`Parsing config failed: ${parsedConfig.left}`);
			process.exit(1);
		}

		yield* Effect.logInfo(`Using config: ${options.config}`);
		const [config, hasWarnings] = yield* parseConfig(parsedConfig.right);
		if (config.isErr) {
			yield* Effect.logError(`Invalid config: ${config.error}`);
			process.exit(1);
		}

		yield* Effect.logInfo(`🌐 Network: ${networkEnv}\n`);

		const dataProxy = new DataProxy(networkEnv, {
			privateKey: privateKey.right,
			rpcUrl: options.rpc,
			coreContract: options.coreContractAddress,
			fastMaxProofAgeMs: config.value.config.sedaFast?.maxProofAgeMs,
			fastAllowedClients: config.value.config.sedaFast?.allowedClients,
		});

		const publicKey = dataProxy.publicKey.toString("hex");
		yield* Effect.logInfo(`🔐 Using public key: ${publicKey}`);
		if (options.skipRegistrationCheck) {
			console.log("⚠️  Registration check was skipped\n");
		} else {
			const dataProxyRegistration = yield* Effect.either(
				dataProxy.getDataProxyRegistration(),
			);
			if (Either.isLeft(dataProxyRegistration)) {
				yield* Effect.logError(
					`Failed to get data proxy registration: ${dataProxyRegistration.left}`,
				);
				process.exit(1);
			}

			const url = new URL(`/data-proxies/${publicKey}`, network.explorerUrl);
			yield* Effect.logInfo(
				`✅ Registration has been verified. Link to explorer page: ${url.toString()}\n`,
			);

			if (!silent) {
				yield* Effect.logInfo(
					`🎟️ Registration info: ${JSON.stringify(dataProxyRegistration.right, null, 2)}\n`,
				);
			}
		}

		yield* Effect.logInfo(
			`🚀 SEDA FAST enabled: ${config.value.config.sedaFast?.enable ? "Yes" : "No"}`,
		);
		if (config.value.config.sedaFast?.enable) {
			yield* Effect.logInfo(
				`🔐 Allowed FAST clients: ${config.value.config.sedaFast?.allowedClients?.join(", ")}`,
			);
		}

		if (!silent) {
			yield* Effect.logInfo(
				`⚙️ Config: ${JSON.stringify(config.value, null, 2)}\n`,
			);
		}

		return { config, dataProxy, hasWarnings };
	}).pipe(
		Effect.catchAll((error) =>
			Effect.gen(function* () {
				yield* Effect.logError(error);
				process.exit(1);
			}),
		),
	);
