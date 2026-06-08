import { beforeEach, describe, expect, it, mock } from "bun:test";
import { Duration, Effect, Fiber, LogLevel, Logger } from "effect";
import * as v from "valibot";
import {
	type PythLazerModuleConfig,
	PythLazerModuleRouteSchema,
} from "../../config/pyth-lazer-module-config";
import { HAS_PRICE_KEY } from "../../constants";
import { ModuleService } from "../module";

// Maps the symbols getSymbols is asked about to their numeric feed ids.
const SYMBOL_IDS: Record<string, number> = { "BTC/USD": 1, "ETH/USD": 2 };

const subscribeMock = mock(
	(_request: {
		priceFeedIds: number[];
		channel: string;
		subscriptionId: number;
	}) => {},
);
const unsubscribeMock = mock((_subscriptionId: number) => {});
const getSymbolsMock = mock(async ({ query }: { query: string }) =>
	query in SYMBOL_IDS
		? [{ symbol: query, pyth_lazer_id: SYMBOL_IDS[query] }]
		: [],
);

// The module registers a single message listener at startup; the test captures it
// to drive stream updates into the price cache.
let messageListener: ((event: unknown) => void) | undefined;
// The module passes onWebSocketPoolError into create; captured here to simulate a
// pool error that names a specific feed.
let poolErrorHandler: ((error: unknown) => void) | undefined;

mock.module("@pythnetwork/pyth-lazer-sdk", () => ({
	PythLazerClient: {
		create: async (config: {
			webSocketPoolConfig?: {
				onWebSocketPoolError?: (error: unknown) => void;
			};
		}) => {
			poolErrorHandler = config.webSocketPoolConfig?.onWebSocketPoolError;
			return {
				addMessageListener: (cb: (event: unknown) => void) => {
					messageListener = cb;
				},
				addAllConnectionsDownListener: () => {},
				subscribe: subscribeMock,
				unsubscribe: unsubscribeMock,
				getSymbols: getSymbolsMock,
			};
		},
	},
}));

// Imported after mock.module so the module under test binds to the mocked SDK.
const { PythLazerModuleService } = await import("./pyth-lazer");

beforeEach(() => {
	subscribeMock.mockClear();
	unsubscribeMock.mockClear();
	getSymbolsMock.mockClear();
	messageListener = undefined;
	poolErrorHandler = undefined;
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
	confidence: 12345,
	emaPrice: "9648000000000",
	emaConfidence: 6789,
	feedUpdateTimestamp: 1_700_000_000_000_000,
	fundingRate: 12,
	fundingRateInterval: 3600,
	fundingTimestamp: 1_700_000_000,
	marketSession: "regular",
	publisherCount: 7,
});

// Drives one streamUpdated frame per feed, each on the subscriptionId the module
// assigned for (feed, channel). Mirrors the SDK: a subscription covers one feed and
// emits its own frame, so the frame's subscriptionId is what routes it to a channel.
const driveFrame = (
	priceFeeds: (Record<string, unknown> & { priceFeedId: number })[],
	timestampUs = TIMESTAMP_US,
	channel = "real_time",
) => {
	if (!messageListener) {
		throw new Error("message listener was never registered");
	}
	for (const priceFeed of priceFeeds) {
		const subscription = subscribeMock.mock.calls.find(
			([req]) =>
				req?.channel === channel &&
				req?.priceFeedIds?.includes(priceFeed.priceFeedId),
		);
		if (!subscription) {
			throw new Error(
				`no subscription for feed ${priceFeed.priceFeedId} on ${channel}`,
			);
		}
		messageListener({
			type: "json",
			value: {
				type: "streamUpdated",
				subscriptionId: subscription[0].subscriptionId,
				parsed: { timestampUs, priceFeeds: [priceFeed] },
			},
		});
	}
};

// Polls until the subscribe daemon has issued a subscribe frame for each id on the
// given channel, proving the module marked them subscribed (so a driven frame lands).
const waitForSubscribe = (priceFeedIds: number[], channel = "real_time") =>
	Effect.gen(function* () {
		for (let attempt = 0; attempt < 100; attempt++) {
			const subscribed = priceFeedIds.every((id) =>
				subscribeMock.mock.calls.some(
					([req]) =>
						req?.channel === channel && req?.priceFeedIds?.includes(id),
				),
			);
			if (subscribed) return;
			yield* Effect.sleep(Duration.millis(5));
		}
		throw new Error(`subscribe never issued for ${priceFeedIds} on ${channel}`);
	});

// Polls until the fiber has parked (suspended on the price wait), so a pool error
// fired next has a registered waiter to reject rather than racing waiter creation.
const waitUntilSuspended = <A, E>(fiber: Fiber.RuntimeFiber<A, E>) =>
	Effect.gen(function* () {
		for (let attempt = 0; attempt < 100; attempt++) {
			const status = yield* Fiber.status(fiber);
			if (status._tag === "Suspended") return;
			yield* Effect.sleep(Duration.millis(5));
		}
		throw new Error("fiber never suspended");
	});

