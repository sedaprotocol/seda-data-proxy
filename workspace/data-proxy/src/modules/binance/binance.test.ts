import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Duration, Effect, LogLevel, Logger } from "effect";
import * as v from "valibot";
import {
	type BinanceModuleConfig,
	BinanceModuleRouteSchema,
} from "../../config/binance-module-config";
import { ModuleService } from "../module";
import { BinanceModuleService } from "./binance";
import type { BinancePriceFrame } from "./ws-client";

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
	reconnectMaxBackoff: Duration.seconds(30),
	reconnectStableThreshold: Duration.seconds(30),
	symbolsCleanupTtl: Duration.minutes(2),
	symbolsCleanupInterval: Duration.seconds(30),
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
}

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

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
	FakeWebSocket.instances = [];
	globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
	globalThis.WebSocket = originalWebSocket;
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
