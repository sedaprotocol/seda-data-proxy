import { describe, expect, it } from "bun:test";
import { parseInboundFrame } from "./ws-client";

describe("parseInboundFrame", () => {
	it("classifies a valid indices message", () => {
		expect(
			parseInboundFrame({
				symbol: "BVIV",
				price: 82.2,
				timestamp: 1_347_942_400,
			}),
		).toEqual({
			kind: "price",
			price: {
				symbol: "BVIV",
				price: 82.2,
				timestamp: 1_347_942_400,
			},
		});
	});

	it("classifies an invalid payload", () => {
		const result = parseInboundFrame({ nope: true });
		expect(result.kind).toBe("invalid-payload");
		if (result.kind === "invalid-payload") {
			expect(result.payload).toEqual({ nope: true });
		}
	});
});
