import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	Duration,
	Effect,
	Fiber,
	LogLevel,
	Logger,
	Option,
	Schedule,
	TestClock,
	TestContext,
} from "effect";
import type {
	AssetCtx,
	BookSnapshot,
	HydromancerModuleConfig,
} from "../../config/hydromancer-module-config";
import { createFreshnessCache } from "../shared/freshness-cache";
import { createPriceCache } from "../shared/price-cache";
import {
	buildSubscribeFrame,
	buildUnsubscribeFrame,
	createHydromancerWS,
	parseInboundFrame,
} from "./ws-client";

const validCtx = {
	oraclePx: "1",
	markPx: "2",
	midPx: "3",
	impactPxs: ["4", "5"],
	openInterest: "6",
};

describe("buildSubscribeFrame / buildUnsubscribeFrame", () => {
	it("produces the documented activeAssetCtx subscribe shape", () => {
		expect(JSON.parse(buildSubscribeFrame("activeAssetCtx", "BTC"))).toEqual({
			method: "subscribe",
			subscription: { type: "activeAssetCtx", coin: "BTC" },
		});
	});

	it("produces the documented activeAssetCtx unsubscribe shape", () => {
		expect(JSON.parse(buildUnsubscribeFrame("activeAssetCtx", "ETH"))).toEqual({
			method: "unsubscribe",
			subscription: { type: "activeAssetCtx", coin: "ETH" },
		});
	});

	it("produces the documented l2Book subscribe shape", () => {
		expect(JSON.parse(buildSubscribeFrame("l2Book", "BTC"))).toEqual({
			method: "subscribe",
			subscription: { type: "l2Book", coin: "BTC" },
		});
	});
});

describe("parseInboundFrame", () => {
	it("extracts {coin, ctx} from a valid activeAssetCtx frame", () => {
		const frame = JSON.stringify({
			channel: "activeAssetCtx",
			seq: 1,
			cursor: "x",
			data: { coin: "ETH", ctx: validCtx },
		});
		expect(parseInboundFrame(frame)).toEqual({
			kind: "activeAssetCtx",
			coin: "ETH",
			ctx: validCtx,
		});
	});

	it("returns null for a non-activeAssetCtx channel", () => {
		expect(parseInboundFrame(JSON.stringify({ channel: "pong" }))).toBeNull();
	});

	it("returns null for malformed JSON", () => {
		expect(parseInboundFrame("not json")).toBeNull();
	});

	it("returns null when data is missing", () => {
		expect(
			parseInboundFrame(JSON.stringify({ channel: "activeAssetCtx" })),
		).toBeNull();
	});

	it("returns null when ctx fields have the wrong types", () => {
		expect(
			parseInboundFrame(
				JSON.stringify({
					channel: "activeAssetCtx",
					data: { coin: "BTC", ctx: { oraclePx: 123 } },
				}),
			),
		).toBeNull();
	});

	it("accepts null openInterest (testnet returns it)", () => {
		const ctxNullOI = { ...validCtx, openInterest: null };
		const frame = JSON.stringify({
			channel: "activeAssetCtx",
			data: { coin: "BTC", ctx: ctxNullOI },
		});
		expect(parseInboundFrame(frame)).toEqual({
			kind: "activeAssetCtx",
			coin: "BTC",
			ctx: ctxNullOI,
		});
	});

	it("accepts null midPx and impactPxs (some non-perp assets return them)", () => {
		const ctxPartial = {
			oraclePx: "151.81",
			markPx: "374.5",
			midPx: null,
			impactPxs: null,
			openInterest: null,
		};
		const frame = JSON.stringify({
			channel: "activeAssetCtx",
			data: { coin: "bmx:TSLA", ctx: ctxPartial },
		});
		expect(parseInboundFrame(frame)).toEqual({
			kind: "activeAssetCtx",
			coin: "bmx:TSLA",
			ctx: ctxPartial,
		});
	});

	it("extracts an l2Book snapshot from a valid l2Book frame", () => {
		const snapshot: BookSnapshot = {
			coin: "BTC",
			levels: [[{ px: "100", sz: "1", n: 1 }], [{ px: "101", sz: "2", n: 2 }]],
			time: 1700000000000,
		};
		const frame = JSON.stringify({ channel: "l2Book", data: snapshot });
		expect(parseInboundFrame(frame)).toEqual({ kind: "l2Book", snapshot });
	});

	it("returns null for an l2Book frame missing required fields", () => {
		const frame = JSON.stringify({
			channel: "l2Book",
			data: { coin: "BTC", levels: [[]] },
		});
		expect(parseInboundFrame(frame)).toBeNull();
	});
});

class FakeWebSocket extends EventTarget {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: FakeWebSocket[] = [];
	static sendImpl?: (instance: FakeWebSocket, data: string) => void;

