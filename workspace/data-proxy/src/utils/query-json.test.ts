import { describe, expect, it } from "bun:test";
import { unwrapResultError } from "@seda-protocol/utils/testing";
import { queryJson } from "./query-json";

describe("queryJson", () => {
	it("should be able to find a nested variable inside a JSON object", () => {
		const result = queryJson(
			JSON.stringify({ a: { b: { c: "ok" } } }),
			"$.a.b.c",
		);

		expect(result).toBeOkResult("ok");
	});

	it("should return an error when the variable was not found", () => {
		const result = queryJson(
			JSON.stringify({ a: { b: { c: "ok" } } }),
			"$.a.b.b",
		);

		const value = unwrapResultError(result);

		expect(value).toInclude("Quering JSON with $.a.b.b returned null");
	});

	it("should return an error when the JSON body is not an object", () => {
		const result = queryJson(JSON.stringify(""), "$.a.b.b");

		const value = unwrapResultError(result);

		expect(value).toInclude(
			"Quering JSON with $.a.b.b returned not an array: undefined",
		);
	});
});
