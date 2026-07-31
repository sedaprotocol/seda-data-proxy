import { describe, expect, it } from "bun:test";
import { matchRoutePath, normalizePath } from "./match-route-path";

describe("normalizePath", () => {
	it("adds a leading slash and strips trailing slashes", () => {
		expect(normalizePath("multi")).toBe("/multi");
		expect(normalizePath("/multi/")).toBe("/multi");
		expect(normalizePath("/multi///")).toBe("/multi");
	});

	it("keeps the root path as a single slash", () => {
		expect(normalizePath("/")).toBe("/");
		expect(normalizePath("")).toBe("/");
	});
});

describe("matchRoutePath", () => {
	it("matches a static path", () => {
		expect(matchRoutePath("/health", "/health")).toEqual({});
	});

	it("does not match a static path", () => {
		expect(matchRoutePath("/health", "/healths")).toBeNull();
	});

	it("captures path params", () => {
		expect(matchRoutePath("/binance/:symbols", "/binance/BTC,ETH")).toEqual({
			symbols: "BTC,ETH",
		});
	});

	it("does not match a path involving a param", () => {
		expect(matchRoutePath("/binance/:symbols", "/binances/BTC,ETH")).toBeNull();
	});

	it("matches when the pattern has no leading slash", () => {
		expect(matchRoutePath("quote/:symbols", "/quote/AAPL")).toEqual({
			symbols: "AAPL",
		});
	});

	it("matches when the request path has no leading slash", () => {
		expect(matchRoutePath("/quote/:symbols", "quote/AAPL")).toEqual({
			symbols: "AAPL",
		});
	});

	it("returns null when segment counts differ", () => {
		expect(matchRoutePath("/a/:b", "/a/b/c")).toBeNull();
	});

	it("returns null when a static segment differs", () => {
		expect(matchRoutePath("/binance/:symbols", "/lighter/1")).toBeNull();
	});

	it("decodes URI-encoded param values", () => {
		expect(matchRoutePath("/x/:v", "/x/a%2Cb")).toEqual({ v: "a,b" });
	});

	it("returns null when a param has malformed percent-encoding", () => {
		expect(matchRoutePath("/x/:v", "/x/%ZZ")).toBeNull();
		expect(matchRoutePath("/x/:v", "/x/%")).toBeNull();
	});

	it("treats trailing slashes as equivalent", () => {
		expect(matchRoutePath("/binance/:symbols/", "/binance/BTC")).toEqual({
			symbols: "BTC",
		});
	});
});
