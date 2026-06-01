import { beforeEach, describe, expect, it, mock } from "bun:test";
import { Duration, Effect, LogLevel, Logger } from "effect";
import * as v from "valibot";
import {
	type PythLazerModuleConfig,
	PythLazerModuleRouteSchema,
} from "../../config/pyth-lazer-module-config";
import { HAS_PRICE_KEY } from "../../constants";
import { ModuleService } from "../module";

// Maps the symbols getSymbols is asked about to their numeric feed ids.
const SYMBOL_IDS: Record<string, number> = { "BTC/USD": 1, "ETH/USD": 2 };

const subscribeMock = mock((_request: { priceFeedIds: number[] }) => {});
const unsubscribeMock = mock((_subscriptionId: number) => {});
const getSymbolsMock = mock(async ({ query }: { query: string }) =>
	query in SYMBOL_IDS
		? [{ symbol: query, pyth_lazer_id: SYMBOL_IDS[query] }]
		: [],
);

// The module registers a single message listener at startup; the test captures it
// to drive stream updates into the price cache.
let messageListener: ((event: unknown) => void) | undefined;

mock.module("@pythnetwork/pyth-lazer-sdk", () => ({
	PythLazerClient: {
		create: async () => ({
			addMessageListener: (cb: (event: unknown) => void) => {
				messageListener = cb;
			},
			addAllConnectionsDownListener: () => {},
			subscribe: subscribeMock,
			unsubscribe: unsubscribeMock,
			getSymbols: getSymbolsMock,
		}),
	},
}));

// Imported after mock.module so the module under test binds to the mocked SDK.
const { PythLazerModuleService } = await import("./pyth-lazer");

beforeEach(() => {
	subscribeMock.mockClear();
	unsubscribeMock.mockClear();
	getSymbolsMock.mockClear();
	messageListener = undefined;
});

const baseConfig: PythLazerModuleConfig = {
	name: "pyth",
	type: "pyth-lazer",
	priceFeedIds: [
		{ name: "BTC/USD", id: 1 },
		{ name: "ETH/USD", id: 2 },
	],
	channel: "real_time",
	maxFeedsPerRequest: 100,
	pythLazerApiKeyEnvKey: "PYTH_LAZER_API_KEY",
	pythLazerApiKey: "test-api-key",
	priceFeedsCleanupTtl: Duration.hours(1),
	priceFeedsCleanupInterval: Duration.seconds(30),
};

const makeConfig = (
	overrides: Partial<PythLazerModuleConfig>,
): PythLazerModuleConfig => ({ ...baseConfig, ...overrides });

const latestPriceRoute = v.parse(PythLazerModuleRouteSchema, {
	type: "pyth-lazer",
	moduleName: "pyth",
	path: "/v1/latest_price",
	method: ["POST"],
});

const pathRoute = v.parse(PythLazerModuleRouteSchema, {
	type: "pyth-lazer",
	moduleName: "pyth",
	path: "/price/:symbols",
	method: ["GET"],
	fetchFromModule: "{:symbols}",
});

const TIMESTAMP_US = "1700000000000000";

const feed = (priceFeedId: number, price = "9650000000000") => ({
	priceFeedId,
	price,
	exponent: -8,
	bestBidPrice: "9649000000000",
	bestAskPrice: "9651000000000",
	emaPrice: "9648000000000",
	feedUpdateTimestamp: 1_700_000_000_000_000,
	marketSession: "regular",
});

const driveFrame = (
	priceFeeds: ReturnType<typeof feed>[],
	timestampUs = TIMESTAMP_US,
) => {
	if (!messageListener) {
		throw new Error("message listener was never registered");
	}
	messageListener({
		type: "json",
		value: {
			type: "streamUpdated",
			parsed: { timestampUs, priceFeeds },
		},
	});
};

