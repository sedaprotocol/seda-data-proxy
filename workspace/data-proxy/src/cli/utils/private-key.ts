import { readFile } from "node:fs/promises";
import { Result } from "true-myth";
import {
	DEFAULT_PRIVATE_KEY_JSON_FILE_NAME,
	PRIVATE_KEY,
} from "../../constants";
import { tryAsync, tryParseSync, trySync } from "../../utils/try";
import { FileKeyPairSchema } from "./key-pair";

async function readPrivateKeyFile(
	path: string,
): Promise<Result<Buffer, unknown>> {
	const privateKeyFile = await tryAsync(async () => readFile(path));

	return privateKeyFile;
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
		return Result.err(
			`Failed to parse private key file: ${JSON.stringify(parsedPrivateKeyFile.error)}`,
		);
	}

	return Result.ok(Buffer.from(parsedPrivateKeyFile.value.privkey, "hex"));
}
