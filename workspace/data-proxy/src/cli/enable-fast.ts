import { createInterface } from "node:readline";
import { Command, Option } from "@commander-js/extra-typings";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { parseJSON5 } from "confbox";
import { Effect } from "effect";
import { parseConfig } from "../config/config-parser";

export const enableFastCmd = new Command("enable-fast")
	.description("Enable Seda Fast with allowed client public keys")
	.option("-c, --config <string>", "Path to config.json", "./config.json")
	.option("--print", "Print the content instead of writing it")
	.argument("[allowed-clients]", "Comma-separated list of allowed client public keys (optional if existing clients are present)")
	.action(async (allowedClients, options) => {
		NodeRuntime.runMain(enableFastConfig(options.config, allowedClients, options.print).pipe(Effect.provide(NodeFileSystem.layer)));
	});

const enableFastConfig = (configPath: string, allowedClients: string | undefined, printOnly = false) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const configFileExists = yield* fs.exists(configPath);
		// If config file doesn't exist, return error
		if (!configFileExists) {
			yield* Effect.logError(`Config file ${configPath} does not exist, please run 'bun start init' to create it`);
			process.exit(1);
		}

		// Read config file
		yield* Effect.logInfo(`Reading config from: ${configPath}`);
		const configFile = Buffer.from(yield* fs.readFile(configPath));
		// biome-ignore lint/suspicious/noExplicitAny: I'm not sure why this was not typed at all before...
		const config = parseJSON5(configFile.toString()) as any;

		// Initialize sedaFast if it doesn't exist
		if (!config.sedaFast) {
			config.sedaFast = {};
		}

		// Get existing clients
		const existingClients = config.sedaFast.allowedClients || [];
		const existingSet = new Set(existingClients);

		// Parse new clients if provided
		let newClients: string[] = [];
		if (allowedClients?.trim()) {
			newClients = allowedClients
				.split(",")
				.map((key: string) => key.trim())
				.filter((key: string) => key.length > 0);

			if (newClients.length === 0) {
				yield* Effect.logError("No valid client public keys provided");
				yield* Effect.logError('Please provide client public keys, use `enable-fast "pubkey1,pubkey2"`');
				process.exit(1);
			}
		} else {
			// No new clients provided, use existing ones if available
			if (existingClients.length > 0) {
				yield* Effect.logInfo("No new clients provided, keeping existing ones...");
			} else {
				yield* Effect.logError("No allowed clients provided and none exist in config");
				yield* Effect.logError('Please provide client public keys, use `enable-fast "pubkey1,pubkey2"`');
				process.exit(1);
			}
		}

		// Check what's new and what already exists
		const alreadyExists = newClients.filter((client) => existingSet.has(client));
		const actuallyNew = newClients.filter((client) => !existingSet.has(client));

		// Show what's happening
		if (newClients.length > 0) {
			if (existingClients.length > 0) {
				yield* Effect.logInfo("\nCurrent allowed clients:");
				existingClients.forEach((client: string, index: number) => {
					console.log(`- [${index + 1}]: ${client}`);
				});
			}

			if (alreadyExists.length > 0) {
				yield* Effect.logInfo("\nAlready exists (will be skipped):");
				alreadyExists.forEach((client: string, index: number) => {
					console.log(`- [${index + 1}]: ${client}`);
				});
			}

			if (actuallyNew.length > 0) {
				console.log("\nAdding new clients:");
				actuallyNew.forEach((client: string, index: number) => {
					console.log(`- [${index + 1}]: ${client}`);
				});
			}

			// Show final result
			const finalClients = [...existingClients, ...actuallyNew];
			console.log("\nFinal allowed clients:");
			finalClients.forEach((client: string, index: number) => {
				console.log(`- [${index + 1}]: ${client}`);
			});

			// Ask for confirmation only if there are existing clients that might be affected
			if (actuallyNew.length > 0 && !printOnly && existingClients.length > 0) {
				const confirmed = yield* Effect.tryPromise(() => askForConfirmation("\nContinue? (y/N): "));
				if (!confirmed) {
					yield* Effect.logInfo("Operation cancelled");
					process.exit(0);
				}
			} else if (actuallyNew.length === 0) {
				yield* Effect.logInfo("\nNo new clients to add. All provided clients already exist.");
				process.exit(0);
			}
		}

		// Check if we're actually changing anything
		const wasEnabled = config.sedaFast.enable;
		const finalClients = [...existingClients, ...actuallyNew];

		// Update configuration
		config.sedaFast.enable = true;
		config.sedaFast.allowedClients = finalClients;

		// Validate the updated config using the parser
		const [parseResult] = yield* parseConfig(config);
		if (parseResult.isErr) {
			yield* Effect.logError("\nConfiguration validation failed:");
			yield* Effect.logError(parseResult.error);
			process.exit(1);
		}

		if (printOnly) {
			yield* Effect.logInfo("\n📄 Content of the updated configuration file:");
			yield* Effect.logInfo(JSON.stringify(config, null, 2));
		} else {
			// Write back the original config (with our SEDA FAST changes)
			yield* fs.writeFile(configPath, Buffer.from(JSON.stringify(config, null, 2)));

			// Show appropriate success message
			if (!wasEnabled) {
				yield* Effect.logInfo(
					`\n✅ SEDA FAST enabled successfully with ${finalClients.length} client${finalClients.length === 1 ? "" : "s"}`,
				);
			} else if (actuallyNew.length > 0) {
				yield* Effect.logInfo(
					`\n✅ SEDA FAST clients updated successfully (${finalClients.length} total client${finalClients.length === 1 ? "" : "s"})`,
				);
			} else {
				yield* Effect.logInfo(
					`\n✅ SEDA FAST is already enabled with ${finalClients.length} client${finalClients.length === 1 ? "" : "s"}`,
				);
			}

			yield* Effect.logInfo("\nRestart the data proxy service to apply the changes");
		}
	});

async function askForConfirmation(question: string): Promise<boolean> {
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	return new Promise((resolve) => {
		rl.question(question, (answer) => {
			rl.close();
			resolve(["y", "yes"].includes(answer.toLowerCase()));
		});
	});
}
