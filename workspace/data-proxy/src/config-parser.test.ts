import { describe, expect, it } from "bun:test";
import {
	assertIsErrorResult,
	assertIsOkResult,
} from "@seda-protocol/utils/testing";
import { Effect } from "effect";
import { parseConfig } from "./config/config-parser";

describe("parseConfig", () => {
	it("should check if route parameters are correctly used in the url", async () => {
		const [result] = Effect.runSync(
			parseConfig({
				routes: [
					{
						path: "/:coinA/:coinB",
						upstreamUrl: "aaaaaa.com?myCoin={:coinA}&coinYo={:coinA}",
						jsonPath: "$.coin[0].{:coinB}",
					},
				],
			}),
		);

		expect(result).toBeOkResult();
	});

	it("should check if route parameters are using env variables and if they exist", async () => {
		process.env.MY_SECRET = "shhh";

		const [result] = Effect.runSync(
			parseConfig({
				routes: [
					{
						path: "/:coinA/:coinB",
						upstreamUrl: "aaaaaa.com?myCoin={:coinA}&coinYo={:coinA}",
						jsonPath: "$.coin[0].{:coinB}",
						headers: {
							"x-secret": "api_key_{$MY_SECRET}",
						},
					},
				],
			}),
		);

		assertIsOkResult(result);
		expect(result.value.config.routes[0].headers).toEqual({
			"x-secret": "api_key_shhh",
		});
		process.env.MY_SECRET = undefined;
	});

	it("should error when a path arg has been used in the headers but was not set in the path", async () => {
		const [result] = Effect.runSync(
			parseConfig({
				routes: [
					{
						path: "/:coinA/:coinB",
						upstreamUrl: "aaaaaa.com?myCoin={:coinA}&coinYo={:coinA}",
						jsonPath: "$.coin[0].{:coinB}",
						headers: {
							"x-secret": "{:ccccc}",
						},
					},
				],
			}),
		);

		expect(result).toBeErrResult(
			"Header x-secret requires :ccccc, but it is not provided in the route /:coinA/:coinB",
		);
	});

	it("should check if route upstream url is using env variables and if they exist", async () => {
		const [result] = Effect.runSync(
			parseConfig({
				routes: [
					{
						path: "/:coinA/:coinB",
						upstreamUrl: "aaaaaa.com?myCoin={:coinA}&key={$MY_SECRET}",
						jsonPath: "$.coin[0].{:coinB}",
					},
				],
			}),
		);

		expect(result).toBeErrResult(
			"Upstream URL aaaaaa.com?myCoin={:coinA}&key={$MY_SECRET} requires MY_SECRET, but it is not provided as an environment variable",
		);

		process.env.MY_SECRET = "shhhh";

		const [result2] = Effect.runSync(
			parseConfig({
				routes: [
					{
						path: "/:coinA/:coinB",
						upstreamUrl: "aaaaaa.com?myCoin={:coinA}&key={$MY_SECRET}",
						jsonPath: "$.coin[0].{:coinB}",
					},
				],
			}),
		);

		expect(result2).toBeOkResult();
		process.env.MY_SECRET = undefined;
	});

	it("should check if route header is using env variables and if they exist", async () => {
		const [result] = Effect.runSync(
			parseConfig({
				routes: [
					{
						path: "/:coinA/:coinB",
						upstreamUrl: "aaaaaa.com?myCoin={:coinA}&coinYo={:coinA}",
						jsonPath: "$.coin[0].{:coinB}",
						headers: {
							"x-secret": "{$NO_SECRET}",
						},
					},
				],
			}),
		);

		expect(result).toBeErrResult(
			"Header x-secret requires NO_SECRET, but it is not provided as an environment variable",
		);
	});

	it("should check if * is used in upstream url but not in path", async () => {
		const [result] = Effect.runSync(
			parseConfig({
				routes: [
					{
						path: "/:coinA/:coinB",
						upstreamUrl: "aaaaaa.com/{*}",
					},
				],
			}),
		);

		expect(result).toBeErrResult(
			"Upstream URL aaaaaa.com/{*} uses {*}, but path does not end with * (/:coinA/:coinB)",
		);
	});

	it("should check if * is used in upstream url but does not end with {*}", async () => {
		const [result] = Effect.runSync(
			parseConfig({
				routes: [
					{
						path: "/:coinA/:coinB",
						upstreamUrl: "aaaaaa.com/{*}/something",
					},
				],
			}),
		);

		expect(result).toBeErrResult(
			"Upstream URL aaaaaa.com/{*}/something uses {*}, but it is not at the end of the URL",
		);
	});

	it("should allow * paths", async () => {
		const [result] = Effect.runSync(
			parseConfig({
				routes: [
					{
						path: "/:coinA/*",
						upstreamUrl: "aaaaaa.com/{*}",
					},
				],
			}),
		);

		expect(result).toBeOkResult();
	});

	it("should fail if the status endpoint uses a the same route group as the proxy", () => {
		const [result] = Effect.runSync(
			parseConfig({
				statusEndpoints: {
					root: "proxy",
				},
				routes: [],
			}),
		);

		assertIsErrorResult(result);
		expect(result.error).toContain("cannot be the same");
	});

	it.each(["OPTIONS", ["OPTIONS", "GET"]])(
		"should error when the OPTIONS method is used for a route",
		(method) => {
			const [resultSingle] = Effect.runSync(
				parseConfig({
					routes: [
						{
							method,
							path: "/:coinA/*",
							upstreamUrl: "aaaaaa.com/{*}",
						},
					],
				}),
			);

			assertIsErrorResult(resultSingle);
			expect(resultSingle.error).toContain("OPTIONS method is reserved");
		},
	);

	describe("module validation", () => {
		it("should reject a pyth-lazer module whose API key env var is unset", () => {
			process.env.PYTH_API_KEY = undefined;

			const [result] = Effect.runSync(
				parseConfig({
					routes: [],
					modules: [
						{
							type: "pyth-lazer",
							name: "pyth",
							pythLazerApiKeyEnvKey: "PYTH_API_KEY",
							priceFeedIds: [{ name: "BTC/USD", id: 1 }],
						},
					],
				}),
			);

			expect(result).toBeErrResult(
				"Module pyth-lazer requires PYTH_API_KEY to be set",
			);
		});

		it("should resolve a pyth-lazer module when its API key is set", () => {
			process.env.PYTH_API_KEY = "pyth-secret";

			const [result] = Effect.runSync(
				parseConfig({
					routes: [],
					modules: [
						{
							type: "pyth-lazer",
							name: "pyth",
							pythLazerApiKeyEnvKey: "PYTH_API_KEY",
							priceFeedIds: [{ name: "BTC/USD", id: 1 }],
						},
					],
				}),
			);

			assertIsOkResult(result);
			const module = result.value.config.modules[0];
			if (module.type !== "pyth-lazer") {
				throw new Error(`expected pyth-lazer, got ${module.type}`);
			}
			expect(module.pythLazerApiKey).toBe("pyth-secret");
			process.env.PYTH_API_KEY = undefined;
		});

		it.each([
			{
				missing: "key" as const,
				env: { CHAINLINK_KEY: undefined, CHAINLINK_SECRET: "secret" },
				expected: "Module chainlink-streams requires CHAINLINK_KEY to be set",
			},
			{
				missing: "secret" as const,
				env: { CHAINLINK_KEY: "key", CHAINLINK_SECRET: undefined },
				expected:
					"Module chainlink-streams requires CHAINLINK_SECRET to be set",
			},
		])(
			"should reject a chainlink-streams module when the $missing env var is unset",
			({ env, expected }) => {
				process.env.CHAINLINK_KEY = env.CHAINLINK_KEY;
				process.env.CHAINLINK_SECRET = env.CHAINLINK_SECRET;

				const [result] = Effect.runSync(
					parseConfig({
						routes: [],
						modules: [
							{
								type: "chainlink-streams",
								name: "chainlink",
								chainlinkKeyEnvKey: "CHAINLINK_KEY",
								chainlinkApiSecretEnvKey: "CHAINLINK_SECRET",
								baseUrl: "https://api.chainlink.example",
							},
						],
					}),
				);

				expect(result).toBeErrResult(expected);

				process.env.CHAINLINK_KEY = undefined;
				process.env.CHAINLINK_SECRET = undefined;
			},
		);

		it("should resolve a chainlink-streams module and track both env vars as secrets", () => {
			process.env.CHAINLINK_KEY = "key";
			process.env.CHAINLINK_SECRET = "secret";

			const [result] = Effect.runSync(
				parseConfig({
					routes: [],
					modules: [
						{
							type: "chainlink-streams",
							name: "chainlink",
							chainlinkKeyEnvKey: "CHAINLINK_KEY",
							chainlinkApiSecretEnvKey: "CHAINLINK_SECRET",
							baseUrl: "https://api.chainlink.example",
						},
					],
				}),
			);

			assertIsOkResult(result);
			const module = result.value.config.modules[0];
			if (module.type !== "chainlink-streams") {
				throw new Error(`expected chainlink-streams, got ${module.type}`);
			}
			expect(module.chainlinkKey).toBe("key");
			expect(module.chainlinkApiSecret).toBe("secret");
			expect(result.value.envSecrets.has("key")).toBe(true);
			expect(result.value.envSecrets.has("secret")).toBe(true);

			process.env.CHAINLINK_KEY = undefined;
			process.env.CHAINLINK_SECRET = undefined;
		});
	});

	describe("it should fail on unknown properties", () => {
		it("at the root", () => {
			const [result] = Effect.runSync(
				parseConfig({
					notRealAttribute: "unknown",
					routes: [],
				}),
			);

			assertIsErrorResult(result);
			expect(result.error).toContain(".notRealAttribute: Unknown attribute");
		});

		it("in a route", () => {
			const [result] = Effect.runSync(
				parseConfig({
					routes: [
						{
							notRealAttribute: "unknown",
							path: "/:coinA/:coinB",
							upstreamUrl: "aaaaaa.com?myCoin={:coinA}&coinYo={:coinA}",
							jsonPath: "$.coin[0].{:coinB}",
						},
					],
				}),
			);

			assertIsErrorResult(result);
			expect(result.error).toContain(
				'.routes.0.notRealAttribute: Invalid key: Expected never but received "notRealAttribute"',
			);
		});

		it("in a status endpoint", () => {
			const [result] = Effect.runSync(
				parseConfig({
					routes: [],
					statusEndpoints: {
						root: "health",
						notRealAttribute: "unknown",
					},
				}),
			);

			assertIsErrorResult(result);
			expect(result.error).toContain(
				".statusEndpoints.notRealAttribute: Unknown attribute",
			);
		});

		it("in a status apikey", () => {
			const [result] = Effect.runSync(
				parseConfig({
					routes: [],
					statusEndpoints: {
						root: "health",
						apiKey: {
							header: "x-api-key",
							secret: "secret",
							notRealAttribute: "unknown",
						},
					},
				}),
			);

			assertIsErrorResult(result);
			expect(result.error).toContain(
				".statusEndpoints.apiKey.notRealAttribute: Unknown attribute",
			);
		});
	});
});
