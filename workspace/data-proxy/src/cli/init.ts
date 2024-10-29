import { randomBytes } from "node:crypto";
import { exists, writeFile } from "node:fs/promises";
import { Command } from "@commander-js/extra-typings";
import { Secp256k1 } from "@cosmjs/crypto";
import { tryAsync } from "@seda-protocol/utils";
import type { Config } from "../config-parser";
import { DEFAULT_PRIVATE_KEY_JSON_FILE_NAME } from "../constants";
import type { FileKeyPair } from "./utils/key-pair";

async function outputJson(
	content: string,
	filePath: string,
	printOnly = false,
) {
	if (printOnly) {
		console.log(`Content for ${filePath}:`);
		console.log(content);
		return;
	}

	const writeResult = await tryAsync(async () => writeFile(filePath, content));

	if (writeResult.isErr) {
		console.error(`Writing file to ${filePath} errored: ${writeResult.error}`);
		process.exit(1);
	}

	console.info(`Written to ${filePath}`);
}

export const initCommand = new Command("init")
	.description("Initializes a config.json file and generates a private key")
	.option(
		"-pkf, --private-key-file <string>",
		"Path where to create the private key json",
		DEFAULT_PRIVATE_KEY_JSON_FILE_NAME,
	)
	.option("-c, --config <string>", "Path to config.json", "./config.json")
	.option("--print", "Print the content instead of writing it")
	.action(async (args) => {
		if (!(await exists(args.privateKeyFile))) {
			const privateKeyBuff = randomBytes(32);
			const keyPair = await Secp256k1.makeKeypair(privateKeyBuff);
			const keyPairJson: FileKeyPair = {
				pubkey: Buffer.from(Secp256k1.compressPubkey(keyPair.pubkey)).toString(
					"hex",
				),
				privkey: Buffer.from(keyPair.privkey).toString("hex"),
			};

			await outputJson(
				JSON.stringify(keyPairJson, null, 2),
				args.privateKeyFile,
				args.print,
			);
		} else {
			console.warn(
				`${args.privateKeyFile} already exists skipping creation of private key`,
			);
		}

		if (!(await exists(args.config))) {
			const config: Partial<Config> = {
				routeGroup: "proxy",
				routes: [
					{
						path: "/*",
						upstreamUrl: "https://swapi.dev/api/{*}",
						// @ts-expect-error
						forwardResponseHeaders: undefined,
						headers: {
							"x-api-key": "some-api-key",
						},
						// @ts-expect-error
						method: undefined,
					},
				],
			};

			await outputJson(
				JSON.stringify(config, null, 2),
				args.config,
				args.print,
			);
		} else {
			console.warn(`${args.config} already exists skipping creation of config`);
		}

		console.info("Done");
	});
