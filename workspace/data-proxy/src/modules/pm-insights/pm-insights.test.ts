import { afterEach, describe, expect, it, mock } from "bun:test";
import { Effect, LogLevel, Logger } from "effect";
import type { Route } from "../../config/config-parser";
import type { PmInsightsModuleConfig } from "../../config/pm-insights-module-config";
import { ModuleService } from "../module";
import { PmInsightsModuleService } from "./pm-insights";

const sampleIssuerResponse = {
	updated_at: "2026-07-13 11:18:46",
	info: {
		id: "AVAN08",
		display_name: "Anthropic",
	},
	price: {
		price: 721.35,
		is_derived: false,
		currency: "USD",
		ytd: 454.31,
		ytd_roi: 170.13,
	},
	volume: {
		three_months: {
			bid: 8119675000.0,
			ask: 20382777500.0,
		},
	},
	valuation: null,
};

const baseConfig: PmInsightsModuleConfig = {
	name: "pm-insights",
	type: "pm-insights",
	baseUrl: "https://api.pminsights.test/",
	emailEnvKey: "PM_INSIGHTS_EMAIL",
	passwordEnvKey: "PM_INSIGHTS_PASSWORD",
	email: "user@test.com",
	password: "secret",
	tokenRefreshIntervalMinutes: 50,
	tokenRetryIntervalMinutes: 5,
};

const routeFor = (fetchFromModule: string): Route =>
	({
		type: "pm-insights",
		moduleName: "pm-insights",
		fetchFromModule,
		path: "/:symbol",
		method: ["GET"],
	}) as unknown as Route;

const quiet = <A, E>(effect: Effect.Effect<A, E>) =>
	effect.pipe(Logger.withMinimumLogLevel(LogLevel.None));

const callHandle = (
	config: PmInsightsModuleConfig,
	params: Record<string, string>,
	fetchFromModule = "issuer/{:symbol}",
	requestUrl = "http://proxy.local/AVAN08",
) => {
	const program = Effect.gen(function* () {
		const svc = yield* ModuleService;
		return yield* svc.handleRequest(
			routeFor(fetchFromModule),
			params,
			new Request(requestUrl),
		);
	});
	return Effect.runPromise(
		quiet(program.pipe(Effect.provide(PmInsightsModuleService(config)))),
	);
};

const urlOf = (input: URL | RequestInfo): string =>
	input instanceof URL
		? input.toString()
		: input instanceof Request
			? input.url
			: String(input);

// TODO: Use dependency injection to mock the HTTP client instead of mutating the global fetch.
const mockPmInsightsFetch = (handlers?: {
	login?: (init?: RequestInit) => Response | Promise<Response>;
	upstream?: (url: string, init?: RequestInit) => Response | Promise<Response>;
}) =>
	mock(async (input: URL | RequestInfo, init?: RequestInit) => {
		const url = urlOf(input);
		if (url.includes("/login")) {
			return (
				handlers?.login?.(init) ??
				new Response(JSON.stringify({ access_token: "test-token" }), {
					status: 200,
				})
			);
		}
		if (handlers?.upstream) {
			return handlers.upstream(url, init);
		}
		if (url.includes("/issuer/")) {
			return new Response(JSON.stringify(sampleIssuerResponse), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		throw new Error(`Unexpected fetch: ${url}`);
	});

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("PmInsightsModuleService.handleRequest", () => {
	it("logs in, fetches upstream, and proxies the response body", async () => {
		const fetchMock = mockPmInsightsFetch({
			login: (init) => {
				expect(init?.method).toBe("POST");
				expect(init?.body).toBe(
					new URLSearchParams({
						username: baseConfig.email,
						password: baseConfig.password,
					}).toString(),
				);
				return new Response(JSON.stringify({ access_token: "test-token" }), {
					status: 200,
				});
			},
			upstream: (url, init) => {
				expect(url).toBe("https://api.pminsights.test/issuer/AVAN08");
				expect(init?.method).toBe("GET");
				expect((init?.headers as Record<string, string>).Authorization).toBe(
					"Bearer test-token",
				);
				return new Response(JSON.stringify(sampleIssuerResponse), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			},
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const response = await callHandle(baseConfig, { symbol: "AVAN08" });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(sampleIssuerResponse);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("forwards request query string to upstream", async () => {
		const fetchMock = mockPmInsightsFetch({
			upstream: (url) => {
				expect(url).toBe("https://api.pminsights.test/issuer/AVAN08?verbose=1");
				return new Response(JSON.stringify(sampleIssuerResponse), {
					status: 200,
				});
			},
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const response = await callHandle(
			baseConfig,
			{ symbol: "AVAN08" },
			"issuer/{:symbol}",
			"http://proxy.local/AVAN08?verbose=1",
		);
		expect(response.status).toBe(200);
	});

	it("returns 400 when the upstream path is missing", async () => {
		const fetchMock = mockPmInsightsFetch();
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const response = await callHandle(baseConfig, {}, "   ");
		expect(response.status).toBe(400);
		// Login still runs during module init; upstream is never fetched.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(urlOf(fetchMock.mock.calls[0][0] as URL | RequestInfo)).toContain(
			"/login",
		);
	});

	it("passes through upstream 4xx status and body", async () => {
		globalThis.fetch = mockPmInsightsFetch({
			upstream: () =>
				new Response("not found", {
					status: 404,
					headers: { "Content-Type": "text/plain" },
				}),
		}) as unknown as typeof fetch;

		const response = await callHandle(baseConfig, { symbol: "AVAN08" });
		expect(response.status).toBe(404);
		expect(await response.text()).toBe("not found");
		expect(response.headers.get("Content-Type")).toBe("text/plain");
	});

	it("reauthenticates when the upstream responds 400", async () => {
		const fetchMock = mockPmInsightsFetch({
			upstream: () => new Response("invalid credentials", { status: 400 }),
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const response = await callHandle(baseConfig, { symbol: "AVAN08" });
		expect(response.status).toBe(400);
		// init login + upstream + reauth login
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(urlOf(fetchMock.mock.calls[0][0] as URL | RequestInfo)).toContain(
			"/login",
		);
		expect(urlOf(fetchMock.mock.calls[1][0] as URL | RequestInfo)).toContain(
			"/issuer/",
		);
		expect(urlOf(fetchMock.mock.calls[2][0] as URL | RequestInfo)).toContain(
			"/login",
		);
	});

	it("returns 504 when the upstream fetch times out", async () => {
		globalThis.fetch = mockPmInsightsFetch({
			upstream: () => {
				const error = new Error("aborted");
				error.name = "TimeoutError";
				throw error;
			},
		}) as unknown as typeof fetch;

		const response = await callHandle(baseConfig, { symbol: "AVAN08" });
		expect(response.status).toBe(504);
	});

	it("dies during module init when login fails", async () => {
		globalThis.fetch = mockPmInsightsFetch({
			login: () =>
				new Response(JSON.stringify({ detail: "Bad Request" }), {
					status: 400,
				}),
		}) as unknown as typeof fetch;

		await expect(
			callHandle(baseConfig, { symbol: "AVAN08" }),
		).rejects.toThrow();
	});
});
