import { Duration, Effect, Redacted } from "effect";
import type { VolmexModuleConfig } from "../../config/volmex-module-config";
import { replaceParams } from "../../utils/replace-params";
import { createUrlSearchParams } from "../../utils/search-params";
import { injectSearchParamsInUrl } from "../../utils/url";
import { FailedToHandleVolmexRequestError } from "./errors";

export type VolmexRestProxyDeps = {
	config: Pick<
		VolmexModuleConfig,
		"volmexApiKey" | "restFetchTimeout" | "restBaseUrl"
	>;
	/** Upstream path relative to `config.restBaseUrl`. Supports `{:param}` templates. */
	upstreamPathTemplate: string;
	params: Record<string, string>;
	request: Request;
	allowedQueryParams?: string[];
};

const joinRestBaseUrl = (baseUrl: string, path: string): string => {
	const base = baseUrl.replace(/\/$/, "");
	const normalizedPath = path.replace(/^\//, "");
	return `${base}/${normalizedPath}`;
};

/**
 * Proxies a GET (or inbound method) to a Volmex REST API URL, attaching the module JWT.
 * Forwards allowed query params from the inbound request onto the upstream URL.
 * `upstreamPathTemplate` comes from the route's `upstreamPath` (supports `{:param}`).
 */
export const proxyVolmexRestRequest = (
	deps: VolmexRestProxyDeps,
): Effect.Effect<Response, FailedToHandleVolmexRequestError> =>
	Effect.gen(function* () {
		const {
			config,
			upstreamPathTemplate,
			params,
			request,
			allowedQueryParams,
		} = deps;
		const timeoutMs = Duration.toMillis(config.restFetchTimeout);

		const pathWithParams = replaceParams(upstreamPathTemplate, params);
		const urlWithParams = joinRestBaseUrl(config.restBaseUrl, pathWithParams);
		const requestSearchParams = createUrlSearchParams(
			new URL(request.url).searchParams,
			allowedQueryParams,
		);

		const upstreamUrl = yield* injectSearchParamsInUrl(
			urlWithParams,
			requestSearchParams,
		).pipe(
			Effect.mapError(
				(error) =>
					new FailedToHandleVolmexRequestError({
						error: `Invalid Volmex upstream URL: ${error.message}`,
						status: 400,
					}),
			),
		);

		yield* Effect.logDebug("Making Volmex REST request", {
			url: upstreamUrl.toString(),
			method: request.method,
		});

		const response = yield* Effect.tryPromise({
			try: () =>
				fetch(upstreamUrl, {
					method: request.method,
					headers: {
						Authorization: `Bearer ${Redacted.value(config.volmexApiKey)}`,
						Accept: "application/json",
					},
					signal: AbortSignal.timeout(timeoutMs),
				}),
			catch: (error) => {
				const isTimeout =
					error instanceof Error && error.name === "TimeoutError";
				return new FailedToHandleVolmexRequestError({
					error: isTimeout
						? `Volmex REST timed out after ${timeoutMs}ms`
						: `Failed to fetch from Volmex REST: ${error}`,
					status: isTimeout ? 504 : 502,
				});
			},
		});

		const responseBody = yield* Effect.tryPromise({
			try: () => response.text(),
			catch: (error) =>
				new FailedToHandleVolmexRequestError({
					error: `Failed to read Volmex REST response: ${error}`,
					status: 500,
				}),
		});

		if (!response.ok) {
			yield* Effect.logError("Volmex REST request failed", {
				status: response.status,
				body: responseBody,
				url: upstreamUrl.toString(),
			});
		}

		const upstreamContentType =
			response.headers.get("content-type") ?? "application/json";

		return new Response(responseBody, {
			status: response.status,
			headers: { "Content-Type": upstreamContentType },
		});
	}).pipe(Effect.withSpan("proxyVolmexRestRequest"));
