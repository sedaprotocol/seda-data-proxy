import { describe, expect, it } from "bun:test";
import { parseConfig } from "./config-parser";
import { assertIsErrorResult, assertIsOkResult } from "./testutils/true-myth";

describe("parseConfig", () => {
	it("should check if route parameters are correctly used in the url", async () => {
		const result = parseConfig({
			routes: [
				{
					path: "/:coinA/:coinB",
					upstreamUrl: "aaaaaa.com?myCoin={:coinA}&coinYo={:coinA}",
					jsonPath: "$.coin[0].{:coinB}",
				},
			],
		});

		expect(result.isOk).toBe(true);
	});

	it("should check if route parameters are using env variables and if they exist", async () => {
		process.env.MY_SECRET = "shhh";

		const result = parseConfig({
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
		});

		assertIsOkResult(result);
		expect(result.value.routes[0].headers).toEqual({
			"x-secret": "api_key_shhh",
		});
		process.env.MY_SECRET = undefined;
	});

	it("should error when a path arg has been used in the headers but was not set in the path", async () => {
		const result = parseConfig({
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
		});

		assertIsErrorResult(result);
		expect(result.error).toBe(
			"Header x-secret required :ccccc but was not given in route /:coinA/:coinB",
		);
	});

	it("should check if route parameters are using env variables and if they exist", async () => {
		const result = parseConfig({
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
		});

		assertIsErrorResult(result);
		expect(result.error).toBe(
			"Header x-secret required NO_SECRET but was not available in the environment",
		);
	});

	it("should check if * is used in upstream url but not in path", async () => {
		const result = parseConfig({
			routes: [
				{
					path: "/:coinA/:coinB",
					upstreamUrl: "aaaaaa.com/{*}",
				},
			],
		});

		assertIsErrorResult(result);
		expect(result.error).toBe(
			"UpstreamUrl: aaaaaa.com/{*} required {*} but path did not end with * (/:coinA/:coinB)",
		);
	});

	it("should check if * is used in upstream url but does not end with {*}", async () => {
		const result = parseConfig({
			routes: [
				{
					path: "/:coinA/:coinB",
					upstreamUrl: "aaaaaa.com/{*}/something",
				},
			],
		});

		assertIsErrorResult(result);
		expect(result.error).toBe(
			"UpstreamUrl: aaaaaa.com/{*}/something uses {*} but was not at the end of the URL",
		);
	});

	it("should allow * paths", async () => {
		const result = parseConfig({
			routes: [
				{
					path: "/:coinA/*",
					upstreamUrl: "aaaaaa.com/{*}",
				},
			],
		});

		assertIsOkResult(result);
	});
});
