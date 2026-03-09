import { defaultFetcher } from "./default-fetcher";
import { pythProFetcher } from "./pyth-pro";
import type { Fetcher } from "./types";

export type { Fetcher, FetcherRequest, FetcherResponse } from "./types";

const registry = new Map<string, Fetcher>();

export function registerFetcher(name: string, fetcher: Fetcher): void {
	registry.set(name, fetcher);
}

export function getFetcher(name: string): Fetcher | undefined {
	return registry.get(name);
}

export function getRegisteredFetcherNames(): string[] {
	return Array.from(registry.keys());
}

// Built-in fetchers — add new ones here
registerFetcher("default", defaultFetcher);
registerFetcher("pyth-pro", pythProFetcher);
