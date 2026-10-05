import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Duration, Effect, Fiber, LogLevel, Logger, Schedule } from "effect";
import type { LighterModuleConfig } from "../../config/lighter-module-config";
import { createPriceCache } from "../shared/price-cache";
import {
	type LighterPriceFrame,
	PING_FRAME,
	PONG_FRAME,
	buildSubscribeFrame,
	buildUnsubscribeFrame,
	createLighterWS,
	parseInboundFrame,
} from "./lighter";

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
		expect(JSON.parse(buildSubscribeFrame(1, "ticker"))).toEqual({
			type: "subscribe",
			channel: "ticker/1",
		});
		expect(JSON.parse(buildUnsubscribeFrame(42, "ticker"))).toEqual({
			type: "unsubscribe",
			channel: "ticker/42",
		});
	});

	it("uses the configured stream type in the channel", () => {
		expect(JSON.parse(buildSubscribeFrame(0, "order_book"))).toEqual({
			type: "subscribe",
			channel: "order_book/0",
		});
		expect(JSON.parse(buildUnsubscribeFrame(0, "trade"))).toEqual({
			type: "unsubscribe",
			channel: "trade/0",
		});
	});
});

const inboundCache = Effect.runSync(
	createPriceCache<number, LighterPriceFrame>(),
);

const snapshotBook = {
	code: 0,
	asks: [
		{ price: "10", size: "1" },
		{ price: "11", size: "2" },
	],
	bids: [
		{ price: "9", size: "3" },
		{ price: "8", size: "4" },
	],
	nonce: 10,
	begin_nonce: 1,
	offset: 1,
};

