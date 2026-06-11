import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { FailedToHandleLoTechRequestError } from "./errors";
import {
	parsePriceFeedKey,
	priceFeedKey,
	resolveLoTechExchange,
} from "./lo-tech";

const moduleConfig = {
	supportedExchanges: ["us_equities", "futures"],
};

describe("lo-tech price feed keys", () => {
	it("should build and parse a composite exchange:symbol key", () => {
		const key = priceFeedKey("us_equities", "NVDA");
		expect(key).toBe("us_equities:NVDA");
		expect(parsePriceFeedKey(key)).toEqual({
			exchange: "us_equities",
			symbol: "NVDA",
		});
	});
});

describe("resolveLoTechExchange", () => {
	it("should use the path exchange when provided", () => {
		expect(Effect.runSync(resolveLoTechExchange("futures", moduleConfig))).toBe(
			"futures",
		);
	});

	it("should fail when the exchange path parameter is missing", () => {
		const result = Effect.runSync(
			Effect.either(resolveLoTechExchange(undefined, moduleConfig)),
		);

		expect(result._tag).toBe("Left");
		if (result._tag === "Left") {
			expect(result.left).toBeInstanceOf(FailedToHandleLoTechRequestError);
			expect(result.left.error).toBe(
				'Missing required "exchange" path parameter',
			);
		}
	});

	it("should reject an unsupported path exchange", () => {
		const result = Effect.runSync(
			Effect.either(resolveLoTechExchange("invalid_exchange", moduleConfig)),
		);

		expect(result._tag).toBe("Left");
		if (result._tag === "Left") {
			expect(result.left).toBeInstanceOf(FailedToHandleLoTechRequestError);
			expect(result.left.error).toBe(
				'Unsupported LO:TECH exchange "invalid_exchange". Supported exchanges: us_equities, futures',
			);
		}
	});
});
