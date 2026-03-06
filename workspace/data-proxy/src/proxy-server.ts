import { randomUUID } from "node:crypto";
import { constants, type DataProxy } from "@seda-protocol/data-proxy-sdk";
import { tryAsync } from "@seda-protocol/utils";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import { Elysia, type HTTPMethod } from "elysia";
import { Maybe } from "true-myth";
import { type Config, type Route, getHttpMethods } from "./config-parser";
import { DEFAULT_PROXY_ROUTE_GROUP, JSON_PATH_HEADER_KEY } from "./constants";
import { getFetcher } from "./fetchers";
import { defaultFetcher } from "./fetchers/default-fetcher";
import logger from "./logger";
import { headersToRecord } from "./utils/headers";
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

type ApplyJsonPathResult =
	| { ok: true; data: string; parsedData: unknown }
	| { ok: false; response: Response };

function applyJsonPath(
	responseData: string | object,
	expression: string,
	label: string,
	errorStatus: number,
	requestLogger: typeof logger,
): ApplyJsonPathResult {
	requestLogger.debug(`Applying ${label} JSONpath ${expression}`);
	const result = queryJson(responseData, expression);

	if (result.isErr) {
		requestLogger.error(`Failed to apply ${label} JSONpath: ${expression}`, {
			error: result.error,
		});
		return {
			ok: false,
			response: createErrorResponse(result.error, errorStatus),
		};
	}

	requestLogger.debug(`Successfully applied ${label} JSONpath`);
	return {
		ok: true,
		data: JSON.stringify(result.value),
		parsedData: result.value,
	};
}

export interface ProxyServerOptions {
	port: number;
	disableProof: boolean;
}

interface RouteHandlerContext {
	headers: Record<string, string | undefined>;
	params: Record<string, string>;
	body: unknown;
	path: string;
	requestId: string;
	request: Request;
}