	url: string;
	readyState = FakeWebSocket.CONNECTING;
	sent: string[] = [];

	constructor(url: string) {
		super();
		this.url = url;
		// Multiple test files overwrite globalThis.WebSocket, so a leftover
		// daemon from another file can hit this constructor on reconnect.
		// Only record this file's wsUrl so instance counts stay accurate.
		if (url.includes("wsclient.test")) {
			FakeWebSocket.instances.push(this);
		}
	}

	send(data: string): void {
		if (FakeWebSocket.sendImpl) {
			FakeWebSocket.sendImpl(this, data);
			return;
		}
		this.sent.push(data);
	}

	close(): void {
		if (this.readyState === FakeWebSocket.CLOSED) return;
		this.readyState = FakeWebSocket.CLOSED;
		this.dispatchEvent(new CloseEvent("close", { code: 1000, wasClean: true }));
	}

	triggerOpen(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.dispatchEvent(new Event("open"));
	}

	triggerMessage(data: string): void {
		this.dispatchEvent(new MessageEvent("message", { data }));
	}

	triggerClose(code = 1000, reason = "", wasClean = true): void {
		if (this.readyState === FakeWebSocket.CLOSED) return;
		this.readyState = FakeWebSocket.CLOSED;
		this.dispatchEvent(new CloseEvent("close", { code, reason, wasClean }));
	}

	triggerError(message = "socket error"): void {
		this.dispatchEvent(new ErrorEvent("error", { message }));
	}
}

const runWithTestClock = <A, E>(effect: Effect.Effect<A, E, never>) =>
	Effect.runPromise(
		effect.pipe(
			Effect.provide(TestContext.TestContext),
			Logger.withMinimumLogLevel(LogLevel.None),
		),
	);

const waitForInstances = (count: number, maxYields = 100) =>
	Effect.gen(function* () {
		for (let i = 0; i < maxYields; i++) {
			if (FakeWebSocket.instances.length >= count) {
				return FakeWebSocket.instances;
			}
			yield* Effect.yieldNow();
		}
		throw new Error(
			`Timed out waiting for ${count} WebSocket instances; saw ${FakeWebSocket.instances.length}`,
		);
	});

const baseConfig: HydromancerModuleConfig = {
	name: "hydromancer",
	type: "hydromancer",
	wsUrl: "wss://wsclient.test/ws",
	restBaseUrl: "https://api.hydromancer.test",
	hydromancerApiKeyEnvKey: "HYDROMANCER_API_KEY",
	hydromancerApiKey: "test-api-key",
	staleAfter: Duration.seconds(10),
	subscriptionCoins: ["BTC", "ETH"],
	maxCoinsPerRequest: 20,
	reconnectMaxBackoff: Duration.seconds(30),
	reconnectStableThreshold: Duration.seconds(30),
	coinsCleanupTtl: Duration.minutes(2),
	coinsCleanupInterval: Duration.seconds(30),
	restFetchTimeout: Duration.seconds(15),
	l2BookSubscriptionCoins: [],
	l2BookMaxCoinsPerRequest: 20,
	l2BookWaitTimeout: Duration.seconds(1),
	l2BookCleanupTtl: Duration.minutes(2),
	l2BookCleanupInterval: Duration.seconds(30),
};

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
	FakeWebSocket.instances = [];
	FakeWebSocket.sendImpl = undefined;
	globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
	globalThis.WebSocket = originalWebSocket;
});

const startService = (
	config: HydromancerModuleConfig,
	preSubscribed: string[] = config.subscriptionCoins,
	options?: Parameters<typeof createHydromancerWS>[3],
) =>
	Effect.gen(function* () {
		const cache = yield* createFreshnessCache<string, AssetCtx>();
		const bookCache = yield* createPriceCache<string, BookSnapshot>();
		const ws = yield* createHydromancerWS(
			config,
			cache,
			bookCache,
			options ?? { reconnectSchedule: Schedule.spaced(Duration.minutes(10)) },
		);
		for (const coin of preSubscribed) {
			yield* ws.subscribe("activeAssetCtx", coin);
		}
		const fiber = yield* ws.start();
		return { cache, bookCache, ws, fiber };
	});

