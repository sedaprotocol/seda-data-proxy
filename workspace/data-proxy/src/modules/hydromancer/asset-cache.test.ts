import { describe, expect, it } from "bun:test";
import { Effect, Option } from "effect";
import { createAssetCache } from "./asset-cache";

const ctx = {
	oraclePx: "1",
	markPx: "2",
	midPx: "3",
	impactPxs: ["4", "5"],
	openInterest: "6",
};

describe("createAssetCache", () => {
	it("returns None for an unset coin", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const cache = yield* createAssetCache();
				expect(Option.isNone(yield* cache.get("BTC"))).toBe(true);
				expect(yield* cache.isFresh("BTC", 1000, 0)).toBe(false);
			}),
		));

	it("considers an entry fresh within the staleness window", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const cache = yield* createAssetCache();
				yield* cache.set("BTC", ctx, 1000);
				expect(yield* cache.isFresh("BTC", 5000, 1000)).toBe(true);
				expect(yield* cache.isFresh("BTC", 5000, 6000)).toBe(true);
			}),
		));

	it("considers an entry stale once the staleness window has elapsed", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const cache = yield* createAssetCache();
				yield* cache.set("BTC", ctx, 1000);
				expect(yield* cache.isFresh("BTC", 5000, 6001)).toBe(false);
			}),
		));

	it("treats a fresh entry as stale while the socket-error flag is set", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const cache = yield* createAssetCache();
				yield* cache.set("BTC", ctx, 1000);
				yield* cache.markSocketError("connection lost");
				expect(yield* cache.hasSocketError()).toBe(true);
				expect(yield* cache.isFresh("BTC", 5000, 1001)).toBe(false);

				yield* cache.clearSocketError();
				expect(yield* cache.hasSocketError()).toBe(false);
				expect(yield* cache.isFresh("BTC", 5000, 1001)).toBe(true);
			}),
		));

	it("set overwrites the previous entry and refreshes lastUpdate", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const cache = yield* createAssetCache();
				yield* cache.set("BTC", ctx, 1000);
				yield* cache.set("BTC", { ...ctx, oraclePx: "999" }, 4000);
				const entry = yield* cache.get("BTC");
				expect(Option.isSome(entry)).toBe(true);
				if (Option.isSome(entry)) {
					expect(entry.value.lastUpdate).toBe(4000);
					expect(entry.value.ctx.oraclePx).toBe("999");
				}
			}),
		));
});
