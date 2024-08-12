import { describe, expect, it } from "bun:test";
import { replaceParams } from "./replace-params";

describe("replaceParams", () => {
	it("should set the parameters for a url", () => {
		const result = replaceParams("price/{:coinA}/{:coinB}", {
			coinA: "eth",
			coinB: "usd",
		});

		expect(result).toBe("price/eth/usd");
	});

	it("should set the parameter for a url multiple times", () => {
		const result = replaceParams("price/{:coinA}/{:coinB}/{:coinA}", {
			coinA: "eth",
			coinB: "usd",
		});

		expect(result).toBe("price/eth/usd/eth");
	});

	it("should set the parameter for a url when using query params", () => {
		const result = replaceParams("price/{:coinA}/{:coinB}?myparam={:coinA}", {
			coinA: "eth",
			coinB: "usd",
		});

		expect(result).toBe("price/eth/usd?myparam=eth");
	});

	it("should set env variables", () => {
		process.env.MY_ENV_VARIABLE = "test";
		const result = replaceParams(
			"price/{:coinA}/{:coinB}?myparam={$MY_ENV_VARIABLE}",
			{
				coinA: "eth",
				coinB: "usd",
			},
		);
		process.env.MY_ENV_VARIABLE = undefined;

		expect(result).toBe("price/eth/usd?myparam=test");
	});
});
