import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Duration, Effect, Fiber, LogLevel, Logger, Schedule } from "effect";
import type { LighterModuleConfig } from "../../config/lighter-module-config";
import { createPriceCache } from "../shared/price-cache";
import {
	type LighterPriceFrame,
	buildSubscribeFrame,
	buildUnsubscribeFrame,
	createLighterWS,
	parseInboundFrame,
} from "./ws-client";

const PING = JSON.stringify({ type: "ping" });
const PONG = JSON.stringify({ type: "pong" });

const innerTicker = (symbol: string) => ({
	s: symbol,
	a: { price: "63327.1", size: "0.05874" },
	b: { price: "63327.0", size: "0.28342" },
	last_updated_at: 1780940152376949,
});

const tickerMessage = (
	marketId: number,
	symbol: string,
	type: "subscribed/ticker" | "update/ticker" = "update/ticker",
) =>
	JSON.stringify({
		channel: `ticker:${marketId}`,
		last_updated_at: 1780940152376949,
		nonce: 14176467251,
		ticker: innerTicker(symbol),
		timestamp: 1780940152623,
		type,
	});

describe("buildSubscribeFrame / buildUnsubscribeFrame", () => {
	it("sends the ticker channel with a slash separator", () => {
		expect(JSON.parse(buildSubscribeFrame(1))).toEqual({
			type: "subscribe",
			channel: "ticker/1",
		});
		expect(JSON.parse(buildUnsubscribeFrame(42))).toEqual({
			type: "unsubscribe",
			channel: "ticker/42",
		});
	});
});

