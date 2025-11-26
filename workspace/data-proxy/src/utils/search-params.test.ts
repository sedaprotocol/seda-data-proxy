import { describe, expect, it } from "bun:test";
import { createUrlSearchParams, mergeUrlSearchParams } from "./search-params";

describe("mergeUrlSearchParams", () => {
	it("should be able to merge two URLSearchParams together", () => {
		const a = new URLSearchParams({
			"1": "one",
			"2": "two",
		});

		const b = new URLSearchParams({
			"3": "three",
		});

		const result = mergeUrlSearchParams(a, b);
		const expected = new URLSearchParams({
			"1": "one",
			"2": "two",
			"3": "three",
		});

		expect(result.toString()).toBe(expected.toString());
	});

	it("should keep both a params and b params", () => {
		const a = new URLSearchParams({
			"1": "one",
			"2": "two",
		});

		const b = new URLSearchParams({
			"2": "test",
		});

		const result = mergeUrlSearchParams(a, b);
		const expected = new URLSearchParams({
			"1": "one",
			"2": "two",
		});

		expected.append("2", "test");

		expect(result.toString()).toBe(expected.toString());
	});

	it("should keep only the allowed query params", () => {
		const queryParams = new URLSearchParams({
			"1": "one",
			"2": "two",
		});

		const result = createUrlSearchParams(queryParams, ["1"]);

		const expected = new URLSearchParams({
			"1": "one",
		});

		expect(result.toString()).toBe(expected.toString());
	});

	it("should allow all query params if no allowed query params are provided", () => {
		const queryParams = new URLSearchParams({
			"1": "one",
			"2": "two",
		});

		const result = createUrlSearchParams(queryParams);

		const expected = new URLSearchParams({
			"1": "one",
			"2": "two",
		});

		expect(result.toString()).toBe(expected.toString());
	});

	it("should support query params that can be repeated", () => {
		const queryParams = new URLSearchParams({
			"1": "one",
			"2": "two",
		});

		queryParams.append("1", "anotherone");

		const result = createUrlSearchParams(queryParams);

		expect(result.toString()).toBe("1=one&2=two&1=anotherone");
	});

	it("should support query params that can be repeated and allowed query params are provided", () => {

		const queryParams = new URLSearchParams({
			"1": "one",
			"2": "two",
		});

		queryParams.append("1", "anotherone");

		const result = createUrlSearchParams(queryParams, ["1"]);

		expect(result.toString()).toBe("1=one&1=anotherone");
	});

	it("should remove query params that are not allowed with multiple values", () => {
		const queryParams = new URLSearchParams({
			"1": "one",
			"2": "two",
		});

		queryParams.append("1", "anotherone");

		const result = createUrlSearchParams(queryParams, ["2"]);
		expect(result.toString()).toBe("2=two");
	});
});
