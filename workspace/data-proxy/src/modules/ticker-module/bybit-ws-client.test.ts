import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Duration, Effect, Fiber, LogLevel, Logger, Schedule } from "effect";
import type { BybitModuleConfig } from "../../config/bybit-module-config";
import {
	FakeWebSocket,
	installFakeWebSocket,
} from "../shared/fake-websocket.test-helpers";
import { createPriceCache } from "../shared/price-cache";
import {
	type BybitPriceFrame,
	PING_FRAME,
	buildSubscribeFrame,
	buildUnsubscribeFrame,
	createBybitWS,
	frameType,
	parseInboundFrame,
} from "./bybit";

const btcTicker: BybitPriceFrame = {
	symbol: "BTCUSDT",
	lastPrice: "76173.9",
	highPrice24h: "78232.5",
	lowPrice24h: "76000",
	prevPrice24h: "77328.9",
	volume24h: "83.489642",
	turnover24h: "6455446.89570903",
	price24hPcnt: "-0.0149",
	usdIndexPrice: "75828.089011",
};

const ethTicker: BybitPriceFrame = {
	symbol: "ETHUSDT",
	lastPrice: "3500.10",
	highPrice24h: "3600.00",
	lowPrice24h: "3400.00",
};

const tickerMessage = (frame: BybitPriceFrame) =>
	JSON.stringify({
		topic: `tickers.${frame.symbol}`,
		ts: 1789503838121,
		type: "snapshot",
		cs: 2190093576,
		data: frame,
	});

describe("buildSubscribeFrame / buildUnsubscribeFrame", () => {
	it("produces the documented subscribe control frame", () => {
		expect(JSON.parse(buildSubscribeFrame(["BTCUSDT"]))).toEqual({
			op: "subscribe",
			args: ["tickers.BTCUSDT"],
		});
	});

	it("batches multiple symbols into one subscribe frame", () => {
		expect(JSON.parse(buildSubscribeFrame(["BTCUSDT", "ETHUSDT"]))).toEqual({
			op: "subscribe",
			args: ["tickers.BTCUSDT", "tickers.ETHUSDT"],
		});
	});

	it("produces the documented unsubscribe control frame", () => {
		expect(JSON.parse(buildUnsubscribeFrame(["BTCUSDT", "ETHUSDT"]))).toEqual({
			op: "unsubscribe",
			args: ["tickers.BTCUSDT", "tickers.ETHUSDT"],
		});
	});
});

describe("parseInboundFrame", () => {
	it("extracts tickers from a snapshot payload", () => {
		expect(parseInboundFrame(tickerMessage(btcTicker))).toEqual({
			kind: "tickers",
			frames: [{ symbol: "BTCUSDT", frame: btcTicker }],
		});
	});

	it("uppercases symbol so cache keys stay consistent", () => {
		const result = parseInboundFrame(
			tickerMessage({ ...btcTicker, symbol: "btcusdt" }),
		);
		expect(result).toMatchObject({
			kind: "tickers",
			frames: [{ symbol: "BTCUSDT" }],
		});
	});

	it("extracts every item when data is an array", () => {
		expect(
			parseInboundFrame(
				JSON.stringify({
					topic: "tickers.BTCUSDT",
					ts: 1,
					type: "snapshot",
					data: [btcTicker, ethTicker],
				}),
			),
		).toEqual({
			kind: "tickers",
			frames: [
				{ symbol: "BTCUSDT", frame: btcTicker },
				{ symbol: "ETHUSDT", frame: ethTicker },
			],
		});
	});

	it("falls back to the topic symbol when data has no symbol field", () => {
		const { symbol: _symbol, ...rest } = btcTicker;
		expect(
			parseInboundFrame(
				JSON.stringify({
					topic: "tickers.BTCUSDT",
					ts: 1,
					type: "snapshot",
					data: rest,
				}),
			),
		).toEqual({
			kind: "tickers",
			frames: [{ symbol: "BTCUSDT", frame: { ...rest, symbol: "BTCUSDT" } }],
		});
	});

	it("extracts a delta payload", () => {
		const parsed = parseInboundFrame(
			JSON.stringify({
				topic: "tickers.BTCUSDT",
				type: "delta",
				data: { symbol: "BTCUSDT", lastPrice: "77000" },
			}),
		);
		expect(parsed).toEqual({
			kind: "tickers",
			frames: [
				{
					symbol: "BTCUSDT",
					frame: { symbol: "BTCUSDT", lastPrice: "77000" },
				},
			],
		});
		if (parsed?.kind !== "tickers") {
			throw new Error("expected a tickers frame");
		}
		expect(Reflect.get(parsed.frames[0].frame, frameType)).toBe("delta");
	});

	it("classifies a keepalive pong", () => {
		expect(
			parseInboundFrame(
				JSON.stringify({
					success: true,
					ret_msg: "pong",
					conn_id: "abc",
					op: "ping",
				}),
			),
		).toEqual({ kind: "pong" });
	});

	it("classifies an op=pong frame", () => {
		expect(parseInboundFrame(JSON.stringify({ op: "pong" }))).toEqual({
			kind: "pong",
		});
	});

	it("returns null for a subscribe ack", () => {
		expect(
			parseInboundFrame(
				JSON.stringify({
					success: true,
					ret_msg: "subscribe",
					conn_id: "dakbc1jboassme3cpgcg-5ie",
					op: "subscribe",
				}),
			),
		).toBeNull();
	});

	it("classifies a venue error frame", () => {
		expect(
			parseInboundFrame(
				JSON.stringify({
					success: false,
					ret_msg: "error:handler not found",
					conn_id: "abc",
					ret_code: 10001,
					op: "",
				}),
			),
		).toEqual({
			kind: "error",
			code: "10001",
			message: "error:handler not found",
		});
	});

	it("returns null for malformed JSON", () => {
		expect(parseInboundFrame("not json")).toBeNull();
	});

	it("returns null when the topic is not a tickers topic", () => {
		expect(
			parseInboundFrame(
				JSON.stringify({
					topic: "orderbook.1.BTCUSDT",
					data: { symbol: "BTCUSDT" },
				}),
			),
		).toBeNull();
	});
});

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const parseControl = (raw: string) =>
	JSON.parse(raw) as {
		op: string;
		args: string[];
	};

