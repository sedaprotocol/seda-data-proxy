import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	Duration,
	Effect,
	Fiber,
	MutableHashMap,
	Option,
	Schedule,
} from "effect";
import type { HydromancerModuleConfig } from "../../config/hydromancer-module-config";
import { createAssetCache } from "./asset-cache";
import {
	buildSubscribeFrame,
	buildUnsubscribeFrame,
	parseInboundFrame,
	startWebSocketDaemon,
} from "./ws-client";

const validCtx = {
	oraclePx: "1",
	markPx: "2",
	midPx: "3",
	impactPxs: ["4", "5"],
	openInterest: "6",
};

describe("buildSubscribeFrame / buildUnsubscribeFrame", () => {
	it("produces the documented subscribe shape", () => {
		expect(JSON.parse(buildSubscribeFrame("BTC"))).toEqual({
			method: "subscribe",
			subscription: { type: "activeAssetCtx", coin: "BTC" },
		});
	});

	it("produces the documented unsubscribe shape", () => {
		expect(JSON.parse(buildUnsubscribeFrame("ETH"))).toEqual({
			method: "unsubscribe",
			subscription: { type: "activeAssetCtx", coin: "ETH" },
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
		expect(parseInboundFrame(frame)).toEqual({ coin: "ETH", ctx: validCtx });
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
		expect(parseInboundFrame(frame)).toEqual({ coin: "BTC", ctx: ctxNullOI });
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
			coin: "bmx:TSLA",
			ctx: ctxPartial,
		});
	});
});

class FakeWebSocket extends EventTarget {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: FakeWebSocket[] = [];

	url: string;
	readyState = FakeWebSocket.CONNECTING;
	sent: string[] = [];

	constructor(url: string) {
		super();
		this.url = url;
		FakeWebSocket.instances.push(this);
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {
		this.readyState = FakeWebSocket.CLOSED;
		this.dispatchEvent(new Event("close"));
	}

	triggerOpen(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.dispatchEvent(new Event("open"));
	}

	triggerMessage(data: string): void {
		this.dispatchEvent(new MessageEvent("message", { data }));
	}

	triggerClose(): void {
		this.readyState = FakeWebSocket.CLOSED;
		this.dispatchEvent(new Event("close"));
	}
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const baseConfig: HydromancerModuleConfig = {
	name: "hydromancer",
	type: "hydromancer",
	wsUrl: "wss://api.hydromancer.test/ws",
	restBaseUrl: "https://api.hydromancer.test",
	hydromancerApiKeyEnvKey: "HYDROMANCER_API_KEY",
	hydromancerApiKey: "test-api-key",
	staleAfter: Duration.seconds(10),
	subscriptionCoins: ["BTC", "ETH"],
	maxCoinsPerRequest: 20,
	reconnectMaxBackoff: Duration.seconds(30),
	coinsCleanupTtl: Duration.minutes(2),
	coinsCleanupInterval: Duration.seconds(30),
};

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
	FakeWebSocket.instances = [];
	globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
	globalThis.WebSocket = originalWebSocket;
});

const startDaemon = (config: HydromancerModuleConfig) =>
	Effect.gen(function* () {
		const cache = yield* createAssetCache();
		const desiredCoins = MutableHashMap.empty<string, true>();
		for (const coin of config.subscriptionCoins) {
			MutableHashMap.set(desiredCoins, coin, true);
		}
		const currentWS: { value: WebSocket | null } = { value: null };
		const fiber = yield* startWebSocketDaemon(
			config,
			cache,
			desiredCoins,
			currentWS,
			{ reconnectSchedule: Schedule.spaced(Duration.minutes(10)) },
		);
		return { cache, fiber, desiredCoins, currentWS };
	});

