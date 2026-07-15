import { Duration, Effect, Either, Layer, Option, Ref, Schedule } from "effect";
import type { Route } from "../../config/config-parser";
import type { PmInsightsModuleConfig } from "../../config/pm-insights-module-config";
import { createErrorResponse } from "../../controllers/create-error-response";
import {
	FailedToParseResponseBodyError,
	HttpClientRequestFailedError,
} from "../../errors";
import { HttpClientService } from "../../services/http-client";
import { replaceParams } from "../../utils/replace-params";
import { FailedToHandleRequest, ModuleService } from "../module";
import { FailedToHandlePmInsightsRequestError } from "./errors";

const FETCH_TIMEOUT_MS = 15_000;

function mapHttpClientError(
	error: unknown,
	context: string,
): FailedToHandlePmInsightsRequestError {
	if (error instanceof FailedToHandlePmInsightsRequestError) {
		return error;
	}

	const cause =
		error instanceof HttpClientRequestFailedError ||
		error instanceof FailedToParseResponseBodyError
			? error.error
			: error;

	if (cause instanceof Error && cause.name === "TimeoutError") {
		return new FailedToHandlePmInsightsRequestError({
			error: `${context} timed out after ${FETCH_TIMEOUT_MS}ms`,
			status: 504,
		});
	}

	return new FailedToHandlePmInsightsRequestError({
		error: `${context}: ${cause}`,
		status: 502,
	});
}

function parseTokenFromLoginBody(text: string): string | undefined {
	const trimmed = text.trim();
	if (trimmed.startsWith("{")) {
		const jsonEither = Either.try(
			() => JSON.parse(trimmed) as Record<string, unknown>,
		);
		if (Either.isRight(jsonEither)) {
			const json = jsonEither.right;
			const t = json.access_token ?? json.token ?? json.accessToken;
			if (typeof t === "string" && t.length > 0) {
				return t;
			}
		}
	}
	if (/^[\w-]+\.[\w-]+\.[\w-]+$/.test(trimmed)) {
		return trimmed;
	}
	return undefined;
}