describe("parseInboundFrame", () => {
	it("extracts market id and verbatim frame from an update/ticker", () => {
		expect(
			parseInboundFrame(tickerMessage(1, "BTC"), "ticker", inboundCache),
		).toEqual({
			kind: "tickers",
			frames: [{ key: 1, frame: innerTicker("BTC") }],
		});
	});

	it("treats the subscribed/ticker snapshot the same as an update", () => {
		const parsed = parseInboundFrame(
			tickerMessage(2, "ETH", "subscribed/ticker"),
			"ticker",
			inboundCache,
		);
		expect(parsed).toEqual({
			kind: "tickers",
			frames: [{ key: 2, frame: innerTicker("ETH") }],
		});
	});

	it("classifies a keepalive ping", () => {
		expect(
			parseInboundFrame(
				JSON.stringify({ type: "ping" }),
				"ticker",
				inboundCache,
			),
		).toEqual({
			kind: "ping",
		});
	});

	it("returns null for the connected control frame", () => {
		expect(
			parseInboundFrame(
				JSON.stringify({ session_id: "x", type: "connected" }),
				"ticker",
				inboundCache,
			),
		).toBeNull();
	});

	it("classifies a venue error frame", () => {
		expect(
			parseInboundFrame(
				JSON.stringify({ error: { code: 30005, message: "Invalid Channel" } }),
				"ticker",
				inboundCache,
			),
		).toEqual({
			kind: "error",
			code: 30005,
			message: "Invalid Channel",
		});
	});

	it("classifies rate-limit error frames", () => {
		expect(
			parseInboundFrame(
				JSON.stringify({
					error: { code: 30010, message: "Too Many Inflight Messages!" },
				}),
				"ticker",
				inboundCache,
			),
		).toEqual({
			kind: "error",
			code: 30010,
			message: "Too Many Inflight Messages!",
		});
	});

	it("returns null for malformed JSON", () => {
		expect(parseInboundFrame("not json", "ticker", inboundCache)).toBeNull();
	});

	it("ignores an order_book diff when no book is cached", () => {
		const orderBook = {
			code: 0,
			asks: [{ price: "2064.54", size: "0.3285" }],
			bids: [{ price: "2064.53", size: "1.0" }],
			nonce: 11,
			begin_nonce: 10,
		};
		expect(
			parseInboundFrame(
				JSON.stringify({
					channel: "order_book:0",
					order_book: orderBook,
					type: "update/order_book",
				}),
				"order_book",
				inboundCache,
			),
		).toEqual({
			kind: "tickers",
			frames: [{ key: 0, frame: orderBook, action: "ignore" }],
		});
	});

	it("extracts a subscribed/order_book snapshot", () => {
		const orderBook = {
			code: 0,
			asks: [{ price: "10", size: "1" }],
			bids: [{ price: "9", size: "2" }],
			nonce: 10,
			begin_nonce: 1,
		};
		expect(
			parseInboundFrame(
				JSON.stringify({
					channel: "order_book:0",
					order_book: orderBook,
					type: "subscribed/order_book",
				}),
				"order_book",
				inboundCache,
			),
		).toEqual({
			kind: "tickers",
			frames: [{ key: 0, frame: orderBook, action: "write" }],
		});
	});

	it("returns null for an order_book frame with no snapshot or update type", () => {
		expect(
			parseInboundFrame(
				JSON.stringify({
					channel: "order_book:0",
					order_book: { asks: [], bids: [], nonce: 1 },
				}),
				"order_book",
				inboundCache,
			),
		).toBeNull();
	});

	it("extracts trade arrays when that stream is configured", () => {
		const trades = [{ trade_id: 1, price: "2181.83", size: "0.1336" }];
		expect(
			parseInboundFrame(
				JSON.stringify({
					channel: "trade:0",
					trades,
					liquidation_trades: [],
					type: "update/trade",
				}),
				"trade",
				inboundCache,
			),
		).toEqual({
			kind: "tickers",
			frames: [{ key: 0, frame: { trades, liquidation_trades: [] } }],
		});
	});

	it("returns null when the channel prefix does not match the stream type", () => {
		expect(
			parseInboundFrame(tickerMessage(1, "BTC"), "order_book", inboundCache),
		).toBeNull();
	});

	it("replaces the book on a snapshot and drops zero-size levels", () => {
		const orderBook = {
			...snapshotBook,
			asks: [
				{ price: "10", size: "1" },
				{ price: "11", size: "0" },
			],
		};
		expect(
			parseInboundFrame(
				JSON.stringify({
					channel: "order_book:0",
					order_book: orderBook,
					type: "subscribed/order_book",
				}),
				"order_book",
				inboundCache,
			),
		).toEqual({
			kind: "tickers",
			frames: [
				{
					key: 0,
					action: "write",
					frame: {
						...snapshotBook,
						asks: [{ price: "10", size: "1" }],
					},
				},
			],
		});
	});

	it("merges a continuous diff and removes a price when size is 0", () => {
		const cache = Effect.runSync(createPriceCache<number, LighterPriceFrame>());
		cache.setPriceSync(0, snapshotBook);
		const orderBook = {
			code: 0,
			asks: [
				{ price: "11", size: "0.0000" },
				{ price: "12", size: "5" },
			],
			bids: [{ price: "9", size: "1.7387" }],
			nonce: 11,
			begin_nonce: 10,
			offset: 2,
		};
		expect(
			parseInboundFrame(
				JSON.stringify({
					channel: "order_book:0",
					order_book: orderBook,
					type: "update/order_book",
				}),
				"order_book",
				cache,
			),
		).toEqual({
			kind: "tickers",
			frames: [
				{
					key: 0,
					action: "write",
					frame: {
						code: 0,
						asks: [
							{ price: "10", size: "1" },
							{ price: "12", size: "5" },
						],
						bids: [
							{ price: "9", size: "1.7387" },
							{ price: "8", size: "4" },
						],
						nonce: 11,
						begin_nonce: 10,
						offset: 2,
					},
				},
			],
		});
	});

	it("asks for a resubscribe when begin_nonce does not match", () => {
		const cache = Effect.runSync(createPriceCache<number, LighterPriceFrame>());
		cache.setPriceSync(0, snapshotBook);
		const orderBook = {
			asks: [],
			bids: [],
			nonce: 100,
			begin_nonce: 99,
		};
		expect(
			parseInboundFrame(
				JSON.stringify({
					channel: "order_book:0",
					order_book: orderBook,
					type: "update/order_book",
				}),
				"order_book",
				cache,
			),
		).toEqual({
			kind: "tickers",
			frames: [{ key: 0, frame: orderBook, action: "resubscribe" }],
		});
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

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const baseConfig: LighterModuleConfig = {
	name: "lighter",
	type: "lighter",
	wsUrl: "wss://lighter.test/stream",
	subscriptionSymbols: [],
	maxSymbolsPerRequest: 100,
	maxMessages: 180,
	maxMessagesWindow: Duration.minutes(1),
	keepaliveInterval: Duration.seconds(60),
	reconnectMaxBackoff: Duration.seconds(30),
	reconnectStableThreshold: Duration.seconds(30),
	symbolsCleanupTtl: Duration.hours(1),
	symbolsCleanupInterval: Duration.seconds(30),
	streamType: "ticker",
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
	reconnectSchedule?: Schedule.Schedule<unknown, unknown, never>,
) =>
	Effect.gen(function* () {
		const cache = yield* createPriceCache<number, LighterPriceFrame>();
		const ws = yield* createLighterWS(
			config,
			cache,
			reconnectSchedule ?? Schedule.spaced(Duration.minutes(10)),
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

		expect(ws.sent).toEqual([
			buildSubscribeFrame(1, "ticker"),
			buildSubscribeFrame(2, "ticker"),
		]);

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

		expect(ws.sent).toEqual([PONG_FRAME]);

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

		expect(
			ws.sent.filter((frame) => frame === PING_FRAME).length,
		).toBeGreaterThan(0);

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
		expect(ws.sent).toEqual([buildSubscribeFrame(1, "ticker")]);

		await Effect.runPromise(service.subscribe([1]));
		await Effect.runPromise(service.subscribe([1]));
		await flush();

		expect(ws.sent).toEqual([buildSubscribeFrame(1, "ticker")]);

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

		await Effect.runPromise(service.unsubscribe([2]));
		await flush();
		expect(ws.sent).toEqual([buildSubscribeFrame(1, "ticker")]);

		await Effect.runPromise(service.unsubscribe([1]));
		await flush();
		expect(ws.sent).toEqual([
			buildSubscribeFrame(1, "ticker"),
			buildUnsubscribeFrame(1, "ticker"),
		]);

		await Effect.runPromise(service.unsubscribe([1]));
		await flush();
		expect(ws.sent).toEqual([
			buildSubscribeFrame(1, "ticker"),
			buildUnsubscribeFrame(1, "ticker"),
		]);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("reconnects after a close and re-subscribes every desired market", async () => {
		const { fiber } = await Effect.runPromise(
			startService(baseConfig, [1, 2], Schedule.spaced(Duration.millis(10))),
		);
		await flush();
		const ws1 = FakeWebSocket.instances[0];
		ws1.triggerOpen();
		await flush();
		expect(ws1.sent).toEqual([
			buildSubscribeFrame(1, "ticker"),
			buildSubscribeFrame(2, "ticker"),
		]);

		ws1.triggerClose();
		await new Promise<void>((r) => setTimeout(r, 40));

		expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
		const ws2 = FakeWebSocket.instances[1];
		expect(ws2).not.toBe(ws1);
		ws2.triggerOpen();
		await flush();

		expect(ws2.sent).toEqual([
			buildSubscribeFrame(1, "ticker"),
			buildSubscribeFrame(2, "ticker"),
		]);

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
			startService(baseConfig, [1], Schedule.spaced(Duration.millis(10))),
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

		expect(ws2.sent).toEqual([buildSubscribeFrame(1, "ticker")]);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("keeps a local order book and resubscribes when begin_nonce gaps", async () => {
		const { cache, fiber } = await Effect.runPromise(
			startService({ ...baseConfig, streamType: "order_book" }, [0]),
		);
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();

		ws.triggerMessage(
			JSON.stringify({
				channel: "order_book:0",
				type: "update/order_book",
				order_book: {
					asks: [{ price: "11", size: "0" }],
					bids: [],
					nonce: 11,
					begin_nonce: 10,
				},
			}),
		);
		await flush();
		expect(cache.size()).toBe(0);
		expect(ws.sent).toEqual([buildSubscribeFrame(0, "order_book")]);

		ws.triggerMessage(
			JSON.stringify({
				channel: "order_book:0",
				type: "subscribed/order_book",
				order_book: snapshotBook,
			}),
		);
		ws.triggerMessage(
			JSON.stringify({
				channel: "order_book:0",
				type: "update/order_book",
				order_book: {
					code: 0,
					asks: [
						{ price: "11", size: "0" },
						{ price: "12", size: "5" },
					],
					bids: [{ price: "9", size: "7" }],
					nonce: 11,
					begin_nonce: 10,
					offset: 2,
				},
			}),
		);
		await flush();

		expect(await Effect.runPromise(cache.getOrWaitPrice(0))).toEqual({
			code: 0,
			asks: [
				{ price: "10", size: "1" },
				{ price: "12", size: "5" },
			],
			bids: [
				{ price: "9", size: "7" },
				{ price: "8", size: "4" },
			],
			nonce: 11,
			begin_nonce: 10,
			offset: 2,
		});

		ws.triggerMessage(
			JSON.stringify({
				channel: "order_book:0",
				type: "update/order_book",
				order_book: {
					asks: [],
					bids: [],
					nonce: 100,
					begin_nonce: 99,
				},
			}),
		);
		await flush();

		expect(cache.size()).toBe(0);
		expect(ws.sent.slice(-2)).toEqual([
			buildUnsubscribeFrame(0, "order_book"),
			buildSubscribeFrame(0, "order_book"),
		]);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("paces outbound frames to stay under maxMessages per maxMessagesWindow", async () => {
		const { fiber } = await Effect.runPromise(
			startService(
				{ ...baseConfig, maxMessages: 6 },
				[1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
			),
		);
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();

		expect(ws.sent).toEqual([
			buildSubscribeFrame(1, "ticker"),
			buildSubscribeFrame(2, "ticker"),
			buildSubscribeFrame(3, "ticker"),
			buildSubscribeFrame(4, "ticker"),
			buildSubscribeFrame(5, "ticker"),
			buildSubscribeFrame(6, "ticker"),
		]);
		await new Promise<void>((r) => setTimeout(r, 50));
		expect(ws.sent).toEqual([
			buildSubscribeFrame(1, "ticker"),
			buildSubscribeFrame(2, "ticker"),
			buildSubscribeFrame(3, "ticker"),
			buildSubscribeFrame(4, "ticker"),
			buildSubscribeFrame(5, "ticker"),
			buildSubscribeFrame(6, "ticker"),
		]);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});
});