describe("createHydromancerWS", () => {
	it("opens the WS with the token query and sends subscribe frames on open", async () => {
		await runWithTestClock(
			Effect.gen(function* () {
				const { fiber, ws: service } = yield* startService(baseConfig);
				yield* waitForInstances(1);

				expect(FakeWebSocket.instances.length).toBe(1);
				const ws = FakeWebSocket.instances[0];
				expect(ws.url).toBe("wss://wsclient.test/ws?token=test-api-key");

				ws.triggerOpen();
				yield* Effect.yieldNow();

				expect(ws.sent).toEqual([
					buildSubscribeFrame("activeAssetCtx", "BTC"),
					buildSubscribeFrame("activeAssetCtx", "ETH"),
				]);
				expect(yield* service.hasError()).toBe(false);

				yield* Fiber.interrupt(fiber);
			}),
		);
	});

	it("writes inbound frames for desired coins into the cache", async () => {
		await runWithTestClock(
			Effect.gen(function* () {
				const { cache, fiber } = yield* startService(baseConfig);
				yield* waitForInstances(1);
				const ws = FakeWebSocket.instances[0];
				ws.triggerOpen();

				ws.triggerMessage(
					JSON.stringify({
						channel: "activeAssetCtx",
						seq: 1,
						data: { coin: "BTC", ctx: validCtx },
					}),
				);

				const now = yield* TestClock.currentTimeMillis;
				const entry = cache.get("BTC", Number.MAX_SAFE_INTEGER, now);
				expect(Option.isSome(entry)).toBe(true);
				if (Option.isSome(entry)) {
					expect(entry.value).toEqual(validCtx);
				}

				yield* Fiber.interrupt(fiber);
			}),
		);
	});

	it("drops inbound frames for coins not in the desired set", async () => {
		await runWithTestClock(
			Effect.gen(function* () {
				const { cache, fiber } = yield* startService(baseConfig, ["BTC"]);
				yield* waitForInstances(1);
				const ws = FakeWebSocket.instances[0];
				ws.triggerOpen();

				ws.triggerMessage(
					JSON.stringify({
						channel: "activeAssetCtx",
						seq: 1,
						data: { coin: "ETH", ctx: validCtx },
					}),
				);

				const now = yield* TestClock.currentTimeMillis;
				expect(
					Option.isNone(cache.get("ETH", Number.MAX_SAFE_INTEGER, now)),
				).toBe(true);

				yield* Fiber.interrupt(fiber);
			}),
		);
	});

	it("routes l2Book frames to the book cache and leaves the asset cache untouched", async () => {
		await runWithTestClock(
			Effect.gen(function* () {
				const {
					cache,
					bookCache,
					ws: service,
					fiber,
				} = yield* startService(baseConfig, []);
				yield* waitForInstances(1);
				const ws = FakeWebSocket.instances[0];
				ws.triggerOpen();

				yield* service.subscribe("l2Book", "BTC");

				const snapshot: BookSnapshot = {
					coin: "BTC",
					levels: [
						[{ px: "100", sz: "1", n: 1 }],
						[{ px: "101", sz: "2", n: 2 }],
					],
					time: 1700000000000,
				};
				ws.triggerMessage(
					JSON.stringify({ channel: "l2Book", data: snapshot }),
				);

				const fromBook = yield* bookCache.getOrWaitPrice("BTC");
				expect(fromBook).toEqual(snapshot);

				const now = yield* TestClock.currentTimeMillis;
				const fromAsset = cache.get("BTC", Number.MAX_SAFE_INTEGER, now);
				expect(Option.isNone(fromAsset)).toBe(true);

				yield* Fiber.interrupt(fiber);
			}),
		);
	});

	it("marks hasError after the socket closes", async () => {
		await runWithTestClock(
			Effect.gen(function* () {
				const { ws: service, fiber } = yield* startService(baseConfig);
				yield* waitForInstances(1);
				const ws = FakeWebSocket.instances[0];
				ws.triggerOpen();
				expect(yield* service.hasError()).toBe(false);

				ws.triggerClose();
				yield* Effect.yieldNow();

				expect(yield* service.hasError()).toBe(true);

				yield* Fiber.interrupt(fiber);
			}),
		);
	});

	it("ignores frames whose channel is not activeAssetCtx", async () => {
		await runWithTestClock(
			Effect.gen(function* () {
				const { cache, fiber } = yield* startService(baseConfig);
				yield* waitForInstances(1);
				const ws = FakeWebSocket.instances[0];
				ws.triggerOpen();

				ws.triggerMessage(JSON.stringify({ channel: "pong" }));
				ws.triggerMessage("not json");

				const now = yield* TestClock.currentTimeMillis;
				const entry = cache.get("BTC", Number.MAX_SAFE_INTEGER, now);
				expect(Option.isNone(entry)).toBe(true);

				yield* Fiber.interrupt(fiber);
			}),
		);
	});

	it("subscribe is idempotent: a duplicate call sends no extra frame", async () => {
		await runWithTestClock(
			Effect.gen(function* () {
				const { ws: service, fiber } = yield* startService(baseConfig, ["BTC"]);
				yield* waitForInstances(1);
				const ws = FakeWebSocket.instances[0];
				ws.triggerOpen();
				expect(ws.sent).toEqual([buildSubscribeFrame("activeAssetCtx", "BTC")]);

				yield* service.subscribe("activeAssetCtx", "BTC");
				yield* service.subscribe("activeAssetCtx", "BTC");

				expect(ws.sent).toEqual([buildSubscribeFrame("activeAssetCtx", "BTC")]);

				yield* Fiber.interrupt(fiber);
			}),
		);
	});

	it("unsubscribe is idempotent: a call for an unknown coin sends no frame", async () => {
		await runWithTestClock(
			Effect.gen(function* () {
				const { ws: service, fiber } = yield* startService(baseConfig, ["BTC"]);
				yield* waitForInstances(1);
				const ws = FakeWebSocket.instances[0];
				ws.triggerOpen();

				yield* service.unsubscribe("activeAssetCtx", "ETH");
				expect(ws.sent).toEqual([buildSubscribeFrame("activeAssetCtx", "BTC")]);

				yield* service.unsubscribe("activeAssetCtx", "BTC");
				expect(ws.sent).toEqual([
					buildSubscribeFrame("activeAssetCtx", "BTC"),
					buildUnsubscribeFrame("activeAssetCtx", "BTC"),
				]);

				yield* service.unsubscribe("activeAssetCtx", "BTC");
				expect(ws.sent).toEqual([
					buildSubscribeFrame("activeAssetCtx", "BTC"),
					buildUnsubscribeFrame("activeAssetCtx", "BTC"),
				]);

				yield* Fiber.interrupt(fiber);
			}),
		);
	});

	it("reconnects after a close, producing a second WebSocket instance", async () => {
		const fastSchedule = Schedule.spaced(Duration.millis(10));
		await runWithTestClock(
			Effect.gen(function* () {
				const { ws: service, fiber } = yield* startService(
					baseConfig,
					baseConfig.subscriptionCoins,
					{ reconnectSchedule: fastSchedule },
				);
				yield* waitForInstances(1);

				expect(FakeWebSocket.instances.length).toBe(1);
				const ws1 = FakeWebSocket.instances[0];
				ws1.triggerOpen();

				ws1.triggerClose();
				yield* Effect.yieldNow();
				yield* TestClock.adjust(Duration.millis(10));
				yield* waitForInstances(2);

				expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
				const ws2 = FakeWebSocket.instances[1];
				expect(ws2).not.toBe(ws1);

				ws2.triggerOpen();
				expect(yield* service.hasError()).toBe(false);

				yield* Fiber.interrupt(fiber);
			}),
		);
	});

	it("re-subscribes every desired coin after reconnect", async () => {
		const fastSchedule = Schedule.spaced(Duration.millis(10));
		await runWithTestClock(
			Effect.gen(function* () {
				const { fiber } = yield* startService(
					baseConfig,
					baseConfig.subscriptionCoins,
					{ reconnectSchedule: fastSchedule },
				);
				yield* waitForInstances(1);

				const ws1 = FakeWebSocket.instances[0];
				ws1.triggerOpen();
				expect(ws1.sent).toEqual([
					buildSubscribeFrame("activeAssetCtx", "BTC"),
					buildSubscribeFrame("activeAssetCtx", "ETH"),
				]);

				ws1.triggerClose();
				yield* Effect.yieldNow();
				yield* TestClock.adjust(Duration.millis(10));
				yield* waitForInstances(2);

				const ws2 = FakeWebSocket.instances[1];
				ws2.triggerOpen();

				expect(ws2.sent).toEqual([
					buildSubscribeFrame("activeAssetCtx", "BTC"),
					buildSubscribeFrame("activeAssetCtx", "ETH"),
				]);

				yield* Fiber.interrupt(fiber);
			}),
		);
	});

	it("recovers from a send error by closing the socket and reconnecting", async () => {
		const fastSchedule = Schedule.spaced(Duration.millis(10));
		// First instance throws on send; second instance accepts normally.
		FakeWebSocket.sendImpl = (instance, data) => {
			if (FakeWebSocket.instances.indexOf(instance) === 0) {
				throw new Error("send-blew-up");
			}
			instance.sent.push(data);
		};

		await runWithTestClock(
			Effect.gen(function* () {
				const { ws: service, fiber } = yield* startService(
					baseConfig,
					["BTC"],
					{ reconnectSchedule: fastSchedule },
				);
				yield* waitForInstances(1);

				const ws1 = FakeWebSocket.instances[0];
				ws1.triggerOpen();
				yield* Effect.yieldNow();
				yield* TestClock.adjust(Duration.millis(10));
				yield* waitForInstances(2);

				expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
				const ws2 = FakeWebSocket.instances[1];
				ws2.triggerOpen();

				expect(ws2.sent).toEqual([
					buildSubscribeFrame("activeAssetCtx", "BTC"),
				]);
				expect(yield* service.hasError()).toBe(false);

				yield* Fiber.interrupt(fiber);
			}),
		);
	});
});
