import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Duration, Effect, LogLevel, Logger } from "effect";
import * as v from "valibot";
import {
	type HydromancerModuleConfig,
	HydromancerModuleRouteSchema,
} from "../../config/hydromancer-module-config";
import { ModuleService } from "../module";
import { HydromancerModuleService } from "./hydromancer";
import { buildSubscribeFrame, buildUnsubscribeFrame } from "./ws-client";

const baseConfig: HydromancerModuleConfig = {
	name: "hydromancer",
	type: "hydromancer",
	wsUrl: "wss://api.hydromancer.test/ws",
	restBaseUrl: "https://api.hydromancer.test",
	hydromancerApiKeyEnvKey: "HYDROMANCER_API_KEY",
	hydromancerApiKey: "test-api-key",
	staleAfter: Duration.seconds(10),
	subscriptionCoins: [],
	maxCoinsPerRequest: 20,
	reconnectMaxBackoff: Duration.seconds(30),
	reconnectStableThreshold: Duration.seconds(30),
	coinsCleanupTtl: Duration.minutes(2),
	coinsCleanupInterval: Duration.seconds(30),
	restFetchTimeout: Duration.seconds(15),
};

const btcCtx = {
	oraclePx: "96500.50",
	markPx: "96485.25",
	midPx: "96490.50",
	impactPxs: ["96490", "96491"],
	openInterest: "25401.1214",
};

const ethCtx = {
	oraclePx: "3450.10",
	markPx: "3448.75",
	midPx: "3449.50",
	impactPxs: ["3449", "3450"],
	openInterest: "192841.521",
};

const buildRoute = () =>
	v.parse(HydromancerModuleRouteSchema, {
		type: "hydromancer",
		moduleName: "hydromancer",
		path: "/info",
		method: ["POST"],
	});

const buildAssetContextRequest = (body: string) =>
	new Request("http://proxy.local/info", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body,
	});

const buildRequestBody = (coins: string[]) =>
	JSON.stringify({ type: "assetContext", coins });

const callHandle = (
	config: HydromancerModuleConfig,
	coins: string[],
	buildBody = buildRequestBody,
) => {
	const route = buildRoute();
	const body = buildBody(coins);
	const program = Effect.gen(function* () {
		const svc = yield* ModuleService;
		return yield* svc.handleRequest(
			route,
			{},
			buildAssetContextRequest(body),
			body,
		);
	});
	return Effect.runPromise(
		program.pipe(
			Effect.provide(HydromancerModuleService(config)),
			Logger.withMinimumLogLevel(LogLevel.None),
		),
	);
};

const callHandleRaw = (config: HydromancerModuleConfig, rawBody: string) => {
	const route = buildRoute();
	const program = Effect.gen(function* () {
		const svc = yield* ModuleService;
		return yield* svc.handleRequest(
			route,
			{},
			new Request("http://proxy.local/info", {
				method: "POST",
				body: rawBody,
			}),
			rawBody,
		);
	});
	return Effect.runPromise(
		program.pipe(
			Effect.provide(HydromancerModuleService(config)),
			Logger.withMinimumLogLevel(LogLevel.None),
		),
	);
};

