import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Duration, Effect, Fiber, LogLevel, Logger, Schedule } from "effect";
import type { BinanceModuleConfig } from "../../config/binance-module-config";
import { createPriceCache } from "../shared/price-cache";
import {
	type BinancePriceFrame,
	buildStreamName,
	buildSubscribeFrame,
	buildUnsubscribeFrame,
	createBinanceWS,
	parseInboundFrame,
} from "./ws-client";

const btcBook: BinancePriceFrame = {
	u: 400900217,
	s: "BTCUSDT",
	b: "67123.44",
	B: "1.2",
	a: "67123.46",
	A: "0.8",
};

const ethBook: BinancePriceFrame = {
	u: 400900218,
	s: "ETHUSDT",
	b: "3500.10",
	B: "5.0",
	a: "3500.20",
	A: "4.1",
};

describe("buildStreamName", () => {
	it("lowercases the symbol and appends the stream type", () => {
		expect(buildStreamName("BTCUSDT", "bookTicker")).toBe("btcusdt@bookTicker");
		expect(buildStreamName("ethusdt", "aggTrade")).toBe("ethusdt@aggTrade");
	});
});

describe("buildSubscribeFrame / buildUnsubscribeFrame", () => {
	it("produces the documented subscribe control frame", () => {
		expect(JSON.parse(buildSubscribeFrame(["btcusdt@bookTicker"], 1))).toEqual({
			method: "SUBSCRIBE",
			params: ["btcusdt@bookTicker"],
			id: 1,
		});
	});

	it("produces the documented unsubscribe control frame", () => {
		expect(
			JSON.parse(
				buildUnsubscribeFrame(["btcusdt@bookTicker", "ethusdt@bookTicker"], 7),
			),
		).toEqual({
			method: "UNSUBSCRIBE",
			params: ["btcusdt@bookTicker", "ethusdt@bookTicker"],
			id: 7,
		});
	});
});

