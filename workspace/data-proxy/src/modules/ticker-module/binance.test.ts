import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	Duration,
	Effect,
	LogLevel,
	Logger,
	TestClock,
	TestContext,
} from "effect";
import * as v from "valibot";
import {
	type BinanceModuleConfig,
	BinanceModuleRouteSchema,
} from "../../config/binance-module-config";
import { ModuleService } from "../module";
import {
	FakeWebSocket,
	installFakeWebSocket,
} from "../shared/fake-websocket.test-helpers";
import { BinanceModuleService } from "./binance";
import type { BinancePriceFrame } from "./binance";

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

const baseConfig: BinanceModuleConfig = {
	name: "binance",
	type: "binance",
	wsUrl: "wss://stream.binance.test/stream",
	streamType: "bookTicker",
	subscriptionSymbols: [],
	maxSymbolsPerRequest: 100,
	maxMessages: 5,
	maxMessagesWindow: Duration.seconds(1),
	reconnectMaxBackoff: Duration.seconds(30),
	reconnectStableThreshold: Duration.seconds(30),
	symbolsCleanupTtl: Duration.minutes(2),
	symbolsCleanupInterval: Duration.seconds(30),
	tradesKeepSeconds: 60,
};

const buildRoute = () =>
	v.parse(BinanceModuleRouteSchema, {
		type: "binance",
		moduleName: "binance",
		path: "/price/:symbols",
		fetchFromModule: "{:symbols}",
		method: ["GET"],
	});

const dummyRequest = new Request("http://proxy.local/price/x", {
	method: "GET",
});

const parseControl = (raw: string) =>
	JSON.parse(raw) as { method: string; params: string[]; id: number };

const waitFor = async (
	predicate: () => boolean,
	label: string,
	timeoutMs = 2000,
) => {
	for (let i = 0; i < timeoutMs; i++) {
		if (predicate()) return;
		await new Promise<void>((r) => setTimeout(r, 1));
	}
	throw new Error(`Timed out waiting for ${label}`);
};

const subscribeFrames = (ws: FakeWebSocket) =>
	ws.sent.filter((raw) => parseControl(raw).method === "SUBSCRIBE");

let restoreWebSocket: (() => void) | undefined;

beforeEach(() => {
	restoreWebSocket = installFakeWebSocket();
});

afterEach(() => {
	restoreWebSocket?.();
});

