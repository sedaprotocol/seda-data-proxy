import { Clock, Effect, Layer } from "effect";
import type { ChainlinkStreamsModuleConfig } from "../../config/chainlink-streams-module-config";
import type { Route } from "../../config/config-parser";
import { createErrorResponse } from "../../controllers/create-error-response";
import { replaceParams } from "../../utils/replace-params";
import { FailedToHandleRequest, ModuleService } from "../module";
import { FailedToHandleChainlinkStreamsRequestError } from "./errors";
import { generateHmacAuth } from "./hmac-auth";

const FETCH_TIMEOUT_MS = 15_000;

export const ChainlinkStreamsModuleService = (
	config: ChainlinkStreamsModuleConfig,
) =>
	Layer.effect(
		ModuleService,
		Effect.gen(function* () {
			yield* Effect.logInfo("Initializing Chainlink Streams module", {
				name: config.name,
				baseUrl: config.baseUrl,
			});

			const start = () =>
				Effect.gen(function* () {
					yield* Effect.logInfo("Chainlink Streams module started", {
						name: config.name,
					});
				}).pipe(Effect.annotateLogs("_name", "chainlink-streams"));

			const handleRequest = (
				route: Route,
				params: Record<string, string>,
				request: Request,
			) =>
				Effect.gen(function* () {
					if (route.type !== "chainlink-streams") {
						return yield* Effect.fail(
							new FailedToHandleRequest({
								msg: "Route is not a Chainlink Streams module",
							}),
						);
					}

					const signedPath =
						replaceParams(route.upstreamPath, params) +
						new URL(request.url).search;
					const upstreamUrl = new URL(signedPath, config.baseUrl);

					let body = "";
					if (request.method !== "GET") {
						body = yield* Effect.tryPromise({
							try: () => request.clone().text(),
							catch: () =>
								new FailedToHandleChainlinkStreamsRequestError({
									error: "Failed to read request body",
									status: 400,
								}),
						});
					}

					const nowMs = yield* Clock.currentTimeMillis;
					const timestamp = nowMs.toString();

					const auth = generateHmacAuth(
						config.chainlinkKey,
						config.chainlinkApiSecret,
						request.method,
						signedPath,
						body,
						timestamp,
					);

					yield* Effect.logDebug("Making Chainlink Streams request", {
						url: upstreamUrl.toString(),
						method: request.method,
						path: signedPath,
					});

					const response = yield* Effect.tryPromise({
						try: () =>
							fetch(upstreamUrl, {
								method: request.method,
								headers: {
									"Content-Type": "application/json",
									Accept: "application/json",
									Authorization: auth.authorization,
									"X-Authorization-Timestamp": auth.timestamp,
									"X-Authorization-Signature-SHA256": auth.signature,
								},
								body: body || undefined,
								signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
							}),
						catch: (error) => {
							const isTimeout =
								error instanceof Error && error.name === "TimeoutError";
							return new FailedToHandleChainlinkStreamsRequestError({
								error: isTimeout
									? `Chainlink Streams request timed out after ${FETCH_TIMEOUT_MS}ms`
									: `Failed to fetch from Chainlink: ${error}`,
								status: isTimeout ? 504 : 502,
							});
						},
					});

					const responseBody = yield* Effect.tryPromise({
						try: () => response.text(),
						catch: (error) =>
							new FailedToHandleChainlinkStreamsRequestError({
								error: `Failed to read response: ${error}`,
								status: 500,
							}),
					});

					if (!response.ok) {
						yield* Effect.logError("Chainlink Streams request failed", {
							status: response.status,
							body: responseBody,
						});
					}

					// Preserve upstream Content-Type: error bodies are often text/plain.
					const upstreamContentType =
						response.headers.get("content-type") ?? "application/json";

					return yield* Effect.succeed(
						new Response(responseBody, {
							status: response.status,
							headers: { "Content-Type": upstreamContentType },
						}),
					);
				}).pipe(
					Effect.withSpan("handleChainlinkStreamsRequest"),
					Effect.catchAll((error) => {
						return Effect.succeed(createErrorResponse(error, error.status));
					}),
				);

			return {
				start,
				handleRequest,
			};
		}),
	);
