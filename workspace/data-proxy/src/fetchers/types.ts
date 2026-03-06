export interface FetcherRequest {
	/** Resolved upstream URL after path/env variable substitution. Empty string when no upstreamUrl is configured. */
	url: string;
	method: string;
	/** Merged request headers with host removed and configured route headers applied. */
	headers: Record<string, string>;
	body?: string;
	/** Raw Elysia path params captured from the route pattern (e.g. { feedId: "BTC" }). */
	pathParams: Record<string, string>;
	/** Allowlist-filtered query params from the incoming request. */
	queryParams: URLSearchParams;
}

export interface FetcherResponse {
	status: number;
	body: string;
	/** Response headers — used by forwardResponseHeaders to selectively pass headers to the client. */
	headers: Record<string, string>;
}

export interface Fetcher {
	fetch(request: FetcherRequest): Promise<FetcherResponse>;
}
