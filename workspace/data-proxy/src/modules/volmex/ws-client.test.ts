import { describe, expect, it } from "bun:test";
import { Redacted } from "effect";
import { buildVolmexWebSocketUrl } from "./ws-client";

describe("buildVolmexWebSocketUrl", () => {
	it("should build a Socket.IO websocket URL with JWT query param", () => {
		expect(
			buildVolmexWebSocketUrl(
				"wss://ws-8jh89.volmex.finance",
				Redacted.make("test.jwt.token"),
			),
		).toBe(
			"wss://ws-8jh89.volmex.finance/socket.io/?EIO=4&transport=websocket&jwtToken=test.jwt.token",
		);
	});

	it("should strip a trailing slash from the base URL", () => {
		expect(
			buildVolmexWebSocketUrl(
				"wss://ws-8jh89.volmex.finance/",
				Redacted.make("abc+def"),
			),
		).toBe(
			"wss://ws-8jh89.volmex.finance/socket.io/?EIO=4&transport=websocket&jwtToken=abc%2Bdef",
		);
	});
});