describe("parseInboundFrame", () => {
	it("extracts market id and verbatim frame from an update/ticker", () => {
		expect(parseInboundFrame(tickerMessage(1, "BTC"))).toEqual({
			kind: "ticker",
			marketId: 1,
			frame: innerTicker("BTC"),
		});
	});

	it("treats the subscribed/ticker snapshot the same as an update", () => {
		const parsed = parseInboundFrame(
			tickerMessage(2, "ETH", "subscribed/ticker"),
		);
		expect(parsed).toEqual({
			kind: "ticker",
			marketId: 2,
			frame: innerTicker("ETH"),
		});
	});

	it("classifies a keepalive ping", () => {
		expect(parseInboundFrame(JSON.stringify({ type: "ping" }))).toEqual({
			kind: "ping",
		});
	});

	it("returns null for the connected control frame", () => {
		expect(
			parseInboundFrame(JSON.stringify({ session_id: "x", type: "connected" })),
		).toBeNull();
	});

	it("returns null for an error frame", () => {
		expect(
			parseInboundFrame(
				JSON.stringify({ error: { code: 30005, message: "Invalid Channel" } }),
			),
		).toBeNull();
	});

	it("returns null for malformed JSON", () => {
		expect(parseInboundFrame("not json")).toBeNull();
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
		FakeWebSocket.instances.push(this);
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
		if (this.readyState === FakeWebSocket.CLOSED) return;
		this.readyState = FakeWebSocket.CLOSED;
		this.dispatchEvent(new Event("close"));
	}
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const baseConfig: LighterModuleConfig = {
	name: "lighter",
	type: "lighter",
	wsUrl: "wss://lighter.test/stream",
	subscriptionMarketIds: [],
	maxMarketsPerRequest: 100,
	keepaliveInterval: Duration.seconds(60),
	reconnectMaxBackoff: Duration.seconds(30),
	reconnectStableThreshold: Duration.seconds(30),
	marketsCleanupTtl: Duration.hours(1),
	marketsCleanupInterval: Duration.seconds(30),
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
	config: LighterModuleConfig,
	preSubscribed: number[] = [],
	options?: Parameters<typeof createLighterWS>[2],
) =>
	Effect.gen(function* () {
		const cache = yield* createPriceCache<number, LighterPriceFrame>();
		const ws = yield* createLighterWS(
			config,
			cache,
			options ?? { reconnectSchedule: Schedule.spaced(Duration.minutes(10)) },
		);
		if (preSubscribed.length > 0) {
			yield* ws.subscribe(preSubscribed);
		}
		const fiber = yield* ws.start();
		return { cache, ws, fiber };
	}).pipe(Logger.withMinimumLogLevel(LogLevel.None));

describe("createLighterWS", () => {
	it("opens the configured WS and subscribes desired markets on open", async () => {
		const { fiber } = await Effect.runPromise(startService(baseConfig, [1, 2]));
		await flush();

		expect(FakeWebSocket.instances.length).toBe(1);
		const ws = FakeWebSocket.instances[0];
		expect(ws.url).toBe("wss://lighter.test/stream");

		ws.triggerOpen();
		await flush();

		expect(ws.sent).toEqual([buildSubscribeFrame(1), buildSubscribeFrame(2)]);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("writes an inbound ticker into the cache keyed by market id", async () => {
		const { cache, fiber } = await Effect.runPromise(
			startService(baseConfig, [1]),
		);
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();

		ws.triggerMessage(tickerMessage(1, "BTC"));
		await flush();

		expect(cache.size()).toBe(1);
		const price = await Effect.runPromise(cache.getOrWaitPrice(1));
		expect(price).toEqual(innerTicker("BTC"));

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("drops an inbound ticker for a market not in the desired set", async () => {
		const { cache, fiber } = await Effect.runPromise(
			startService(baseConfig, [1]),
		);
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();

		ws.triggerMessage(tickerMessage(2, "ETH"));
		await flush();

		expect(cache.size()).toBe(0);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("replies pong to a server ping", async () => {
		const { fiber } = await Effect.runPromise(startService(baseConfig, [1]));
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();
		ws.sent.length = 0;

		ws.triggerMessage(JSON.stringify({ type: "ping" }));
		await flush();

		expect(ws.sent).toEqual([PONG]);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("sends keepalive pings on the configured interval", async () => {
		const { fiber } = await Effect.runPromise(
			startService(
				{ ...baseConfig, keepaliveInterval: Duration.millis(10) },
				[1],
			),
		);
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();
		ws.sent.length = 0;

		await new Promise<void>((r) => setTimeout(r, 50));

		expect(ws.sent.filter((frame) => frame === PING).length).toBeGreaterThan(0);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("subscribe is idempotent: a duplicate market id sends no extra frame", async () => {
		const { ws: service, fiber } = await Effect.runPromise(
			startService(baseConfig, [1]),
		);
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();
		expect(ws.sent).toEqual([buildSubscribeFrame(1)]);

		await Effect.runPromise(service.subscribe([1]));
		await Effect.runPromise(service.subscribe([1]));
		await flush();

		expect(ws.sent).toEqual([buildSubscribeFrame(1)]);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("unsubscribe is idempotent and removes from the desired set", async () => {
		const { ws: service, fiber } = await Effect.runPromise(
			startService(baseConfig, [1]),
		);
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();

		// Unknown market id: no frame.
		await Effect.runPromise(service.unsubscribe([2]));
		await flush();
		expect(ws.sent).toEqual([buildSubscribeFrame(1)]);

		await Effect.runPromise(service.unsubscribe([1]));
		await flush();
		expect(ws.sent).toEqual([buildSubscribeFrame(1), buildUnsubscribeFrame(1)]);

		// Repeat: already removed, no frame.
		await Effect.runPromise(service.unsubscribe([1]));
		await flush();
		expect(ws.sent).toEqual([buildSubscribeFrame(1), buildUnsubscribeFrame(1)]);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("reconnects after a close and re-subscribes every desired market", async () => {
		const { fiber } = await Effect.runPromise(
			startService(baseConfig, [1, 2], {
				reconnectSchedule: Schedule.spaced(Duration.millis(10)),
			}),
		);
		await flush();
		const ws1 = FakeWebSocket.instances[0];
		ws1.triggerOpen();
		await flush();
		expect(ws1.sent).toEqual([buildSubscribeFrame(1), buildSubscribeFrame(2)]);

		ws1.triggerClose();
		await new Promise<void>((r) => setTimeout(r, 40));

		expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
		const ws2 = FakeWebSocket.instances[1];
		expect(ws2).not.toBe(ws1);
		ws2.triggerOpen();
		await flush();

		expect(ws2.sent).toEqual([buildSubscribeFrame(1), buildSubscribeFrame(2)]);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("recovers from a send error by closing the socket and reconnecting", async () => {
		FakeWebSocket.sendImpl = (instance, data) => {
			if (FakeWebSocket.instances.indexOf(instance) === 0) {
				throw new Error("send-blew-up");
			}
			instance.sent.push(data);
		};

		const { fiber } = await Effect.runPromise(
			startService(baseConfig, [1], {
				reconnectSchedule: Schedule.spaced(Duration.millis(10)),
			}),
		);
		await flush();
		const ws1 = FakeWebSocket.instances[0];
		ws1.triggerOpen();
		await flush();

		await new Promise<void>((r) => setTimeout(r, 40));
		expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
		const ws2 = FakeWebSocket.instances[1];
		ws2.triggerOpen();
		await flush();

		expect(ws2.sent).toEqual([buildSubscribeFrame(1)]);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});
});
