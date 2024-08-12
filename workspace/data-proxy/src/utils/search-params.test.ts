import { describe, expect, it } from "bun:test";
import { mergeUrlSearchParams } from "./search-params";

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
});
