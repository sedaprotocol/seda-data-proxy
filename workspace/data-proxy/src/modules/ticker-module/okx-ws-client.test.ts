import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Duration, Effect, Fiber, LogLevel, Logger, Schedule } from "effect";
import type { OkxModuleConfig } from "../../config/okx-module-config";
import {
	FakeWebSocket,
	installFakeWebSocket,
} from "../shared/fake-websocket.test-helpers";
import { createPriceCache } from "../shared/price-cache";
import {
	type OkxPriceFrame,
	PING_FRAME,
	buildSubscribeFrame,
	buildUnsubscribeFrame,
	createOkxWS,
	parseInboundFrame,
} from "./okx";

const btcTicker: OkxPriceFrame = {
	instType: "SPOT",
	instId: "BTC-USDT",
	last: "9999.99",
	lastSz: "0.1",
	askPx: "9999.99",
	askSz: "11",
	bidPx: "8888.88",
	bidSz: "5",
	ts: "1597026383085",
};

const ethTicker: OkxPriceFrame = {
	instType: "SPOT",
	instId: "ETH-USDT",
	last: "3500.10",
	askPx: "3500.20",
	bidPx: "3500.00",
	ts: "1597026383086",
};

const tickerMessage = (frame: OkxPriceFrame) =>
	JSON.stringify({
		arg: { channel: "tickers", instId: frame.instId },
		data: [frame],
	});

describe("buildSubscribeFrame / buildUnsubscribeFrame", () => {
	it("produces the documented subscribe control frame", () => {
		expect(JSON.parse(buildSubscribeFrame(["BTC-USDT"], "1"))).toEqual({
			id: "1",
			op: "subscribe",
			args: [{ channel: "tickers", instId: "BTC-USDT" }],
		});
	});

	it("batches multiple symbols into one subscribe frame", () => {
		expect(
			JSON.parse(buildSubscribeFrame(["BTC-USDT", "ETH-USDT"], "2")),
		).toEqual({
			id: "2",
			op: "subscribe",
			args: [
				{ channel: "tickers", instId: "BTC-USDT" },
				{ channel: "tickers", instId: "ETH-USDT" },
			],
		});
	});

	it("produces the documented unsubscribe control frame", () => {
		expect(
			JSON.parse(buildUnsubscribeFrame(["BTC-USDT", "ETH-USDT"], "7")),
		).toEqual({
			id: "7",
			op: "unsubscribe",
			args: [
				{ channel: "tickers", instId: "BTC-USDT" },
				{ channel: "tickers", instId: "ETH-USDT" },
			],
		});
	});
});

describe("parseInboundFrame", () => {
	it("extracts tickers from a push payload", () => {
		expect(parseInboundFrame(tickerMessage(btcTicker))).toEqual({
			kind: "tickers",
			frames: [{ key: "BTC-USDT", frame: btcTicker }],
		});
	});

	it("uppercases instId so cache keys stay consistent", () => {
		const result = parseInboundFrame(
			tickerMessage({ ...btcTicker, instId: "btc-usdt" }),
		);
		expect(result).toMatchObject({
			kind: "tickers",
			frames: [{ key: "BTC-USDT" }],
		});
	});

	it("extracts every item in a data array", () => {
		expect(
			parseInboundFrame(
				JSON.stringify({
					arg: { channel: "tickers", instId: "BTC-USDT" },
					data: [btcTicker, ethTicker],
				}),
			),
		).toEqual({
			kind: "tickers",
			frames: [
				{ key: "BTC-USDT", frame: btcTicker },
				{ key: "ETH-USDT", frame: ethTicker },
			],
		});
	});

	it("classifies a keepalive pong", () => {
		expect(parseInboundFrame("pong")).toEqual({ kind: "pong" });
	});

	it("returns null for a subscribe ack", () => {
		expect(
			parseInboundFrame(
				JSON.stringify({
					id: "1512",
					event: "subscribe",
					arg: { channel: "tickers", instId: "BTC-USDT" },
					connId: "a4d3ae55",
				}),
			),
		).toBeNull();
	});

	it("classifies a venue error frame", () => {
		expect(
			parseInboundFrame(
				JSON.stringify({
					id: "1512",
					event: "error",
					code: "60012",
					msg: "Invalid request",
					connId: "a4d3ae55",
				}),
			),
		).toEqual({
			kind: "error",
			code: "60012",
			message: "Invalid request",
		});
	});

	it("classifies a service-upgrade notice as an error", () => {
		expect(
			parseInboundFrame(
				JSON.stringify({
					event: "notice",
					code: "64008",
					msg: "The connection will soon be closed for a service upgrade. Please reconnect.",
					connId: "a4d3ae55",
				}),
			),
		).toEqual({
			kind: "error",
			code: "64008",
			message:
				"The connection will soon be closed for a service upgrade. Please reconnect.",
		});
	});

	it("returns null for malformed JSON", () => {
		expect(parseInboundFrame("not json")).toBeNull();
	});

	it("returns null when data items have no instId", () => {
		expect(
			parseInboundFrame(
				JSON.stringify({
					arg: { channel: "tickers" },
					data: [{ last: "1" }],
				}),
			),
		).toBeNull();
	});
});

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const parseControl = (raw: string) =>
	JSON.parse(raw) as {
		id: string;
		op: string;
		args: Array<{ channel: string; instId: string }>;
	};

