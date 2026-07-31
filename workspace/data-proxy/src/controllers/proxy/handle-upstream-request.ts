import { constants } from "@seda-protocol/data-proxy-sdk";
import { Effect, Option } from "effect";
import type { UpstreamModuleRoute } from "../../config/upstream-module-config";
import { UpstreamRequestFailedError } from "../../errors";
import { HttpClientService } from "../../services/http-client";
import { replaceParams } from "../../utils/replace-params";
import { injectSearchParamsInUrl } from "../../utils/url";

export type HandleUpstreamRequestParams = {
	route: UpstreamModuleRoute;
	params: Record<string, string>;
	headers: Record<string, string | undefined>;
	body: Option.Option<string>;
	request: Request;
	routePath: string;
	requestSearchParams: URLSearchParams;
};

// Builds the upstream URL/headers and fetches. Configured route headers win over
// forwarded request headers; `host` is dropped so the client accepts the proxy response.
export const handleUpstreamRequest = ({
	route,
	params,
	headers,
	body,
	request,
	routePath,
	requestSearchParams,
}: HandleUpstreamRequestParams) =>
	Effect.gen(function* () {
		yield* Effect.logDebug("Handling upstream request");
		const httpClient = yield* HttpClientService;
		const upstreamHeaders = new Headers();

		const url = replaceParams(route.upstreamUrl, params);

		const upstreamUrl = yield* injectSearchParamsInUrl(
			url,
			requestSearchParams,
		).pipe(Effect.map((parsedUrl) => parsedUrl.toString()));

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
			body: Option.getOrUndefined(body),
			upstreamUrl,
		});

		return yield* httpClient
			.request(upstreamUrl, {
				method: request.method,
				headers: upstreamHeaders,
				body: Option.getOrUndefined(body),
			})
			.pipe(
				Effect.tapError(() =>
					Effect.logError("Upstream HTTP request failed", {
						routePath,
						method: request.method,
						clientRequestUrl: request.url,
						upstreamRequestUrl: upstreamUrl,
						upstreamRequestHeaders: upstreamHeaders,
						routeParams: params,
						requestBody: Option.getOrUndefined(body),
					}),
				),
				Effect.mapError(
					(error) => new UpstreamRequestFailedError({ error, routePath }),
				),
			);
	});
