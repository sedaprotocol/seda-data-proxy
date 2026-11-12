import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Duration, Effect, Fiber, LogLevel, Logger, Schedule } from "effect";
import type { BinanceFuturesModuleConfig } from "../../config/binance-futures-module-config";
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
	createBinanceFuturesWS,
	parseInboundFrame,
} from "./binance-futures";

type DepthRestSnapshot = {
	lastUpdateId: number;
	bids: Array<[string, string]>;
	asks: Array<[string, string]>;
};

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
		expect(buildStreamName("BTCUSDT", "depth")).toBe("btcusdt@depth");
		expect(buildStreamName("BTCUSDT", "depth@500ms")).toBe(
			"btcusdt@depth@500ms",
		);
		expect(buildStreamName("BTCUSDT", "depth@100ms")).toBe(
			"btcusdt@depth@100ms",
		);
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
		expect(parseInboundFrame(raw, "bookTicker")).toEqual({
			kind: "tickers",
			frames: [{ key: "BTCUSDT", frame: btcBook }],
		});
	});

	it("accepts a bare (raw-stream) payload", () => {
		expect(parseInboundFrame(JSON.stringify(ethBook), "bookTicker")).toEqual({
			kind: "tickers",
			frames: [{ key: "ETHUSDT", frame: ethBook }],
		});
	});

	it("uppercases the symbol so cache keys stay consistent", () => {
		const result = parseInboundFrame(
			JSON.stringify({ s: "btcusdt", b: "1" }),
			"bookTicker",
		);
		expect(result).toMatchObject({
			kind: "tickers",
			frames: [{ key: "BTCUSDT" }],
		});
	});

	it("returns null for a control ack with no symbol", () => {
		expect(
			parseInboundFrame(JSON.stringify({ result: null, id: 1 }), "bookTicker"),
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
				"bookTicker",
			),
		).toEqual({
			kind: "error",
			code: 3,
			message: "Invalid JSON: key must be a string at line 1 column 2",
		});
	});

	it("returns null for malformed JSON", () => {
		expect(parseInboundFrame("not json", "bookTicker")).toBeNull();
	});

	it("returns null when the payload has no string symbol", () => {
		expect(
			parseInboundFrame(JSON.stringify({ b: "1", a: "2" }), "bookTicker"),
		).toBeNull();
	});
});

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const parseControl = (raw: string) =>
	JSON.parse(raw) as { method: string; params: string[]; id: number };

const baseConfig: BinanceFuturesModuleConfig = {
	name: "binance-futures",
	type: "binance-futures",
	wsUrl: "wss://fstream.binance.test/stream",
	streamType: "bookTicker",
	subscriptionSymbols: ["BTCUSDT", "ETHUSDT"],
	maxSymbolsPerRequest: 100,
	maxMessages: 10,
	maxMessagesWindow: Duration.seconds(1),
	reconnectMaxBackoff: Duration.seconds(30),
	reconnectStableThreshold: Duration.seconds(30),
	symbolsCleanupTtl: Duration.minutes(2),
	symbolsCleanupInterval: Duration.seconds(30),
	tradesKeepSeconds: 60,
};

let restoreWebSocket: (() => void) | undefined;

beforeEach(() => {
	restoreWebSocket = installFakeWebSocket();
});

afterEach(() => {
	restoreWebSocket?.();
});

const startService = (
	config: BinanceFuturesModuleConfig,
	preSubscribed: string[] = config.subscriptionSymbols,
	reconnectSchedule: Schedule.Schedule<
		unknown,
		unknown,
		never
	> = Schedule.spaced(Duration.minutes(10)),
) =>
	Effect.gen(function* () {
		const cache = yield* createPriceCache<string, BinancePriceFrame>();
		const ws = yield* createBinanceFuturesWS(config, cache, reconnectSchedule);
		yield* ws.subscribe(preSubscribed);
		const fiber = yield* ws.start();
		return { cache, ws, fiber };
	}).pipe(Logger.withMinimumLogLevel(LogLevel.None));

