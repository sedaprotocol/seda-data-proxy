/**
 * Quick smoke-test for the pyth-pro custom fetcher running on the local proxy.
 *
 * Mirrors the oracle program URL construction:
 *   let url = [proxy_config.proxy_url.deref(), "v1/", "latest_price"].concat();
 *   let url = [proxy_config.proxy_url.deref(), "v1/", "price"].concat();
 *
 * Config used (single wildcard route):
 *   { "path": "/pyth-pro/*", "upstreamUrl": "https://pyth-lazer.dourolabs.app/{*}", "fetcher": "pyth-pro" }
 *
 * Prerequisites:
 *   1. Start the proxy (from the repo root):
 *        bun run workspace/data-proxy/src/index.ts run \
 *          --config config.json \
 *          --disable-proof \
 *          --skip-registration-check \
 *          --port 3000
 *
 *   2. Run this script:
 *        bun run temp/script.ts
 */

// Simulates proxy_config.proxy_url — the base URL the oracle program holds.
const PROXY_URL = "http://localhost:3000/proxy/pyth-pro/";

// Oracle program builds the full URL by concatenating the endpoint segment.
function buildUrl(endpoint: "v1/latest_price" | "v1/price"): string {
	return [PROXY_URL, endpoint].join("");
}

// ---------------------------------------------------------------------------
// Shared request body fields
// ---------------------------------------------------------------------------
const SHARED_PARAMS = {
	priceFeedIds: [1], // confirmed valid: 1 = BTC/USD
	channel: "fixed_rate@200ms",
	formats: ["evm"], // valid values: evm | solana | leEcdsa | leUnsigned
	properties: ["price"], // valid values: price | bestBidPrice | bestAskPrice | publisherCount | exponent | confidence | ...
	jsonBinaryEncoding: "base64",
	parsed: true,
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function post(url: string, body: object): Promise<void> {
	console.log(`\n→ POST ${url}`);
	console.log("  body:", JSON.stringify(body, null, 2));

	const res = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

	const text = await res.text();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = text;
	}

	console.log(`  status: ${res.status}`);
	console.log("  response:", JSON.stringify(parsed, null, 2));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// 1. latest_price — oracle appends "v1/latest_price"
await post(buildUrl("v1/latest_price"), {
	...SHARED_PARAMS,
});

// 2. price — oracle appends "v1/price" + includes timestamp
// Timestamp must be whole-second precision in microseconds:
//   Math.floor(Date.now() / 1000) * 1_000_000
await post(buildUrl("v1/price"), {
	...SHARED_PARAMS,
	timestamp: (Math.floor(Date.now() / 1000) - 5 * 60) * 1_000_000, // 5 min ago
});

// 3. Error: /v1/price without timestamp → expect 400
await post(buildUrl("v1/price"), {
	...SHARED_PARAMS,
});

// 4. Error: missing priceFeedIds → expect 400
await post(buildUrl("v1/latest_price"), {
	channel: "fixed_rate@200ms",
	formats: ["evm"],
	properties: ["price"],
});
