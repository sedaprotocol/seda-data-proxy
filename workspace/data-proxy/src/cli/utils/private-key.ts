import { readFile } from "node:fs/promises";
import { Environment } from "@seda-protocol/data-proxy-sdk";
import { tryAsync, tryParseSync, trySync } from "@seda-protocol/utils";
import { Result } from "true-myth";
import {
	DEFAULT_PRIVATE_KEY_JSON_FILE_NAME,
	PRIVATE_KEY,
} from "../../constants";
import { FileKeyPairSchema } from "./key-pair";

async function readPrivateKeyFile(
	path: string,
): Promise<Result<Buffer, unknown>> {
	const privateKeyFile = await tryAsync(async () => readFile(path));

	return privateKeyFile;
}

export async function loadNetworkFromKeyFile(
	privateKeyFilePath?: string,
): Promise<Result<Environment, string>> {
	// If no private key file path is provided and PRIVATE_KEY is set, use default network Testnet
	if (!privateKeyFilePath && PRIVATE_KEY) {
		return Result.ok(Environment.Testnet);
	}

	const filePath = privateKeyFilePath ?? DEFAULT_PRIVATE_KEY_JSON_FILE_NAME;
	const privateKeyFile = await readPrivateKeyFile(filePath);

	if (privateKeyFile.isErr) {
		return Result.err(
			`Failed to read private key file ${filePath}: ${privateKeyFile.error}`,
		);
	}

	const privateKeyFileObject = trySync(() =>
		JSON.parse(privateKeyFile.value.toString()),
	);

	if (privateKeyFileObject.isErr) {
		return Result.err(
			`Failed to read private key file as JSON: ${privateKeyFileObject.error}`,
		);
	}

	const parsedPrivateKeyFile = tryParseSync(
		FileKeyPairSchema,
		privateKeyFileObject.value,
	);

	if (parsedPrivateKeyFile.isErr) {
		let resultError = "";

		for (const error of parsedPrivateKeyFile.error) {
			resultError += `${error.message} on config property "${error.path?.[0].key}" \n`;
		}

		return Result.err(`Failed to parse private key file: \n ${resultError}`);
	}

	return Result.ok(parsedPrivateKeyFile.value.network);
}

export async function loadPrivateKey(
	privateKeyFilePath?: string,
): Promise<Result<Buffer, string>> {
	if (!privateKeyFilePath && PRIVATE_KEY) {
		// Diagnostic logging
		console.log("🔍 DEBUG: Loading private key from environment variable");
		console.log(`🔍 DEBUG: PRIVATE_KEY raw length: ${PRIVATE_KEY.length}`);
		console.log(
			`🔍 DEBUG: PRIVATE_KEY first 10 chars: "${PRIVATE_KEY.substring(0, 10)}"`,
		);
		console.log(
			`🔍 DEBUG: PRIVATE_KEY last 4 chars: "${PRIVATE_KEY.substring(PRIVATE_KEY.length - 4)}"`,
		);
		console.log(
			`🔍 DEBUG: PRIVATE_KEY has newline at end: ${PRIVATE_KEY.endsWith("\n")}`,
		);
		console.log(
			`🔍 DEBUG: PRIVATE_KEY has carriage return at end: ${PRIVATE_KEY.endsWith("\r")}`,
		);
		console.log(
			`🔍 DEBUG: PRIVATE_KEY char codes (last 5): ${Array.from(
				PRIVATE_KEY.slice(-5),
			)
				.map((c) => c.charCodeAt(0))
				.join(",")}`,
		);

		const trimmedKey = PRIVATE_KEY.trim();
		console.log(`🔍 DEBUG: After trim() length: ${trimmedKey.length}`);

		const buffer = Buffer.from(trimmedKey, "hex");
		console.log(
			`🔍 DEBUG: Buffer length: ${buffer.length} bytes (expected: 32)`,
		);

		return Result.ok(buffer);
	}

	const privateKeyFile = await readPrivateKeyFile(
		privateKeyFilePath ?? DEFAULT_PRIVATE_KEY_JSON_FILE_NAME,
	);

	if (privateKeyFile.isErr) {
		return Result.err(
			`Failed to read private key file ${privateKeyFilePath}: ${privateKeyFile.error}`,
		);
	}

	const privateKeyFileObject = trySync(() =>
		JSON.parse(privateKeyFile.value.toString()),
	);

	if (privateKeyFileObject.isErr) {
		return Result.err(
			`Failed to read private key file as JSON: ${privateKeyFileObject.error}`,
		);
	}

	const parsedPrivateKeyFile = tryParseSync(
		FileKeyPairSchema,
		privateKeyFileObject.value,
	);

	if (parsedPrivateKeyFile.isErr) {
		let resultError = "";

		for (const error of parsedPrivateKeyFile.error) {
			resultError += `${error.message} on config property "${error.path?.[0].key}" \n`;
		}

		return Result.err(`Failed to parse private key file: \n ${resultError}`);
	}

	// Diagnostic logging for file-based private key
	const rawPrivkey = parsedPrivateKeyFile.value.privkey;
	console.log("🔍 DEBUG: Loading private key from file");
	console.log(`🔍 DEBUG: File privkey raw length: ${rawPrivkey.length}`);
	console.log(
		`🔍 DEBUG: File privkey first 10 chars: "${rawPrivkey.substring(0, 10)}"`,
	);
	console.log(
		`🔍 DEBUG: File privkey last 10 chars: "${rawPrivkey.substring(rawPrivkey.length - 10)}"`,
	);

	const trimmedPrivkey = rawPrivkey.trim();
	console.log(`🔍 DEBUG: After trim() length: ${trimmedPrivkey.length}`);

	const buffer = Buffer.from(trimmedPrivkey, "hex");
	console.log(`🔍 DEBUG: Buffer length: ${buffer.length} bytes (expected: 32)`);

	return Result.ok(buffer);
}