describe("createBinanceFuturesWS", () => {
	it("opens the WS at the configured url and batches the subscribe on open", async () => {
		const { fiber, ws: service } = await Effect.runPromise(
			startService(baseConfig),
		);
		await flush();

		expect(FakeWebSocket.instances.length).toBe(1);
		const ws = FakeWebSocket.instances[0];
		expect(ws.url).toBe("wss://fstream.binance.test/stream");

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

const depthUpdate = (
	symbol: string,
	U: number,
	u: number,
	pu: number,
	b: Array<[string, string]> = [],
	a: Array<[string, string]> = [],
) =>
	JSON.stringify({
		stream: `${symbol.toLowerCase()}@depth@100ms`,
		data: { e: "depthUpdate", s: symbol, U, u, pu, b, a },
	});

const createSnapshotFeed = () => {
	const pending: Array<{
		resolve: (book: DepthRestSnapshot) => void;
		reject: (error: Error) => void;
	}> = [];
	const queued: DepthRestSnapshot[] = [];
	let calls = 0;
	const original = globalThis.fetch;
	globalThis.fetch = (async (_input, init) => {
		calls += 1;
		const signal = init?.signal ?? undefined;
		const book = await new Promise<DepthRestSnapshot>((resolve, reject) => {
			const abort = () => {
				reject(new DOMException("The operation was aborted", "AbortError"));
			};
			if (signal?.aborted) {
				abort();
				return;
			}
			const next = queued.shift();
			if (next !== undefined) {
				resolve(next);
				return;
			}
			const waiter = { resolve, reject };
			pending.push(waiter);
			signal?.addEventListener(
				"abort",
				() => {
					const index = pending.indexOf(waiter);
					if (index !== -1) pending.splice(index, 1);
					abort();
				},
				{ once: true },
			);
		});
		return new Response(JSON.stringify(book), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;

	const deliver = (book: DepthRestSnapshot) => {
		const waiter = pending.shift();
		if (waiter !== undefined) waiter.resolve(book);
		else queued.push(book);
	};
	return {
		deliver,
		calls: () => calls,
		restore: () => {
			globalThis.fetch = original;
		},
	};
};

describe("createBinanceFuturesWS depth", () => {
	const depthConfig: BinanceFuturesModuleConfig = {
		...baseConfig,
		streamType: "depth@100ms",
		subscriptionSymbols: ["BTCUSDT"],
	};
	let restoreFetch: (() => void) | undefined;

	afterEach(() => {
		restoreFetch?.();
		restoreFetch = undefined;
	});

	const startDepth = (
		feed: ReturnType<typeof createSnapshotFeed>,
		preSubscribed: string[] = ["BTCUSDT"],
	) =>
		Effect.gen(function* () {
			restoreFetch = feed.restore;
			const cache = yield* createPriceCache<string, BinancePriceFrame>();
			const ws = yield* createBinanceFuturesWS(
				depthConfig,
				cache,
				Schedule.spaced(Duration.minutes(10)),
			);
			yield* ws.subscribe(preSubscribed);
			const fiber = yield* ws.start();
			return { cache, ws, fiber };
		}).pipe(Logger.withMinimumLogLevel(LogLevel.None));

	it("subscribes to the depth stream and waits to publish until a diff bridges the snapshot", async () => {
		const feed = createSnapshotFeed();
		const { cache, fiber } = await Effect.runPromise(startDepth(feed));
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();

		expect(parseControl(ws.sent[0]).params).toEqual(["btcusdt@depth@100ms"]);
		expect(feed.calls()).toBe(1);
		expect(cache.size()).toBe(0);

		// Bridges the upcoming snapshot (lastUpdateId=100): U <= 100 <= u.
		ws.triggerMessage(
			depthUpdate("BTCUSDT", 95, 102, 94, [
				["1", "0"],
				["3", "1"],
			]),
		);
		await flush();
		expect(cache.size()).toBe(0);

		feed.deliver({
			lastUpdateId: 100,
			bids: [
				["1", "5"],
				["3", "1"],
			],
			asks: [["2", "5"]],
		});
		await flush();

		expect(await Effect.runPromise(cache.getOrWaitPrice("BTCUSDT"))).toEqual({
			s: "BTCUSDT",
			lastUpdateId: 102,
			bids: [["3", "1"]],
			asks: [["2", "5"]],
		});

		// Continues via pu === 102 (the prior event's u).
		ws.triggerMessage(depthUpdate("BTCUSDT", 103, 103, 102, [], [["2", "9"]]));
		await flush();
		expect(feed.calls()).toBe(1);
		expect(await Effect.runPromise(cache.getOrWaitPrice("BTCUSDT"))).toEqual({
			s: "BTCUSDT",
			lastUpdateId: 103,
			bids: [["3", "1"]],
			asks: [["2", "9"]],
		});

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("refetches the snapshot after a pu mismatch and keeps the gapped diff", async () => {
		const feed = createSnapshotFeed();
		const { cache, fiber } = await Effect.runPromise(startDepth(feed));
		await flush();
		FakeWebSocket.instances[0].triggerOpen();
		await flush();

		feed.deliver({ lastUpdateId: 100, bids: [["1", "5"]], asks: [] });
		await flush();
		FakeWebSocket.instances[0].triggerMessage(
			depthUpdate("BTCUSDT", 99, 101, 98, [["1", "8"]]),
		);
		await flush();
		expect(cache.getCached("BTCUSDT")).toMatchObject({ lastUpdateId: 101 });

		// pu should be 101; a mismatch means at least one update was missed.
		FakeWebSocket.instances[0].triggerMessage(
			depthUpdate("BTCUSDT", 110, 111, 109, [["8", "1"]]),
		);
		await flush();
		expect(cache.getCached("BTCUSDT")).toBeUndefined();
		expect(feed.calls()).toBe(2);

		// Unlike Spot's "+1" allowance, the new snapshot must land inside the
		// gapped diff's own [U, u] range (110..111) to bridge.
		feed.deliver({ lastUpdateId: 110, bids: [["1", "5"]], asks: [] });
		await flush();
		expect(await Effect.runPromise(cache.getOrWaitPrice("BTCUSDT"))).toEqual({
			s: "BTCUSDT",
			lastUpdateId: 111,
			bids: [
				["8", "1"],
				["1", "5"],
			],
			asks: [],
		});

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("drops a snapshot that arrives after unsubscribe", async () => {
		const feed = createSnapshotFeed();
		const {
			cache,
			ws: service,
			fiber,
		} = await Effect.runPromise(startDepth(feed));
		await flush();
		FakeWebSocket.instances[0].triggerOpen();
		await flush();
		expect(feed.calls()).toBe(1);

		await Effect.runPromise(service.unsubscribe(["BTCUSDT"]));
		await flush();
		feed.deliver({ lastUpdateId: 100, bids: [["1", "5"]], asks: [] });
		await flush();
		FakeWebSocket.instances[0].triggerMessage(
			depthUpdate("BTCUSDT", 99, 101, 98, [["1", "8"]]),
		);
		await flush();

		expect(cache.size()).toBe(0);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});
});
