import { describe, expect, it } from "bun:test";
import { assertIsOkResult } from "@seda-protocol/utils/testing";
import { Effect } from "effect";
import { createUrlSearchParams } from "./search-params";
import { injectSearchParamsInUrl } from "./url";

describe("url", () => {
	it("should fill in query params on a target url", () => {
		const targetUrl = "http://example.com?one=1";
		const targetSearchParams = new URLSearchParams({
			two: "2",
		});

		const injection = createUrlSearchParams(targetSearchParams);
		const result = Effect.runSync(injectSearchParamsInUrl(targetUrl, injection));

		expect(result.toString()).toBe("http://example.com/?two=2&one=1");
	});
});
