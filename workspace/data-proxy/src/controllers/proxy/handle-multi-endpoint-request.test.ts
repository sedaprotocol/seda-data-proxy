import { describe, expect, it } from "bun:test";
import type { DataProxy } from "@seda-protocol/data-proxy-sdk";
import { Effect, Option } from "effect";
import { Maybe } from "true-myth";
import type { Config } from "../../config/config-parser";
import {
	DEFAULT_MULTI_CONCURRENCY,
	DEFAULT_MULTI_ENDPOINT_PATH,
	DEFAULT_MULTI_MAX_SUB_REQUESTS,
	type MultiEndpoint,
} from "../../config/multi-endpoint-config";
import {
	DEFAULT_PROXY_ROUTE_GROUP,
	DEFAULT_VERIFICATION_MAX_RETRIES,
	DEFAULT_VERIFICATION_RETRY_DELAY,
} from "../../constants";
import {
	FailedToHandleRequest,
	type ModuleHandlers,
} from "../../modules/module";
import { HttpClientService } from "../../services/http-client";
import {
	type HandleMultiEndpointRequestParams,
	handleMultiEndpointRequest,
} from "./handle-multi-endpoint-request";

const mockDataProxy = {
	signData: () =>
		Effect.succeed({
			signature: "sig",
			publicKey: "pub",
			version: "1",
		}),
} as unknown as DataProxy;

const handlers = (
	handleRequest: ModuleHandlers["handleRequest"],
): ModuleHandlers => ({
	start: () => Effect.succeed(undefined),
	handleRequest,
});

const echoHandlers = handlers((route, params, _request, body) =>
	Effect.succeed(
		new Response(
			JSON.stringify({
				type: route.type,
				params,
				fetchFromModule:
					"fetchFromModule" in route ? route.fetchFromModule : undefined,
				body,
			}),
			{ status: 200 },
		),
	),
);

const baseConfig = (): Config => ({
	fastOnly: true,
	modules: [],
	routes: [],
	verificationMaxRetries: DEFAULT_VERIFICATION_MAX_RETRIES,
	verificationRetryDelay: DEFAULT_VERIFICATION_RETRY_DELAY,
	routeGroup: DEFAULT_PROXY_ROUTE_GROUP,
	baseURL: Maybe.nothing(),
	statusEndpoints: { root: "status" },
	multiEndpoint: {
		enable: false,
		path: DEFAULT_MULTI_ENDPOINT_PATH,
		maxSubRequests: DEFAULT_MULTI_MAX_SUB_REQUESTS,
		concurrency: DEFAULT_MULTI_CONCURRENCY,
	},
});

const binanceRoute = {
	type: "binance" as const,
	moduleName: "bin",
	path: "/binance/:symbols",
	method: ["GET"] as string[],
	fetchFromModule: "{:symbols}",
	headers: {},
	useLegacyJsonPath: true,
	forwardResponseHeaders: new Set<string>(),
	baseURL: Maybe.nothing(),
};

const lighterRoute = {
	type: "lighter" as const,
	moduleName: "lig",
	path: "/lighter/:markets",
	method: ["GET"] as string[],
	fetchFromModule: "{:markets}",
	headers: {},
	useLegacyJsonPath: true,
	forwardResponseHeaders: new Set<string>(),
	baseURL: Maybe.nothing(),
};

const hydromancerRoute = {
	type: "hydromancer" as const,
	moduleName: "hydro",
	path: "/hydromancer/asset-context",
	method: ["POST"] as string[],
	headers: {},
	useLegacyJsonPath: true,
	forwardResponseHeaders: new Set<string>(),
	baseURL: Maybe.nothing(),
};

const runMultiEndpoint = async (
	body: unknown,
	moduleHandlers: Map<string, ModuleHandlers>,
	eligibleRoutes: Config["routes"],
	multiEndpoint: MultiEndpoint = {
		enable: true,
		path: DEFAULT_MULTI_ENDPOINT_PATH,
		maxSubRequests: DEFAULT_MULTI_MAX_SUB_REQUESTS,
		concurrency: DEFAULT_MULTI_CONCURRENCY,
	},
	headers: Record<string, string | undefined> = {},
) => {
	const bodyText = JSON.stringify(body);
	const params: HandleMultiEndpointRequestParams = {
		serverOptions: { port: 0, disableProof: true },
		dataProxy: mockDataProxy,
		headers: {
			"content-type": "application/json",
			"content-length": String(bodyText.length),
			...headers,
		},
		body: Option.some(bodyText),
		path: "/multi",
		config: baseConfig(),
		request: new Request("http://localhost/proxy/multi", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"content-length": String(bodyText.length),
			},
			body: bodyText,
		}),
		moduleHandlers,
		eligibleRoutes,
		multiEndpoint,
	};

	return Effect.runPromise(
		handleMultiEndpointRequest(params).pipe(
			Effect.provide(HttpClientService.Default()),
		),
	);
};

