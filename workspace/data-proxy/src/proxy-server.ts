import { randomUUID } from "node:crypto";
import { constants, type DataProxy } from "@seda-protocol/data-proxy-sdk";
import { tryAsync } from "@seda-protocol/utils";
import { Elysia } from "elysia";
import { Maybe } from "true-myth";
import { type Config, getHttpMethods } from "./config-parser";
import { DEFAULT_PROXY_ROUTE_GROUP, JSON_PATH_HEADER_KEY } from "./constants";
import logger from "./logger";
import { StatusContext, statusPlugin } from "./status-plugin";
import {
	createDefaultResponseHeaders,
	createSignedResponseHeaders,
} from "./utils/create-headers";
import { queryJson } from "./utils/query-json";
import { replaceParams } from "./utils/replace-params";
import { createUrlSearchParams } from "./utils/search-params";
import { injectSearchParamsInUrl } from "./utils/url";
import { verifyWithRetry } from "./utils/verify-with-retry";

function createErrorResponse(error: string, status: number) {
	return new Response(JSON.stringify({ data_proxy_error: error }), {
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
	const server = new Elysia()
		// Assign a unique ID to every request
		.derive(() => {
			return {
				requestId: randomUUID(),
			};
		})
		.onBeforeHandle(
			({
				requestId,
				headers,
				body,
				params,
				path,
				query,
				request: { method },
			}) => {
				logger.debug("Received request", {
					requestId,
					headers,
					body,
					params,
					path,
					query,
					method,
				});
			},
		)
		.onAfterResponse(({ requestId, response }) => {
			logger.debug("Responded to request", { requestId, response });
		});

	const statusContext = new StatusContext(dataProxy.publicKey.toString("hex"));
	server.use(statusPlugin(statusContext, dataProxy, config.statusEndpoints));

	const proxyGroup = config.routeGroup ?? DEFAULT_PROXY_ROUTE_GROUP;

	server.group(proxyGroup, (app) => {
		// Only update the status context in routes that are part of the proxy group
		app.onBeforeHandle(() => statusContext.incrementRequests());
		app.onAfterHandle(({ response }) => {
			if (response instanceof Response && !response.ok) {
				statusContext.incrementErrors();
			}
		});

		for (const route of config.routes) {
			app.route("OPTIONS", route.path, () => {
				const headers = new Headers({
					[constants.PUBLIC_KEY_HEADER_KEY]:
						dataProxy.publicKey.toString("hex"),
					[constants.SIGNATURE_VERSION_HEADER_KEY]: dataProxy.version,
				});
				return new Response(null, { headers });
			});

			// A route can have multiple methods attach to it
			const routeMethods = getHttpMethods(route.method);
			for (const routeMethod of routeMethods) {
				app.route(
					routeMethod,
					route.path,
					async ({
						headers,
						params,
						body,
						path,
						query,
						requestId,
						request,
					}) => {
						const requestLogger = logger.child({ requestId });

						// requestBody is now always a string because of the parse function in this route
						const requestBody = Maybe.of(body as string | undefined);

						// Verification with the SEDA chain that the overlay node is eligible
						if (!serverOptions.disableProof) {
							requestLogger.debug("Verifying proof");

							const proofHeader = Maybe.of(headers[constants.PROOF_HEADER_KEY]);
							const heightFromHeader = Number(
								headers[constants.HEIGHT_HEADER_KEY],
							);
							const eligibleHeight = Maybe.of(
								Number.isNaN(heightFromHeader) ? undefined : heightFromHeader,
							);

							requestLogger.debug(
								`Received proof for height ${eligibleHeight.mapOr(
									"unknown",
									(h) => h.toString(),
								)}`,
							);

							if (proofHeader.isNothing) {
								const message = `Header "${constants.PROOF_HEADER_KEY}" is not provided`;
								requestLogger.error(message);
								return createErrorResponse(message, 400);
							}

							const decodedProof = dataProxy.decodeProof(proofHeader.value);

							if (decodedProof.isErr) {
								const message = `Failed to decode proof: ${decodedProof.error}, make sure the proof is a base64 encoded string`;
								requestLogger.error(message);
								return createErrorResponse(message, 400);
							}

							const { drId } = decodedProof.value;
							requestLogger.debug(`Data Request Id: ${drId}`);

							const verification = await verifyWithRetry(
								requestLogger,
								dataProxy,
								proofHeader.value,
								eligibleHeight,
								config.verificationMaxRetries,
								() => config.verificationRetryDelay,
							);

							if (verification.isErr) {
								const message = `Failed to verify eligibility proof ${verification.error}`;
								requestLogger.error(message);
								return createErrorResponse(message, 401);
							}

							if (!verification.value.isValid) {
								const message = `Ineligible executor at height ${verification.value.currentHeight}: ${verification.value.status}`;
								requestLogger.error(message);
								return createErrorResponse(message, 401);
							}

							// Verification passed, we can proceed
						} else {
							requestLogger.debug("Skipping proof verification.");
						}

						// Add the request search params (?one=two) to the upstream url
						const requestSearchParams = createUrlSearchParams(
							query,
							route.allowedQueryParams,
						);
						let upstreamUrl = replaceParams(route.upstreamUrl, params);
						const upstreamUrlResult = injectSearchParamsInUrl(
							upstreamUrl,
							requestSearchParams,
						);

						if (upstreamUrlResult.isErr) {
							return createErrorResponse(upstreamUrlResult.error, 500);
						}
						upstreamUrl = upstreamUrlResult.value.toString();

						const upstreamHeaders = new Headers();

						// Redirect all headers given by the requester
						for (const [key, value] of Object.entries(headers)) {
							if (!value || key === constants.PROOF_HEADER_KEY) {
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

						requestLogger.debug(
							`${routeMethod} ${proxyGroup}${route.path} -> ${upstreamUrl}`,
							{ headers: upstreamHeaders, body, upstreamUrl },
						);

						const upstreamResponse = await tryAsync(async () =>
							fetch(upstreamUrl, {
								method: routeMethod,
								headers: upstreamHeaders,
								body: body as string,
							}),
						);

						if (upstreamResponse.isErr) {
							const message = `Proxying URL ${route.path} failed: ${upstreamResponse.error}`;
							requestLogger.error(message, { error: upstreamResponse.error });
							return createErrorResponse(message, 500);
						}

						requestLogger.debug("Received upstream response", {
							headers: upstreamResponse.value.headers,
						});

						const upstreamTextResponse = await tryAsync(
							async () => await upstreamResponse.value.text(),
						);

						if (upstreamTextResponse.isErr) {
							const message = `Reading ${route.path} response body failed: ${upstreamTextResponse.error}`;
							requestLogger.error(message, {
								error: upstreamTextResponse.error,
							});
							return createErrorResponse(message, 500);
						}

						let responseData: string = upstreamTextResponse.value;

						if (route.jsonPath) {
							requestLogger.debug(`Applying route JSONpath ${route.jsonPath}`);
							const data = queryJson(
								upstreamTextResponse.value,
								route.jsonPath,
							);

							if (data.isErr) {
								requestLogger.error(
									`Failed to apply route JSONpath: ${route.jsonPath}`,
									{ error: data.error },
								);
								return createErrorResponse(data.error, 500);
							}

							responseData = JSON.stringify(data.value);
							requestLogger.debug("Successfully applied route JSONpath");
						}

						const jsonPathRequestHeader = Maybe.of(
							headers[JSON_PATH_HEADER_KEY],
						);

						// TODO: Would be nice to only parse the JSON once
						if (jsonPathRequestHeader.isJust) {
							requestLogger.debug(
								`Applying request JSONpath ${jsonPathRequestHeader.value}`,
							);
							// We apply the JSON path to the data that's exposed by the data proxy.
							// This allows operators to specify what data is accessible while the data request program can specify what it wants from the accessible data.
							const data = queryJson(responseData, jsonPathRequestHeader.value);

							if (data.isErr) {
								requestLogger.error(
									`Failed to apply JSONpath: ${jsonPathRequestHeader.value}`,
									{ error: data.error },
								);
								return createErrorResponse(data.error, 400);
							}

							responseData = JSON.stringify(data.value);
							requestLogger.debug("Successfully applied request JSONpath");
						}

						// If the route or proxy has a public endpoint we replace the protocol and host with the public endpoint.
						const calledEndpoint = route.baseURL
							.or(config.baseURL)
							.mapOr(request.url, (t) => {
								const pathIndex = request.url.indexOf(path);
								return `${t}${request.url.slice(pathIndex)}`;
							});

						requestLogger.debug("Signing data", {
							calledEndpoint,
							method: request.method,
							body: requestBody.unwrapOr(undefined),
							responseData,
						});

						const signature = await dataProxy.signData(
							calledEndpoint,
							request.method,
							Buffer.from(requestBody.isJust ? requestBody.value : "", "utf-8"),
							Buffer.from(responseData, "utf-8"),
						);

						const responseHeaders = new Headers();

						// Forward all headers that are configured in the config.json
						for (const forwardHeaderKey of route.forwardResponseHeaders) {
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
							// TODO: forward the request body transparently.
							// https://github.com/sedaprotocol/seda-data-proxy/issues/12
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

	return server;
}
