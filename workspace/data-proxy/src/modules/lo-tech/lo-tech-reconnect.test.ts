import { afterEach, describe, expect, it } from "bun:test";
import type { Server, ServerWebSocket } from "bun";
import { Duration, Effect, LogLevel, Logger } from "effect";
import * as v from "valibot";
import {
	type LoTechModuleConfig,
	LoTechModuleRouteSchema,
} from "../../config/lo-tech-module-config";
import { HAS_PRICE_KEY } from "../../constants";
import { ModuleService } from "../module";
import { LoTechModuleService } from "./lo-tech";

const SYMBOL = "O|SICI-USD:SPOT";

type FakeLoTech = {
	server: Server;
	/** SUBSCRIBE frames received, across all connections. */
	subscribes: Array<{ symbol: string; id: number }>;
	/** Price sent right after each acked SUBSCRIBE. */
	price: number;
	/** When true, new connections are refused. */
	down: boolean;
	dropConnections: () => void;
};

const startFakeLoTech = (): FakeLoTech => {
	const sockets = new Set<ServerWebSocket<unknown>>();
	const fake: FakeLoTech = {
		server: undefined as unknown as Server,
		subscribes: [],
		price: 100,
		down: false,
		dropConnections: () => {
			for (const ws of sockets) ws.close();
		},
	};

	fake.server = Bun.serve({
		port: 0,
		fetch(req, server) {
			if (fake.down) return new Response("unavailable", { status: 503 });
			if (server.upgrade(req)) return;
			return new Response("ws only", { status: 400 });
		},
		websocket: {
			open(ws) {
				sockets.add(ws);
			},
			close(ws) {
				sockets.delete(ws);
			},
			message(ws, raw) {
				const msg = JSON.parse(String(raw));
				if (msg.op !== "SUBSCRIBE") return;
				for (const topic of msg.topics) {
					fake.subscribes.push({ symbol: topic.symbol, id: msg.id });
				}
				ws.send(JSON.stringify({ egress_ts: 1, ack: { id: msg.id } }));
				for (const topic of msg.topics) {
					ws.send(
						JSON.stringify({
							egress_ts: 2,
							data: {
								type: "PRICE",
								symbol: topic.symbol,
								ingress_ts: 1,
								publish_ts: 1,
								transaction_ts: 1,
								price: fake.price,
								spread: 0.0001,
							},
						}),
					);
				}
			},
		},
	});

	return fake;
};

const configFor = (fake: FakeLoTech): LoTechModuleConfig => ({
	type: "lo-tech",
	name: "lotech",
	baseUrl: `ws://127.0.0.1:${fake.server.port}/ws/v1`,
	supportedExchanges: ["us_equities", "futures", "compute_index"],
	priceFeeds: [],
	maxFeedsPerRequest: 100,
	loTechApiKeyEnvKey: "LOTECH_API_KEY",
	loTechApiKey: "test-key",
	priceFeedsCleanupTtl: Duration.hours(1),
	priceFeedsCleanupInterval: Duration.seconds(30),
	reconnectDelayMs: 10,
});

const route = v.parse(LoTechModuleRouteSchema, {
	type: "lo-tech",
	moduleName: "lotech",
	path: "/:exchange/:priceSymbol",
	method: "GET",
	fetchFromModule: "{:priceSymbol}",
});

const params = { exchange: "compute_index", priceSymbol: SYMBOL };
const request = new Request("http://proxy.local/compute_index/x");

const waitFor = async (predicate: () => boolean, label: string) => {
	for (let i = 0; i < 2000; i++) {
		if (predicate()) return;
		await new Promise<void>((r) => setTimeout(r, 1));
	}
	throw new Error(`Timed out waiting for ${label}`);
};

const fetchPrice = Effect.gen(function* () {
	const svc = yield* ModuleService;
	const response = yield* svc.handleRequest(route, params, request);
	const body = (yield* Effect.promise(() => response.json())) as Array<
		Record<string, unknown>
	>;
	return body[0];
});

const servers: Server[] = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

describe("LoTechModuleService reconnects", () => {
	it("resubscribes after the socket closes and serves the new price", async () => {
		const fake = startFakeLoTech();
		servers.push(fake.server);

		const program = Effect.gen(function* () {
			const svc = yield* ModuleService;
			yield* svc.start();

			const before = yield* fetchPrice;

			fake.price = 200;
			fake.dropConnections();
			yield* Effect.promise(() =>
				waitFor(() => fake.subscribes.length >= 2, "resubscribe"),
			);

			const after = yield* fetchPrice;
			return { before, after };
		}).pipe(
			Effect.provide(LoTechModuleService(configFor(fake))),
			Logger.withMinimumLogLevel(LogLevel.None),
		);

		const { before, after } = await Effect.runPromise(program);

		expect(before).toMatchObject({ price: 100, [HAS_PRICE_KEY]: true });
		expect(after).toMatchObject({ price: 200, [HAS_PRICE_KEY]: true });
		// A request before the resubscribe is acked may send its own SUBSCRIBE too.
		expect(fake.subscribes.length).toBeGreaterThanOrEqual(2);
		expect(new Set(fake.subscribes.map((s) => s.symbol))).toEqual(
			new Set([SYMBOL]),
		);
	}, 10_000);

	it("does not serve the cached price while LO:TECH is unreachable", async () => {
		const fake = startFakeLoTech();
		servers.push(fake.server);

		const program = Effect.gen(function* () {
			const svc = yield* ModuleService;
			yield* svc.start();

			const before = yield* fetchPrice;

			fake.down = true;
			fake.dropConnections();
			yield* Effect.sleep(Duration.millis(50));
			const during = yield* fetchPrice;

			fake.price = 300;
			fake.down = false;
			yield* Effect.promise(() =>
				waitFor(() => fake.subscribes.length >= 2, "resubscribe"),
			);
			const after = yield* fetchPrice;
			return { before, during, after };
		}).pipe(
			Effect.provide(LoTechModuleService(configFor(fake))),
			Logger.withMinimumLogLevel(LogLevel.None),
		);

		const { before, during, after } = await Effect.runPromise(program);

		expect(before).toMatchObject({ price: 100, [HAS_PRICE_KEY]: true });
		expect(during).toEqual({ symbol: SYMBOL, [HAS_PRICE_KEY]: false });
		expect(after).toMatchObject({ price: 300, [HAS_PRICE_KEY]: true });
	}, 15_000);
});