const baseConfig: BybitModuleConfig = {
	name: "bybit",
	type: "bybit",
	wsUrl: "wss://stream.bybit.test/v5/public/spot",
	subscriptionSymbols: ["BTCUSDT", "ETHUSDT"],
	maxSymbolsPerRequest: 100,
	maxMessages: 5,
	maxMessagesWindow: Duration.seconds(1),
	keepaliveInterval: Duration.minutes(10),
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
	config: BybitModuleConfig,
	preSubscribed: string[] = config.subscriptionSymbols,
	reconnectSchedule: Schedule.Schedule<
		unknown,
		unknown,
		never
	> = Schedule.spaced(Duration.minutes(10)),
) =>
	Effect.gen(function* () {
		const cache = yield* createPriceCache<string, BybitPriceFrame>();
		const ws = yield* createBybitWS(config, cache, reconnectSchedule);
		yield* ws.subscribe(preSubscribed);
		const fiber = yield* ws.start();
		return { cache, ws, fiber };
	}).pipe(Logger.withMinimumLogLevel(LogLevel.None));

describe("createBybitWS", () => {
	it("opens the WS at the configured url and batches the subscribe on open", async () => {
		const { fiber, ws: service } = await Effect.runPromise(
			startService(baseConfig),
		);
		await flush();

		expect(FakeWebSocket.instances.length).toBe(1);
		const ws = FakeWebSocket.instances[0];
		expect(ws.url).toBe("wss://stream.bybit.test/v5/public/spot");

		ws.triggerOpen();
		await flush();

		expect(ws.sent.length).toBe(1);
		const frame = parseControl(ws.sent[0]);
		expect(frame.op).toBe("subscribe");
		expect(frame.args).toEqual(["tickers.BTCUSDT", "tickers.ETHUSDT"]);
		expect(await Effect.runPromise(service.hasError())).toBe(false);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("writes inbound frames for desired symbols into the cache", async () => {
		const { cache, fiber } = await Effect.runPromise(startService(baseConfig));
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();

		ws.triggerMessage(tickerMessage(btcTicker));
		await flush();

		const price = await Effect.runPromise(cache.getOrWaitPrice("BTCUSDT"));
		expect(price).toEqual(btcTicker);

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

		ws.triggerMessage(tickerMessage(ethTicker));
		await flush();

		expect(cache.size()).toBe(0);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("ignores control acks, pongs, and non-json frames", async () => {
		const { cache, fiber } = await Effect.runPromise(startService(baseConfig));
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();

		ws.triggerMessage(
			JSON.stringify({
				success: true,
				ret_msg: "subscribe",
				op: "subscribe",
			}),
		);
		ws.triggerMessage(
			JSON.stringify({ success: true, ret_msg: "pong", op: "ping" }),
		);
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
		expect(frame.op).toBe("subscribe");
		expect(frame.args).toEqual([
			"tickers.BTCUSDT",
			"tickers.ETHUSDT",
			"tickers.SOLUSDT",
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
		expect(frame.op).toBe("unsubscribe");
		expect(frame.args).toEqual(["tickers.BTCUSDT"]);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("sends a JSON ping keepalive on the configured interval", async () => {
		const { fiber } = await Effect.runPromise(
			startService(
				{ ...baseConfig, keepaliveInterval: Duration.millis(30) },
				[],
			),
		);
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();

		await new Promise<void>((r) => setTimeout(r, 80));
		expect(ws.sent.some((raw) => raw === PING_FRAME)).toBe(true);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});
});