// Runs multiple handleRequest invocations against the SAME module instance,
// so cache state carries across calls. Returns responses in order.
const callHandleSequence = (
	config: HydromancerModuleConfig,
	calls: string[][],
	between?: () => Promise<void>,
	buildBody = buildRequestBody,
) => {
	const route = buildRoute();
	const program = Effect.gen(function* () {
		const svc = yield* ModuleService;
		const responses: Response[] = [];
		for (const coins of calls) {
			const body = buildBody(coins);
			const response = yield* svc.handleRequest(
				route,
				{},
				buildAssetContextRequest(body),
				body,
			);
			responses.push(response);
			if (between) {
				yield* Effect.promise(() => between());
			}
		}
		return responses;
	});
	return Effect.runPromise(
		program.pipe(
			Effect.provide(HydromancerModuleService(config)),
			Logger.withMinimumLogLevel(LogLevel.None),
		),
	);
};

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("HydromancerModuleService.handleRequest (REST batch path)", () => {
	it("issues a single batch POST and returns one entry per resolved coin", async () => {
		const fetchMock = mock(
			async (input: URL | RequestInfo, init?: RequestInit) => {
				const url =
					input instanceof URL
						? input.toString()
						: ((input as Request).url ?? input);
				expect(String(url)).toContain("/info");
				expect(init?.method).toBe("POST");
				expect(JSON.parse(init?.body as string)).toEqual({
					type: "assetContext",
					coins: ["BTC", "ETH"],
				});
				expect((init?.headers as Record<string, string>).Authorization).toBe(
					"Bearer test-api-key",
				);
				return new Response(JSON.stringify({ BTC: btcCtx, ETH: ethCtx }), {
					status: 200,
				});
			},
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const response = await callHandle(baseConfig, ["BTC", "ETH"]);
		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const body = await response.json();
		expect(body).toEqual({ BTC: btcCtx, ETH: ethCtx });
	});

	it("supports single-coin assetContext requests", async () => {
		const fetchMock = mock(
			async (input: URL | RequestInfo, init?: RequestInit) => {
				const url =
					input instanceof URL
						? input.toString()
						: ((input as Request).url ?? input);
				expect(String(url)).toContain("/info");
				expect(init?.method).toBe("POST");
				expect(JSON.parse(init?.body as string)).toEqual({
					type: "assetContext",
					coins: ["BTC"],
				});
				expect((init?.headers as Record<string, string>).Authorization).toBe(
					"Bearer test-api-key",
				);
				return new Response(JSON.stringify({ BTC: btcCtx }), {
					status: 200,
				});
			},
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const response = await callHandle(baseConfig, ["BTC"], (coins) =>
			JSON.stringify({ type: "assetContext", coin: coins[0] }),
		);
		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const body = await response.json();
		expect(body).toEqual(btcCtx);
	});

	it("keeps null entries for coins that come back null", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ BTC: btcCtx, ZZZ: null }), {
					status: 200,
				}),
		) as unknown as typeof fetch;

		const response = await callHandle(baseConfig, ["BTC", "ZZZ"]);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toEqual({ BTC: btcCtx, ZZZ: null });
	});

	it("returns null for every requested coin when none resolve", async () => {
		globalThis.fetch = mock(
			async () => new Response(JSON.stringify({ ZZZ: null }), { status: 200 }),
		) as unknown as typeof fetch;

		const response = await callHandle(baseConfig, ["ZZZ"]);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toEqual({ ZZZ: null });
	});

	it("passes through a 4xx upstream status", async () => {
		globalThis.fetch = mock(
			async () => new Response("Bad request", { status: 400 }),
		) as unknown as typeof fetch;

		const response = await callHandle(baseConfig, ["BTC"]);
		expect(response.status).toBe(400);
	});

	it("maps a 5xx upstream status to 502", async () => {
		globalThis.fetch = mock(
			async () => new Response("internal", { status: 500 }),
		) as unknown as typeof fetch;

		const response = await callHandle(baseConfig, ["BTC"]);
		expect(response.status).toBe(502);
	});

	it("returns 504 when the fetch times out", async () => {
		globalThis.fetch = mock(async () => {
			const error = new Error("aborted");
			error.name = "TimeoutError";
			throw error;
		}) as unknown as typeof fetch;

		const response = await callHandle(baseConfig, ["BTC"]);
		expect(response.status).toBe(504);
	});

	it("returns 502 when the response shape is invalid", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ BTC: { oraclePx: 1 } }), {
					status: 200,
				}),
		) as unknown as typeof fetch;

		const response = await callHandle(baseConfig, ["BTC"]);
		expect(response.status).toBe(502);
	});

	it("rejects when more coins than maxCoinsPerRequest are requested", async () => {
		const tightConfig: HydromancerModuleConfig = {
			...baseConfig,
			maxCoinsPerRequest: 2,
		};
		globalThis.fetch = mock(
			async () => new Response("{}", { status: 200 }),
		) as unknown as typeof fetch;

		const response = await callHandle(tightConfig, ["BTC", "ETH", "SOL"]);
		expect(response.status).toBe(400);
	});
});