describe("BinanceModuleService.handleRequest", () => {
	it("subscribes new symbols, returns seeded prices, and flags unseeded ones", async () => {
		const route = buildRoute();
		const params = { symbols: "ETHUSDT,BTCUSDT,DOGEUSDT" };

		const program = Effect.gen(function* () {
			const svc = yield* ModuleService;
			yield* svc.start();
			return yield* svc.handleRequest(route, params, dummyRequest);
		}).pipe(
			Effect.provide(BinanceModuleService(baseConfig)),
			Logger.withMinimumLogLevel(LogLevel.None),
		);

		const resultPromise = Effect.runPromise(program);

		await waitFor(
			() => FakeWebSocket.instances.length >= 1,
			"WebSocket instance",
		);
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		// A subscribe frame proves all three symbols reached the desired set.
		await waitFor(() => ws.sent.length >= 1, "subscribe frame");
		expect(parseControl(ws.sent[0]).params).toEqual([
			"ethusdt@bookTicker",
			"btcusdt@bookTicker",
			"dogeusdt@bookTicker",
		]);

		ws.triggerMessage(
			JSON.stringify({ stream: "ethusdt@bookTicker", data: ethBook }),
		);
		ws.triggerMessage(
			JSON.stringify({ stream: "btcusdt@bookTicker", data: btcBook }),
		);

		const response = await resultPromise;
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toEqual([
			{ symbol: "ETHUSDT", ...ethBook, __sedaHasPrice: true },
			{ symbol: "BTCUSDT", ...btcBook, __sedaHasPrice: true },
			{ symbol: "DOGEUSDT", __sedaHasPrice: false },
		]);
	}, 10_000);

	it("does not re-subscribe a symbol already requested", async () => {
		const route = buildRoute();
		const params = { symbols: "BTCUSDT" };

		const program = Effect.gen(function* () {
			const svc = yield* ModuleService;
			yield* svc.start();
			const r1 = yield* svc.handleRequest(route, params, dummyRequest);
			const r2 = yield* svc.handleRequest(route, params, dummyRequest);
			return [r1, r2] as const;
		}).pipe(
			Effect.provide(BinanceModuleService(baseConfig)),
			Logger.withMinimumLogLevel(LogLevel.None),
		);

		const resultPromise = Effect.runPromise(program);

		await waitFor(
			() => FakeWebSocket.instances.length >= 1,
			"WebSocket instance",
		);
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await waitFor(() => ws.sent.length >= 1, "subscribe frame");
		ws.triggerMessage(
			JSON.stringify({ stream: "btcusdt@bookTicker", data: btcBook }),
		);

		const [r1, r2] = await resultPromise;
		expect(r1.status).toBe(200);
		expect(r2.status).toBe(200);
		// Only the first request subscribes; the repeat is served from cache.
		expect(subscribeFrames(ws).length).toBe(1);
	});

	it("stops vouching for cached prices once the socket has errored", async () => {
		const route = buildRoute();
		const params = { symbols: "BTCUSDT" };

		const program = Effect.gen(function* () {
			const svc = yield* ModuleService;
			yield* svc.start();
			const fresh = yield* svc.handleRequest(route, params, dummyRequest);
			// Socket drops; the ws-client flags hasError until it reconnects.
			FakeWebSocket.instances[0].close();
			const afterError = yield* svc.handleRequest(route, params, dummyRequest);
			return [fresh, afterError] as const;
		}).pipe(
			Effect.provide(BinanceModuleService(baseConfig)),
			Logger.withMinimumLogLevel(LogLevel.None),
		);

		const resultPromise = Effect.runPromise(program);

		await waitFor(
			() => FakeWebSocket.instances.length >= 1,
			"WebSocket instance",
		);
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await waitFor(() => ws.sent.length >= 1, "subscribe frame");
		ws.triggerMessage(
			JSON.stringify({ stream: "btcusdt@bookTicker", data: btcBook }),
		);

		const [fresh, afterError] = await resultPromise;
		const freshBody = await fresh.json();
		expect(freshBody[0].__sedaHasPrice).toBe(true);
		// Same symbol is still cached, but the unhealthy socket means it is no
		// longer presented as a live price.
		const afterBody = await afterError.json();
		expect(afterBody).toEqual([{ symbol: "BTCUSDT", __sedaHasPrice: false }]);
	}, 10_000);

	it("keeps a trade window and drops aged trades when the request is served", async () => {
		const route = buildRoute();
		const config: BinanceModuleConfig = {
			...baseConfig,
			streamType: "trade",
			tradesKeepSeconds: 60,
			subscriptionSymbols: ["BTCUSDT"],
		};
		const tradeAt = (id: number, time: number) => ({
			e: "trade",
			E: time,
			s: "BTCUSDT",
			t: id,
			p: "67123.44",
			q: "0.01",
			T: time,
			m: false,
			M: true,
		});

		const program = Effect.gen(function* () {
			const now = yield* TestClock.currentTimeMillis;
			const early = tradeAt(1, now - 50_000);
			const mid = tradeAt(2, now - 5_000);
			const fresh = tradeAt(4, now - 1_000);
			const svc = yield* ModuleService;
			yield* svc.start();

			let ws: FakeWebSocket | undefined;
			for (let i = 0; i < 100 && ws === undefined; i++) {
				ws = FakeWebSocket.instances[0];
				if (ws === undefined) yield* Effect.yieldNow();
			}
			if (ws === undefined) throw new Error("Timed out waiting for WebSocket");
			ws.triggerOpen();
			yield* Effect.yieldNow();
			ws.triggerMessage(
				JSON.stringify({ stream: "btcusdt@trade", data: early }),
			);
			ws.triggerMessage(
				JSON.stringify({
					stream: "btcusdt@trade",
					data: { e: "trade", s: "BTCUSDT", t: 7, p: "1", q: "1" },
				}),
			);
			ws.triggerMessage(JSON.stringify({ stream: "btcusdt@trade", data: mid }));
			ws.triggerMessage(
				JSON.stringify({
					stream: "btcusdt@trade",
					data: tradeAt(3, now - 70_000),
				}),
			);
			ws.triggerMessage(
				JSON.stringify({ stream: "btcusdt@trade", data: fresh }),
			);

			const request = () =>
				Effect.gen(function* () {
					const response = yield* svc.handleRequest(
						route,
						{ symbols: "BTCUSDT" },
						dummyRequest,
					);
					return yield* Effect.promise(() => response.json());
				});

			const withinWindow = yield* request();
			yield* TestClock.adjust(Duration.seconds(50));
			const partlyAged = yield* request();
			yield* TestClock.adjust(Duration.seconds(20));
			const agedOut = yield* request();
			return { withinWindow, partlyAged, agedOut, early, mid, fresh };
		});

		const { withinWindow, partlyAged, agedOut, early, mid, fresh } =
			await Effect.runPromise(
				program.pipe(
					Effect.provide(BinanceModuleService(config)),
					Effect.provide(TestContext.TestContext),
					Logger.withMinimumLogLevel(LogLevel.None),
				),
			);

		expect(withinWindow).toEqual([
			{
				s: "BTCUSDT",
				trades: [early, mid, fresh],
				symbol: "BTCUSDT",
				__sedaHasPrice: true,
			},
		]);
		expect(partlyAged).toEqual([
			{
				s: "BTCUSDT",
				trades: [mid, fresh],
				symbol: "BTCUSDT",
				__sedaHasPrice: true,
			},
		]);
		expect(agedOut).toEqual([
			{
				s: "BTCUSDT",
				trades: [],
				symbol: "BTCUSDT",
				__sedaHasPrice: true,
			},
		]);
	});

	it("rejects when more symbols than maxSymbolsPerRequest are requested", async () => {
		const route = buildRoute();
		const config: BinanceModuleConfig = {
			...baseConfig,
			maxSymbolsPerRequest: 2,
		};

		const program = Effect.gen(function* () {
			const svc = yield* ModuleService;
			return yield* svc.handleRequest(
				route,
				{ symbols: "BTCUSDT,ETHUSDT,SOLUSDT" },
				dummyRequest,
			);
		}).pipe(
			Effect.provide(BinanceModuleService(config)),
			Logger.withMinimumLogLevel(LogLevel.None),
		);

		const response = await Effect.runPromise(program);
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.moduleName).toBe("binance");
		expect(body.data_proxy_error).toContain("binance");
		expect(body.data_proxy_error).toContain("max is 2");
		expect(body.data_proxy_error).toContain("got 3");
	});
});