// Polls until the subscribe daemon has issued a subscribe frame for each id, proving
// the module marked them subscribed (so a driven frame will land in the cache).
const waitForSubscribe = (priceFeedIds: number[]) =>
	Effect.gen(function* () {
		for (let attempt = 0; attempt < 100; attempt++) {
			const subscribed = priceFeedIds.every((id) =>
				subscribeMock.mock.calls.some((call) =>
					call[0]?.priceFeedIds?.includes(id),
				),
			);
			if (subscribed) return;
			yield* Effect.sleep(Duration.millis(5));
		}
		throw new Error(`subscribe never issued for ${priceFeedIds}`);
	});

const latestPriceBody = (feeds: {
	priceFeedIds?: number[];
	priceFeedSymbols?: string[];
}) =>
	JSON.stringify({
		channel: "real_time",
		formats: [],
		jsonBinaryEncoding: "base64",
		parsed: true,
		properties: ["price", "exponent", "feedUpdateTimestamp"],
		...feeds,
	});

// Runs a program against a fresh module instance with logs silenced.
const run = <A, E>(
	config: PythLazerModuleConfig,
	program: (svc: typeof ModuleService.Service) => Effect.Effect<A, E, never>,
) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const svc = yield* ModuleService;
			return yield* program(svc);
		}).pipe(
			Effect.provide(PythLazerModuleService(config)),
			Logger.withMinimumLogLevel(LogLevel.None),
		),
	);

