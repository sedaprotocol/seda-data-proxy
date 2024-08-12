import { describe, expect, it } from "bun:test";
import { queryJson } from "./query-json";

describe("queryJson", () => {
	it("should be able to find a nested variable inside a JSON object", () => {
		const result = queryJson(
			JSON.stringify({ a: { b: { c: "ok" } } }),
			"$.a.b.c",
		);

		expect(result.unwrapOr("")).toBe("ok");
	});

	it("should return an error when the variable was not found", () => {
		const result = queryJson(
			JSON.stringify({ a: { b: { c: "ok" } } }),
			"$.a.b.b",
		);

		expect(result.isErr).toBe(true);
	});
});
