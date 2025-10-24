import { exists, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Command, Option } from "@commander-js/extra-typings";
import { parseConfig } from "../config-parser";

export const enableFastCmd = new Command("enable-fast")
	.description("Enable Seda Fast with allowed client public keys")
	.option("-c, --config <string>", "Path to config.json", "./config.json")
	.option("--print", "Print the content instead of writing it")
	.argument(
		"[allowed-clients]",
		"Comma-separated list of allowed client public keys (optional if existing clients are present)",
	)
	.action(async (allowedClients, options) => {
		await enableFastConfig(options.config, allowedClients, options.print);
	});

async function enableFastConfig(
	configPath: string,
	allowedClients: string | undefined,
	printOnly = false,
) {
	// If config file doesn't exist, return error
	if (!(await exists(configPath))) {
		console.error(
			`Config file ${configPath} does not exist, please run 'bun start init' to create it`,
		);
		process.exit(1);
	}

	// Read config file
	console.log(`Reading config from: ${configPath}`);
	const configFile = await readFile(configPath);
	const config = JSON.parse(configFile.toString());

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
			console.error("No valid client public keys provided");
			console.error(
				'Please provide client public keys: bun start enable-fast "pubkey1,pubkey2"',
			);
			process.exit(1);
		}
	} else {
		// No new clients provided, use existing ones if available
		if (existingClients.length > 0) {
			console.log("No new clients provided, keeping existing ones...");
		} else {
			console.error("No allowed clients provided and none exist in config");
			console.error(
				'Please provide client public keys: bun start enable-fast "pubkey1,pubkey2"',
			);
			process.exit(1);
		}
	}

	// Check what's new and what already exists
	const alreadyExists = newClients.filter((client) => existingSet.has(client));
	const actuallyNew = newClients.filter((client) => !existingSet.has(client));

	// Show what's happening
	if (newClients.length > 0) {
		if (existingClients.length > 0) {
			console.log("\nCurrent allowed clients:");
			existingClients.forEach((client: string, index: number) => {
				console.log(`- [${index + 1}]: ${client}`);
			});
		}

		if (alreadyExists.length > 0) {
			console.log("\nAlready exists (will be skipped):");
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
			const confirmed = await askForConfirmation("\nContinue? (y/N): ");
			if (!confirmed) {
				console.log("Operation cancelled");
				process.exit(0);
			}
		} else if (actuallyNew.length === 0) {
			console.log(
				"\nNo new clients to add. All provided clients already exist.",
			);
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
	const [parseResult] = parseConfig(config);
	if (parseResult.isErr) {
		console.error("\nConfiguration validation failed:");
		console.error(parseResult.error);
		process.exit(1);
	}

	if (printOnly) {
		console.log("\n📄 Content of the updated configuration file:");
		console.log(JSON.stringify(config, null, 2));
	} else {
		// Write back the original config (with our SEDA FAST changes)
		await writeFile(configPath, JSON.stringify(config, null, 2));

		// Show appropriate success message
		if (!wasEnabled) {
			console.log(
				`\n✅ SEDA FAST enabled successfully with ${finalClients.length} client${finalClients.length === 1 ? "" : "s"}`,
			);
		} else if (actuallyNew.length > 0) {
			console.log(
				`\n✅ SEDA FAST clients updated successfully (${finalClients.length} total client${finalClients.length === 1 ? "" : "s"})`,
			);
		} else {
			console.log(
				`\n✅ SEDA FAST is already enabled with ${finalClients.length} client${finalClients.length === 1 ? "" : "s"}`,
			);
		}
	}
}

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
