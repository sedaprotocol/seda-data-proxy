import { constants, type DataProxy } from "@seda-protocol/data-proxy-sdk";
import { Effect, Match, Option } from "effect";
import type { Config } from "../../config/config-parser";
import { JSON_PATH_HEADER_KEY } from "../../constants";
import {
	FailedToParseResponseBodyError,
	NotOkUpstreamResponseError,
	UpstreamRequestFailedError,
} from "../../errors";
import { ModuleService } from "../../modules/module";
import type { ProxyServerOptions } from "../../proxy-server";
import { HttpClientService } from "../../services/http-client";
import { createSignedResponseHeaders } from "../../utils/create-headers";
import { maybeToOption } from "../../utils/effect-utils";
import { QueryJsonError, queryJson } from "../../utils/query-json";
import { replaceParams } from "../../utils/replace-params";
import { createUrlSearchParams } from "../../utils/search-params";
import { injectSearchParamsInUrl } from "../../utils/url";
import { createErrorResponse } from "../create-error-response";
import { verifyProof } from "./verify-proof";

export type HandleProxyRequestParams = {
	serverOptions: ProxyServerOptions;
	// TODO: We should inject this as a layer
	dataProxy: DataProxy;
	headers: Record<string, string | undefined>;
	params: Record<string, string>;
	body: Option.Option<string>;
	path: string;
	config: Config;
	request: Request;
	route: Config["routes"][number];
};

