import { tryParseSync } from "@seda-protocol/utils";
import { Effect } from "effect";
import * as v from "valibot";
import {
	type AssetCtx,
	AssetCtxSchema,
	type HydromancerModuleConfig,
} from "../../config/hydromancer-module-config";
import { FailedToHandleHydromancerRequestError } from "./errors";

const FETCH_TIMEOUT_MS = 15_000;

const BatchResponseSchema = v.record(v.string(), v.nullable(AssetCtxSchema));

export type BatchAssetContexts = v.InferOutput<typeof BatchResponseSchema>;

export const fetchAssetContextsFromRest = (
	config: HydromancerModuleConfig,
	coins: string[],
): Effect.Effect<BatchAssetContexts, FailedToHandleHydromancerRequestError> =>
	Effect.gen(function* () {
		const url = new URL("/info", config.restBaseUrl);

		const response = yield* Effect.tryPromise({
			try: () =>
				fetch(url, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${config.hydromancerApiKey}`,
					},
					body: JSON.stringify({ type: "assetContext", coins }),
					signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
				}),
			catch: (error) => {
				const isTimeout =
					error instanceof Error && error.name === "TimeoutError";
				return new FailedToHandleHydromancerRequestError({
					error: isTimeout
						? `Hydromancer REST timed out after ${FETCH_TIMEOUT_MS}ms`
						: `Failed to fetch from Hydromancer: ${error}`,
					status: isTimeout ? 504 : 502,
				});
			},
		});

		const responseText = yield* Effect.tryPromise({
			try: () => response.text(),
			catch: (error) =>
				new FailedToHandleHydromancerRequestError({
					error: `Failed to read Hydromancer response: ${error}`,
					status: 500,
				}),
		});

		if (!response.ok) {
			const upstreamStatus = response.status;
			return yield* Effect.fail(
				new FailedToHandleHydromancerRequestError({
					error: `Hydromancer responded ${upstreamStatus}: ${responseText}`,
					status: upstreamStatus >= 500 ? 502 : upstreamStatus,
				}),
			);
		}

		const parsedJson = yield* Effect.try({
			try: () => JSON.parse(responseText) as unknown,
			catch: (error) =>
				new FailedToHandleHydromancerRequestError({
					error: `Hydromancer returned non-JSON body: ${error}`,
					status: 502,
				}),
		});

		const validated = tryParseSync(BatchResponseSchema, parsedJson);
		if (validated.isErr) {
			return yield* Effect.fail(
				new FailedToHandleHydromancerRequestError({
					error: `Invalid Hydromancer response shape: ${validated.error
						.map((e) => e.message)
						.join(", ")}`,
					status: 502,
				}),
			);
		}

		return validated.value;
	});

export const pickResolvedContexts = (
	requested: string[],
	batch: BatchAssetContexts,
): Array<{ coin: string } & AssetCtx> => {
	const resolved: Array<{ coin: string } & AssetCtx> = [];
	for (const coin of requested) {
		const ctx = batch[coin];
		if (ctx) {
			resolved.push({ coin, ...ctx });
		}
	}
	return resolved;
};
