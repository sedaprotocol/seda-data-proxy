import { tryParseSync } from "@seda-protocol/utils";
import { Duration, Effect, Schedule } from "effect";
import * as v from "valibot";
import {
	AssetCtxSchema,
	type HydromancerModuleConfig,
} from "../../config/hydromancer-module-config";
import { FailedToHandleHydromancerRequestError } from "./errors";

const BatchResponseSchema = v.record(v.string(), v.nullable(AssetCtxSchema));

export type BatchAssetContexts = v.InferOutput<typeof BatchResponseSchema>;

export const REST_MAX_COINS_PER_REQUEST = 20;

// Hydromancer's edge sometimes resets the connection before headers (a 502,
// 503, or 504). `/info` is a read, so those are safe to replay.
const RETRYABLE_UPSTREAM_STATUSES = new Set([502, 503, 504]);

export const executeHydromancerRestRequest = (
	config: HydromancerModuleConfig,
	rawBody: unknown,
): Effect.Effect<Response, FailedToHandleHydromancerRequestError> => {
	const url = new URL("/info", config.restBaseUrl);
	const timeoutMs = Duration.toMillis(config.restFetchTimeout);
	const body = typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody);

	return Effect.tryPromise({
		try: () =>
			fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${config.hydromancerApiKey}`,
				},
				body,
				signal: AbortSignal.timeout(timeoutMs),
			}),
		catch: (error) => {
			const isTimeout = error instanceof Error && error.name === "TimeoutError";
			return new FailedToHandleHydromancerRequestError({
				error: isTimeout
					? `Hydromancer REST timed out after ${timeoutMs}ms`
					: `Failed to fetch from Hydromancer: ${error}`,
				status: isTimeout ? 504 : 502,
			});
		},
	}).pipe(
		Effect.flatMap((response) => {
			if (!RETRYABLE_UPSTREAM_STATUSES.has(response.status)) {
				return Effect.succeed(response);
			}
			return Effect.tryPromise({
				try: () => response.text(),
				catch: (error) =>
					new FailedToHandleHydromancerRequestError({
						error: `Failed to read Hydromancer response: ${error}`,
						status: 500,
					}),
			}).pipe(
				Effect.flatMap((text) =>
					Effect.fail(
						new FailedToHandleHydromancerRequestError({
							error: `Hydromancer responded ${response.status}: ${text}`,
							status: 502,
						}),
					),
				),
			);
		}),
		// A timeout is 504 and a body-read failure is 500, so neither is retried.
		// Schedule.exponential("200 millis") waits 200ms, 400ms, then 800ms.
		Effect.retry({
			times: 3,
			schedule: Schedule.exponential("200 millis"),
			while: (error) => error.status === 502,
		}),
		Effect.withSpan("executeHydromancerRestRequest"),
	);
};

const fetchAssetContextsChunkFromRest = (
	config: HydromancerModuleConfig,
	coins: string[],
): Effect.Effect<BatchAssetContexts, FailedToHandleHydromancerRequestError> =>
	Effect.gen(function* () {
		const response = yield* executeHydromancerRestRequest(config, {
			type: "assetContext",
			coins,
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

export const fetchAssetContextsFromRest = (
	config: HydromancerModuleConfig,
	coins: string[],
): Effect.Effect<BatchAssetContexts, FailedToHandleHydromancerRequestError> => {
	const chunks: string[][] = [];
	for (let i = 0; i < coins.length; i += REST_MAX_COINS_PER_REQUEST) {
		chunks.push(coins.slice(i, i + REST_MAX_COINS_PER_REQUEST));
	}

	return Effect.forEach(
		chunks,
		(chunk) => fetchAssetContextsChunkFromRest(config, chunk),
		{ concurrency: "unbounded" },
	).pipe(
		Effect.map((batches) => Object.assign({}, ...batches)),
		Effect.withSpan("fetchAssetContextsFromRest", { attributes: { coins } }),
	);
};
