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
		return Result.ok(Buffer.from(PRIVATE_KEY, "hex"));
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

	return Result.ok(Buffer.from(parsedPrivateKeyFile.value.privkey, "hex"));
}
