import { tryParseSync } from "@seda-protocol/utils";
import { Data, Duration, Effect, Schedule } from "effect";
import * as v from "valibot";
import {
	AssetCtxSchema,
	type HydromancerModuleConfig,
} from "../../config/hydromancer-module-config";
import { FailedToHandleHydromancerRequestError } from "./errors";

const BatchResponseSchema = v.record(v.string(), v.nullable(AssetCtxSchema));

export type BatchAssetContexts = v.InferOutput<typeof BatchResponseSchema>;

export const REST_MAX_COINS_PER_REQUEST = 20;

// Statuses that signal a transient upstream/edge failure (e.g. Envoy's
// "upstream connect error or disconnect/reset before headers" 503).
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

// Carries a buffered retryable response so it can be returned as-is once the
// retries are exhausted. Internal to the retry loop, never escapes.
class RetryableRestResponse extends Data.TaggedError("RetryableRestResponse")<{
	status: number;
	statusText: string;
	headers: Headers;
	body: string;
}> {}

type RestAttemptError =
	| FailedToHandleHydromancerRequestError
	| RetryableRestResponse;

const isRetryable = (error: RestAttemptError) =>
	error._tag === "RetryableRestResponse" ||
	// The only 502 produced by a single attempt is a connection-level fetch
	// failure. Timeouts (504) are not retried: each attempt can already take
	// `restFetchTimeout`, and stacking more would blow the caller's budget.
	error.status === 502;

const attemptHydromancerRestRequest = (
	config: HydromancerModuleConfig,
	body: string,
): Effect.Effect<Response, RestAttemptError> =>
	Effect.gen(function* () {
		const url = new URL("/info", config.restBaseUrl);
		const timeoutMs = Duration.toMillis(config.restFetchTimeout);

		const response = yield* Effect.tryPromise({
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
				const isTimeout =
					error instanceof Error && error.name === "TimeoutError";
				return new FailedToHandleHydromancerRequestError({
					error: isTimeout
						? `Hydromancer REST timed out after ${timeoutMs}ms`
						: `Failed to fetch from Hydromancer: ${error}`,
					status: isTimeout ? 504 : 502,
				});
			},
		});

		if (RETRYABLE_STATUSES.has(response.status)) {
			// Buffer the body so the connection is released before retrying.
			const text = yield* Effect.promise(() => response.text().catch(() => ""));
			return yield* Effect.fail(
				new RetryableRestResponse({
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
					body: text,
				}),
			);
		}

		return response;
	});

export const executeHydromancerRestRequest = (
	config: HydromancerModuleConfig,
	rawBody: unknown,
): Effect.Effect<Response, FailedToHandleHydromancerRequestError> => {
	const body = typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody);

	// `/info` is a read-only query, so replaying it is safe.
	const schedule = Schedule.exponential(config.restRetryBaseDelay).pipe(
		Schedule.jittered,
		Schedule.intersect(Schedule.recurs(config.restMaxRetries)),
	);

	return attemptHydromancerRestRequest(config, body).pipe(
		Effect.tapError((error) =>
			isRetryable(error)
				? Effect.logWarning("Hydromancer REST request failed, may retry", {
						status: error.status,
						error:
							error._tag === "RetryableRestResponse"
								? error.body
								: error.message,
					})
				: Effect.void,
		),
		Effect.retry({ schedule, while: isRetryable }),
		// Retries exhausted: hand the last upstream response back unchanged so
		// callers keep reporting the real upstream status and body.
		Effect.catchTag("RetryableRestResponse", (error) =>
			Effect.succeed(
				new Response(error.body, {
					status: error.status,
					statusText: error.statusText,
					headers: error.headers,
				}),
			),
		),
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
