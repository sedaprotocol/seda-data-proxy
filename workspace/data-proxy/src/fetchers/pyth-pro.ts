import type {
	Channel,
	Format,
	JsonBinaryEncoding,
	PriceFeedProperty,
} from "@pythnetwork/pyth-lazer-sdk";
import { PythLazerClient } from "@pythnetwork/pyth-lazer-sdk";
import type { Fetcher, FetcherRequest, FetcherResponse } from "./types";

const clientCache = new Map<string, PythLazerClient>();

async function getOrCreateClient(
	priceServiceUrl: string,
	token: string,
): Promise<PythLazerClient> {
	const key = `${priceServiceUrl}|${token}`;
	if (!clientCache.has(key)) {
		clientCache.set(
			key,
			await PythLazerClient.create({ token, priceServiceUrl }),
		);
	}
	return clientCache.get(key) as PythLazerClient;
}

type PythProEndpoint = "latest_price" | "price";

interface PythProRequestBody {
	// Feed identifiers — at least one of these must be provided
	priceFeedIds?: number[];
	priceFeedSymbols?: string[];
	// Required when the URL endpoint is "price".
	// Must be whole-second precision in microseconds: Math.floor(Date.now() / 1000) * 1_000_000
	timestamp?: number;
	// SDK subscription params — passed through directly to the SDK
	channel: Channel;
	formats: Format[];
	properties: PriceFeedProperty[];
	jsonBinaryEncoding?: JsonBinaryEncoding;
	parsed?: boolean;
}

function resolveEndpoint(rawUrl: string): PythProEndpoint | null {
	let pathname: string;
	try {
		pathname = new URL(rawUrl).pathname;
	} catch {
		return null;
	}
	const last = pathname.split("/").filter(Boolean).pop();
	if (last === "latest_price" || last === "price") return last;
	return null;
}

/** Strips the trailing /v1/<endpoint> from a URL to get the Pyth Lazer service base URL. */
function resolveBaseUrl(rawUrl: string): string {
	try {
		const parsed = new URL(rawUrl);
		const v1Index = parsed.pathname.lastIndexOf("/v1/");
		const basePath =
			v1Index !== -1 ? parsed.pathname.substring(0, v1Index) : "";
		return `${parsed.origin}${basePath}`;
	} catch {
		return rawUrl;
	}
}

export const pythProFetcher: Fetcher = {
	async fetch(request: FetcherRequest): Promise<FetcherResponse> {
		const authHeader =
			request.headers.authorization ?? request.headers.Authorization;

		if (!authHeader) {
			return {
				status: 401,
				body: JSON.stringify({
					error:
						'Missing Authorization header. Set it in the route config: "headers": { "Authorization": "Bearer {$PYTH_LAZER_TOKEN}" }',
				}),
				headers: { "content-type": "application/json" },
			};
		}

		const token = authHeader.startsWith("Bearer ")
			? authHeader.slice("Bearer ".length)
			: authHeader;

		let parsedBody: PythProRequestBody;
		try {
			parsedBody = JSON.parse(request.body ?? "{}") as PythProRequestBody;
		} catch {
			return {
				status: 400,
				body: JSON.stringify({ error: "Request body must be valid JSON" }),
				headers: { "content-type": "application/json" },
			};
		}

		const {
			priceFeedIds,
			priceFeedSymbols,
			timestamp,
			channel,
			formats,
			properties,
			jsonBinaryEncoding,
			parsed,
		} = parsedBody;

		if (
			(!priceFeedIds || priceFeedIds.length === 0) &&
			(!priceFeedSymbols || priceFeedSymbols.length === 0)
		) {
			return {
				status: 400,
				body: JSON.stringify({
					error:
						"Request body must include at least one of: priceFeedIds, priceFeedSymbols",
				}),
				headers: { "content-type": "application/json" },
			};
		}

		if (!channel) {
			return {
				status: 400,
				body: JSON.stringify({
					error:
						'Request body must include "channel" (real_time | fixed_rate@50ms | fixed_rate@200ms | fixed_rate@1000ms)',
				}),
				headers: { "content-type": "application/json" },
			};
		}

		if (!properties || properties.length === 0) {
			return {
				status: 400,
				body: JSON.stringify({
					error: 'Request body must include "properties" array',
				}),
				headers: { "content-type": "application/json" },
			};
		}

		const endpoint = resolveEndpoint(request.url);

		if (!endpoint) {
			return {
				status: 400,
				body: JSON.stringify({
					error:
						'Upstream URL must end with either "/v1/latest_price" or "/v1/price"',
				}),
				headers: { "content-type": "application/json" },
			};
		}

		if (endpoint === "price" && timestamp === undefined) {
			return {
				status: 400,
				body: JSON.stringify({
					error:
						'The "/v1/price" endpoint requires "timestamp" (whole-second microseconds, e.g. Math.floor(Date.now() / 1000) * 1_000_000) in the request body',
				}),
				headers: { "content-type": "application/json" },
			};
		}

		const baseUrl = resolveBaseUrl(request.url);
		const client = await getOrCreateClient(baseUrl, token);

		const sdkParams = {
			...(priceFeedIds && priceFeedIds.length > 0 ? { priceFeedIds } : {}),
			...(priceFeedSymbols && priceFeedSymbols.length > 0
				? { symbols: priceFeedSymbols }
				: {}),
			channel,
			formats: formats ?? [],
			properties,
			...(jsonBinaryEncoding !== undefined ? { jsonBinaryEncoding } : {}),
			...(parsed !== undefined ? { parsed } : {}),
		};
		// timestamp is guaranteed defined here — we return 400 above if endpoint === "price" && timestamp === undefined
		const result =
			endpoint === "price" && timestamp !== undefined
				? await client.getPrice({ ...sdkParams, timestamp })
				: await client.getLatestPrice(sdkParams);

		return {
			status: 200,
			body: JSON.stringify(result),
			headers: { "content-type": "application/json" },
		};
	},
};
