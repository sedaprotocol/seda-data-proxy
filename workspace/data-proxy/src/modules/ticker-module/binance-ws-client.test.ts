import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Duration, Effect, Fiber, LogLevel, Logger, Schedule } from "effect";
import type { BinanceModuleConfig } from "../../config/binance-module-config";
import {
	FakeWebSocket,
	installFakeWebSocket,
} from "../shared/fake-websocket.test-helpers";
import { createPriceCache } from "../shared/price-cache";
import {
	type BinancePriceFrame,
	buildStreamName,
	buildSubscribeFrame,
	buildUnsubscribeFrame,
	createBinanceWS,
	parseInboundFrame,
} from "./binance";

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
			kind: "tickers",
			frames: [{ key: "BTCUSDT", frame: btcBook }],
		});
	});

	it("accepts a bare (raw-stream) payload", () => {
		expect(parseInboundFrame(JSON.stringify(ethBook))).toEqual({
			kind: "tickers",
			frames: [{ key: "ETHUSDT", frame: ethBook }],
		});
	});

	it("uppercases the symbol so cache keys stay consistent", () => {
		const result = parseInboundFrame(JSON.stringify({ s: "btcusdt", b: "1" }));
		expect(result).toMatchObject({
			kind: "tickers",
			frames: [{ key: "BTCUSDT" }],
		});
	});

	it("returns null for a control ack with no symbol", () => {
		expect(
			parseInboundFrame(JSON.stringify({ result: null, id: 1 })),
		).toBeNull();
	});

	it("classifies a venue error frame", () => {
		expect(
			parseInboundFrame(
				JSON.stringify({
					error: {
						code: 3,
						msg: "Invalid JSON: key must be a string at line 1 column 2",
					},
				}),
			),
		).toEqual({
			kind: "error",
			code: 3,
			message: "Invalid JSON: key must be a string at line 1 column 2",
		});
	});

	it("returns null for malformed JSON", () => {
		expect(parseInboundFrame("not json")).toBeNull();
	});

	it("returns null when the payload has no string symbol", () => {
		expect(parseInboundFrame(JSON.stringify({ b: "1", a: "2" }))).toBeNull();
	});
});

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
	maxMessages: 5,
	maxMessagesWindow: Duration.seconds(1),
	reconnectMaxBackoff: Duration.seconds(30),
	reconnectStableThreshold: Duration.seconds(30),
	symbolsCleanupTtl: Duration.minutes(2),
	symbolsCleanupInterval: Duration.seconds(30),
};

let restoreWebSocket: (() => void) | undefined;

beforeEach(() => {
	restoreWebSocket = installFakeWebSocket();
});

afterEach(() => {
	restoreWebSocket?.();
});

const startService = (
	config: BinanceModuleConfig,
	preSubscribed: string[] = config.subscriptionSymbols,
	reconnectSchedule: Schedule.Schedule<
		unknown,
		unknown,
		never
	> = Schedule.spaced(Duration.minutes(10)),
) =>
	Effect.gen(function* () {
		const cache = yield* createPriceCache<string, BinancePriceFrame>();
		const ws = yield* createBinanceWS(config, cache, reconnectSchedule);
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
});
