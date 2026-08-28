import type { DataProxy } from "@seda-protocol/data-proxy-sdk";
import { tryParseSync } from "@seda-protocol/utils";
import { Effect, Either, Option } from "effect";
import { type Config, getHttpMethods } from "../../config/config-parser";
import {
	type MultiEndpoint,
	type MultiEndpointRequestBody,
	MultiEndpointRequestBodySchema,
	type MultiEndpointSubRequest,
} from "../../config/multi-endpoint-config";
import type { ModuleHandlers } from "../../modules/module";
import type { ProxyServerOptions } from "../../proxy-server";
import { createSignedResponseHeaders } from "../../utils/create-headers";
import { maybeToOption } from "../../utils/effect-utils";
import { matchRoutePath } from "../../utils/match-route-path";
import { createErrorResponse } from "../create-error-response";
import { executeRoute } from "./execute-route";
import { verifyProof } from "./verify-proof";

export type HandleMultiEndpointRequestParams = {
	serverOptions: ProxyServerOptions;
	dataProxy: DataProxy;
	headers: Record<string, string | undefined>;
	body: Option.Option<string>;
	path: string;
	config: Config;
	request: Request;
	moduleHandlers: ReadonlyMap<string, ModuleHandlers>;
	routes: Readonly<Config["routes"]>;
	multiEndpoint: MultiEndpoint;
};

const createBadRequestResponse = (error: string) =>
	new Response(JSON.stringify({ error }), {
		status: 400,
		headers: { "Content-Type": "application/json" },
	});

const serializeRequestBody = (body: unknown): string | undefined => {
	if (body === undefined) {
		return undefined;
	}
	if (typeof body === "string") {
		return body;
	}
	return JSON.stringify(body);
};

const findMatchingRoute = (
	eligibleRoutes: Readonly<Config["routes"]>,
	path: string,
	method: string,
): {
	route: Config["routes"][number];
	params: Record<string, string>;
} | null => {
	const normalizedMethod = method.toUpperCase();

	for (const route of eligibleRoutes) {
		// Check if the route supports the requested method.
		const methods = getHttpMethods(route.method).map((m) => m.toUpperCase());
		if (!methods.includes(normalizedMethod as (typeof methods)[number])) {
			continue;
		}

		// Check if the route matches the requested path.
		const params = matchRoutePath(route.path, path);
		if (params !== null) {
			return { route, params };
		}
	}

	return null;
};

const buildSubRequest = (
	parent: Request,
	subRequest: MultiEndpointSubRequest,
	headers: Record<string, string>,
	body: string | undefined,
): Request => {
	const url = new URL(parent.url);
	// Sub-request paths are route paths (e.g. /binance/BTC), not including the
	// outer multi endpoint path. Keep the parent origin; replace path + query.
	const pathname = subRequest.path.startsWith("/")
		? subRequest.path
		: `/${subRequest.path}`;
	url.pathname = pathname;
	url.search = "";

	if (subRequest.query) {
		for (const [key, value] of Object.entries(subRequest.query)) {
			if (Array.isArray(value)) {
				for (const valueEntry of value) {
					url.searchParams.append(key, valueEntry);
				}
			} else {
				url.searchParams.set(key, value);
			}
		}
	}

	const init: RequestInit = {
		method: subRequest.method.toUpperCase(),
		headers,
	};

	if (body !== undefined && init.method !== "GET" && init.method !== "HEAD") {
		init.body = body;
	}

	return new Request(url, init);
};

const runSubRequest = (
	subRequest: MultiEndpointSubRequest,
	params: HandleMultiEndpointRequestParams,
) =>
	Effect.gen(function* () {
		const method = subRequest.method.toUpperCase();
		const matched = findMatchingRoute(params.routes, subRequest.path, method);

		if (!matched) {
			return {
				error: `No configured route matches ${method} ${subRequest.path}`,
				status: 404,
			};
		}

		const bodyText = serializeRequestBody(subRequest.body);
		const requestHeaders = subRequest.headers;
		const request = buildSubRequest(
			params.request,
			subRequest,
			requestHeaders,
			bodyText,
		);

		const result = yield* Effect.either(
			executeRoute({
				route: matched.route,
				params: matched.params,
				request,
				headers: requestHeaders,
				body:
					bodyText !== undefined && method !== "GET" && method !== "HEAD"
						? Option.some(bodyText)
						: Option.none(),
				moduleHandlers: params.moduleHandlers,
				routePath: matched.route.path,
			}),
		);

		if (Either.isLeft(result)) {
			const error = result.left;
			const status =
				"status" in error && typeof error.status === "number"
					? error.status
					: 500;
			const body =
				"body" in error && typeof error.body === "string"
					? error.body
					: undefined;

			return {
				error: error.message,
				status,
				...(body !== undefined ? { body } : {}),
			};
		}

		try {
			return result.right.responseData.length > 0
				? JSON.parse(result.right.responseData)
				: null;
		} catch {
			return result.right.responseData;
		}
	});

