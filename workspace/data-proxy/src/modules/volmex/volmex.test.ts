import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Effect, LogLevel, Logger, Redacted } from "effect";
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
	baseUrl: "wss://volmex.test",
	maxSymbolsPerRequest: 100,
	volmexApiKeyEnvKey: "VOLMEX_API_KEY",
	reconnectDelayMs: 60_000,
	volmexApiKey: Redacted.make("test.jwt.token"),
};

const buildRoute = () =>
	v.parse(VolmexModuleRouteSchema, {
		type: "volmex",
		moduleName: "volmex",
		path: "/price/:symbols",
		fetchFromModule: "{:symbols}",
		method: ["GET"],
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

beforeEach(() => {
	FakeSocket.instances = [];
});

afterEach(() => {
	for (const socket of FakeSocket.instances) {
		socket.close();
	}
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
