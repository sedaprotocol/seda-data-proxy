import { describe, expect, it } from "bun:test";
import * as v from "valibot";
import {
	PythLazerModuleConfigSchema,
	PythLazerModuleRouteSchema,
} from "../../config/pyth-lazer-module-config";
import { lagMsFromTimestampUs, priceFeedSubscriptionKey } from "./pyth-lazer";

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

describe("priceFeedSubscriptionKey", () => {
	it("formats as channel:feedId", () => {
		expect(priceFeedSubscriptionKey(1, "fixed_rate@200ms")).toBe(
			"fixed_rate@200ms:1",
		);
	});

	it("isolates the same feed across different channels", () => {
		expect(priceFeedSubscriptionKey(1, "fixed_rate@50ms")).not.toBe(
			priceFeedSubscriptionKey(1, "fixed_rate@200ms"),
		);
	});

	it("isolates different feeds on the same channel", () => {
		expect(priceFeedSubscriptionKey(1, "real_time")).not.toBe(
			priceFeedSubscriptionKey(2, "real_time"),
		);
	});
});
