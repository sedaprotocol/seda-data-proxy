import { exists, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Command, Option } from "@commander-js/extra-typings";

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
	try {
		// If config file doesn't exist, return error
		if (!(await exists(configPath))) {
			console.error(
				`Config file ${configPath} does not exist, please run 'bun start init' to create it`,
			);
			process.exit(1);
		}

		// Read config file
		console.log(`Using config: ${configPath}`);
		const configFile = await readFile(configPath);
		const config = JSON.parse(configFile.toString());

		// Initialize sedaFast if it doesn't exist
		if (!config.sedaFast) {
			config.sedaFast = {};
		}

		let uniqueClients: string[] = [];

		// Handle allowed clients argument
		if (allowedClients?.trim()) {
			// Parse and validate clients
			const newClients = allowedClients
				.split(",")
				.map((key: string) => key.trim())
				.filter((key: string) => key.length > 0);

			if (newClients.length === 0) {
				console.error("No valid client public keys provided");
				console.error(
					'Please provide client public keys: bun start fast-enable "pubkey1,pubkey2"',
				);
				process.exit(1);
			}

			uniqueClients = [...new Set(newClients)];
		} else {
			// No new clients provided, use existing ones if available
			if (config.sedaFast.allowedClients?.length > 0) {
				uniqueClients = config.sedaFast.allowedClients;
				console.log("No new clients provided, keeping existing ones...");
			} else {
				console.error("No allowed clients provided and none exist in config");
				console.error(
					'Please provide client public keys: bun start fast-enable "pubkey1,pubkey2"',
				);
				process.exit(1);
			}
		}

		// Check if there are existing clients and ask for confirmation (only if we're replacing them)
		if (allowedClients?.trim() && config.sedaFast.allowedClients?.length > 0) {
			const status = config.sedaFast.enable ? "enabled" : "disabled";
			console.log(`⚠️  Seda Fast is ${status} but has existing clients:`);

			config.sedaFast.allowedClients.forEach(
				(client: string, index: number) => {
					console.log(`- [${index + 1}]: ${client}`);
				},
			);

			console.log("\nReplace with:");
			uniqueClients.forEach((client: string, index: number) => {
				console.log(`- [${index + 1}]: ${client}`);
			});

			if (!printOnly) {
				const confirmed = await askForConfirmation("\nContinue? (y/N): ");
				if (!confirmed) {
					console.log("Operation cancelled");
					process.exit(0);
				}
			}
			console.log("");
		}

		// Check if we're actually changing anything
		const wasEnabled = config.sedaFast.enable;
		const clientsChanged =
			JSON.stringify(config.sedaFast.allowedClients) !==
			JSON.stringify(uniqueClients);

		// Update configuration
		config.sedaFast.enable = true;
		config.sedaFast.allowedClients = uniqueClients;

		if (printOnly) {
			console.log("⚙️ Updated configuration file content:");
			console.log(JSON.stringify(config, null, 2));
		} else {
			// Write back to file
			await writeFile(configPath, JSON.stringify(config, null, 2));

			// Show appropriate success message
			if (!wasEnabled) {
				console.log(
					`✅ Seda Fast enabled successfully with ${uniqueClients.length} clients`,
				);
			} else if (clientsChanged) {
				console.log(
					`✅ Seda Fast clients updated successfully (${uniqueClients.length} clients)`,
				);
			} else {
				console.log(
					`Seda Fast is already enabled with ${uniqueClients.length} clients`,
				);
			}
		}
	} catch (error) {
		console.error(`Failed to update config: ${error}`);
		process.exit(1);
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