describe("HydromancerModuleService.handleRequest (non-assetContext)", () => {
	it("forwards the body to the upstream REST endpoint", async () => {
		const fetchMock = mock(async () => new Response("{}", { status: 200 }));
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const response = await callHandleRaw(
			baseConfig,
			JSON.stringify({ type: "fundingHistory", coin: "BTC" }),
		);
		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledWith(
			new URL("/info", baseConfig.restBaseUrl),
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer test-api-key",
				},
				body: JSON.stringify({ type: "fundingHistory", coin: "BTC" }),
				signal: expect.anything(),
			},
		);
	});
});

describe("HydromancerModuleService cache behavior", () => {
	it("serves a repeat request from cache without hitting REST", async () => {
		const fetchMock = mock(
			async () =>
				new Response(JSON.stringify({ BTC: btcCtx }), { status: 200 }),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const [r1, r2] = await callHandleSequence(baseConfig, [["BTC"], ["BTC"]]);

		expect(r1.status).toBe(200);
		expect(r2.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(await r1.json()).toEqual({ BTC: btcCtx });
		expect(await r2.json()).toEqual({ BTC: btcCtx });
	});

	it("refetches via REST once the entry is older than staleAfter", async () => {
		const tightConfig: HydromancerModuleConfig = {
			...baseConfig,
			staleAfter: Duration.millis(20),
		};
		const fetchMock = mock(
			async () =>
				new Response(JSON.stringify({ BTC: btcCtx }), { status: 200 }),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		await callHandleSequence(
			tightConfig,
			[["BTC"], ["BTC"]],
			() => new Promise((r) => setTimeout(r, 60)),
		);

		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("only batches the coins that need REST, leaving cached coins untouched", async () => {
		const fetchedBatches: string[][] = [];
		const fetchMock = mock(
			async (_input: URL | RequestInfo, init?: RequestInit) => {
				const body = JSON.parse(init?.body as string);
				fetchedBatches.push(body.coins);
				const responseBody: Record<string, typeof btcCtx> = {};
				for (const coin of body.coins) {
					if (coin === "BTC") responseBody[coin] = btcCtx;
					if (coin === "ETH") responseBody[coin] = ethCtx;
				}
				return new Response(JSON.stringify(responseBody), { status: 200 });
			},
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const [r1, r2] = await callHandleSequence(baseConfig, [
			["BTC"],
			["BTC", "ETH"],
		]);

		expect(r1.status).toBe(200);
		expect(r2.status).toBe(200);
		expect(fetchedBatches).toEqual([["BTC"], ["ETH"]]);
		expect(await r2.json()).toEqual({ BTC: btcCtx, ETH: ethCtx });
	});
});

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
		this.readyState = FakeWebSocket.CLOSED;
		this.dispatchEvent(new Event("close"));
	}

	triggerOpen(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.dispatchEvent(new Event("open"));
	}
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("HydromancerModuleService demand-driven subscriptions", () => {
	const originalWebSocket = globalThis.WebSocket;

	beforeEach(() => {
		FakeWebSocket.instances = [];
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
	});

	afterEach(() => {
		globalThis.WebSocket = originalWebSocket;
	});

	it("subscribes via WS for a coin first seen via handleRequest", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ BTC: btcCtx }), { status: 200 }),
		) as unknown as typeof fetch;

		const config: HydromancerModuleConfig = {
			...baseConfig,
			subscriptionCoins: [],
		};

		const program = Effect.gen(function* () {
			const svc = yield* ModuleService;
			yield* svc.start();
			const route = buildRoute();
			const body = buildRequestBody(["BTC"]);
			return yield* svc.handleRequest(
				route,
				{},
				buildAssetContextRequest(body),
				body,
			);
		});

		const response = await Effect.runPromise(
			program.pipe(
				Effect.provide(HydromancerModuleService(config)),
				Logger.withMinimumLogLevel(LogLevel.None),
			),
		);
		expect(response.status).toBe(200);

		await flush();
		await flush();
		expect(FakeWebSocket.instances.length).toBe(1);
		const ws = FakeWebSocket.instances[0];

		ws.triggerOpen();
		await flush();

		expect(ws.sent).toEqual([buildSubscribeFrame("BTC")]);
	});

	it("does not enqueue a coin a second time on a repeat handleRequest", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ BTC: btcCtx }), { status: 200 }),
		) as unknown as typeof fetch;

		const config: HydromancerModuleConfig = {
			...baseConfig,
			subscriptionCoins: [],
		};

		const program = Effect.gen(function* () {
			const svc = yield* ModuleService;
			yield* svc.start();
			const route = buildRoute();
			const body = buildRequestBody(["BTC"]);
			yield* svc.handleRequest(route, {}, buildAssetContextRequest(body), body);
			yield* svc.handleRequest(route, {}, buildAssetContextRequest(body), body);
		});

		await Effect.runPromise(
			program.pipe(
				Effect.provide(HydromancerModuleService(config)),
				Logger.withMinimumLogLevel(LogLevel.None),
			),
		);

		await flush();
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();

		// Only one subscribe frame, even though handleRequest was called twice.
		expect(ws.sent).toEqual([buildSubscribeFrame("BTC")]);
	});

	it("unsubscribes a coin once it has been idle past coinsCleanupTtl", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ BTC: btcCtx }), { status: 200 }),
		) as unknown as typeof fetch;

		const config: HydromancerModuleConfig = {
			...baseConfig,
			subscriptionCoins: [],
			// TTL must be long enough that the cleanup pass cannot fire before the
			// WS is opened by the test setup; interval is short to keep the test fast.
			coinsCleanupTtl: Duration.millis(150),
			coinsCleanupInterval: Duration.millis(20),
		};

		const program = Effect.gen(function* () {
			const svc = yield* ModuleService;
			yield* svc.start();
			const route = buildRoute();
			const body = buildRequestBody(["BTC"]);
			yield* svc.handleRequest(route, {}, buildAssetContextRequest(body), body);
		});

		await Effect.runPromise(
			program.pipe(
				Effect.provide(HydromancerModuleService(config)),
				Logger.withMinimumLogLevel(LogLevel.None),
			),
		);

		await flush();
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();

		expect(ws.sent).toEqual([buildSubscribeFrame("BTC")]);

		// Wait past TTL + at least one cleanup tick.
		await new Promise<void>((r) => setTimeout(r, 250));

		expect(ws.sent).toEqual([
			buildSubscribeFrame("BTC"),
			buildUnsubscribeFrame("BTC"),
		]);
	});
});

