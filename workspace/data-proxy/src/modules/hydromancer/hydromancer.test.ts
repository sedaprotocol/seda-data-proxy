import { afterEach, describe, expect, it, mock } from "bun:test";
import { Duration, Effect } from "effect";
import * as v from "valibot";
import {
	type HydromancerModuleConfig,
	HydromancerModuleRouteSchema,
} from "../../config/hydromancer-module-config";
import { ModuleService } from "../module";
import { HydromancerModuleService } from "./hydromancer";

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

const buildRoute = (fetchFromModule: string) =>
	v.parse(HydromancerModuleRouteSchema, {
		type: "hydromancer",
		moduleName: "hydromancer",
		path: "/hydromancer/:coin",
		fetchFromModule,
	});

const callHandle = (
	config: HydromancerModuleConfig,
	fetchFromModule: string,
	params: Record<string, string>,
) => {
	const route = buildRoute(fetchFromModule);
	const program = Effect.gen(function* () {
		const svc = yield* ModuleService;
		return yield* svc.handleRequest(
			route,
			params,
			new Request("http://proxy.local/hydromancer/BTC"),
		);
	});
	return Effect.runPromise(
		program.pipe(Effect.provide(HydromancerModuleService(config))),
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

		const response = await callHandle(baseConfig, "BTC,ETH", {});
		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const body = await response.json();
		expect(body).toEqual([
			{ coin: "BTC", ...btcCtx },
			{ coin: "ETH", ...ethCtx },
		]);
	});

	it("filters out coins that come back null", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ BTC: btcCtx, ZZZ: null }), {
					status: 200,
				}),
		) as unknown as typeof fetch;

		const response = await callHandle(baseConfig, "BTC,ZZZ", {});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toEqual([{ coin: "BTC", ...btcCtx }]);
	});

	it("returns an empty array when every coin is unknown", async () => {
		globalThis.fetch = mock(
			async () => new Response(JSON.stringify({ ZZZ: null }), { status: 200 }),
		) as unknown as typeof fetch;

		const response = await callHandle(baseConfig, "ZZZ", {});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toEqual([]);
	});

	it("substitutes path params into fetchFromModule", async () => {
		const captured: { body?: unknown } = {};
		globalThis.fetch = mock(
			async (_input: URL | RequestInfo, init?: RequestInit) => {
				captured.body = JSON.parse(init?.body as string);
				return new Response(JSON.stringify({ BTC: btcCtx }), { status: 200 });
			},
		) as unknown as typeof fetch;

		const response = await callHandle(baseConfig, "{:coin}", { coin: "BTC" });
		expect(response.status).toBe(200);
		expect(captured.body).toEqual({ type: "assetContext", coins: ["BTC"] });
	});

	it("passes through a 4xx upstream status", async () => {
		globalThis.fetch = mock(
			async () => new Response("Bad request", { status: 400 }),
		) as unknown as typeof fetch;

		const response = await callHandle(baseConfig, "BTC", {});
		expect(response.status).toBe(400);
	});

	it("maps a 5xx upstream status to 502", async () => {
		globalThis.fetch = mock(
			async () => new Response("internal", { status: 500 }),
		) as unknown as typeof fetch;

		const response = await callHandle(baseConfig, "BTC", {});
		expect(response.status).toBe(502);
	});

	it("returns 504 when the fetch times out", async () => {
		globalThis.fetch = mock(async () => {
			const error = new Error("aborted");
			error.name = "TimeoutError";
			throw error;
		}) as unknown as typeof fetch;

		const response = await callHandle(baseConfig, "BTC", {});
		expect(response.status).toBe(504);
	});

	it("returns 502 when the response shape is invalid", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ BTC: { oraclePx: 1 } }), {
					status: 200,
				}),
		) as unknown as typeof fetch;

		const response = await callHandle(baseConfig, "BTC", {});
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

		const response = await callHandle(tightConfig, "BTC,ETH,SOL", {});
		expect(response.status).toBe(400);
	});
});
