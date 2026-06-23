import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { MultiModuleRoute } from "../../config/multi-module-config";
import {
	FailedToHandleRequest,
	type ModuleHandlers,
} from "../../modules/module";
import { handleMultiRequest } from "./handle-multi-request";

const handlers = (
	handleRequest: ModuleHandlers["handleRequest"],
): ModuleHandlers => ({
	start: () => Effect.succeed(undefined),
	handleRequest,
});

// Echoes back what the synthetic route/body carried so tests can assert the
// templates were filled and forwarded.
const echoHandlers = handlers((route, _params, _request, body) =>
	Effect.succeed(
		new Response(
			JSON.stringify({ fetchFromModule: route.fetchFromModule, body }),
			{ status: 200 },
		),
	),
);

const makeRoute = (fetches: MultiModuleRoute["fetches"]): MultiModuleRoute =>
	({
		type: "multi",
		moduleName: "default",
		path: "/multi/:symbol/:index",
		method: ["GET"],
		fetches,
		headers: {},
		useLegacyJsonPath: true,
		forwardResponseHeaders: new Set<string>(),
	}) as unknown as MultiModuleRoute;

const run = (route: MultiModuleRoute, map: Map<string, ModuleHandlers>) =>
	Effect.runPromise(
		handleMultiRequest(
			route,
			{ symbol: "BTC", index: "1" },
			new Request("http://localhost/multi/BTC/1"),
			map,
		).pipe(Effect.flatMap((res) => Effect.promise(() => res.json()))),
	);

describe("handleMultiRequest", () => {
	it("fills each fetch template from the request params and keys results by name", async () => {
		const route = makeRoute([
			{
				name: "binance",
				moduleName: "bin",
				type: "binance",
				fetchFromModule: "{:symbol}USDT",
			},
			{
				name: "lighter",
				moduleName: "lig",
				type: "lighter",
				fetchFromModule: "{:index}",
			},
		]);
		const map = new Map<string, ModuleHandlers>([
			["bin", echoHandlers],
			["lig", echoHandlers],
		]);

		const body = await run(route, map);
		expect(body).toEqual({
			binance: { fetchFromModule: "BTCUSDT" },
			lighter: { fetchFromModule: "1" },
		});
	});

	it("fills a body template and forwards it to the target module", async () => {
		const route = makeRoute([
			{
				name: "hydro",
				moduleName: "hydro",
				type: "hydromancer",
				body: '{"type":"assetContext","coins":["{:symbol}"]}',
			},
		]);
		const map = new Map<string, ModuleHandlers>([["hydro", echoHandlers]]);

		const body = await run(route, map);
		expect(body).toEqual({
			hydro: {
				fetchFromModule: "",
				body: '{"type":"assetContext","coins":["BTC"]}',
			},
		});
	});

	it("records a per-fetch error for a missing module without failing the request", async () => {
		const route = makeRoute([
			{
				name: "binance",
				moduleName: "bin",
				type: "binance",
				fetchFromModule: "{:symbol}",
			},
			{
				name: "ghost",
				moduleName: "ghost",
				type: "lighter",
				fetchFromModule: "{:index}",
			},
		]);
		const map = new Map<string, ModuleHandlers>([["bin", echoHandlers]]);

		const body = (await run(route, map)) as Record<string, unknown>;
		expect(body.binance).toEqual({ fetchFromModule: "BTC" });
		expect(body.ghost).toEqual({
			error: "Module ghost not found",
			status: 500,
		});
	});

	it("captures a sub-fetch handler failure as an error entry", async () => {
		const failing = handlers(() =>
			Effect.fail(new FailedToHandleRequest({ msg: "boom" })),
		);
		const route = makeRoute([
			{
				name: "binance",
				moduleName: "bin",
				type: "binance",
				fetchFromModule: "{:symbol}",
			},
			{
				name: "broken",
				moduleName: "brk",
				type: "lighter",
				fetchFromModule: "{:index}",
			},
		]);
		const map = new Map<string, ModuleHandlers>([
			["bin", echoHandlers],
			["brk", failing],
		]);

		const body = (await run(route, map)) as Record<string, unknown>;
		expect(body.binance).toEqual({ fetchFromModule: "BTC" });
		expect(body.broken).toEqual({
			error: "Failed to handle request: boom",
			status: 500,
		});
	});

	it("captures a non-ok sub-fetch response", async () => {
		const notOk = handlers(() =>
			Effect.succeed(
				new Response(JSON.stringify({ reason: "bad" }), { status: 502 }),
			),
		);
		const route = makeRoute([
			{
				name: "x",
				moduleName: "x",
				type: "lighter",
				fetchFromModule: "{:index}",
			},
		]);
		const map = new Map<string, ModuleHandlers>([["x", notOk]]);

		const body = (await run(route, map)) as Record<string, unknown>;
		expect(body.x).toEqual({
			error: "Sub-fetch returned a non-ok response",
			status: 502,
			body: { reason: "bad" },
		});
	});
});
