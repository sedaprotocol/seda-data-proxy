import { describe, expect, it } from "bun:test";
import { isU32 } from "./number";

describe("isU32", () => {
	it("accepts integers from 0 through 2^32 - 1", () => {
		expect(isU32(0)).toBe(true);
		expect(isU32(1)).toBe(true);
		expect(isU32(0xffff_ffff)).toBe(true);
	});

	it("rejects negatives, fractions, and values above 2^32 - 1", () => {
		expect(isU32(-1)).toBe(false);
		expect(isU32(1.5)).toBe(false);
		expect(isU32(0x1_0000_0000)).toBe(false);
		expect(isU32(Number.POSITIVE_INFINITY)).toBe(false);
		expect(isU32(Number.NaN)).toBe(false);
	});
});
