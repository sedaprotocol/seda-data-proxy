import type { DataProxy } from "@seda-protocol/data-proxy-sdk";
import { Elysia } from "elysia";
import { Maybe } from "true-myth";
import { type Config, getHttpMethods } from "./config-parser";
import {
	DEFAULT_PROXY_ROUTE_GROUP,
	JSON_PATH_HEADER_KEY,
	PROOF_HEADER_KEY,
	SERVER_PORT,
} from "./constants";
import logger from "./logger";
import {
	createDefaultResponseHeaders,
	createSignedResponseHeaders,
} from "./utils/create-headers";
import { queryJson } from "./utils/query-json";
import { replaceParams } from "./utils/replace-params";
import { createUrlSearchParams } from "./utils/search-params";
import { tryAsync } from "./utils/try";
import { injectSearchParamsInUrl } from "./utils/url";

function createErrorResponse(error: string, status: number) {
	return new Response(JSON.stringify({ error }), {
		status,
		headers: createDefaultResponseHeaders(),
	});
}

export interface ProxyServerOptions {
	port: number;
	disableProof: boolean;
}

export function startProxyServer(
	config: Config,
	dataProxy: DataProxy,
	serverOptions: ProxyServerOptions,
) {
	const server = new Elysia();
	const proxyGroup = config.routeGroup ?? DEFAULT_PROXY_ROUTE_GROUP;

	server.group(proxyGroup, (app) => {
		for (const route of config.routes) {
			const routeMethods = getHttpMethods(route.method);

			// A route can have multiple methods attach to it
			for (const routeMethod of routeMethods) {
				app.route(
					routeMethod,
					route.path,
					async ({ headers, params, body, query }) => {
						// Verification with the SEDA chain that the overlay node is eligible
						if (!serverOptions.disableProof) {
							const proofHeader = Maybe.of(headers[PROOF_HEADER_KEY]);

							if (proofHeader.isNothing) {
								return createErrorResponse(
									`Header "${PROOF_HEADER_KEY}" is not provided`,
									400,
								);
							}

							const verification = await dataProxy.verify(proofHeader.value);

							if (verification.isErr) {
								return createErrorResponse(
									`Invalid proof: ${verification.error}`,
									401,
								);
							}
						}

						// Add the request search params (?one=two) to the upstream url
						const requestSearchParams = createUrlSearchParams(query);
						let upstreamUrl = replaceParams(route.upstreamUrl, params);
						upstreamUrl = injectSearchParamsInUrl(
							upstreamUrl,
							requestSearchParams,
						).toString();

						const upstreamHeaders = new Headers();

						// Redirect all headers given by the requester
						for (const [key, value] of Object.entries(headers)) {
							if (!value) {
								continue;
							}

							upstreamHeaders.append(key, value);
						}

						// Inject all configured headers by the data proxy node configuration
						for (const [key, value] of Object.entries(route.headers)) {
							upstreamHeaders.append(key, replaceParams(value, params));
						}

						// Host doesn't match since we are proxying. Returning the upstream host while the URL does not match results
						// in the client to not return the response.
						upstreamHeaders.delete("host");

						logger.debug(
							`${routeMethod} ${proxyGroup}${route.path} -> ${upstreamUrl}`,
						);

						const upstreamResponse = await tryAsync(async () =>
							fetch(upstreamUrl, {
								method: routeMethod,
								headers: upstreamHeaders,
								body: body as BodyInit,
							}),
						);

						if (upstreamResponse.isErr) {
							return createErrorResponse(
								`Proxying URL ${route.path} failed: ${upstreamResponse.error}`,
								500,
							);
						}

						const upstreamTextResponse = await tryAsync(
							async () => await upstreamResponse.value.text(),
						);

						if (upstreamTextResponse.isErr) {
							return createErrorResponse(
								`Parsing ${route.path} response to JSON failed: ${upstreamTextResponse.error}`,
								500,
							);
						}

						let responseData: string = upstreamTextResponse.value;

						if (route.jsonPath) {
							const data = queryJson(
								upstreamTextResponse.value,
								route.jsonPath,
							);

							if (data.isErr) {
								return createErrorResponse(data.error, 500);
							}

							responseData = JSON.stringify(data.value);
						}

						const jsonPathRequestHeader = Maybe.of(
							headers[JSON_PATH_HEADER_KEY],
						);

						// TODO: Would be nice to only parse the JSON once
						if (jsonPathRequestHeader.isJust) {
							// We apply the JSON path to the data that's exposed by the data proxy.
							// This allows operators to specify what data is accessible while the data request program can specify what it wants from the accessible data.
							const data = queryJson(responseData, jsonPathRequestHeader.value);

							if (data.isErr) {
								return createErrorResponse(data.error, 400);
							}

							responseData = JSON.stringify(data.value);
						}

						const signature = dataProxy.signData(responseData);
						const responseHeaders = new Headers();

						// Forward all headers that are configured in the config.json
						for (const forwardHeaderKey of route.forwardRepsonseHeaders) {
							const forwardHeaderValue =
								upstreamResponse.value.headers.get(forwardHeaderKey);

							if (forwardHeaderValue) {
								responseHeaders.append(forwardHeaderKey, forwardHeaderValue);
							}
						}

						return new Response(responseData, {
							headers: createSignedResponseHeaders(signature, responseHeaders),
						});
					},
					{
						config: {},
						parse: ({ request }) => {
							return request.text();
						},
					},
				);
			}
		}

		return app;
	});

	server.listen(serverOptions.port);
	logger.info(
		`Proxy routes is at http://127.0.0.1:${serverOptions.port}/${proxyGroup === "" || proxyGroup.endsWith("/") ? `${proxyGroup}` : `${proxyGroup}/`}`,
	);
}