export const handleMultiEndpointRequest = (
	inputParams: HandleMultiEndpointRequestParams,
) =>
	Effect.gen(function* () {
		const {
			serverOptions,
			headers,
			body,
			path,
			config,
			request,
			dataProxy,
			multiEndpoint,
		} = inputParams;

		if (!serverOptions.disableProof) {
			yield* verifyProof({ headers, config, dataProxy });
		} else {
			yield* Effect.logDebug("Skipping proof verification.");
		}

		const rawBody = Option.getOrElse(body, () => "");
		let parsedJson: unknown;
		try {
			parsedJson = rawBody.length > 0 ? JSON.parse(rawBody) : null;
		} catch {
			return createBadRequestResponse(
				"Multi endpoint request body must be valid JSON",
			);
		}

		const parsedBody = tryParseSync(MultiEndpointRequestBodySchema, parsedJson);
		if (parsedBody.isErr) {
			return createBadRequestResponse(
				parsedBody.error
					.map((err) => {
						const key = err.path?.reduce((p, segment) => {
							return p.concat(".", segment.key as string);
						}, "");
						return `${key}: ${err.message}`;
					})
					.join("; "),
			);
		}

		const multiBody: MultiEndpointRequestBody = parsedBody.value;
		const subRequestEntries = Object.entries(multiBody);

		if (subRequestEntries.length > multiEndpoint.maxSubRequests) {
			return createBadRequestResponse(
				`Request exceeds maxSubRequests (${multiEndpoint.maxSubRequests}): got ${subRequestEntries.length}`,
			);
		}

		// Run each sub-request concurrently; results align with
		// subRequestEntries order.
		const results = yield* Effect.forEach(
			subRequestEntries,
			([, subRequest]) => runSubRequest(subRequest, inputParams),
			{ concurrency: multiEndpoint.concurrency },
		);

		const combined = Object.fromEntries(
			subRequestEntries.map(([id], i) => [id, results[i]]),
		);

		const responseData = JSON.stringify(combined);

		const calledEndpoint = maybeToOption(config.baseURL).pipe(
			Option.map((t) => {
				const pathIndex = request.url.indexOf(path);
				return pathIndex >= 0
					? `${t}${request.url.slice(pathIndex)}`
					: `${t}${path}`;
			}),
			Option.getOrElse(() => request.url),
		);

		yield* Effect.logDebug("Signing multi endpoint data", {
			calledEndpoint,
			method: request.method,
			body: rawBody,
			responseData,
		});

		const signature = yield* dataProxy.signData(
			calledEndpoint,
			request.method,
			Buffer.from(rawBody, "utf-8"),
			Buffer.from(responseData, "utf-8"),
		);

		return new Response(responseData, {
			headers: createSignedResponseHeaders(signature),
		});
	}).pipe(
		Effect.withSpan("handleMultiEndpointRequest"),
		Effect.tapError((error) =>
			Effect.logError(error.message, {
				headers: inputParams.headers,
				body: Option.getOrUndefined(inputParams.body),
				path: inputParams.path,
				method: inputParams.request.method,
				requestUrl: inputParams.request.url,
			}),
		),
		// Per-sub-request failures are captured per-id above; only proof/signing
		// errors surface on the outer effect.
		Effect.catchTags({
			VerifyProofError: (error) =>
				Effect.succeed(createErrorResponse(error, 400)),
			IneligibleProofError: (error) =>
				Effect.succeed(createErrorResponse(error, 401)),
			UnknownError: (error) => Effect.succeed(createErrorResponse(error, 500)),
		}),
	);
