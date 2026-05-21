import { layer as fetchHttpClientLayer } from "@effect/platform/FetchHttpClient";
import * as Headers from "@effect/platform/Headers";
import { text as httpBodyText } from "@effect/platform/HttpBody";
import { HttpClient } from "@effect/platform/HttpClient";
import * as HttpClientRequest from "@effect/platform/HttpClientRequest";
import { type HttpMethod, hasBody } from "@effect/platform/HttpMethod";
import { Duration, Effect, Either, Layer, Option, Ref, Schedule } from "effect";
import type { Route } from "../../config/config-parser";
import type { PmInsightsModuleConfig } from "../../config/pm-insights-module-config";
import { createErrorResponse } from "../../controllers/create-error-response";
import { replaceParams } from "../../utils/replace-params";
import { FailedToHandleRequest, ModuleService } from "../module";
import { FailedToHandlePmInsightsRequestError } from "./errors";

const FETCH_TIMEOUT_MS = 15_000;

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

function normalizeHttpMethod(method: string): HttpMethod {
	const u = method.toUpperCase();
	switch (u) {
		case "GET":
		case "POST":
		case "PUT":
		case "DELETE":
		case "PATCH":
		case "HEAD":
		case "OPTIONS":
			return u;
		default:
			return "GET";
	}
}

export const PmInsightsModuleService = (config: PmInsightsModuleConfig) =>
	Layer.effect(
		ModuleService,
		Effect.gen(function* () {
			yield* Effect.logInfo("Initializing PM Insights module", {
				name: config.name,
				baseUrl: config.baseUrl,
			});

			const tokenRef = yield* Ref.make<Option.Option<string>>(Option.none());

			const loginUrl = new URL("login", config.baseUrl).toString();

			const performLogin = Effect.gen(function* () {
				const body = new URLSearchParams({
					username: config.email,
					password: config.password,
				}).toString();

				const client = yield* HttpClient;
				const response = yield* client
					.post(loginUrl, {
						body: httpBodyText(body, "application/x-www-form-urlencoded"),
					})
					.pipe(
						Effect.timeoutFail({
							duration: Duration.millis(FETCH_TIMEOUT_MS),
							onTimeout: () =>
								new FailedToHandlePmInsightsRequestError({
									error: `Login timed out after ${FETCH_TIMEOUT_MS}ms`,
									status: 504,
								}),
						}),
						Effect.mapError((error): FailedToHandlePmInsightsRequestError => {
							if (error instanceof FailedToHandlePmInsightsRequestError) {
								return error;
							}
							return new FailedToHandlePmInsightsRequestError({
								error: `Login request failed: ${error}`,
								status: 502,
							});
						}),
					);

				const responseBody = yield* response.text.pipe(
					Effect.mapError(
						(error) =>
							new FailedToHandlePmInsightsRequestError({
								error: `Failed to read login response: ${error}`,
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
			}).pipe(Effect.provide(fetchHttpClientLayer));

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
				body: string,
			) =>
				Effect.gen(function* () {
					if (route.type !== "pm-insights") {
						return yield* Effect.fail(
							new FailedToHandleRequest({
								msg: "Route is not a PM Insights module route",
							}),
						);
					}

					const signedPath =
						replaceParams(route.upstreamPath, params) +
						new URL(request.url).search;
					const upstreamUrl = new URL(signedPath, config.baseUrl);

					const method = normalizeHttpMethod(request.method);

					const tokenOpt = yield* Ref.get(tokenRef);
					if (Option.isNone(tokenOpt)) {
						return yield* Effect.fail(
							new FailedToHandlePmInsightsRequestError({
								error: "No bearer token available",
								status: 503,
							}),
						);
					}

					const headers: Record<string, string> = {
						Authorization: `Bearer ${tokenOpt.value}`,
						Accept: request.headers.get("accept") ?? "application/json",
						"Content-Type":
							request.headers.get("content-type") ?? "application/json",
					};

					const upstreamRequest = !hasBody(method)
						? HttpClientRequest.make(method)(upstreamUrl, { headers })
						: HttpClientRequest.make(method)(upstreamUrl, {
								headers,
								body: body ? httpBodyText(body) : undefined,
							});

					yield* Effect.logDebug("Making PM Insights request", {
						url: upstreamUrl.toString(),
						method: request.method,
						path: signedPath,
					});

					const response = yield* Effect.gen(function* () {
						const client = yield* HttpClient;
						return yield* client.execute(upstreamRequest);
					}).pipe(
						Effect.provide(fetchHttpClientLayer),
						Effect.timeoutFail({
							duration: Duration.millis(FETCH_TIMEOUT_MS),
							onTimeout: () =>
								new FailedToHandlePmInsightsRequestError({
									error: `PM Insights request timed out after ${FETCH_TIMEOUT_MS}ms`,
									status: 504,
								}),
						}),
						Effect.mapError((error): FailedToHandlePmInsightsRequestError => {
							if (error instanceof FailedToHandlePmInsightsRequestError) {
								return error;
							}
							return new FailedToHandlePmInsightsRequestError({
								error: `Failed to fetch from PM Insights: ${error}`,
								status: 502,
							});
						}),
					);

					const responseBody = yield* response.text.pipe(
						Effect.mapError(
							(error) =>
								new FailedToHandlePmInsightsRequestError({
									error: `Failed to read response: ${error}`,
									status: 500,
								}),
						),
					);

					// PM Insights returns 400 for invalid credentials
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

					const upstreamOk = response.status >= 200 && response.status < 300;
					if (!upstreamOk) {
						yield* Effect.logError("PM Insights request failed", {
							status: response.status,
							body: responseBody,
						});
					}

					const upstreamContentType = Option.getOrElse(
						Headers.get(response.headers, "content-type"),
						() => "application/json",
					);

					return yield* Effect.succeed(
						new Response(responseBody, {
							status: response.status,
							headers: { "Content-Type": upstreamContentType },
						}),
					);
				}).pipe(
					Effect.withSpan("handlePmInsightsRequest"),
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