describe("parseInboundFrame", () => {
	it("unwraps a combined-stream envelope", () => {
		const raw = JSON.stringify({ stream: "btcusdt@bookTicker", data: btcBook });
		expect(parseInboundFrame(raw)).toEqual({
			symbol: "BTCUSDT",
			frame: btcBook,
		});
	});

	it("accepts a bare (raw-stream) payload", () => {
		expect(parseInboundFrame(JSON.stringify(ethBook))).toEqual({
			symbol: "ETHUSDT",
			frame: ethBook,
		});
	});

	it("uppercases the symbol so cache keys stay consistent", () => {
		const result = parseInboundFrame(JSON.stringify({ s: "btcusdt", b: "1" }));
		expect(result?.symbol).toBe("BTCUSDT");
	});

	it("returns null for a control ack with no symbol", () => {
		expect(
			parseInboundFrame(JSON.stringify({ result: null, id: 1 })),
		).toBeNull();
	});

	it("returns null for malformed JSON", () => {
		expect(parseInboundFrame("not json")).toBeNull();
	});

	it("returns null when the payload has no string symbol", () => {
		expect(parseInboundFrame(JSON.stringify({ b: "1", a: "2" }))).toBeNull();
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

const parseControl = (raw: string) =>
	JSON.parse(raw) as { method: string; params: string[]; id: number };

const baseConfig: BinanceModuleConfig = {
	name: "binance",
	type: "binance",
	wsUrl: "wss://stream.binance.test/stream",
	streamType: "bookTicker",
	subscriptionSymbols: ["BTCUSDT", "ETHUSDT"],
	maxSymbolsPerRequest: 100,
	reconnectMaxBackoff: Duration.seconds(30),
	reconnectStableThreshold: Duration.seconds(30),
	symbolsCleanupTtl: Duration.minutes(2),
	symbolsCleanupInterval: Duration.seconds(30),
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
	config: BinanceModuleConfig,
	preSubscribed: string[] = config.subscriptionSymbols,
	options?: Parameters<typeof createBinanceWS>[2],
) =>
	Effect.gen(function* () {
		const cache = yield* createPriceCache<string, BinancePriceFrame>();
		const ws = yield* createBinanceWS(
			config,
			cache,
			options ?? { reconnectSchedule: Schedule.spaced(Duration.minutes(10)) },
		);
		yield* ws.subscribe(preSubscribed);
		const fiber = yield* ws.start();
		return { cache, ws, fiber };
	}).pipe(Logger.withMinimumLogLevel(LogLevel.None));

describe("createBinanceWS", () => {
	it("opens the WS at the configured url and batches the subscribe on open", async () => {
		const { fiber, ws: service } = await Effect.runPromise(
			startService(baseConfig),
		);
		await flush();

		expect(FakeWebSocket.instances.length).toBe(1);
		const ws = FakeWebSocket.instances[0];
		expect(ws.url).toBe("wss://stream.binance.test/stream");

		ws.triggerOpen();
		await flush();

		expect(ws.sent.length).toBe(1);
		const frame = parseControl(ws.sent[0]);
		expect(frame.method).toBe("SUBSCRIBE");
		expect(frame.params).toEqual(["btcusdt@bookTicker", "ethusdt@bookTicker"]);
		expect(typeof frame.id).toBe("number");
		expect(await Effect.runPromise(service.hasError())).toBe(false);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("writes inbound frames for desired symbols into the cache", async () => {
		const { cache, fiber } = await Effect.runPromise(startService(baseConfig));
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();

		ws.triggerMessage(
			JSON.stringify({ stream: "btcusdt@bookTicker", data: btcBook }),
		);
		await flush();

		const price = await Effect.runPromise(cache.getOrWaitPrice("BTCUSDT"));
		expect(price).toEqual(btcBook);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("drops inbound frames for symbols not in the desired set", async () => {
		const { cache, fiber } = await Effect.runPromise(
			startService(baseConfig, ["BTCUSDT"]),
		);
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();

		ws.triggerMessage(
			JSON.stringify({ stream: "ethusdt@bookTicker", data: ethBook }),
		);
		await flush();

		expect(cache.size()).toBe(0);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("marks hasError after the socket closes", async () => {
		const { ws: service, fiber } = await Effect.runPromise(
			startService(baseConfig),
		);
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();
		expect(await Effect.runPromise(service.hasError())).toBe(false);

		ws.triggerClose();
		await flush();

		expect(await Effect.runPromise(service.hasError())).toBe(true);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("ignores control acks and non-json frames", async () => {
		const { cache, fiber } = await Effect.runPromise(startService(baseConfig));
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();

		ws.triggerMessage(JSON.stringify({ result: null, id: 1 }));
		ws.triggerMessage("not json");
		await flush();

		expect(cache.size()).toBe(0);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("subscribe is idempotent: a duplicate symbol sends no extra frame", async () => {
		const { ws: service, fiber } = await Effect.runPromise(
			startService(baseConfig, ["BTCUSDT"]),
		);
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();
		expect(ws.sent.length).toBe(1);

		await Effect.runPromise(service.subscribe(["BTCUSDT"]));
		await Effect.runPromise(service.subscribe(["BTCUSDT"]));
		await flush();

		expect(ws.sent.length).toBe(1);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("subscribe batches multiple new symbols into one frame", async () => {
		const { ws: service, fiber } = await Effect.runPromise(
			startService(baseConfig, []),
		);
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();
		expect(ws.sent.length).toBe(0);

		await Effect.runPromise(
			service.subscribe(["BTCUSDT", "ETHUSDT", "SOLUSDT"]),
		);
		await flush();

		expect(ws.sent.length).toBe(1);
		const frame = parseControl(ws.sent[0]);
		expect(frame.method).toBe("SUBSCRIBE");
		expect(frame.params).toEqual([
			"btcusdt@bookTicker",
			"ethusdt@bookTicker",
			"solusdt@bookTicker",
		]);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("unsubscribe removes the symbol and sends an unsubscribe frame", async () => {
		const { ws: service, fiber } = await Effect.runPromise(
			startService(baseConfig, ["BTCUSDT"]),
		);
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();
		expect(ws.sent.length).toBe(1);

		// Unknown symbol: no frame.
		await Effect.runPromise(service.unsubscribe(["ETHUSDT"]));
		await flush();
		expect(ws.sent.length).toBe(1);

		await Effect.runPromise(service.unsubscribe(["BTCUSDT"]));
		await flush();
		expect(ws.sent.length).toBe(2);
		const frame = parseControl(ws.sent[1]);
		expect(frame.method).toBe("UNSUBSCRIBE");
		expect(frame.params).toEqual(["btcusdt@bookTicker"]);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("reconnects after a close, producing a second WebSocket instance", async () => {
		const fastSchedule = Schedule.spaced(Duration.millis(10));
		const { ws: service, fiber } = await Effect.runPromise(
			startService(baseConfig, baseConfig.subscriptionSymbols, {
				reconnectSchedule: fastSchedule,
			}),
		);
		await flush();

		expect(FakeWebSocket.instances.length).toBe(1);
		const ws1 = FakeWebSocket.instances[0];
		ws1.triggerOpen();
		await flush();

		ws1.triggerClose();
		await new Promise<void>((r) => setTimeout(r, 40));

		expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
		const ws2 = FakeWebSocket.instances[1];
		expect(ws2).not.toBe(ws1);

		ws2.triggerOpen();
		await flush();
		expect(await Effect.runPromise(service.hasError())).toBe(false);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("re-subscribes every desired symbol after reconnect", async () => {
		const fastSchedule = Schedule.spaced(Duration.millis(10));
		const { fiber } = await Effect.runPromise(
			startService(baseConfig, baseConfig.subscriptionSymbols, {
				reconnectSchedule: fastSchedule,
			}),
		);
		await flush();

		const ws1 = FakeWebSocket.instances[0];
		ws1.triggerOpen();
		await flush();
		expect(parseControl(ws1.sent[0]).params).toEqual([
			"btcusdt@bookTicker",
			"ethusdt@bookTicker",
		]);

		ws1.triggerClose();
		await new Promise<void>((r) => setTimeout(r, 40));

		const ws2 = FakeWebSocket.instances[1];
		ws2.triggerOpen();
		await flush();

		expect(parseControl(ws2.sent[0]).params).toEqual([
			"btcusdt@bookTicker",
			"ethusdt@bookTicker",
		]);

		await Effect.runPromise(Fiber.interrupt(fiber));
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

		const { ws: service, fiber } = await Effect.runPromise(
			startService(baseConfig, ["BTCUSDT"], {
				reconnectSchedule: fastSchedule,
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

		expect(parseControl(ws2.sent[0]).params).toEqual(["btcusdt@bookTicker"]);
		expect(await Effect.runPromise(service.hasError())).toBe(false);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});
});
