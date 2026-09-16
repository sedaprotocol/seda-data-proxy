import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Duration, Effect, LogLevel, Logger } from "effect";
import * as v from "valibot";
import {
	type BybitModuleConfig,
	BybitModuleRouteSchema,
} from "../../config/bybit-module-config";
import { ModuleService } from "../module";
import {
	FakeWebSocket,
	installFakeWebSocket,
} from "../shared/fake-websocket.test-helpers";
import { BybitModuleService, type BybitPriceFrame } from "./bybit";

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

const baseConfig: BybitModuleConfig = {
	name: "bybit",
	type: "bybit",
	wsUrl: "wss://stream.bybit.test/v5/public/spot",
	subscriptionSymbols: [],
	maxSymbolsPerRequest: 100,
	maxMessages: 5,
	maxMessagesWindow: Duration.seconds(1),
	keepaliveInterval: Duration.minutes(10),
	reconnectMaxBackoff: Duration.seconds(30),
	reconnectStableThreshold: Duration.seconds(30),
	symbolsCleanupTtl: Duration.minutes(2),
	symbolsCleanupInterval: Duration.seconds(30),
};

const buildRoute = () =>
	v.parse(BybitModuleRouteSchema, {
		type: "bybit",
		moduleName: "bybit",
		path: "/price/:symbols",
		fetchFromModule: "{:symbols}",
		method: ["GET"],
	});

const dummyRequest = new Request("http://proxy.local/price/x", {
	method: "GET",
});

const parseControl = (raw: string) =>
	JSON.parse(raw) as {
		op: string;
		args: string[];
	};

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
	ws.sent.filter((raw) => {
		try {
			return parseControl(raw).op === "subscribe";
		} catch {
			return false;
		}
	});

let restoreWebSocket: (() => void) | undefined;

beforeEach(() => {
	restoreWebSocket = installFakeWebSocket();
});

afterEach(() => {
	restoreWebSocket?.();
});

describe("BybitModuleService.handleRequest", () => {
	it("subscribes new symbols, returns seeded prices, and flags unseeded ones", async () => {
		const route = buildRoute();
		const params = { symbols: "ETHUSDT,BTCUSDT,DOGEUSDT" };

		const program = Effect.gen(function* () {
			const svc = yield* ModuleService;
			yield* svc.start();
			return yield* svc.handleRequest(route, params, dummyRequest);
		}).pipe(
			Effect.provide(BybitModuleService(baseConfig)),
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
		expect(parseControl(ws.sent[0]).args).toEqual([
			"tickers.ETHUSDT",
			"tickers.BTCUSDT",
			"tickers.DOGEUSDT",
		]);

		ws.triggerMessage(tickerMessage(ethTicker));
		ws.triggerMessage(tickerMessage(btcTicker));

		const response = await resultPromise;
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toEqual([
			{ ...ethTicker, symbol: "ETHUSDT", __sedaHasPrice: true },
			{ ...btcTicker, symbol: "BTCUSDT", __sedaHasPrice: true },
			{ symbol: "DOGEUSDT", __sedaHasPrice: false },
		]);
	}, 10_000);

	it("does not re-subscribe an symbol already requested", async () => {
		const route = buildRoute();
		const params = { symbols: "BTCUSDT" };

		const program = Effect.gen(function* () {
			const svc = yield* ModuleService;
			yield* svc.start();
			const r1 = yield* svc.handleRequest(route, params, dummyRequest);
			const r2 = yield* svc.handleRequest(route, params, dummyRequest);
			return [r1, r2] as const;
		}).pipe(
			Effect.provide(BybitModuleService(baseConfig)),
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
		ws.triggerMessage(tickerMessage(btcTicker));

		const [r1, r2] = await resultPromise;
		expect(r1.status).toBe(200);
		expect(r2.status).toBe(200);
		expect(subscribeFrames(ws).length).toBe(1);
	});

	it("stops vouching for cached prices once the socket has errored", async () => {
		const route = buildRoute();
		const params = { symbols: "BTCUSDT" };

		const program = Effect.gen(function* () {
			const svc = yield* ModuleService;
			yield* svc.start();
			const fresh = yield* svc.handleRequest(route, params, dummyRequest);
			FakeWebSocket.instances[0].close();
			const afterError = yield* svc.handleRequest(route, params, dummyRequest);
			return [fresh, afterError] as const;
		}).pipe(
			Effect.provide(BybitModuleService(baseConfig)),
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
		ws.triggerMessage(tickerMessage(btcTicker));

		const [fresh, afterError] = await resultPromise;
		const freshBody = await fresh.json();
		expect(freshBody[0].__sedaHasPrice).toBe(true);
		const afterBody = await afterError.json();
		expect(afterBody).toEqual([{ symbol: "BTCUSDT", __sedaHasPrice: false }]);
	}, 10_000);

	it("rejects when more symbols than maxSymbolsPerRequest are requested", async () => {
		const route = buildRoute();
		const config: BybitModuleConfig = {
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
			Effect.provide(BybitModuleService(config)),
			Logger.withMinimumLogLevel(LogLevel.None),
		);

		const response = await Effect.runPromise(program);
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.moduleName).toBe("bybit");
		expect(body.data_proxy_error).toContain("bybit");
		expect(body.data_proxy_error).toContain("max is 2");
		expect(body.data_proxy_error).toContain("got 3");
	});
});

describe("BybitModuleService lifecycle", () => {
	it("seeds subscriptionSymbols on start", async () => {
		const config: BybitModuleConfig = {
			...baseConfig,
			subscriptionSymbols: ["BTCUSDT", "ETHUSDT"],
		};

		const program = Effect.gen(function* () {
			const svc = yield* ModuleService;
			yield* svc.start();
		}).pipe(
			Effect.provide(BybitModuleService(config)),
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

		expect(parseControl(ws.sent[0]).op).toBe("subscribe");
		expect(parseControl(ws.sent[0]).args).toEqual([
			"tickers.BTCUSDT",
			"tickers.ETHUSDT",
		]);
	});

	it("unsubscribes an symbol once it has been idle past symbolsCleanupTtl", async () => {
		const config: BybitModuleConfig = {
			...baseConfig,
			subscriptionSymbols: ["BTCUSDT"],
			symbolsCleanupTtl: Duration.millis(150),
			symbolsCleanupInterval: Duration.millis(20),
		};

		const program = Effect.gen(function* () {
			const svc = yield* ModuleService;
			yield* svc.start();
		}).pipe(
			Effect.provide(BybitModuleService(config)),
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
			() =>
				ws.sent.some((raw) => {
					try {
						return parseControl(raw).op === "unsubscribe";
					} catch {
						return false;
					}
				}),
			"unsubscribe frame",
		);
		const unsubscribe = ws.sent.find((raw) => {
			try {
				return parseControl(raw).op === "unsubscribe";
			} catch {
				return false;
			}
		});
		expect(parseControl(unsubscribe as string).args).toEqual([
			"tickers.BTCUSDT",
		]);
	});
});
