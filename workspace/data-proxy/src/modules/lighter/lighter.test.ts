import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Duration, Effect, LogLevel, Logger } from "effect";
import type { Route } from "../../config/config-parser";
import type { LighterModuleConfig } from "../../config/lighter-module-config";
import { HAS_PRICE_KEY } from "../../constants";
import { ModuleService } from "../module";
import { LighterModuleService } from "./lighter";
import { buildSubscribeFrame } from "./ws-client";

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

const baseConfig: LighterModuleConfig = {
	name: "lighter",
	type: "lighter",
	wsUrl: "wss://lighter.test/stream",
	subscriptionMarketIds: [],
	maxMarketsPerRequest: 100,
	keepaliveInterval: Duration.seconds(60),
	reconnectMaxBackoff: Duration.seconds(30),
	reconnectStableThreshold: Duration.seconds(30),
	marketsCleanupTtl: Duration.hours(1),
	marketsCleanupInterval: Duration.seconds(30),
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
			subscriptionMarketIds: [1],
		});
		await Effect.runPromise(quiet(service.start()));
		await flush();

		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();

		// The seeded market's subscribe frame actually went out.
		expect(ws.sent).toContain(buildSubscribeFrame(1));

		ws.triggerMessage(tickerMessage(1, "BTC"));
		await flush();

		const response = await Effect.runPromise(
			service.handleRequest(routeFor("1,NOPE"), {}, new Request("http://x")),
		);
		expect(response.status).toBe(200);
		// "1" resolves to a price; "NOPE" is not a market id, so it short-circuits to a miss.
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

		// Market 2 was not seeded; the request itself drives the subscription, then
		// waits on the cache. Deliver the ticker while that wait is in flight.
		const responsePromise = Effect.runPromise(
			service.handleRequest(routeFor("2"), {}, new Request("http://x")),
		);
		await flush();
		expect(ws.sent).toContain(buildSubscribeFrame(2));

		ws.triggerMessage(tickerMessage(2, "ETH"));
		const response = await responsePromise;

		expect(await response.json()).toEqual([
			{ marketId: "2", ...innerTicker("ETH"), [HAS_PRICE_KEY]: true },
		]);
	});

	it("rejects a request over maxMarketsPerRequest with 400", async () => {
		const service = await buildService({
			...baseConfig,
			maxMarketsPerRequest: 1,
		});

		const response = await Effect.runPromise(
			service.handleRequest(routeFor("1,2"), {}, new Request("http://x")),
		);

		expect(response.status).toBe(400);
	});
});