describe("PythLazerModuleService latest_price surface (POST body)", () => {
	it("returns the parsed shape keyed by request order for numeric ids", async () => {
		const response = await run(baseConfig, (svc) =>
			Effect.gen(function* () {
				yield* svc.start();
				yield* waitForSubscribe([1, 2]);
				driveFrame([feed(1, "111"), feed(2, "222")]);
				return yield* svc.handleRequest(
					latestPriceRoute,
					{},
					new Request("http://proxy.local/v1/latest_price", { method: "POST" }),
					latestPriceBody({ priceFeedIds: [1, 2] }),
				);
			}),
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			parsed: {
				timestampUs: string;
				priceFeeds: { priceFeedId: number; price: string }[];
			};
		};
		expect(body.parsed.timestampUs).toBe(TIMESTAMP_US);
		expect(body.parsed.priceFeeds.map((f) => f.priceFeedId)).toEqual([1, 2]);
		expect(body.parsed.priceFeeds[0].price).toBe("111");
		// The internal partial-response marker must never leak into the parsed shape.
		expect(JSON.stringify(body)).not.toContain(HAS_PRICE_KEY);
	});

	it("preserves request order even when it differs from subscription order", async () => {
		const response = await run(baseConfig, (svc) =>
			Effect.gen(function* () {
				yield* svc.start();
				yield* waitForSubscribe([1, 2]);
				driveFrame([feed(1, "111"), feed(2, "222")]);
				return yield* svc.handleRequest(
					latestPriceRoute,
					{},
					new Request("http://proxy.local/v1/latest_price", { method: "POST" }),
					latestPriceBody({ priceFeedIds: [2, 1] }),
				);
			}),
		);

		const body = (await response.json()) as {
			parsed: { priceFeeds: { priceFeedId: number }[] };
		};
		expect(body.parsed.priceFeeds.map((f) => f.priceFeedId)).toEqual([2, 1]);
	});

	it("derives timestampUs from requested feeds only", async () => {
		const response = await run(baseConfig, (svc) =>
			Effect.gen(function* () {
				yield* svc.start();
				yield* waitForSubscribe([1]);
				driveFrame([feed(1, "111")], "100");
				driveFrame([feed(999, "999")], "999");
				return yield* svc.handleRequest(
					latestPriceRoute,
					{},
					new Request("http://proxy.local/v1/latest_price", { method: "POST" }),
					latestPriceBody({ priceFeedIds: [1] }),
				);
			}),
		);

		const body = (await response.json()) as {
			parsed: { timestampUs: string };
		};
		expect(body.parsed.timestampUs).toBe("100");
	});

	it("resolves priceFeedSymbols through getSymbols", async () => {
		const response = await run(baseConfig, (svc) =>
			Effect.gen(function* () {
				yield* svc.start();
				yield* waitForSubscribe([1]);
				driveFrame([feed(1, "111")]);
				return yield* svc.handleRequest(
					latestPriceRoute,
					{},
					new Request("http://proxy.local/v1/latest_price", { method: "POST" }),
					latestPriceBody({ priceFeedSymbols: ["BTC/USD"] }),
				);
			}),
		);

		expect(response.status).toBe(200);
		expect(getSymbolsMock).toHaveBeenCalledWith({ query: "BTC/USD" });
		const body = (await response.json()) as {
			parsed: { priceFeeds: { priceFeedId: number }[] };
		};
		expect(body.parsed.priceFeeds.map((f) => f.priceFeedId)).toEqual([1]);
	});

	it("rejects a body with neither priceFeedIds nor priceFeedSymbols", async () => {
		const response = await run(baseConfig, (svc) =>
			svc.handleRequest(
				latestPriceRoute,
				{},
				new Request("http://proxy.local/v1/latest_price", { method: "POST" }),
				JSON.stringify({ channel: "real_time" }),
			),
		);
		expect(response.status).toBe(400);
	});

	it("rejects more feeds than maxFeedsPerRequest", async () => {
		const response = await run(makeConfig({ maxFeedsPerRequest: 2 }), (svc) =>
			svc.handleRequest(
				latestPriceRoute,
				{},
				new Request("http://proxy.local/v1/latest_price", { method: "POST" }),
				latestPriceBody({ priceFeedIds: [1, 2, 3] }),
			),
		);
		expect(response.status).toBe(400);
	});

	it("rejects a malformed JSON body", async () => {
		const response = await run(baseConfig, (svc) =>
			svc.handleRequest(
				latestPriceRoute,
				{},
				new Request("http://proxy.local/v1/latest_price", { method: "POST" }),
				"{ not json",
			),
		);
		expect(response.status).toBe(400);
	});

	it("rejects a body with incorrectly typed feed ids", async () => {
		const response = await run(baseConfig, (svc) =>
			svc.handleRequest(
				latestPriceRoute,
				{},
				new Request("http://proxy.local/v1/latest_price", { method: "POST" }),
				JSON.stringify({ priceFeedIds: ["1"] }),
			),
		);
		expect(response.status).toBe(400);
	});

	it("fails the whole request when a requested feed never produces a price", async () => {
		const response = await run(makeConfig({ priceFeedIds: [] }), (svc) =>
			svc.handleRequest(
				latestPriceRoute,
				{},
				new Request("http://proxy.local/v1/latest_price", { method: "POST" }),
				latestPriceBody({ priceFeedIds: [99] }),
			),
		);
		// All-or-fail: no partial array, the cache wait times out and surfaces an error.
		expect(response.status).toBeGreaterThanOrEqual(400);
	}, 10_000);
});

describe("PythLazerModuleService path surface (GET array)", () => {
	it("returns a per-feed array tagged with the price marker", async () => {
		const response = await run(baseConfig, (svc) =>
			Effect.gen(function* () {
				yield* svc.start();
				yield* waitForSubscribe([1]);
				driveFrame([feed(1, "111")]);
				return yield* svc.handleRequest(
					pathRoute,
					{ symbols: "1" },
					new Request("http://proxy.local/price/1", { method: "GET" }),
					"",
				);
			}),
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			priceFeedId: number;
			symbol: string;
			price: string;
			[HAS_PRICE_KEY]: boolean;
		}[];
		expect(Array.isArray(body)).toBe(true);
		expect(body[0].priceFeedId).toBe(1);
		expect(body[0].symbol).toBe("1");
		expect(body[0].price).toBe("111");
		expect(body[0][HAS_PRICE_KEY]).toBe(true);
	});
});
