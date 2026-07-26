import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type {
	MultiFetch,
	MultiModuleRoute,
} from "../../config/multi-module-config";
import {
	FailedToHandleRequest,
	type ModuleHandlers,
} from "../../modules/module";
import {
	emptyParamsFor,
	handleMultiRequest,
	sanitizeParams,
} from "./handle-multi-request";

const handlers = (
	handleRequest: ModuleHandlers["handleRequest"],
): ModuleHandlers => ({
	start: () => Effect.succeed(undefined),
	handleRequest,
});

// Echoes back what the synthetic route/body carried so tests can assert the
// templates were filled and forwarded. `fetchFromModule` is not on every Route
// variant (e.g. upstream, hydromancer), so narrow before reading it.
const echoHandlers = handlers((route, _params, _request, body) =>
	Effect.succeed(
		new Response(
			JSON.stringify({
				fetchFromModule:
					"fetchFromModule" in route ? route.fetchFromModule : undefined,
				body,
			}),
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

const runRaw = (
	route: MultiModuleRoute,
	map: Map<string, ModuleHandlers>,
	url = "http://localhost/multi/BTC/1",
	params: Record<string, string> = { symbol: "BTC", index: "1" },
) =>
	Effect.runPromise(handleMultiRequest(route, params, new Request(url), map));

const run = (
	route: MultiModuleRoute,
	map: Map<string, ModuleHandlers>,
	url?: string,
	params?: Record<string, string>,
) => runRaw(route, map, url, params).then((res) => res.json());

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

	it("forwards Pyth channels and defaults them to fixed 200ms", async () => {
		const route = makeRoute([
			{
				name: "default",
				moduleName: "pyth",
				type: "pyth-lazer",
				fetchFromModule: "1",
			},
			{
				name: "realtime",
				moduleName: "pyth",
				type: "pyth-lazer",
				fetchFromModule: "1",
				channel: "real_time",
			},
		]);
		const pythHandlers = handlers((syntheticRoute) =>
			Effect.succeed(
				new Response(
					JSON.stringify({
						channel:
							syntheticRoute.type === "pyth-lazer"
								? syntheticRoute.channel
								: undefined,
					}),
					{ status: 200 },
				),
			),
		);

		const body = await run(
			route,
			new Map<string, ModuleHandlers>([["pyth", pythHandlers]]),
		);
		expect(body).toEqual({
			default: { channel: "fixed_rate@200ms" },
			realtime: { channel: "real_time" },
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

	describe("sources query param", () => {
		const twoVenueRoute = () =>
			makeRoute([
				{
					name: "binance",
					moduleName: "bin",
					type: "binance",
					fetchFromModule: "{:symbol}USDT",
				},
				{
					name: "binance-futures",
					moduleName: "fut",
					type: "binance",
					fetchFromModule: "{:symbol}USDT",
				},
			]);

		const countingHandlers = () => {
			let calls = 0;
			return {
				handlers: handlers((route) => {
					calls++;
					return Effect.succeed(
						new Response(
							JSON.stringify({
								fetchFromModule:
									"fetchFromModule" in route
										? route.fetchFromModule
										: undefined,
							}),
							{ status: 200 },
						),
					);
				}),
				calls: () => calls,
			};
		};

		it("runs only the fetches named in sources and skips the rest entirely", async () => {
			const bin = countingHandlers();
			const fut = countingHandlers();
			const map = new Map<string, ModuleHandlers>([
				["bin", bin.handlers],
				["fut", fut.handlers],
			]);

			const body = (await run(
				twoVenueRoute(),
				map,
				"http://localhost/multi/NVDA/110?sources=binance-futures",
			)) as Record<string, unknown>;

			expect(Object.keys(body)).toEqual(["binance-futures"]);
			expect(fut.calls()).toBe(1);
			expect(bin.calls()).toBe(0);
		});

		it("runs every fetch when the param is absent", async () => {
			const bin = countingHandlers();
			const fut = countingHandlers();
			const map = new Map<string, ModuleHandlers>([
				["bin", bin.handlers],
				["fut", fut.handlers],
			]);

			const body = (await run(twoVenueRoute(), map)) as Record<string, unknown>;

			expect(Object.keys(body).sort()).toEqual(["binance", "binance-futures"]);
			expect(bin.calls()).toBe(1);
			expect(fut.calls()).toBe(1);
		});

		it("rejects an unknown source name with 400", async () => {
			const map = new Map<string, ModuleHandlers>([
				["bin", echoHandlers],
				["fut", echoHandlers],
			]);

			const response = await runRaw(
				twoVenueRoute(),
				map,
				"http://localhost/multi/BTC/1?sources=binance,kraken",
			);

			expect(response.status).toBe(400);
			const body = (await response.json()) as { error: string };
			expect(body.error).toContain("unknown source(s): kraken");
		});

		it("rejects an empty sources param with 400", async () => {
			const map = new Map<string, ModuleHandlers>([
				["bin", echoHandlers],
				["fut", echoHandlers],
			]);

			const response = await runRaw(
				twoVenueRoute(),
				map,
				"http://localhost/multi/BTC/1?sources=",
			);

			expect(response.status).toBe(400);
			const body = (await response.json()) as { error: string };
			expect(body.error).toContain("no sources selected");
		});
	});

	describe("empty param token", () => {
		const countingEcho = () => {
			let calls = 0;
			return {
				handlers: handlers((route, _params, _request, body) => {
					calls++;
					return Effect.succeed(
						new Response(
							JSON.stringify({
								fetchFromModule:
									"fetchFromModule" in route
										? route.fetchFromModule
										: undefined,
								body,
							}),
							{ status: 200 },
						),
					);
				}),
				calls: () => calls,
			};
		};

		const binanceRoute = () =>
			makeRoute([
				{
					name: "binance",
					moduleName: "bin",
					type: "binance",
					fetchFromModule: "{:symbol}",
				},
				{
					name: "lighter",
					moduleName: "lig",
					type: "lighter",
					fetchFromModule: "{:index}",
				},
			]);

		it("drops placeholder elements and forwards the remaining assets", async () => {
			const map = new Map<string, ModuleHandlers>([
				["bin", echoHandlers],
				["lig", echoHandlers],
			]);

			const body = await run(binanceRoute(), map, undefined, {
				symbol: "BTC,_,SOL",
				index: "1,2,3",
			});

			expect(body).toEqual({
				binance: { fetchFromModule: "BTC,SOL" },
				lighter: { fetchFromModule: "1,2,3" },
			});
		});

		it("skips a fetch whose only param is the placeholder without calling the module", async () => {
			const bin = countingEcho();
			const lig = countingEcho();
			const map = new Map<string, ModuleHandlers>([
				["bin", bin.handlers],
				["lig", lig.handlers],
			]);

			const body = (await run(binanceRoute(), map, undefined, {
				symbol: "_",
				index: "1",
			})) as Record<string, unknown>;

			expect(body.binance).toEqual([]);
			expect(bin.calls()).toBe(0);
			expect(lig.calls()).toBe(1);
		});

		it("leaves an underscore inside a symbol untouched", async () => {
			const map = new Map<string, ModuleHandlers>([
				["bin", echoHandlers],
				["lig", echoHandlers],
			]);

			const body = (await run(binanceRoute(), map, undefined, {
				symbol: "BTC_USD",
				index: "1",
			})) as Record<string, unknown>;

			expect(body.binance).toEqual({ fetchFromModule: "BTC_USD" });
		});

		it("skips a body-template fetch and returns the hydromancer empty shape", async () => {
			const hydro = countingEcho();
			const route = makeRoute([
				{
					name: "hydro",
					moduleName: "hydro",
					type: "hydromancer",
					body: '{"type":"assetContext","coins":["{:symbol}"]}',
				},
			]);
			const map = new Map<string, ModuleHandlers>([["hydro", hydro.handlers]]);

			const body = (await run(route, map, undefined, {
				symbol: "_",
				index: "1",
			})) as Record<string, unknown>;

			expect(body.hydro).toEqual({});
			expect(hydro.calls()).toBe(0);
		});

		it("intersects with the sources query param", async () => {
			const map = new Map<string, ModuleHandlers>([
				["bin", echoHandlers],
				["lig", echoHandlers],
			]);

			const body = (await run(
				binanceRoute(),
				map,
				"http://localhost/multi/_/1?sources=binance,lighter",
				{ symbol: "_", index: "1" },
			)) as Record<string, unknown>;

			expect(body.binance).toEqual([]);
			expect(body.lighter).toEqual({ fetchFromModule: "1" });
		});

		it("returns 200 with every value empty when all params are the placeholder", async () => {
			const map = new Map<string, ModuleHandlers>([
				["bin", echoHandlers],
				["lig", echoHandlers],
			]);

			const response = await runRaw(binanceRoute(), map, undefined, {
				symbol: "_",
				index: "_",
			});

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ binance: [], lighter: [] });
		});
	});
});

describe("sanitizeParams", () => {
	it("drops whole-element placeholder tokens from a comma list", () => {
		expect(sanitizeParams({ symbol: "BTC,_,SOL" })).toEqual({
			symbol: "BTC,SOL",
		});
	});

	it("empties a param that is only the placeholder", () => {
		expect(sanitizeParams({ symbol: "_" })).toEqual({ symbol: "" });
	});

	it("leaves the placeholder alone inside a larger element", () => {
		expect(sanitizeParams({ symbol: "BTC_USD,wstETH_1" })).toEqual({
			symbol: "BTC_USD,wstETH_1",
		});
	});

	it("strips surrounding whitespace before matching the token", () => {
		expect(sanitizeParams({ symbol: "BTC, _ ,SOL" })).toEqual({
			symbol: "BTC,SOL",
		});
	});

	it("leaves params without the token untouched", () => {
		expect(sanitizeParams({ market: "1,2,3", tk: "BTC" })).toEqual({
			market: "1,2,3",
			tk: "BTC",
		});
	});

	it("handles an empty params map", () => {
		expect(sanitizeParams({})).toEqual({});
	});
});

const fetchOf = (overrides: Partial<MultiFetch>): MultiFetch => ({
	name: "f",
	moduleName: "m",
	type: "binance",
	...overrides,
});

describe("emptyParamsFor", () => {
	it("reports a referenced param that sanitized to empty", () => {
		const fetch = fetchOf({ fetchFromModule: "{:symbol}" });
		expect(emptyParamsFor(fetch, { symbol: "", market: "1" })).toEqual([
			"symbol",
		]);
	});

	it("ignores an empty param the fetch does not reference", () => {
		const fetch = fetchOf({ fetchFromModule: "{:market}" });
		expect(emptyParamsFor(fetch, { symbol: "", market: "1" })).toEqual([]);
	});

	it("reports an empty param referenced from a body template", () => {
		const fetch = fetchOf({
			type: "hydromancer",
			body: '{"type":"assetContext","coins":["{:tk}"]}',
		});
		expect(emptyParamsFor(fetch, { tk: "" })).toEqual(["tk"]);
	});

	it("reports every empty referenced param when a fetch uses several", () => {
		const fetch = fetchOf({ fetchFromModule: "{:symbol}-{:market}" });
		expect(emptyParamsFor(fetch, { symbol: "", market: "" }).sort()).toEqual([
			"market",
			"symbol",
		]);
	});

	it("returns nothing when every referenced param has a value", () => {
		const fetch = fetchOf({ fetchFromModule: "{:symbol}" });
		expect(emptyParamsFor(fetch, { symbol: "BTC,SOL" })).toEqual([]);
	});

	it("recognizes both wildcard reference forms", () => {
		expect(
			emptyParamsFor(fetchOf({ fetchFromModule: "{*}" }), { "*": "" }),
		).toEqual(["*"]);
		expect(
			emptyParamsFor(fetchOf({ fetchFromModule: "{:*}" }), { "*": "" }),
		).toEqual(["*"]);
	});

	it("does not match a reference split across fetchFromModule and body", () => {
		const fetch = fetchOf({ fetchFromModule: "{:sym", body: "bol}" });
		expect(emptyParamsFor(fetch, { symbol: "" })).toEqual([]);
	});
});
