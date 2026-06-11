import { describe, expect, it } from "bun:test";
import * as v from "valibot";
import { LoTechDataMessageSchema } from "./schema";

describe("LoTechDataMessageSchema", () => {
	it("should parse us_equities price messages", () => {
		const result = v.safeParse(LoTechDataMessageSchema, {
			egress_ts: 1781207288221783,
			data: {
				type: "PRICE",
				symbol: "NVDA",
				ingress_ts: 1781207288221783,
				publish_ts: 1781207288178000,
				transaction_ts: 1781207288177000,
				price: 204.469,
				spread: 0.04,
			},
		});

		expect(result.success).toBe(true);
	});

	it("should parse futures price messages", () => {
		const result = v.safeParse(LoTechDataMessageSchema, {
			egress_ts: 1781208650070012,
			data: {
				type: "PRICE",
				symbol: "WTIN6",
				generic_symbol: "WTI/1",
				ingress_ts: 1781208650069961,
				publish_ts: 1781208650015000,
				transaction_ts: null,
				price: 86.373,
				spread: 0.02,
				expiry_date: "2026-06-22",
				roll_date: "2026-06-22",
			},
		});

		expect(result.success).toBe(true);
		if (!result.success) {
			throw new Error(v.summarize(result.issues));
		}

		expect(result.output.data.symbol).toBe("WTIN6");
		expect(result.output.data.generic_symbol).toBe("WTI/1");
	});
});