describe("handleMultiEndpointRequest", () => {
	it("fans out to matching routes and keys results by id", async () => {
		const map = new Map<string, ModuleHandlers>([
			["bin", echoHandlers],
			["lig", echoHandlers],
		]);

		const response = await runMultiEndpoint(
			{
				binance: { path: "/binance/BTC,ETH" },
				lighter: { path: "/lighter/1,2" },
			},
			map,
			[binanceRoute, lighterRoute] as Config["routes"],
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			binance: {
				type: "binance",
				params: { symbols: "BTC,ETH" },
				fetchFromModule: "{:symbols}",
				body: undefined,
			},
			lighter: {
				type: "lighter",
				params: { markets: "1,2" },
				fetchFromModule: "{:markets}",
				body: undefined,
			},
		});
	});

	it("forwards a JSON body to a POST module route", async () => {
		const map = new Map<string, ModuleHandlers>([["hydro", echoHandlers]]);

		const response = await runMultiEndpoint(
			{
				hydro: {
					path: "/hydromancer/asset-context",
					method: "POST",
					body: { type: "assetContext", coins: "BTC,ETH" },
				},
			},
			map,
			[hydromancerRoute] as Config["routes"],
		);

		expect(await response.json()).toEqual({
			hydro: {
				type: "hydromancer",
				params: {},
				fetchFromModule: undefined,
				body: '{"type":"assetContext","coins":"BTC,ETH"}',
			},
		});
	});

	it("returns a per-id 404 when no route matches", async () => {
		const response = await runMultiEndpoint(
			{
				missing: { path: "/nope/1" },
			},
			new Map(),
			[binanceRoute] as Config["routes"],
		);

		expect(await response.json()).toEqual({
			missing: {
				error: "No configured route matches GET /nope/1",
				status: 404,
			},
		});
	});

	it("captures a module handler failure as a sub-request error", async () => {
		const failing = handlers(() =>
			Effect.fail(new FailedToHandleRequest({ msg: "boom" })),
		);
		const map = new Map<string, ModuleHandlers>([
			["bin", echoHandlers],
			["lig", failing],
		]);

		const response = await runMultiEndpoint(
			{
				binance: { path: "/binance/BTC" },
				lighter: { path: "/lighter/1" },
			},
			map,
			[binanceRoute, lighterRoute] as Config["routes"],
		);

		const body = (await response.json()) as Record<string, unknown>;
		expect(body.binance).toEqual({
			type: "binance",
			params: { symbols: "BTC" },
			fetchFromModule: "{:symbols}",
			body: undefined,
		});
		expect(body.lighter).toEqual({
			error: "Failed to handle request: boom",
			status: 500,
		});
	});

	it("rejects requests that exceed maxSubRequests", async () => {
		const response = await runMultiEndpoint(
			{
				a: { path: "/binance/BTC" },
				b: { path: "/binance/ETH" },
			},
			new Map([["bin", echoHandlers]]),
			[binanceRoute] as Config["routes"],
			{ enable: true, path: "multi", maxSubRequests: 1, concurrency: 1 },
		);

		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string };
		expect(body.error).toContain("maxSubRequests");
	});

	it("rejects invalid JSON with 400", async () => {
		const response = await Effect.runPromise(
			handleMultiEndpointRequest({
				serverOptions: { port: 0, disableProof: true },
				dataProxy: mockDataProxy,
				headers: {},
				body: Option.some("{not-json"),
				path: "/multi",
				config: baseConfig(),
				request: new Request("http://localhost/proxy/multi", {
					method: "POST",
					body: "{not-json",
				}),
				moduleHandlers: new Map(),
				eligibleRoutes: [],
				multiEndpoint: {
					enable: true,
					path: DEFAULT_MULTI_ENDPOINT_PATH,
					maxSubRequests: DEFAULT_MULTI_MAX_SUB_REQUESTS,
					concurrency: DEFAULT_MULTI_CONCURRENCY,
				},
			}).pipe(Effect.provide(HttpClientService.Default())),
		);

		expect(response.status).toBe(400);
	});

	it("uses sub-request headers and ignores parent request headers", async () => {
		let seen: Headers | undefined;
		const capturing = handlers((_route, _params, request) => {
			seen = request.headers;
			return Effect.succeed(
				new Response(JSON.stringify({ ok: true }), { status: 200 }),
			);
		});

		const response = await runMultiEndpoint(
			{
				binance: {
					path: "/binance/BTC",
					headers: { "x-custom": "from-body" },
				},
			},
			new Map([["bin", capturing]]),
			[binanceRoute] as Config["routes"],
			undefined,
			{ "x-custom": "from-parent", "user-agent": "curl/8.7.1" },
		);

		expect(response.status).toBe(200);
		expect(seen?.get("content-length")).toBeNull();
		expect(seen?.get("content-type")).toBeNull();
		expect(seen?.get("user-agent")).toBeNull();
		expect(seen?.get("x-custom")).toBe("from-body");
	});
});
