import { describe, expect, it } from "bun:test";
import { lagMsFromTimestampUs } from "./pyth-lazer";

describe("lagMsFromTimestampUs", () => {
	it("returns lag in ms from a microsecond timestamp", () => {
		const nowMs = 1_700_000_000_500;
		const timestampUs = (nowMs - 250) * 1000;

		expect(lagMsFromTimestampUs(nowMs, timestampUs)).toBe(250);
	});

	it("accepts string timestamps", () => {
		const nowMs = 1_700_000_000_500;
		const timestampUs = String((nowMs - 100) * 1000);

		expect(lagMsFromTimestampUs(nowMs, timestampUs)).toBe(100);
	});

	it("returns undefined for missing or invalid timestamps", () => {
		expect(lagMsFromTimestampUs(1_000, undefined)).toBeUndefined();
		expect(lagMsFromTimestampUs(1_000, "not-a-number")).toBeUndefined();
	});
});