const baseConfig: OkxModuleConfig = {
	name: "okx",
	type: "okx",
	wsUrl: "wss://ws.okx.test/ws/v5/public",
	subscriptionSymbols: ["BTC-USDT", "ETH-USDT"],
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
	config: OkxModuleConfig,
	preSubscribed: string[] = config.subscriptionSymbols,
	reconnectSchedule: Schedule.Schedule<
		unknown,
		unknown,
		never
	> = Schedule.spaced(Duration.minutes(10)),
) =>
	Effect.gen(function* () {
		const cache = yield* createPriceCache<string, OkxPriceFrame>();
		const ws = yield* createOkxWS(config, cache, reconnectSchedule);
		yield* ws.subscribe(preSubscribed);
		const fiber = yield* ws.start();
		return { cache, ws, fiber };
	}).pipe(Logger.withMinimumLogLevel(LogLevel.None));

describe("createOkxWS", () => {
	it("opens the WS at the configured url and batches the subscribe on open", async () => {
		const { fiber, ws: service } = await Effect.runPromise(
			startService(baseConfig),
		);
		await flush();

		expect(FakeWebSocket.instances.length).toBe(1);
		const ws = FakeWebSocket.instances[0];
		expect(ws.url).toBe("wss://ws.okx.test/ws/v5/public");

		ws.triggerOpen();
		await flush();

		expect(ws.sent.length).toBe(1);
		const frame = parseControl(ws.sent[0]);
		expect(frame.op).toBe("subscribe");
		expect(frame.args).toEqual([
			{ channel: "tickers", instId: "BTC-USDT" },
			{ channel: "tickers", instId: "ETH-USDT" },
		]);
		expect(typeof frame.id).toBe("string");
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

		const price = await Effect.runPromise(cache.getOrWaitPrice("BTC-USDT"));
		expect(price).toEqual(btcTicker);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("drops inbound frames for symbols not in the desired set", async () => {
		const { cache, fiber } = await Effect.runPromise(
			startService(baseConfig, ["BTC-USDT"]),
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
				event: "subscribe",
				arg: { channel: "tickers", instId: "BTC-USDT" },
			}),
		);
		ws.triggerMessage("pong");
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
			service.subscribe(["BTC-USDT", "ETH-USDT", "SOL-USDT"]),
		);
		await flush();

		expect(ws.sent.length).toBe(1);
		const frame = parseControl(ws.sent[0]);
		expect(frame.op).toBe("subscribe");
		expect(frame.args).toEqual([
			{ channel: "tickers", instId: "BTC-USDT" },
			{ channel: "tickers", instId: "ETH-USDT" },
			{ channel: "tickers", instId: "SOL-USDT" },
		]);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("unsubscribe removes the symbol and sends an unsubscribe frame", async () => {
		const { ws: service, fiber } = await Effect.runPromise(
			startService(baseConfig, ["BTC-USDT"]),
		);
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();
		expect(ws.sent.length).toBe(1);

		await Effect.runPromise(service.unsubscribe(["ETH-USDT"]));
		await flush();
		expect(ws.sent.length).toBe(1);

		await Effect.runPromise(service.unsubscribe(["BTC-USDT"]));
		await flush();
		expect(ws.sent.length).toBe(2);
		const frame = parseControl(ws.sent[1]);
		expect(frame.op).toBe("unsubscribe");
		expect(frame.args).toEqual([{ channel: "tickers", instId: "BTC-USDT" }]);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("sends a ping keepalive on the configured interval", async () => {
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
