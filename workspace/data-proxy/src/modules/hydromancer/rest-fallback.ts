import { tryParseSync } from "@seda-protocol/utils";
import { Duration, Effect } from "effect";
import * as v from "valibot";
import {
	AssetCtxSchema,
	type HydromancerModuleConfig,
} from "../../config/hydromancer-module-config";
import { FailedToHandleHydromancerRequestError } from "./errors";

const BatchResponseSchema = v.record(v.string(), v.nullable(AssetCtxSchema));

export type BatchAssetContexts = v.InferOutput<typeof BatchResponseSchema>;

export const executeHydromancerRestRequest = (
	config: HydromancerModuleConfig,
	rawBody: unknown,
): Effect.Effect<Response, FailedToHandleHydromancerRequestError> =>
	Effect.gen(function* () {
		const url = new URL("/info", config.restBaseUrl);
		const timeoutMs = Duration.toMillis(config.restFetchTimeout);

		const body =
			typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody);

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

		return response;
	}).pipe(Effect.withSpan("executeHydromancerRestRequest"));

export const fetchAssetContextsFromRest = (
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
	}).pipe(
		Effect.withSpan("fetchAssetContextsFromRest", { attributes: { coins } }),
	);
