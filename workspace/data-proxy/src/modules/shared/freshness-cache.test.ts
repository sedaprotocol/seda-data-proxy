import { describe, expect, it } from "bun:test";
import { Effect, Option } from "effect";
import { createFreshnessCache } from "./freshness-cache";

type SampleValue = { id: string; n: number };

describe("createFreshnessCache", () => {
	it("returns None for an unset key", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const cache = yield* createFreshnessCache<string, SampleValue>();
				expect(Option.isNone(cache.get("BTC", 1000, 0))).toBe(true);
			}),
		));

	it("returns the value while it is within the staleness window", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const cache = yield* createFreshnessCache<string, SampleValue>();
				cache.set("BTC", { id: "BTC", n: 1 }, 1000);
				const atWindowEdge = cache.get("BTC", 5000, 6000);
				expect(Option.isSome(atWindowEdge)).toBe(true);
				if (Option.isSome(atWindowEdge)) {
					expect(atWindowEdge.value.n).toBe(1);
				}
			}),
		));

	it("returns None once the entry is older than the staleness window", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const cache = yield* createFreshnessCache<string, SampleValue>();
				cache.set("BTC", { id: "BTC", n: 1 }, 1000);
				expect(Option.isNone(cache.get("BTC", 5000, 6001))).toBe(true);
			}),
		));

	it("set overwrites the value and refreshes the freshness timestamp", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const cache = yield* createFreshnessCache<string, SampleValue>();
				cache.set("BTC", { id: "BTC", n: 1 }, 1000);
				cache.set("BTC", { id: "BTC", n: 2 }, 4000);
				// A 2000ms window is stale against the first write (1000) but
				// fresh against the second (4000); a hit proves lastUpdate moved.
				const got = cache.get("BTC", 2000, 5000);
				expect(Option.isSome(got)).toBe(true);
				if (Option.isSome(got)) {
					expect(got.value.n).toBe(2);
				}
			}),
		));

	it("remove drops the entry", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const cache = yield* createFreshnessCache<string, SampleValue>();
				cache.set("BTC", { id: "BTC", n: 1 }, 1000);
				cache.remove("BTC");
				expect(Option.isNone(cache.get("BTC", 100000, 1000))).toBe(true);
			}),
		));
});
