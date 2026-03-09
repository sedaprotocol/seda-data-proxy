import { readFile } from "node:fs/promises";
import { Environment } from "@seda-protocol/data-proxy-sdk";
import { tryParseSync } from "@seda-protocol/utils";
import { Data, Effect } from "effect";
import {
	DEFAULT_PRIVATE_KEY_JSON_FILE_NAME,
	getPrivateKey,
} from "../../constants";
import { FileKeyPairSchema } from "./key-pair";

export class FailedToReadPrivateKeyFileError extends Data.TaggedError(
	"FailedToReadPrivateKeyFileError",
)<{ error: string | unknown }> {
	message = `Failed to read private key file: ${this.error}`;
}

const readPrivateKeyFile = (path: string) =>
	Effect.gen(function* () {
		const privateKeyFile = yield* Effect.tryPromise({
			try: () => readFile(path),
			catch: (error) => new FailedToReadPrivateKeyFileError({ error }),
		});

		return privateKeyFile;
	});

export class FailedToParsePrivateKeyFileError extends Data.TaggedError(
	"FailedToParsePrivateKeyFileError",
)<{ error: string | unknown }> {
	message = `Failed to parse private key file: ${this.error}`;
}

export const loadNetworkFromKeyFile = (privateKeyFilePath?: string) =>
	Effect.gen(function* () {
		// If no private key file path is provided and private key env var is set, use default network Testnet
		if (!privateKeyFilePath && getPrivateKey()) {
			return yield* Effect.succeed(Environment.Testnet);
		}

		const filePath = privateKeyFilePath ?? DEFAULT_PRIVATE_KEY_JSON_FILE_NAME;
		const privateKeyFile = yield* readPrivateKeyFile(filePath);

		const privateKeyFileObject = (yield* Effect.try({
			try: () => JSON.parse(privateKeyFile.toString()),
			catch: (error) =>
				new FailedToParsePrivateKeyFileError({
					error: `[loadNetworkFromKeyFile] JSON.parse failed: ${error}`,
				}),
		})) as unknown;

		const parsedPrivateKeyFile = tryParseSync(
			FileKeyPairSchema,
			privateKeyFileObject,
		);

		if (parsedPrivateKeyFile.isErr) {
			let resultError = "";

			for (const error of parsedPrivateKeyFile.error) {
				resultError += `${error.message} on config property "${error.path?.[0].key}" \n`;
			}

			return yield* Effect.fail(
				new FailedToParsePrivateKeyFileError({
					error: `[loadNetworkFromKeyFile] ${resultError}`,
				}),
			);
		}

		return yield* Effect.succeed(parsedPrivateKeyFile.value.network);
	});

export const loadPrivateKey = (privateKeyFilePath?: string) =>
	Effect.gen(function* () {
		const privateKey = getPrivateKey();

		if (!privateKeyFilePath && privateKey) {
			return yield* Effect.succeed(Buffer.from(privateKey.trim(), "hex"));
		}

		const privateKeyFile = yield* readPrivateKeyFile(
			privateKeyFilePath ?? DEFAULT_PRIVATE_KEY_JSON_FILE_NAME,
		);

		const privateKeyFileObject = (yield* Effect.try({
			try: () => JSON.parse(privateKeyFile.toString()),
			catch: (error) =>
				new FailedToParsePrivateKeyFileError({
					error: `[loadPrivateKey] JSON.parse failed: ${error}`,
				}),
		})) as unknown;

		const parsedPrivateKeyFile = tryParseSync(
			FileKeyPairSchema,
			privateKeyFileObject,
		);

		if (parsedPrivateKeyFile.isErr) {
			let resultError = "";

			for (const error of parsedPrivateKeyFile.error) {
				resultError += `${error.message} on config property "${error.path?.[0].key}" \n`;
			}

			return yield* Effect.fail(
				new FailedToParsePrivateKeyFileError({
					error: `[loadPrivateKey] ${resultError}`,
				}),
			);
		}

		return yield* Effect.succeed(
			Buffer.from(parsedPrivateKeyFile.value.privkey.trim(), "hex"),
		);
	});
