import { describe, expect, it } from "bun:test";
import { unwrapResultError } from "@seda-protocol/utils/testing";
import { Effect } from "effect";
import { queryJson } from "./query-json";

describe("queryJson", () => {
	it("should be able to find a nested variable inside a JSON object", () => {
		const program = Effect.gen(function* () {
			return yield* queryJson(
				JSON.stringify({ a: { b: { c: "ok" } } }),
				"$.a.b.c",
			);
		});

		const result = Effect.runSync(program);

		expect(result).toBe("ok");
	});

	it("should return an error when the variable was not found", () => {
		const program = Effect.gen(function* () {
			return yield* queryJson(
				JSON.stringify({ a: { b: { c: "ok" } } }),
				"$.a.b.b",
			);
		});

		const result = Effect.runSync(Effect.either(program));
		expect(result.toString()).toInclude("JSONPath $.a.b.b returned null");
	});

	it("should return an error when the JSON body is not an object", () => {
		const program = Effect.gen(function* () {
			return yield* queryJson(JSON.stringify(""), "$.a.b.b");
		});

		const result = Effect.runSync(Effect.either(program));

		expect(result.toString()).toInclude(
			"JSONPath $.a.b.b did not return an array",
		);
	});
});
