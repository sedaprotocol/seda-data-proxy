import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	Duration,
	Effect,
	LogLevel,
	Logger,
	TestClock,
	TestContext,
} from "effect";
import type { Route } from "../../config/config-parser";
import type { LighterModuleConfig } from "../../config/lighter-module-config";
import { HAS_PRICE_KEY } from "../../constants";
import { ModuleService } from "../module";
import { LighterModuleService, buildSubscribeFrame } from "./lighter";

const innerTicker = (symbol: string) => ({
	s: symbol,
	a: { price: "63327.1", size: "0.05874" },
	b: { price: "63327.0", size: "0.28342" },
	last_updated_at: 1780940152376949,
});

const tickerMessage = (marketId: number, symbol: string) =>
	JSON.stringify({
		channel: `ticker:${marketId}`,
		ticker: innerTicker(symbol),
		timestamp: 1780940152623,
		type: "update/ticker",
	});

const routeFor = (fetchFromModule: string): Route =>
	({
		type: "lighter",
		moduleName: "lighter",
		fetchFromModule,
		path: "/price/:markets",
		method: ["GET"],
	}) as unknown as Route;

class FakeWebSocket extends EventTarget {
	static readonly OPEN = 1;
	static readonly CLOSED = 3;
	static instances: FakeWebSocket[] = [];

	url: string;
	readyState = 0;
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

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const waitForSocket = (maxYields = 100) =>
	Effect.gen(function* () {
		for (let i = 0; i < maxYields; i++) {
			if (FakeWebSocket.instances.length > 0) {
				return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
			}
			yield* Effect.yieldNow();
		}
		throw new Error("Timed out waiting for FakeWebSocket construction");
	});

const tradeAt = (tradeId: number, timestamp: number) => ({
	trade_id: tradeId,
	price: "2181.83",
	size: "0.1336",
	timestamp,
});

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
	tradesKeepSeconds: 60,
};

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
	FakeWebSocket.instances = [];
	globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
	globalThis.WebSocket = originalWebSocket;
});

const quiet = <A, E>(effect: Effect.Effect<A, E>) =>
	effect.pipe(Logger.withMinimumLogLevel(LogLevel.None));

const buildService = (config: LighterModuleConfig) =>
	Effect.runPromise(
		quiet(ModuleService.pipe(Effect.provide(LighterModuleService(config)))),
	);