async function handleProxyRequest(
	ctx: RouteHandlerContext,
	route: Route,
	routeMethod: HTTPMethod,
	proxyGroup: string,
	config: Config,
	dataProxy: DataProxy,
	serverOptions: ProxyServerOptions,
): Promise<Response> {
	const { headers, params, body, path, requestId, request } = ctx;
	const requestLogger = logger.child({ requestId, path });

	// requestBody is now always a string because of the parse function in this route
	const requestBody = Maybe.of(body as string | undefined);

	// Verification with the SEDA chain that the overlay node is eligible
	if (!serverOptions.disableProof) {
		requestLogger.debug("Verifying proof");

		const proofHeader = Option.fromNullable(
			headers[constants.PROOF_HEADER_KEY],
		);
		const sedaFastProofHeader = Option.fromNullable(
			headers[constants.SEDA_FAST_PROOF_HEADER_KEY],
		);

		const heightFromHeader = Number(headers[constants.HEIGHT_HEADER_KEY]);
		const eligibleHeight = Maybe.of(
			Number.isNaN(heightFromHeader) ? undefined : BigInt(heightFromHeader),
		);

		requestLogger.debug(
			`Received proof for height ${eligibleHeight.mapOr("unknown", (h) =>
				h.toString(),
			)}`,
		);

		if (Option.isNone(proofHeader) && Option.isNone(sedaFastProofHeader)) {
			const message = `Header "${constants.PROOF_HEADER_KEY}" or "${constants.SEDA_FAST_PROOF_HEADER_KEY}" is not provided`;
			requestLogger.error(message);
			return createErrorResponse(message, 400);
		}

		// Disallow SEDA Fast usage if it's not enabled
		if (!config.sedaFast?.enable && Option.isSome(sedaFastProofHeader)) {
			const message = `Header "${constants.SEDA_FAST_PROOF_HEADER_KEY}" is not allowed`;
			requestLogger.error(message);
			return createErrorResponse(message, 400);
		}

		const proofInfo = Match.value(proofHeader).pipe(
			Match.when(Option.isSome, (header) => {
				return {
					decodedProof: dataProxy.decodeProof(header.value),
					rawProof: header.value,
					type: "seda-core" as const,
				};
			}),
			Match.when(Option.isNone, () => {
				// Should not throw since we checked for both headers above
				return {
					decodedProof: dataProxy.decodeSedaFastProof(
						Option.getOrThrow(sedaFastProofHeader),
					),
					rawProof: Option.getOrThrow(sedaFastProofHeader),
					type: "seda-fast" as const,
				};
			}),
			Match.exhaustive,
		);

		if (proofInfo.decodedProof.isErr) {
			const message = `Failed to decode proof: ${proofInfo.decodedProof.error}, make sure the proof is a base64 encoded string`;
			requestLogger.error(message);
			return createErrorResponse(message, 400);
		}

		const proofId =
			proofInfo.type === "seda-core"
				? proofInfo.decodedProof.value.drId
				: proofInfo.decodedProof.value.publicKey.toString("hex");

		const idType =
			proofInfo.type === "seda-core"
				? "Data Request Id"
				: "SEDA Fast Public Key";
		requestLogger.debug(`${idType}: ${proofId}`);

		const verificationResult = await Match.value(proofInfo).pipe(
			Match.when({ type: "seda-fast" }, async (proof) => {
				// Should not happen since we already checked for this above, but we need to satisfy the type checker
				if (proof.decodedProof.isErr) {
					throw new Error("Failed to decode proof");
				}

				return {
					verification: await dataProxy.verifyFastProof(
						proof.decodedProof.value,
					),
					type: "seda-fast" as const,
				};
			}),
			Match.when({ type: "seda-core" }, async (proof) => {
				return {
					verification: await verifyWithRetry(
						requestLogger,
						dataProxy,
						proof.rawProof,
						eligibleHeight,
						config.verificationMaxRetries,
						() => config.verificationRetryDelay,
					),
					type: "seda-core" as const,
				};
			}),
			Match.exhaustive,
		);

		if (verificationResult.verification.isErr) {
			const message = `Failed to verify eligibility proof ${verificationResult.verification.error}`;
			requestLogger.error(message);
			return createErrorResponse(message, 401);
		}

		if (!verificationResult.verification.value.isValid) {
			const heightOrTimestamp =
				verificationResult.type === "seda-core"
					? verificationResult.verification.value.currentHeight
					: verificationResult.verification.value.currentUnixTimestamp;
			const message = `Ineligible executor at height/timestamp ${heightOrTimestamp}: ${verificationResult.verification.value.status}`;
			requestLogger.error(message);
			return createErrorResponse(message, 401);
		}

		// Verification passed, we can proceed
	} else {
		requestLogger.debug("Skipping proof verification.");
	}

	// Parse the request URL to get the search params,
	// this is to support query params that can be repeated, such as ?one=one&one=two
	const requestUrl = new URL(request.url);

	// Add the request search params (?one=two) to the upstream url
	const requestSearchParams = createUrlSearchParams(
		requestUrl.searchParams,
		route.allowedQueryParams,
	);

	const upstreamHeaders = new Headers();

	// Redirect all headers given by the requester
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

	const resolvedUrlResult = injectSearchParamsInUrl(
		replaceParams(route.upstreamUrl, params),
		requestSearchParams,
	);
	if (resolvedUrlResult.isErr) {
		return createErrorResponse(resolvedUrlResult.error, 500);
	}
	const resolvedUrl = resolvedUrlResult.value.toString();

	let responseData: string;
	let upstreamResponseHeaders: Headers;

	// Use the configured custom fetcher, or fall back to the default HTTP fetcher
	const fetcherName = route.fetcher ?? "default";
	const fetcher = route.fetcher ? getFetcher(route.fetcher)! : defaultFetcher;

	requestLogger.debug(
		route.fetcher
			? `${routeMethod} ${proxyGroup}${route.path} -> fetcher:${fetcherName}`
			: `${routeMethod} ${proxyGroup}${route.path} -> ${resolvedUrl}`,
		{ headers: upstreamHeaders, body, resolvedUrl },
	);

	const fetcherResult = await tryAsync(async () =>
		fetcher.fetch({
			url: resolvedUrl,
			method: routeMethod,
			headers: headersToRecord(upstreamHeaders),
			body: body as string | undefined,
			pathParams: params,
			queryParams: requestSearchParams,
		}),
	);

	if (fetcherResult.isErr) {
		const message = `Fetcher "${fetcherName}" for ${route.path} failed: ${fetcherResult.error}`;
		requestLogger.error(message, { error: fetcherResult.error });
		return createErrorResponse(message, 500);
	}

	if (fetcherResult.value.status >= 400) {
		const message = `Fetcher "${fetcherName}" for ${route.path} returned status ${fetcherResult.value.status}: ${fetcherResult.value.body}`;
		requestLogger.error(message);
		return createErrorResponse(message, fetcherResult.value.status);
	}

	requestLogger.debug("Received fetcher response", {
		status: fetcherResult.value.status,
	});

	responseData = fetcherResult.value.body;
	upstreamResponseHeaders = new Headers(fetcherResult.value.headers);

	// jsonPathInput tracks the most recently parsed form of the response so that
	// sequential JSONPath applications don't re-parse the same JSON string.
	let jsonPathInput: string | object = responseData;

	if (route.jsonPath) {
		const jsonPathResult = applyJsonPath(
			jsonPathInput,
			replaceParams(route.jsonPath, params),
			"route",
			500,
			requestLogger,
		);
		if (!jsonPathResult.ok) return jsonPathResult.response;
		responseData = jsonPathResult.data;
		jsonPathInput = jsonPathResult.parsedData as object;
	}

	const jsonPathRequestHeader = Maybe.of(headers[JSON_PATH_HEADER_KEY]);

	// We apply the JSON path to the data that's exposed by the data proxy.
	// This allows operators to specify what data is accessible while the data request program can specify what it wants from the accessible data.
	if (jsonPathRequestHeader.isJust) {
		const jsonPathResult = applyJsonPath(
			jsonPathInput,
			jsonPathRequestHeader.value,
			"request",
			400,
			requestLogger,
		);
		if (!jsonPathResult.ok) return jsonPathResult.response;
		responseData = jsonPathResult.data;
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
		const forwardHeaderValue = upstreamResponseHeaders.get(forwardHeaderKey);
		if (forwardHeaderValue) {
			responseHeaders.append(forwardHeaderKey, forwardHeaderValue);
		}
	}

	return new Response(responseData, {
		headers: createSignedResponseHeaders(signature, responseHeaders),
	});
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
				logger.debug(`Received request ${method} ${path}`, {
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

	const statusContext = new StatusContext(
		dataProxy.publicKey.toString("hex"),
		config.sedaFast,
	);
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
					(ctx) =>
						handleProxyRequest(
							ctx,
							route,
							routeMethod,
							proxyGroup,
							config,
							dataProxy,
							serverOptions,
						),
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

	// Validate that every route referencing a custom fetcher has a registered implementation.
	for (const route of config.routes) {
		if (route.fetcher && !getFetcher(route.fetcher)) {
			throw new Error(
				`Route "${route.path}" references fetcher "${route.fetcher}", but no fetcher with that name is registered. Register it via registerFetcher() in workspace/data-proxy/src/fetchers/index.ts.`,
			);
		}
	}

	server.listen(serverOptions.port);
	logger.info(
		`Proxy routes is at http://127.0.0.1:${serverOptions.port}/${proxyGroup === "" || proxyGroup.endsWith("/") ? `${proxyGroup}` : `${proxyGroup}/`}`,
	);

	return server;
}
