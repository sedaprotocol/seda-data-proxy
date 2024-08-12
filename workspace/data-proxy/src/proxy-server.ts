import type { DataProxy } from "@seda-protocol/data-proxy-sdk";
import { Elysia } from "elysia";
import { Maybe } from "true-myth";
import { type Config, getHttpMethods } from "./config-parser";
import {
	DEFAULT_PROXY_ROUTE_GROUP,
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

						// Add the request search params (?one=two) to the upstream url
						const requestSearchParams = createUrlSearchParams(query);
						let proxyUrl = replaceParams(route.upstreamUrl, params);
						proxyUrl = injectSearchParamsInUrl(
							proxyUrl,
							requestSearchParams,
						).toString();

						const proxyHeaders = new Headers();

						// Redirect all headers given by the requester
						for (const [key, value] of Object.entries(headers)) {
							if (!value) {
								continue;
							}

							proxyHeaders.append(key, value);
						}

						// Inject all configured headers by the data proxy node configuration
						for (const [key, value] of Object.entries(route.headers)) {
							proxyHeaders.append(key, replaceParams(value, params));
						}

						// Required to make it work...
						proxyHeaders.delete("host");

						logger.debug(
							`${routeMethod} ${proxyGroup}${route.path} -> ${proxyUrl}`,
						);

						const proxyResponse = await tryAsync(async () =>
							fetch(proxyUrl, {
								method: routeMethod,
								headers: proxyHeaders,
								body: body as BodyInit,
							}),
						);

						if (proxyResponse.isErr) {
							return createErrorResponse(
								`Proxying URL ${route.path} failed: ${proxyResponse.error}`,
								500,
							);
						}

						const textResponse = await tryAsync(
							async () => await proxyResponse.value.text(),
						);

						if (textResponse.isErr) {
							return createErrorResponse(
								`Parsing ${route.path} response to JSON failed: ${textResponse.error}`,
								500,
							);
						}

						let responseData: string = textResponse.value;

						if (route.jsonPath) {
							const data = queryJson(textResponse.value, route.jsonPath);

							if (data.isErr) {
								return createErrorResponse(data.error, 500);
							}

							responseData = JSON.stringify(data.value);
						}

						const signature = dataProxy.signData(responseData);
						const responseHeaders = new Headers();

						// Forward all headers that are configured in the config.json
						for (const forwardHeaderKey of route.forwardRepsonseHeaders) {
							const forwardHeaderValue =
								proxyResponse.value.headers.get(forwardHeaderKey);

							if (forwardHeaderValue) {
								responseHeaders.append(forwardHeaderKey, forwardHeaderValue);
							}
						}

						return new Response(responseData, {
							headers: createSignedResponseHeaders(signature, responseHeaders),
						});
					},
				);
			}
		}

		return app;
	});

	server.listen(serverOptions.port);
	logger.info(
		`Proxy routes is at http://127.0.0.1:${serverOptions.port}/${proxyGroup === '' || proxyGroup.endsWith('/') ? `${proxyGroup}` : `${proxyGroup}/`}`,
	);
}
