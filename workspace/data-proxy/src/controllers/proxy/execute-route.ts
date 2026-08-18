import { Effect, Match, Option } from "effect";
import type { Config } from "../../config/config-parser";
import { HAS_PRICE_KEY } from "../../constants";
import {
	FailedToParseResponseBodyError,
	NotOkUpstreamResponseError,
	QueryJsonError,
} from "../../errors";
import type { ModuleHandlers } from "../../modules/module";
import { HttpClientService } from "../../services/http-client";
import { queryJson } from "../../utils/query-json";
import { replaceParams } from "../../utils/replace-params";
import { createUrlSearchParams } from "../../utils/search-params";
import { handleMultiRequest } from "./handle-multi-request";
import { handleUpstreamRequest } from "./handle-upstream-request";

export type ExecuteRouteParams = {
	route: Config["routes"][number];
	params: Record<string, string>;
	request: Request;
	headers: Record<string, string | undefined>;
	body: Option.Option<string>;
	moduleHandlers: ReadonlyMap<string, ModuleHandlers>;
	routePath: string;
};

export type ExecuteRouteResult = {
	responseData: string;
	upstreamResponse: Response;
};

// Runs a configured route (module, upstream, or legacy multi) through to a
// filtered response body — without proof verification or signing. Callers that
// need those wrap this and apply them once for the outer request.
export const executeRoute = ({
	route,
	params,
	request,
	headers,
	body,
	moduleHandlers,
	routePath,
}: ExecuteRouteParams) =>
	Effect.gen(function* () {
		const httpClient = yield* HttpClientService;

		const requestUrl = new URL(request.url);
		const requestSearchParams = createUrlSearchParams(
			requestUrl.searchParams,
			route.allowedQueryParams,
		);

		const upstreamResponse = yield* Match.value(route).pipe(
			// TODO(#162): To be deprecated
			Match.when({ type: "multi" }, (multiModuleRoute) =>
				Effect.gen(function* () {
					yield* Effect.logDebug("Handling legacy multi request");
					return yield* handleMultiRequest(
						multiModuleRoute,
						params,
						request,
						moduleHandlers,
					);
				}),
			),
			Match.when({ type: "upstream" }, (upstreamRoute) =>
				handleUpstreamRequest({
					route: upstreamRoute,
					params,
					headers,
					body,
					request,
					routePath,
					requestSearchParams,
				}),
			),
			Match.orElse((moduleRoute) =>
				Effect.gen(function* () {
					const handlers = moduleHandlers.get(moduleRoute.moduleName);
					if (!handlers) {
						return yield* Effect.fail(
							new NotOkUpstreamResponseError({
								status: 500,
								body: `Module ${moduleRoute.moduleName} not found`,
								routePath,
							}),
						);
					}

					yield* Effect.logDebug(`Handling ${moduleRoute.type} request`);

					return yield* handlers.handleRequest(
						moduleRoute,
						params,
						request,
						Option.getOrUndefined(body),
					);
				}),
			),
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
					Effect.tapError((error) =>
						Effect.logError(
							`Upstream response body parsing failed with status: ${upstreamResponse.status} err: ${error}`,
							{
								routePath,
								method: request.method,
								clientRequestUrl: request.url,
								upstreamResponseUrl: upstreamResponse.url,
								routeParams: params,
								requestBody: Option.getOrUndefined(body),
							},
						),
					),
				);

			yield* Effect.logError(
				`Upstream response for route ${routePath} is not ok: ${upstreamResponse.status} body: ${upstreamResponseBody}`,
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
					routePath,
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

		let responseData: string = upstreamTextResponse;

		// TEMP: This is added for older ops who may not handle __sedaHasPrice key in the response.
		// we should remove this once all ops have updated to the new response format.
		// Multi routes return arbitrary per-source payloads where a per-source miss
		// is expected, so the price gate does not apply.
		if (route.type !== "multi" && !requestSearchParams.has("skipPriceErrors")) {
			if (upstreamTextResponse.includes(`"${HAS_PRICE_KEY}":false`)) {
				return yield* Effect.fail(
					new NotOkUpstreamResponseError({
						status: 500,
						body: `Not all symbols have a price: ${upstreamTextResponse}`,
						routePath,
					}),
				);
			}
		}

		if (route.jsonPath) {
			const jsonPath = replaceParams(route.jsonPath, params);
			yield* Effect.logDebug(`Applying route JSONpath ${jsonPath}`);
			const data = yield* queryJson(
				upstreamTextResponse,
				jsonPath,
				route.useLegacyJsonPath,
			).pipe(
				Effect.annotateSpans("type", "route-config"),
				Effect.mapError(
					(error) =>
						new QueryJsonError({
							error: error.message,
							data: error.data,
							type: "config",
							status: 500,
						}),
				),
			);
			responseData = JSON.stringify(data);
			yield* Effect.logDebug("Successfully applied route JSONpath");
		}

		return {
			responseData,
			upstreamResponse,
		} satisfies ExecuteRouteResult;
	});
