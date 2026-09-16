import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Duration, Effect, LogLevel, Logger } from "effect";
import * as v from "valibot";
import {
	type OkxModuleConfig,
	OkxModuleRouteSchema,
} from "../../config/okx-module-config";
import { ModuleService } from "../module";
import {
	FakeWebSocket,
	installFakeWebSocket,
} from "../shared/fake-websocket.test-helpers";
import { OkxModuleService, type OkxPriceFrame } from "./okx";

const btcTicker: OkxPriceFrame = {
	instType: "SPOT",
	instId: "BTC-USDT",
	last: "9999.99",
	askPx: "9999.99",
	bidPx: "8888.88",
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

const baseConfig: OkxModuleConfig = {
	name: "okx",
	type: "okx",
	wsUrl: "wss://ws.okx.test/ws/v5/public",
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
	v.parse(OkxModuleRouteSchema, {
		type: "okx",
		moduleName: "okx",
		path: "/price/:symbols",
		fetchFromModule: "{:symbols}",
		method: ["GET"],
	});

const dummyRequest = new Request("http://proxy.local/price/x", {
	method: "GET",
});

const parseControl = (raw: string) =>
	JSON.parse(raw) as {
		id: string;
		op: string;
		args: Array<{ channel: string; instId: string }>;
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

describe("OkxModuleService.handleRequest", () => {
	it("subscribes new symbols, returns seeded prices, and flags unseeded ones", async () => {
		const route = buildRoute();
		const params = { symbols: "ETH-USDT,BTC-USDT,DOGE-USDT" };

		const program = Effect.gen(function* () {
			const svc = yield* ModuleService;
			yield* svc.start();
			return yield* svc.handleRequest(route, params, dummyRequest);
		}).pipe(
			Effect.provide(OkxModuleService(baseConfig)),
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
			{ channel: "tickers", instId: "ETH-USDT" },
			{ channel: "tickers", instId: "BTC-USDT" },
			{ channel: "tickers", instId: "DOGE-USDT" },
		]);

		ws.triggerMessage(tickerMessage(ethTicker));
		ws.triggerMessage(tickerMessage(btcTicker));

		const response = await resultPromise;
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toEqual([
			{ ...ethTicker, instId: "ETH-USDT", __sedaHasPrice: true },
			{ ...btcTicker, instId: "BTC-USDT", __sedaHasPrice: true },
			{ instId: "DOGE-USDT", __sedaHasPrice: false },
		]);
	}, 10_000);

	it("does not re-subscribe an symbol already requested", async () => {
		const route = buildRoute();
		const params = { symbols: "BTC-USDT" };

		const program = Effect.gen(function* () {
			const svc = yield* ModuleService;
			yield* svc.start();
			const r1 = yield* svc.handleRequest(route, params, dummyRequest);
			const r2 = yield* svc.handleRequest(route, params, dummyRequest);
			return [r1, r2] as const;
		}).pipe(
			Effect.provide(OkxModuleService(baseConfig)),
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
		const params = { symbols: "BTC-USDT" };

		const program = Effect.gen(function* () {
			const svc = yield* ModuleService;
			yield* svc.start();
			const fresh = yield* svc.handleRequest(route, params, dummyRequest);
			FakeWebSocket.instances[0].close();
			const afterError = yield* svc.handleRequest(route, params, dummyRequest);
			return [fresh, afterError] as const;
		}).pipe(
			Effect.provide(OkxModuleService(baseConfig)),
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
		expect(afterBody).toEqual([{ instId: "BTC-USDT", __sedaHasPrice: false }]);
	}, 10_000);

	it("rejects when more symbols than maxSymbolsPerRequest are requested", async () => {
		const route = buildRoute();
		const config: OkxModuleConfig = {
			...baseConfig,
			maxSymbolsPerRequest: 2,
		};

		const program = Effect.gen(function* () {
			const svc = yield* ModuleService;
			return yield* svc.handleRequest(
				route,
				{ symbols: "BTC-USDT,ETH-USDT,SOL-USDT" },
				dummyRequest,
			);
		}).pipe(
			Effect.provide(OkxModuleService(config)),
			Logger.withMinimumLogLevel(LogLevel.None),
		);

		const response = await Effect.runPromise(program);
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.moduleName).toBe("okx");
		expect(body.data_proxy_error).toContain("okx");
		expect(body.data_proxy_error).toContain("max is 2");
		expect(body.data_proxy_error).toContain("got 3");
	});
});

describe("OkxModuleService lifecycle", () => {
	it("seeds subscriptionSymbols on start", async () => {
		const config: OkxModuleConfig = {
			...baseConfig,
			subscriptionSymbols: ["BTC-USDT", "ETH-USDT"],
		};

		const program = Effect.gen(function* () {
			const svc = yield* ModuleService;
			yield* svc.start();
		}).pipe(
			Effect.provide(OkxModuleService(config)),
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
			{ channel: "tickers", instId: "BTC-USDT" },
			{ channel: "tickers", instId: "ETH-USDT" },
		]);
	});

	it("unsubscribes an symbol once it has been idle past symbolsCleanupTtl", async () => {
		const config: OkxModuleConfig = {
			...baseConfig,
			subscriptionSymbols: ["BTC-USDT"],
			symbolsCleanupTtl: Duration.millis(150),
			symbolsCleanupInterval: Duration.millis(20),
		};

		const program = Effect.gen(function* () {
			const svc = yield* ModuleService;
			yield* svc.start();
		}).pipe(
			Effect.provide(OkxModuleService(config)),
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
			{ channel: "tickers", instId: "BTC-USDT" },
		]);
	});
});
