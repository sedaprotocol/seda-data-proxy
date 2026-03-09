import { headersToRecord } from "../utils/headers";
import type { Fetcher, FetcherRequest, FetcherResponse } from "./types";

export const defaultFetcher: Fetcher = {
	async fetch(request: FetcherRequest): Promise<FetcherResponse> {
		const response = await fetch(request.url, {
			method: request.method,
			headers: request.headers,
			body: request.body,
		});

		const body = await response.text();

		return {
			status: response.status,
			body,
			headers: headersToRecord(response.headers),
		};
	},
};
