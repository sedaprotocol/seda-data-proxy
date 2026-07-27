import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Duration, Effect, LogLevel, Logger, Redacted } from "effect";
import * as v from "valibot";
import {
	type VolmexModuleConfig,
	VolmexModuleRouteSchema,
} from "../../config/volmex-module-config";
import { HAS_PRICE_KEY } from "../../constants";
import { ModuleService } from "../module";

type FakeSocketOptions = {
	path?: string;
	transports?: string[];
	query?: Record<string, string>;
	reconnection?: boolean;
	reconnectionDelay?: number;
};

class FakeSocket {
	static instances: FakeSocket[] = [];

	url: string;
	opts: FakeSocketOptions;
	emitted: Array<[string, unknown]> = [];
	private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

	constructor(url: string, opts: FakeSocketOptions = {}) {
		this.url = url;
		this.opts = opts;
		FakeSocket.instances.push(this);
	}

	on(event: string, handler: (...args: unknown[]) => void): this {
		const list = this.listeners.get(event) ?? [];
		list.push(handler);
		this.listeners.set(event, list);
		return this;
	}

	emit(event: string, payload?: unknown): this {
		this.emitted.push([event, payload]);
		return this;
	}

	close(): void {
		this.trigger("disconnect");
	}

	removeAllListeners(): void {
		this.listeners.clear();
	}

	trigger(event: string, ...args: unknown[]): void {
		for (const handler of this.listeners.get(event) ?? []) {
			handler(...args);
		}
	}
}

mock.module("socket.io-client", () => ({
	io: (url: string, opts?: FakeSocketOptions) =>
		new FakeSocket(url, opts ?? {}),
}));

const { VolmexModuleService } = await import("./volmex");

const bvivPrice = {
	symbol: "BVIV",
	price: 42.57,
	timestamp: 1783951338255,
};

const evivPrice = {
	symbol: "EVIV",
	price: 54.22,
	timestamp: 1783951338838,
};

const baseConfig: VolmexModuleConfig = {
	name: "volmex",
	type: "volmex",
	wsBaseUrl: "wss://volmex.test",
	restBaseUrl: "https://rest.volmex.test",
	maxSymbolsPerRequest: 100,
	volmexApiKeyEnvKey: "VOLMEX_API_KEY",
	reconnectDelayMs: 60_000,
	restFetchTimeout: Duration.seconds(15),
	volmexApiKey: Redacted.make("test.jwt.token"),
};

const buildRoute = () =>
	v.parse(VolmexModuleRouteSchema, {
		type: "volmex",
		moduleName: "volmex",
		source: "ws",
		path: "/price/:symbols",
		fetchFromModule: "{:symbols}",
		method: ["GET"],
	});

const buildRestRoute = (overrides: Record<string, unknown> = {}) =>
	v.parse(VolmexModuleRouteSchema, {
		type: "volmex",
		moduleName: "volmex",
		source: "rest",
		path: "/history",
		upstreamPath: "/v2/history",
		method: ["GET"],
		...overrides,
	});

const dummyRequest = new Request("http://proxy.local/price/x", {
	method: "GET",
});

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

const completeHandshake = async (socket: FakeSocket) => {
	socket.trigger("connect");
	await waitFor(
		() =>
			socket.emitted.some(
				([event, payload]) =>
					event === "fetch-indices-messages-private" &&
					JSON.stringify(payload) === "{}",
			),
		"indices subscribe",
	);
};

const quiet = <A, E>(effect: Effect.Effect<A, E>) =>
	effect.pipe(Logger.withMinimumLogLevel(LogLevel.None));

const originalFetch = globalThis.fetch;

beforeEach(() => {
	FakeSocket.instances = [];
});

afterEach(() => {
	for (const socket of FakeSocket.instances) {
		socket.close();
	}
	globalThis.fetch = originalFetch;
});

describe("VolmexModuleService.handleRequest", () => {
	it("serves streamed prices and flags symbols that never arrive", async () => {
		const route = buildRoute();
		const params = { symbols: "EVIV,BVIV,UNKNOWN" };

		const program = Effect.gen(function* () {
			const svc = yield* ModuleService;
			yield* svc.start();
			return yield* svc.handleRequest(route, params, dummyRequest);
		}).pipe(Effect.provide(VolmexModuleService(baseConfig)), quiet);

		const resultPromise = Effect.runPromise(program);

		await waitFor(() => FakeSocket.instances.length >= 1, "Socket.IO instance");
		const socket = FakeSocket.instances[0];
		expect(socket.url).toBe("wss://volmex.test");
		expect(socket.opts.query?.jwtToken).toBe("test.jwt.token");
		expect(socket.opts.transports).toEqual(["websocket"]);
		expect(socket.opts.reconnection).toBe(true);
		expect(socket.opts.reconnectionDelay).toBe(60_000);

		await completeHandshake(socket);
		socket.trigger("indices-messages-stream-private", evivPrice);
		socket.trigger("indices-messages-stream-private", bvivPrice);

		const response = await resultPromise;
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual([
			{ ...evivPrice, [HAS_PRICE_KEY]: true },
			{ ...bvivPrice, [HAS_PRICE_KEY]: true },
			{ symbol: "UNKNOWN", [HAS_PRICE_KEY]: false },
		]);
	}, 10_000);

	it("serves a previously cached price on a later request", async () => {
		const route = buildRoute();
		const params = { symbols: "BVIV" };

		const program = Effect.gen(function* () {
			const svc = yield* ModuleService;
			yield* svc.start();
			const first = yield* svc.handleRequest(route, params, dummyRequest);
			const second = yield* svc.handleRequest(route, params, dummyRequest);
			return [first, second] as const;
		}).pipe(Effect.provide(VolmexModuleService(baseConfig)), quiet);

		const resultPromise = Effect.runPromise(program);

		await waitFor(() => FakeSocket.instances.length >= 1, "Socket.IO instance");
		const socket = FakeSocket.instances[0];
		await completeHandshake(socket);
		socket.trigger("indices-messages-stream-private", bvivPrice);

		const [first, second] = await resultPromise;
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(await first.json()).toEqual([
			{ ...bvivPrice, [HAS_PRICE_KEY]: true },
		]);
		expect(await second.json()).toEqual([
			{ ...bvivPrice, [HAS_PRICE_KEY]: true },
		]);
	});

	it("rejects when more symbols than maxSymbolsPerRequest are requested", async () => {
		const route = buildRoute();
		const config: VolmexModuleConfig = {
			...baseConfig,
			maxSymbolsPerRequest: 2,
		};

		const program = Effect.gen(function* () {
			const svc = yield* ModuleService;
			return yield* svc.handleRequest(
				route,
				{ symbols: "BVIV,EVIV,SVIV" },
				dummyRequest,
			);
		}).pipe(Effect.provide(VolmexModuleService(config)), quiet);

		const response = await Effect.runPromise(program);
		expect(response.status).toBe(400);
	});
});