describe("startWebSocketDaemon", () => {
	it("opens the WS with the token query and sends subscribe frames on open", async () => {
		const { cache, fiber } = await Effect.runPromise(startDaemon(baseConfig));
		await flush();

		expect(FakeWebSocket.instances.length).toBe(1);
		const ws = FakeWebSocket.instances[0];
		expect(ws.url).toBe("wss://api.hydromancer.test/ws?token=test-api-key");

		ws.triggerOpen();
		await flush();

		expect(ws.sent).toEqual([
			buildSubscribeFrame("BTC"),
			buildSubscribeFrame("ETH"),
		]);
		expect(await Effect.runPromise(cache.hasSocketError())).toBe(false);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("writes inbound activeAssetCtx frames into the cache", async () => {
		const { cache, fiber } = await Effect.runPromise(startDaemon(baseConfig));
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();

		ws.triggerMessage(
			JSON.stringify({
				channel: "activeAssetCtx",
				seq: 1,
				data: { coin: "BTC", ctx: validCtx },
			}),
		);
		await flush();

		const entry = await Effect.runPromise(cache.get("BTC"));
		expect(Option.isSome(entry)).toBe(true);
		if (Option.isSome(entry)) {
			expect(entry.value.ctx).toEqual(validCtx);
		}

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("marks socket-error on close", async () => {
		const { cache, fiber } = await Effect.runPromise(startDaemon(baseConfig));
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();
		expect(await Effect.runPromise(cache.hasSocketError())).toBe(false);

		ws.triggerClose();
		await flush();

		expect(await Effect.runPromise(cache.hasSocketError())).toBe(true);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("ignores frames whose channel is not activeAssetCtx", async () => {
		const { cache, fiber } = await Effect.runPromise(startDaemon(baseConfig));
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();

		ws.triggerMessage(JSON.stringify({ channel: "pong" }));
		ws.triggerMessage("not json");
		await flush();

		const entry = await Effect.runPromise(cache.get("BTC"));
		expect(Option.isNone(entry)).toBe(true);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("reconnects after a close, producing a second WebSocket instance", async () => {
		const fastSchedule = Schedule.spaced(Duration.millis(10));
		const { cache, fiber } = await Effect.runPromise(
			Effect.gen(function* () {
				const cache = yield* createAssetCache();
				const desiredCoins = MutableHashMap.empty<string, true>();
				for (const coin of baseConfig.subscriptionCoins) {
					MutableHashMap.set(desiredCoins, coin, true);
				}
				const currentWS: { value: WebSocket | null } = { value: null };
				const fiber = yield* startWebSocketDaemon(
					baseConfig,
					cache,
					desiredCoins,
					currentWS,
					{ reconnectSchedule: fastSchedule },
				);
				return { cache, fiber };
			}),
		);
		await flush();

		expect(FakeWebSocket.instances.length).toBe(1);
		const ws1 = FakeWebSocket.instances[0];
		ws1.triggerOpen();
		await flush();

		ws1.triggerClose();
		// Wait long enough for the daemon to retry past the 10ms schedule.
		await new Promise<void>((r) => setTimeout(r, 40));

		expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
		const ws2 = FakeWebSocket.instances[1];
		expect(ws2).not.toBe(ws1);

		// The freshly-connected socket should clear the error flag once opened.
		ws2.triggerOpen();
		await flush();
		expect(await Effect.runPromise(cache.hasSocketError())).toBe(false);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("re-subscribes to every desired coin after reconnect", async () => {
		const fastSchedule = Schedule.spaced(Duration.millis(10));
		const { fiber } = await Effect.runPromise(
			Effect.gen(function* () {
				const cache = yield* createAssetCache();
				const desiredCoins = MutableHashMap.empty<string, true>();
				for (const coin of baseConfig.subscriptionCoins) {
					MutableHashMap.set(desiredCoins, coin, true);
				}
				const currentWS: { value: WebSocket | null } = { value: null };
				const fiber = yield* startWebSocketDaemon(
					baseConfig,
					cache,
					desiredCoins,
					currentWS,
					{ reconnectSchedule: fastSchedule },
				);
				return { cache, fiber };
			}),
		);
		await flush();

		const ws1 = FakeWebSocket.instances[0];
		ws1.triggerOpen();
		await flush();
		expect(ws1.sent).toEqual([
			buildSubscribeFrame("BTC"),
			buildSubscribeFrame("ETH"),
		]);

		ws1.triggerClose();
		await new Promise<void>((r) => setTimeout(r, 40));

		const ws2 = FakeWebSocket.instances[1];
		ws2.triggerOpen();
		await flush();

		expect(ws2.sent).toEqual([
			buildSubscribeFrame("BTC"),
			buildSubscribeFrame("ETH"),
		]);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});
});