describe("HydromancerModuleService REST fallback when WS is errored", () => {
	const originalWebSocket = globalThis.WebSocket;

	beforeEach(() => {
		FakeWebSocket.instances = [];
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
	});

	afterEach(() => {
		globalThis.WebSocket = originalWebSocket;
	});

	it("falls through to REST when the WS has been marked errored, even with a fresh cache entry", async () => {
		const restCalls: string[][] = [];
		globalThis.fetch = mock(
			async (_url: URL | RequestInfo, init?: RequestInit) => {
				const body = JSON.parse((init?.body as string) ?? "{}");
				restCalls.push(body.coins);
				return new Response(JSON.stringify({ BTC: btcCtx }), { status: 200 });
			},
		) as unknown as typeof fetch;

		const config: HydromancerModuleConfig = {
			...baseConfig,
			subscriptionCoins: [],
		};

		const program = Effect.gen(function* () {
			const svc = yield* ModuleService;
			yield* svc.start();

			// Let the WS daemon construct a FakeWebSocket and then bring it up.
			yield* Effect.sleep(Duration.millis(0));
			yield* Effect.sleep(Duration.millis(0));
			const ws = FakeWebSocket.instances[0];
			ws.triggerOpen();
			yield* Effect.sleep(Duration.millis(0));

			const route = buildRoute();

			// Request 1: cache miss, REST populates BTC.
			const body = buildRequestBody(["BTC"]);
			yield* svc.handleRequest(route, {}, buildAssetContextRequest(body), body);

			// Drop the socket: cache.markSocketError fires, currentWS clears.
			ws.close();
			yield* Effect.sleep(Duration.millis(0));

			// Request 2: BTC is fresh in cache but socketError forces another REST.
			yield* svc.handleRequest(route, {}, buildAssetContextRequest(body), body);
		});

		await Effect.runPromise(
			program.pipe(
				Effect.provide(HydromancerModuleService(config)),
				Logger.withMinimumLogLevel(LogLevel.None),
			),
		);

		expect(restCalls).toEqual([["BTC"], ["BTC"]]);
	});
});