export const handleProxyRequest = (inputParams: HandleProxyRequestParams) =>
	Effect.gen(function* () {
		const httpClient = yield* HttpClientService;
		const moduleService = yield* ModuleService;

		const {
			serverOptions,
			headers,
			params,
			body,
			path,
			config,
			request,
			dataProxy,
			route,
		} = inputParams;

		if (!serverOptions.disableProof) {
			yield* verifyProof({ headers, config, dataProxy });
		} else {
			yield* Effect.logDebug("Skipping proof verification.");
		}

		// Parse the request URL to get the search params,
		// this is to support query params that can be repeated, such as ?one=one&one=two
		const requestUrl = new URL(request.url);
		// Add the request search params (?one=two) to the upstream url
		const requestSearchParams = createUrlSearchParams(
			requestUrl.searchParams,
			route.allowedQueryParams,
		);

		const upstreamResponse = yield* Match.value(route).pipe(
			Match.when({ type: "pyth-lazer" }, (pythLazerModuleRoute) =>
				Effect.gen(function* () {
					yield* Effect.logDebug("Handling Pyth Lazer request");
					return yield* moduleService.handleRequest(
						pythLazerModuleRoute,
						params,
						request,
					);
				}),
			),
			Match.when({ type: "chainlink-streams" }, (chainlinkStreamsModuleRoute) =>
				Effect.gen(function* () {
					yield* Effect.logDebug("Handling Chainlink Streams request");
					return yield* moduleService.handleRequest(
						chainlinkStreamsModuleRoute,
						params,
						request,
					);
				}),
			),
			Match.when({ type: "lo-tech" }, (loTechModuleRoute) =>
				Effect.gen(function* () {
					yield* Effect.logDebug("Handling LO:TECH request");
					return yield* moduleService.handleRequest(
						loTechModuleRoute,
						params,
						request,
					);
				}),
			),
			Match.when({ type: "upstream" }, (upstreamModuleRoute) =>
				Effect.gen(function* () {
					yield* Effect.logDebug("Handling upstream request");
					const upstreamHeaders = new Headers();

					const upstreamUrl = yield* injectSearchParamsInUrl(
						replaceParams(upstreamModuleRoute.upstreamUrl, params),
						requestSearchParams,
					).pipe(Effect.map((url) => url.toString()));

					// Forward all headers sent by the requester
					for (const [key, value] of Object.entries(headers)) {
						if (!value || key === constants.PROOF_HEADER_KEY) {
							continue;
						}

						upstreamHeaders.append(key, value);
					}

					// Inject all configured headers by the data proxy node configuration
					// Important: configured headers take precedence over headers sent in the request
					for (const [key, value] of Object.entries(route.headers)) {
						upstreamHeaders.set(key, replaceParams(value, params));
					}

					// Host doesn't match since we are proxying. Returning the upstream host while the URL does not match results
					// in the client to not return the response.
					upstreamHeaders.delete("host");

					yield* Effect.logDebug(`Fetching ${upstreamUrl}..`, {
						headers: upstreamHeaders,
						body,
						upstreamUrl,
					});

					// Fetch the upstream response and process
					const upstreamResponse = yield* httpClient
						.request(upstreamUrl, {
							method: request.method,
							headers: upstreamHeaders,
							body: Option.getOrUndefined(body),
						})
						.pipe(
							Effect.mapError(
								(error) =>
									new UpstreamRequestFailedError({ error, routePath: path }),
							),
						);

					return upstreamResponse;
				}),
			),
			Match.exhaustive,
		);

		if (!upstreamResponse.ok) {
			const upstreamResponseBody = yield* httpClient
				.parseBodyAsText(upstreamResponse)
				.pipe(
					Effect.mapError(
						(error) =>
							new FailedToParseResponseBodyError({
								error: error.message,
								status: upstreamResponse.status,
							}),
					),
				)
				.pipe(
					Effect.tapError((error) =>
						Effect.logError(
							`Upstream response body parsing failed for ${route.path} is not ok: ${upstreamResponse.status} err: ${error}`,
							{
								requestBody: Option.getOrUndefined(body),
								method: request.method,
								upstreamUrl: upstreamResponse.url,
							},
						),
					),
				);

			yield* Effect.logError(
				`Upstream response for route ${path} is not ok: ${upstreamResponse.status} body: ${upstreamResponseBody}`,
				{
					requestBody: Option.getOrUndefined(body),
					method: request.method,
					upstreamUrl: upstreamResponse.url,
				},
			);

			return yield* Effect.fail(
				new NotOkUpstreamResponseError({
					status: upstreamResponse.status,
					body: upstreamResponseBody,
					routePath: path,
				}),
			);
		}

		yield* Effect.logDebug("Received upstream response", {
			headers: upstreamResponse.headers,
		});

		const upstreamTextResponse = yield* httpClient
			.parseBodyAsText(upstreamResponse)
			.pipe(
				Effect.mapError(
					(error) =>
						new FailedToParseResponseBodyError({
							error: error.message,
							status: upstreamResponse.status,
						}),
				),
			);

		// Now we are going to handle jsonPath filtering if configured
		let responseData: string = upstreamTextResponse;

		if (route.jsonPath) {
			yield* Effect.logDebug(`Applying route JSONpath ${route.jsonPath}`);
			const data = yield* queryJson(
				upstreamTextResponse,
				route.jsonPath,
				route.useLegacyJsonPath,
			).pipe(
				Effect.mapError(
					(error) =>
						new QueryJsonError({
							error: error.message,
							type: "config",
							status: 500,
						}),
				),
			);
			responseData = JSON.stringify(data);
			yield* Effect.logDebug("Successfully applied route JSONpath");
		}

		// Now we are going to handle jsonPath filtering if configured in the request header (by the user)
		// We apply the JSON path to the data that's exposed by the data proxy.
		// This allows operators to specify what data is accessible while the data request program can specify what it wants from the accessible data.
		const jsonPathRequestHeader = Option.fromNullable(
			headers[JSON_PATH_HEADER_KEY],
		);

		if (Option.isSome(jsonPathRequestHeader)) {
			yield* Effect.logDebug(
				`Applying request JSONpath ${jsonPathRequestHeader.value}`,
			);

			const data = yield* queryJson(
				responseData,
				jsonPathRequestHeader.value,
				route.useLegacyJsonPath,
			).pipe(
				Effect.mapError(
					(error) =>
						new QueryJsonError({
							error: error.message,
							type: "header",
							// Fault is from the user side
							status: 400,
						}),
				),
			);

			responseData = JSON.stringify(data);
			yield* Effect.logDebug("Successfully applied request JSONpath");
		}

		// If the route or proxy has a public endpoint we replace the protocol and host with the public endpoint.
		const routeBaseUrl = maybeToOption(route.baseURL);
		const configBaseUrl = maybeToOption(config.baseURL);

		const calledEndpoint = Option.firstSomeOf([
			routeBaseUrl,
			configBaseUrl,
		]).pipe(
			Option.map((t) => {
				const pathIndex = request.url.indexOf(path);
				return `${t}${request.url.slice(pathIndex)}`;
			}),
			Option.getOrElse(() => request.url),
		);

		yield* Effect.logDebug("Signing data", {
			calledEndpoint,
			method: request.method,
			body: Option.getOrUndefined(body),
			responseData,
		});

		const signature = yield* dataProxy.signData(
			calledEndpoint,
			request.method,
			Buffer.from(
				Option.getOrElse(body, () => ""),
				"utf-8",
			),
			Buffer.from(responseData, "utf-8"),
		);

		const responseHeaders = new Headers();

		// Forward all headers that are configured in the config.json
		for (const forwardHeaderKey of route.forwardResponseHeaders) {
			const forwardHeaderValue = upstreamResponse.headers.get(forwardHeaderKey);

			if (forwardHeaderValue) {
				responseHeaders.append(forwardHeaderKey, forwardHeaderValue);
			}
		}

		return new Response(responseData, {
			headers: createSignedResponseHeaders(signature, responseHeaders),
		});
	}).pipe(
		Effect.withSpan("handleProxyRequest"),
		Effect.catchTag("VerifyProofError", (error) =>
			Effect.gen(function* () {
				yield* Effect.logError(error);
				return createErrorResponse(error, 400);
			}),
		),
		Effect.catchTag("IneligibleProofError", (error) =>
			Effect.gen(function* () {
				yield* Effect.logError(error);
				return createErrorResponse(error, 401);
			}),
		),
		Effect.catchTag("UnknownError", (error) =>
			Effect.gen(function* () {
				yield* Effect.logError(error);
				return createErrorResponse(error, 500);
			}),
		),
		Effect.catchTag("FailedToParseTargetUrlError", (error) =>
			Effect.gen(function* () {
				yield* Effect.logError(error);
				return createErrorResponse(error, 500);
			}),
		),
		Effect.catchTag("UpstreamRequestFailedError", (error) =>
			Effect.gen(function* () {
				yield* Effect.logError(error);
				return createErrorResponse(error, 500);
			}),
		),
		Effect.catchTag("FailedToParseResponseBodyError", (error) =>
			Effect.gen(function* () {
				yield* Effect.logError(error);
				return createErrorResponse(error, 500);
			}),
		),
		Effect.catchTag("NotOkUpstreamResponseError", (error) =>
			Effect.gen(function* () {
				yield* Effect.logError(error);
				return createErrorResponse(error, error.status);
			}),
		),
		Effect.catchTag("QueryJsonError", (error) =>
			Effect.gen(function* () {
				yield* Effect.logError(error);
				return createErrorResponse(error, error.status ?? 500);
			}),
		),
		Effect.catchTag("FailedToHandleRequest", (error) =>
			Effect.gen(function* () {
				yield* Effect.logError(error);
				return createErrorResponse(error, error.status);
			}),
		),
	);