export const PmInsightsModuleService = (config: PmInsightsModuleConfig) =>
	Layer.effect(
		ModuleService,
		Effect.gen(function* () {
			yield* Effect.logInfo("Initializing PM Insights module", {
				name: config.name,
				baseUrl: config.baseUrl,
			});

			const httpClient = yield* HttpClientService;
			const tokenRef = yield* Ref.make<Option.Option<string>>(Option.none());

			const loginUrl = new URL("login", config.baseUrl).toString();

			const performLogin = Effect.gen(function* () {
				const body = new URLSearchParams({
					username: config.email,
					password: config.password,
				}).toString();

				const response = yield* httpClient
					.request(loginUrl, {
						method: "POST",
						headers: {
							"Content-Type": "application/x-www-form-urlencoded",
						},
						body,
						signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
					})
					.pipe(
						Effect.mapError((error) =>
							mapHttpClientError(error, "Login request failed"),
						),
					);

				const responseBody = yield* httpClient.parseBodyAsText(response).pipe(
					Effect.mapError(
						(error) =>
							new FailedToHandlePmInsightsRequestError({
								error: `Failed to read login response: ${error.error}`,
								status: 500,
							}),
					),
				);

				const loginOk = response.status >= 200 && response.status < 300;
				if (!loginOk) {
					return yield* Effect.fail(
						new FailedToHandlePmInsightsRequestError({
							error: `Login failed with status ${response.status}: ${responseBody}`,
							status: 502,
						}),
					);
				}

				const token = parseTokenFromLoginBody(responseBody);
				if (!token) {
					return yield* Effect.fail(
						new FailedToHandlePmInsightsRequestError({
							error: "Login response did not contain a recognizable token",
							status: 502,
						}),
					);
				}

				yield* Ref.set(tokenRef, Option.some(token));
				yield* Effect.logInfo("PM Insights bearer token refreshed");
			});

			yield* performLogin.pipe(Effect.orDie);

			const start = () =>
				Effect.gen(function* () {
					yield* Effect.logInfo("PM Insights module started", {
						name: config.name,
					});

					// Set up login refresh and retry schedules
					const refreshInterval = Duration.minutes(
						config.tokenRefreshIntervalMinutes,
					);
					const retryInterval = Duration.minutes(
						config.tokenRetryIntervalMinutes,
					);
					yield* Effect.forkDaemon(
						performLogin.pipe(
							Effect.schedule(Schedule.spaced(refreshInterval)),
							Effect.catchAll((error) => {
								return Effect.logError(
									"PM Insights login refresh failed - Initiating retry",
									{ error },
								).pipe(
									Effect.flatMap(() =>
										Effect.retry(
											performLogin.pipe(
												Effect.tapError((error) =>
													Effect.logError("PM Insights login retry failed", {
														error,
													}),
												),
											),
											Schedule.spaced(retryInterval),
										),
									),
								);
							}),
						),
					);
				}).pipe(Effect.annotateLogs("_name", "pm-insights"));

			const handleRequest = (
				route: Route,
				params: Record<string, string>,
				request: Request,
			) =>
				Effect.gen(function* () {
					if (route.type !== "pm-insights") {
						return yield* Effect.fail(
							new FailedToHandleRequest({
								msg: "Route is not a PM Insights module route",
							}),
						);
					}

					const path = replaceParams(route.fetchFromModule, params).trim();
					if (!path) {
						return yield* Effect.fail(
							new FailedToHandlePmInsightsRequestError({
								error: "Missing upstream path",
								status: 400,
							}),
						);
					}

					const upstreamPath = path + new URL(request.url).search;
					const upstreamUrl = new URL(upstreamPath, config.baseUrl).toString();

					const tokenOpt = yield* Ref.get(tokenRef);
					if (Option.isNone(tokenOpt)) {
						return yield* Effect.fail(
							new FailedToHandlePmInsightsRequestError({
								error: "No bearer token available",
								status: 503,
							}),
						);
					}

					yield* Effect.logDebug("Making PM Insights request", {
						url: upstreamUrl,
						path: upstreamPath,
					});

					const response = yield* httpClient
						.request(upstreamUrl, {
							method: "GET",
							headers: {
								Authorization: `Bearer ${tokenOpt.value}`,
								Accept: "application/json",
							},
							signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
						})
						.pipe(
							Effect.mapError((error) =>
								mapHttpClientError(error, "Failed to fetch from PM Insights"),
							),
						);

					const responseBody = yield* httpClient.parseBodyAsText(response).pipe(
						Effect.mapError(
							(error) =>
								new FailedToHandlePmInsightsRequestError({
									error: `Failed to read response: ${error.error}`,
									status: 500,
								}),
						),
					);

					// PM Insights returns 400 for invalid credentials.
					if (response.status === 400) {
						yield* Effect.logWarning(
							"PM Insights upstream rejected credentials; refreshing login",
							{ status: response.status },
						);
						yield* performLogin.pipe(
							Effect.catchAll((error) =>
								Effect.logError("PM Insights login refresh failed", { error }),
							),
						);
					}

					if (response.status < 200 || response.status >= 300) {
						yield* Effect.logError("PM Insights request failed", {
							status: response.status,
							body: responseBody,
							path: upstreamPath,
						});
					}

					return yield* Effect.succeed(
						new Response(responseBody, {
							status: response.status,
							headers: {
								"Content-Type":
									response.headers.get("content-type") ?? "application/json",
							},
						}),
					);
				}).pipe(
					Effect.withSpan("handlePmInsightsRequest"),
					Effect.catchAll((error) => {
						const status =
							typeof error.status === "number" ? error.status : 500;
						return Effect.succeed(createErrorResponse(error, status));
					}),
				);

			return {
				start,
				handleRequest,
			};
		}).pipe(Effect.provide(HttpClientService.Default())),
	);