describe("VolmexModuleService.handleRequest (REST)", () => {
	it("proxies to restBaseUrl + upstreamPath with JWT and forwards query params", async () => {
		const route = buildRestRoute({
			allowedQueryParams: ["symbol", "resolution", "from", "to"],
		});
		const request = new Request(
			"http://proxy.local/history?symbol=BVIV&resolution=D&from=1&to=2&ignored=x",
			{ method: "GET" },
		);

		const fetchMock = mock(
			async (input: URL | RequestInfo, init?: RequestInit) => {
				const url =
					input instanceof URL
						? input
						: new URL(typeof input === "string" ? input : input.url);
				expect(url.origin + url.pathname).toBe(
					"https://rest.volmex.test/v2/history",
				);
				expect(url.searchParams.get("symbol")).toBe("BVIV");
				expect(url.searchParams.get("resolution")).toBe("D");
				expect(url.searchParams.get("from")).toBe("1");
				expect(url.searchParams.get("to")).toBe("2");
				expect(url.searchParams.has("ignored")).toBe(false);
				expect(init?.method).toBe("GET");
				expect((init?.headers as Record<string, string>).Authorization).toBe(
					"Bearer test.jwt.token",
				);
				return new Response(JSON.stringify({ s: "ok", t: [1], c: [42] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			},
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const program = Effect.gen(function* () {
			const svc = yield* ModuleService;
			return yield* svc.handleRequest(route, {}, request);
		}).pipe(Effect.provide(VolmexModuleService(baseConfig)), quiet);

		const response = await Effect.runPromise(program);
		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(await response.json()).toEqual({ s: "ok", t: [1], c: [42] });
	});

	it("substitutes path params in upstreamPath", async () => {
		const route = buildRestRoute({
			path: "/history/:symbol",
			upstreamPath: "/v2/history/{:symbol}",
		});
		const request = new Request("http://proxy.local/history/BVIV", {
			method: "GET",
		});

		const fetchMock = mock(async (input: URL | RequestInfo) => {
			const url =
				input instanceof URL
					? input.toString()
					: typeof input === "string"
						? input
						: input.url;
			expect(url).toBe("https://rest.volmex.test/v2/history/BVIV");
			return new Response("{}", { status: 200 });
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const program = Effect.gen(function* () {
			const svc = yield* ModuleService;
			return yield* svc.handleRequest(route, { symbol: "BVIV" }, request);
		}).pipe(Effect.provide(VolmexModuleService(baseConfig)), quiet);

		const response = await Effect.runPromise(program);
		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("passes through upstream 4xx status", async () => {
		const route = buildRestRoute();
		const fetchMock = mock(
			async () => new Response("bad symbol", { status: 400 }),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const program = Effect.gen(function* () {
			const svc = yield* ModuleService;
			return yield* svc.handleRequest(
				route,
				{},
				new Request("http://proxy.local/history", { method: "GET" }),
			);
		}).pipe(Effect.provide(VolmexModuleService(baseConfig)), quiet);

		const response = await Effect.runPromise(program);
		expect(response.status).toBe(400);
		expect(await response.text()).toBe("bad symbol");
	});

	it("returns 504 when the upstream fetch times out", async () => {
		const route = buildRestRoute();
		const fetchMock = mock(
			async (_input: URL | RequestInfo, init?: RequestInit) => {
				const signal = init?.signal;
				return await new Promise<Response>((_resolve, reject) => {
					signal?.addEventListener("abort", () => {
						const error = new Error("aborted");
						error.name = "TimeoutError";
						reject(error);
					});
				});
			},
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const config: VolmexModuleConfig = {
			...baseConfig,
			restFetchTimeout: Duration.millis(20),
		};

		const program = Effect.gen(function* () {
			const svc = yield* ModuleService;
			return yield* svc.handleRequest(
				route,
				{},
				new Request("http://proxy.local/history", { method: "GET" }),
			);
		}).pipe(Effect.provide(VolmexModuleService(config)), quiet);

		const response = await Effect.runPromise(program);
		expect(response.status).toBe(504);
	});
});