describe("BinanceModuleService lifecycle", () => {
	it("seeds subscriptionSymbols on start", async () => {
		const config: BinanceModuleConfig = {
			...baseConfig,
			subscriptionSymbols: ["BTCUSDT", "ETHUSDT"],
		};

		const program = Effect.gen(function* () {
			const svc = yield* ModuleService;
			yield* svc.start();
		}).pipe(
			Effect.provide(BinanceModuleService(config)),
			Logger.withMinimumLogLevel(LogLevel.None),
		);

		await Effect.runPromise(program);

		await waitFor(
			() => FakeWebSocket.instances.length >= 1,
			"WebSocket instance",
		);
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await waitFor(() => ws.sent.length >= 1, "subscribe frame");

		expect(parseControl(ws.sent[0]).method).toBe("SUBSCRIBE");
		expect(parseControl(ws.sent[0]).params).toEqual([
			"btcusdt@bookTicker",
			"ethusdt@bookTicker",
		]);
	});

	it("unsubscribes a symbol once it has been idle past symbolsCleanupTtl", async () => {
		const config: BinanceModuleConfig = {
			...baseConfig,
			subscriptionSymbols: ["BTCUSDT"],
			// TTL is long enough that the socket opens first, short enough to keep the test fast.
			symbolsCleanupTtl: Duration.millis(150),
			symbolsCleanupInterval: Duration.millis(20),
		};

		const program = Effect.gen(function* () {
			const svc = yield* ModuleService;
			yield* svc.start();
		}).pipe(
			Effect.provide(BinanceModuleService(config)),
			Logger.withMinimumLogLevel(LogLevel.None),
		);

		await Effect.runPromise(program);

		await waitFor(
			() => FakeWebSocket.instances.length >= 1,
			"WebSocket instance",
		);
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await waitFor(() => ws.sent.length >= 1, "subscribe frame");

		await waitFor(
			() => ws.sent.some((raw) => parseControl(raw).method === "UNSUBSCRIBE"),
			"unsubscribe frame",
		);
		const unsubscribe = ws.sent.find(
			(raw) => parseControl(raw).method === "UNSUBSCRIBE",
		);
		expect(parseControl(unsubscribe as string).params).toEqual([
			"btcusdt@bookTicker",
		]);
	});
});
