import { describe, expect, it } from "bun:test";
import * as v from "valibot";
import { VolmexDataPriceSchema } from "./schema";

describe("VolmexDataPriceSchema", () => {
	it("should parse a valid indices message", () => {
		const result = v.safeParse(VolmexDataPriceSchema, {
			symbol: "BVIV",
			price: 82.2,
			timestamp: 1_347_942_400,
		});

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.output).toEqual({
				symbol: "BVIV",
				price: 82.2,
				timestamp: 1_347_942_400,
			});
		}
	});
});