describe("LighterModuleService", () => {
	it("subscribes seeded markets, caches a delivered ticker, and serves it in request order", async () => {
		const service = await buildService({
			...baseConfig,
			subscriptionSymbols: ["1"],
		});
		await Effect.runPromise(quiet(service.start()));
		await flush();

		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();

		expect(ws.sent).toContain(buildSubscribeFrame(1, "ticker"));

		ws.triggerMessage(tickerMessage(1, "BTC"));
		await flush();

		const response = await Effect.runPromise(
			service.handleRequest(routeFor("1,NOPE"), {}, new Request("http://x")),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual([
			{ marketId: "1", ...innerTicker("BTC"), [HAS_PRICE_KEY]: true },
			{ marketId: "NOPE", [HAS_PRICE_KEY]: false },
		]);
	});

	it("subscribes a market requested for the first time and resolves once its ticker lands", async () => {
		const service = await buildService(baseConfig);
		await Effect.runPromise(quiet(service.start()));
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();

		const responsePromise = Effect.runPromise(
			service.handleRequest(routeFor("2"), {}, new Request("http://x")),
		);
		await flush();
		expect(ws.sent).toContain(buildSubscribeFrame(2, "ticker"));

		ws.triggerMessage(tickerMessage(2, "ETH"));
		const response = await responsePromise;

		expect(await response.json()).toEqual([
			{ marketId: "2", ...innerTicker("ETH"), [HAS_PRICE_KEY]: true },
		]);
	});

	it("stops vouching for cached prices once the socket has errored", async () => {
		const service = await buildService({
			...baseConfig,
			subscriptionSymbols: ["1"],
		});
		await Effect.runPromise(quiet(service.start()));
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();
		ws.triggerMessage(tickerMessage(1, "BTC"));
		await flush();

		const fresh = await Effect.runPromise(
			service.handleRequest(routeFor("1"), {}, new Request("http://x")),
		);
		expect((await fresh.json())[0][HAS_PRICE_KEY]).toBe(true);

		ws.close();
		await flush();

		const afterError = await Effect.runPromise(
			service.handleRequest(routeFor("1"), {}, new Request("http://x")),
		);
		expect(await afterError.json()).toEqual([
			{ marketId: "1", [HAS_PRICE_KEY]: false },
		]);
	});

	it("keeps a trade window and drops aged trades when the request is served", async () => {
		const config: LighterModuleConfig = {
			...baseConfig,
			streamType: "trade",
			tradesKeepSeconds: 60,
			subscriptionSymbols: ["0"],
		};

		const program = Effect.gen(function* () {
			const now = yield* TestClock.currentTimeMillis;
			const early = tradeAt(1, now - 50_000);
			const mid = tradeAt(2, now - 5_000);
			const fresh = tradeAt(4, now - 1_000);
			const liquidation = tradeAt(9, now - 5_000);

			const svc = yield* ModuleService;
			yield* svc.start();
			const ws = yield* waitForSocket();
			ws.triggerOpen();
			yield* Effect.yieldNow();

			ws.triggerMessage(
				JSON.stringify({
					channel: "trade:0",
					type: "update/trade",
					trades: [early, { trade_id: 7, price: "7", size: "1" }, mid],
					liquidation_trades: [tradeAt(8, now - 90_000), liquidation],
				}),
			);
			ws.triggerMessage(
				JSON.stringify({
					channel: "trade:0",
					type: "update/trade",
					trades: [tradeAt(3, now - 70_000), fresh],
					liquidation_trades: [],
				}),
			);

			const request = () =>
				Effect.gen(function* () {
					const response = yield* svc.handleRequest(
						routeFor("0"),
						{},
						new Request("http://x"),
					);
					return yield* Effect.promise(() => response.json());
				});

			const withinWindow = yield* request();
			yield* TestClock.adjust(Duration.seconds(50));
			const partlyAged = yield* request();
			yield* TestClock.adjust(Duration.seconds(20));
			const agedOut = yield* request();
			return {
				withinWindow,
				partlyAged,
				agedOut,
				early,
				mid,
				fresh,
				liquidation,
			};
		});

		const {
			withinWindow,
			partlyAged,
			agedOut,
			early,
			mid,
			fresh,
			liquidation,
		} = await Effect.runPromise(
			quiet(
				program.pipe(
					Effect.provide(LighterModuleService(config)),
					Effect.provide(TestContext.TestContext),
				),
			),
		);

		expect(withinWindow).toEqual([
			{
				marketId: "0",
				trades: [early, mid, fresh],
				liquidation_trades: [liquidation],
				[HAS_PRICE_KEY]: true,
			},
		]);
		expect(partlyAged).toEqual([
			{
				marketId: "0",
				trades: [mid, fresh],
				liquidation_trades: [liquidation],
				[HAS_PRICE_KEY]: true,
			},
		]);
		expect(agedOut).toEqual([
			{
				marketId: "0",
				trades: [],
				liquidation_trades: [],
				[HAS_PRICE_KEY]: true,
			},
		]);
	});

	it("rejects a request over maxSymbolsPerRequest with 400", async () => {
		const service = await buildService({
			...baseConfig,
			maxSymbolsPerRequest: 1,
		});

		const response = await Effect.runPromise(
			service.handleRequest(routeFor("1,2"), {}, new Request("http://x")),
		);

		expect(response.status).toBe(400);
	});
});
