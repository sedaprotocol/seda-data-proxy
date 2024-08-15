import { describe, expect, it } from "bun:test";
import { createUrlSearchParams } from "./search-params";
import { injectSearchParamsInUrl } from "./url";

describe("url", () => {
	it("should fill in query params on a target url", () => {
		const targetUrl = "http://example.com?one=1";
		const injection = createUrlSearchParams({
			two: "2",
		});

		const result = injectSearchParamsInUrl(targetUrl, injection);
		expect(result.toString()).toBe("http://example.com/?two=2&one=1");
	});
});
