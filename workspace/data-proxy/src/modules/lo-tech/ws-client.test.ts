import { describe, expect, it } from "bun:test";
import { parseInboundFrame } from "./ws-client";

const priceMessage = {
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
} as const;

describe("parseInboundFrame", () => {
	it("classifies a PRICE data message", () => {
		expect(parseInboundFrame(JSON.stringify(priceMessage))).toEqual({
			kind: "data",
			data: priceMessage.data,
		});
	});

	it("classifies an ack", () => {
		expect(
			parseInboundFrame(JSON.stringify({ egress_ts: 1, ack: { id: 7 } })),
		).toEqual({
			kind: "ack",
			msg: { egress_ts: 1, ack: { id: 7 } },
		});
	});

	it("classifies a pong", () => {
		expect(parseInboundFrame(JSON.stringify({ pong: true }))).toEqual({
			kind: "pong",
		});
	});

	it("classifies unexpected objects", () => {
		expect(parseInboundFrame(JSON.stringify({ hello: "world" }))).toEqual({
			kind: "unexpected",
			parsed: { hello: "world" },
		});
	});

	it("classifies invalid JSON", () => {
		const result = parseInboundFrame("not json");
		expect(result.kind).toBe("invalid-json");
		if (result.kind === "invalid-json") {
			expect(result.text).toBe("not json");
		}
	});

	it("classifies non-object JSON as bad-format", () => {
		expect(parseInboundFrame("null")).toEqual({
			kind: "bad-format",
			parsed: null,
		});
	});

	it("classifies a data envelope that fails the schema", () => {
		const result = parseInboundFrame(
			JSON.stringify({ egress_ts: 1, data: { type: "PRICE" } }),
		);
		expect(result.kind).toBe("schema");
		if (result.kind === "schema") {
			expect(result.label).toBe("data");
		}
	});
});
