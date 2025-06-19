import { describe, expect, it } from "bun:test";
import {
	assertIsErrorResult,
	assertIsOkResult,
} from "@seda-protocol/utils/testing";
import { parseConfig } from "./config-parser";

describe("parseConfig", () => {
	it("should check if route parameters are correctly used in the url", async () => {
		const [result] = parseConfig({
			routes: [
				{
					path: "/:coinA/:coinB",
					upstreamUrl: "aaaaaa.com?myCoin={:coinA}&coinYo={:coinA}",
					jsonPath: "$.coin[0].{:coinB}",
				},
			],
		});

		expect(result).toBeOkResult();
	});

	it("should check if route parameters are using env variables and if they exist", async () => {
		process.env.MY_SECRET = "shhh";

		const [result] = parseConfig({
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
		const [result] = parseConfig({
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

		expect(result).toBeErrResult(
			"Header x-secret required :ccccc but was not given in route /:coinA/:coinB",
		);
	});

	it("should check if route parameters are using env variables and if they exist", async () => {
		const [result] = parseConfig({
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

		expect(result).toBeErrResult(
			"Header x-secret required NO_SECRET but was not available in the environment",
		);
	});

	it("should check if * is used in upstream url but not in path", async () => {
		const [result] = parseConfig({
			routes: [
				{
					path: "/:coinA/:coinB",
					upstreamUrl: "aaaaaa.com/{*}",
				},
			],
		});

		expect(result).toBeErrResult(
			"UpstreamUrl: aaaaaa.com/{*} required {*} but path did not end with * (/:coinA/:coinB)",
		);
	});

	it("should check if * is used in upstream url but does not end with {*}", async () => {
		const [result] = parseConfig({
			routes: [
				{
					path: "/:coinA/:coinB",
					upstreamUrl: "aaaaaa.com/{*}/something",
				},
			],
		});

		expect(result).toBeErrResult(
			"UpstreamUrl: aaaaaa.com/{*}/something uses {*} but was not at the end of the URL",
		);
	});

	it("should allow * paths", async () => {
		const [result] = parseConfig({
			routes: [
				{
					path: "/:coinA/*",
					upstreamUrl: "aaaaaa.com/{*}",
				},
			],
		});

		expect(result).toBeOkResult();
	});

	it("should fail if the status endpoint uses a the same route group as the proxy", () => {
		const [result] = parseConfig({
			statusEndpoints: {
				root: "proxy",
			},
			routes: [],
		});

		assertIsErrorResult(result);
		expect(result.error).toContain("can not be the same");
	});

	it.each(["OPTIONS", ["OPTIONS", "GET"]])(
		"should error when the OPTIONS method is used for a route",
		(method) => {
			const [resultSingle] = parseConfig({
				routes: [
					{
						method,
						path: "/:coinA/*",
						upstreamUrl: "aaaaaa.com/{*}",
					},
				],
			});

			assertIsErrorResult(resultSingle);
			expect(resultSingle.error).toContain("OPTIONS method is reserved");
		},
	);

	describe("it should fail on unknown properties", () => {
		it("at the root", () => {
			const [result] = parseConfig({
				notRealAttribute: "unknown",
				routes: [],
			});

			assertIsErrorResult(result);
			expect(result.error).toContain(".notRealAttribute: Unknown attribute");
		});

		it("in a route", () => {
			const [result] = parseConfig({
				routes: [
					{
						notRealAttribute: "unknown",
						path: "/:coinA/:coinB",
						upstreamUrl: "aaaaaa.com?myCoin={:coinA}&coinYo={:coinA}",
						jsonPath: "$.coin[0].{:coinB}",
					},
				],
			});

			assertIsErrorResult(result);
			expect(result.error).toContain(
				".routes.0.notRealAttribute: Unknown attribute",
			);
		});

		it("in a status endpoint", () => {
			const [result] = parseConfig({
				routes: [],
				statusEndpoints: {
					root: "health",
					notRealAttribute: "unknown",
				},
			});

			assertIsErrorResult(result);
			expect(result.error).toContain(
				".statusEndpoints.notRealAttribute: Unknown attribute",
			);
		});

		it("in a status apikey", () => {
			const [result] = parseConfig({
				routes: [],
				statusEndpoints: {
					root: "health",
					apiKey: {
						header: "x-api-key",
						secret: "secret",
						notRealAttribute: "unknown",
					},
				},
			});

			assertIsErrorResult(result);
			expect(result.error).toContain(
				".statusEndpoints.apiKey.notRealAttribute: Unknown attribute",
			);
		});
	});
});
