import type { DataProxy } from "@seda-protocol/data-proxy-sdk";
import { Effect, Option } from "effect";
import type { Config } from "../../config/config-parser";
import { JSON_PATH_HEADER_KEY } from "../../constants";
import { QueryJsonError } from "../../errors";
import type { ModuleHandlers } from "../../modules/module";
import type { ProxyServerOptions } from "../../proxy-server";
import { createSignedResponseHeaders } from "../../utils/create-headers";
import { maybeToOption } from "../../utils/effect-utils";
import { queryJson } from "../../utils/query-json";
import { createErrorResponse } from "../create-error-response";
import { executeRoute } from "./execute-route";
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
	// Resolved module handlers keyed by module name, used by multi routes to
	// fan out to several modules in one request.
	moduleHandlers: ReadonlyMap<string, ModuleHandlers>;
};

export const handleProxyRequest = (inputParams: HandleProxyRequestParams) =>
	Effect.gen(function* () {
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
			moduleHandlers,
		} = inputParams;

		if (!serverOptions.disableProof) {
			yield* verifyProof({ headers, config, dataProxy });
		} else {
			yield* Effect.logDebug("Skipping proof verification.");
		}

		let { responseData, upstreamResponse } = yield* executeRoute({
			route,
			params,
			request,
			headers,
			body,
			moduleHandlers,
			routePath: path,
		});

		// Apply header-based JSON path if provided.
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
				Effect.annotateSpans("type", "request-header"),
				Effect.mapError(
					(error) =>
						new QueryJsonError({
							// Attach result of operator supplied JSON path, which should
							// limit the size of data returned to the user.
							error: error.message.concat(
								`for input ${JSON.stringify(responseData)}`,
							),
							data: error.data,
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
		Effect.tapError((error) =>
			Effect.gen(function* () {
				// We don't want to log errors for 4xx status codes
				if (
					error._tag === "NotOkUpstreamResponseError" &&
					error.status >= 400 &&
					error.status < 500
				) {
					return;
				}

				const { message, ...errorRest } = error as unknown as {
					message: string;
				} & Record<string, unknown>;

				yield* Effect.logError(error.message, {
					...errorRest,
					headers: inputParams.headers,
					params: inputParams.params,
					body: Option.getOrUndefined(inputParams.body),
					path: inputParams.path,
					method: inputParams.request.method,
					requestUrl: inputParams.request.url,
					requestBody: Option.getOrUndefined(inputParams.body),
				});
			}),
		),
		Effect.catchTags({
			VerifyProofError: (error) =>
				Effect.succeed(createErrorResponse(error, 400)),
			IneligibleProofError: (error) =>
				Effect.succeed(createErrorResponse(error, 401)),
			UnknownError: (error) => Effect.succeed(createErrorResponse(error, 500)),
			FailedToParseTargetUrlError: (error) =>
				Effect.succeed(createErrorResponse(error, 500)),
			UpstreamRequestFailedError: (error) =>
				Effect.succeed(createErrorResponse(error, 500)),
			FailedToParseResponseBodyError: (error) =>
				Effect.succeed(createErrorResponse(error, 500)),
			NotOkUpstreamResponseError: (error) =>
				Effect.succeed(createErrorResponse(error, error.status)),
			QueryJsonError: (error) =>
				Effect.succeed(createErrorResponse(error, error.status ?? 500)),
			FailedToHandleRequest: (error) =>
				Effect.succeed(createErrorResponse(error, error.status)),
		}),
	);