const latestPriceBody = (feeds: {
	priceFeedIds?: number[];
	priceFeedSymbols?: string[];
	channel?: string;
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
				priceFeeds: {
					priceFeedId: number;
					price: string;
					bestAskPrice: string;
					bestBidPrice: string;
					confidence: number;
					emaConfidence: number;
					emaPrice: string;
					exponent: number;
					feedUpdateTimestamp: number;
					fundingRate: number;
					fundingRateInterval: number;
					fundingTimestamp: number;
					marketSession: string;
					publisherCount: number;
				}[];
			};
		};
		expect(body.parsed.timestampUs).toBe(TIMESTAMP_US);
		expect(body.parsed.priceFeeds.map((f) => f.priceFeedId)).toEqual([1, 2]);
		expect(body.parsed.priceFeeds[0].price).toBe("111");
		expect(body.parsed.priceFeeds[0]).toMatchObject({
			bestAskPrice: "9651000000000",
			bestBidPrice: "9649000000000",
			confidence: 12345,
			emaConfidence: 6789,
			emaPrice: "9648000000000",
			exponent: -8,
			feedUpdateTimestamp: 1_700_000_000_000_000,
			fundingRate: 12,
			fundingRateInterval: 3600,
			fundingTimestamp: 1_700_000_000,
			marketSession: "regular",
			publisherCount: 7,
		});
		// The internal partial-response marker must never leak into the parsed shape.
		expect(JSON.stringify(body)).not.toContain(HAS_PRICE_KEY);
	});

	it("emits the full Pyth Pro compatibility field set with nulls for unavailable values", async () => {
		const response = await run(baseConfig, (svc) =>
			Effect.gen(function* () {
				yield* svc.start();
				yield* waitForSubscribe([1]);
				driveFrame([
					{
						priceFeedId: 1,
						price: "111",
						exponent: -8,
						feedUpdateTimestamp: 1_700_000_000_000_000,
					},
				]);
				return yield* svc.handleRequest(
					latestPriceRoute,
					{},
					new Request("http://proxy.local/v1/latest_price", { method: "POST" }),
					latestPriceBody({ priceFeedIds: [1] }),
				);
			}),
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			parsed: { priceFeeds: Record<string, unknown>[] };
		};
		expect(body.parsed.priceFeeds[0]).toEqual({
			priceFeedId: 1,
			exponent: -8,
			feedUpdateTimestamp: 1_700_000_000_000_000,
			bestAskPrice: null,
			bestBidPrice: null,
			confidence: null,
			emaConfidence: null,
			emaPrice: null,
			fundingRate: null,
			fundingRateInterval: null,
			fundingTimestamp: null,
			marketSession: null,
			price: "111",
			publisherCount: null,
		});
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
				yield* waitForSubscribe([1, 2]);
				driveFrame([feed(1, "111")], "100");
				// A later, higher-timestamp update on another feed must not bleed into
				// the requested feed's timestampUs.
				driveFrame([feed(2, "999")], "999");
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

	it("uses the configured channel for the path surface", async () => {
		const config = makeConfig({
			channel: "fixed_rate@50ms",
			priceFeedIds: [{ name: "BTC/USD", id: 1 }],
		});
		const response = await run(config, (svc) =>
			Effect.gen(function* () {
				yield* svc.start();
				yield* waitForSubscribe([1], "fixed_rate@50ms");
				driveFrame([feed(1, "111")], TIMESTAMP_US, "fixed_rate@50ms");
				return yield* svc.handleRequest(
					pathRoute,
					{ symbols: "1" },
					new Request("http://proxy.local/price/1", { method: "GET" }),
					"",
				);
			}),
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as { price: string }[];
		expect(body[0].price).toBe("111");
		// The path surface never subscribes on anything but the configured channel.
		expect(
			subscribeMock.mock.calls.every(
				([req]) => req.channel === "fixed_rate@50ms",
			),
		).toBe(true);
	});
});

describe("PythLazerModuleService channel differentiation", () => {
	it("subscribes to and serves the channel named in the request body", async () => {
		const response = await run(baseConfig, (svc) =>
			Effect.gen(function* () {
				yield* svc.start();
				// The requested channel is not seeded at startup, so the request itself
				// drives the subscription: fork it, wait for the subscribe, then feed it.
				const fiber = yield* Effect.fork(
					svc.handleRequest(
						latestPriceRoute,
						{},
						new Request("http://proxy.local/v1/latest_price", {
							method: "POST",
						}),
						latestPriceBody({
							priceFeedIds: [1],
							channel: "fixed_rate@200ms",
						}),
					),
				);
				yield* waitForSubscribe([1], "fixed_rate@200ms");
				driveFrame([feed(1, "200ms")], TIMESTAMP_US, "fixed_rate@200ms");
				return yield* Fiber.join(fiber);
			}),
		);

		expect(response.status).toBe(200);
		// The subscribe for the requested channel actually went out.
		expect(
			subscribeMock.mock.calls.find(
				([req]) =>
					req.channel === "fixed_rate@200ms" && req.priceFeedIds.includes(1),
			),
		).toBeDefined();
		const body = (await response.json()) as {
			parsed: { priceFeeds: { price: string }[] };
		};
		expect(body.parsed.priceFeeds[0].price).toBe("200ms");
	});

	it("does not serve a real_time price for a fixed_rate request", async () => {
		const response = await run(baseConfig, (svc) =>
			Effect.gen(function* () {
				yield* svc.start();
				// Seed the same feed on the default real_time channel first.
				yield* waitForSubscribe([1], "real_time");
				driveFrame([feed(1, "realtime")], TIMESTAMP_US, "real_time");

				// A fixed_rate request must ignore the real_time cache and wait for a
				// fixed_rate frame instead.
				const fiber = yield* Effect.fork(
					svc.handleRequest(
						latestPriceRoute,
						{},
						new Request("http://proxy.local/v1/latest_price", {
							method: "POST",
						}),
						latestPriceBody({
							priceFeedIds: [1],
							channel: "fixed_rate@200ms",
						}),
					),
				);
				yield* waitForSubscribe([1], "fixed_rate@200ms");
				driveFrame([feed(1, "fixedrate")], TIMESTAMP_US, "fixed_rate@200ms");
				return yield* Fiber.join(fiber);
			}),
		);

		const body = (await response.json()) as {
			parsed: { priceFeeds: { price: string }[] };
		};
		expect(body.parsed.priceFeeds[0].price).toBe("fixedrate");
	});

	it("falls back to the configured channel when the body omits one", async () => {
		const config = makeConfig({
			channel: "fixed_rate@1000ms",
			priceFeedIds: [{ name: "BTC/USD", id: 1 }],
		});
		const response = await run(config, (svc) =>
			Effect.gen(function* () {
				yield* svc.start();
				yield* waitForSubscribe([1], "fixed_rate@1000ms");
				driveFrame([feed(1, "111")], TIMESTAMP_US, "fixed_rate@1000ms");
				return yield* svc.handleRequest(
					latestPriceRoute,
					{},
					new Request("http://proxy.local/v1/latest_price", { method: "POST" }),
					JSON.stringify({ priceFeedIds: [1] }),
				);
			}),
		);

		expect(response.status).toBe(200);
		// No subscription leaked onto a different channel than the configured default.
		expect(
			subscribeMock.mock.calls.every(
				([req]) => req.channel === "fixed_rate@1000ms",
			),
		).toBe(true);
	});

	it("rejects a body with an invalid channel", async () => {
		const response = await run(baseConfig, (svc) =>
			svc.handleRequest(
				latestPriceRoute,
				{},
				new Request("http://proxy.local/v1/latest_price", { method: "POST" }),
				JSON.stringify({ priceFeedIds: [1], channel: "fixed_rate@9999ms" }),
			),
		);
		expect(response.status).toBe(400);
	});

	it("fails every channel a feed is subscribed on when a pool error names it", async () => {
		const responses = await run(baseConfig, (svc) =>
			Effect.gen(function* () {
				yield* svc.start();
				// Feed 1 is pending on two channels at once: real_time (seeded at
				// startup) and fixed_rate@200ms (driven by the second request). Neither
				// has a price, so both requests park on the price wait.
				const realTime = yield* Effect.fork(
					svc.handleRequest(
						latestPriceRoute,
						{},
						new Request("http://proxy.local/v1/latest_price", {
							method: "POST",
						}),
						latestPriceBody({ priceFeedIds: [1], channel: "real_time" }),
					),
				);
				const fixedRate = yield* Effect.fork(
					svc.handleRequest(
						latestPriceRoute,
						{},
						new Request("http://proxy.local/v1/latest_price", {
							method: "POST",
						}),
						latestPriceBody({ priceFeedIds: [1], channel: "fixed_rate@200ms" }),
					),
				);
				// Both (feed, channel) subscriptions exist (so the fan-out finds them)
				// and both requests have parked (so there is a waiter to reject).
				yield* waitForSubscribe([1], "real_time");
				yield* waitForSubscribe([1], "fixed_rate@200ms");
				yield* waitUntilSuspended(realTime);
				yield* waitUntilSuspended(fixedRate);

				if (!poolErrorHandler) {
					throw new Error("pool error handler was never registered");
				}
				poolErrorHandler("Feeds are not stable: 1");

				return {
					realTime: yield* Fiber.join(realTime),
					fixedRate: yield* Fiber.join(fixedRate),
				};
			}),
		);

		// Both channels' waiters are failed by the pool error, not by the wait timeout.
		for (const response of [responses.realTime, responses.fixedRate]) {
			expect(response.status).toBe(500);
			const body = await response.text();
			expect(body).toContain("Feeds are not stable: 1");
			expect(body).not.toContain("Timed out");
		}
	}, 10_000);
});
