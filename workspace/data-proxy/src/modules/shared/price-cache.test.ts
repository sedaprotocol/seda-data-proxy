import { describe, expect, it } from "bun:test";
import type { ParsedFeedPayload } from "@pythnetwork/pyth-lazer-sdk";
import { Duration, Effect, Fiber } from "effect";
import type { LoTechDataPrice } from "../lo-tech/schema";
import { createPriceCache } from "./price-cache";

const run = <A, E>(program: Effect.Effect<A, E>) => Effect.runPromise(program);

/** Minimal arbitrary value shape for generic cache behavior tests */
type SampleValue = { tag: "sample"; n: number; label: string };

const sample = (
	overrides: Partial<Omit<SampleValue, "tag">> = {},
): SampleValue => ({
	tag: "sample",
	n: 0,
	label: "x",
	...overrides,
});

const loTechPrice = (
	symbol: string,
	overrides: Partial<LoTechDataPrice> = {},
): LoTechDataPrice => ({
	type: "PRICE",
	symbol,
	ingress_ts: 1000,
	publish_ts: null,
	transaction_ts: 1000,
	price: 100,
	spread: 1,
	...overrides,
});

describe("createPriceCache", () => {
	it("should set and get a price", async () => {
		await run(
			Effect.gen(function* () {
				const cache = yield* createPriceCache<string, SampleValue>();
				const entry = sample({ n: 123, label: "a" });
				cache.setPriceSync("k1", entry);
				const got = yield* cache.getOrWaitPrice("k1");
				expect(got).toEqual(entry);
			}),
		);
	});

	it("should resolve a waiter when setPriceSync is called", async () => {
		await run(
			Effect.gen(function* () {
				const cache = yield* createPriceCache<string, SampleValue>();
				const entry = sample({ n: 500, label: "sync" });
				const waiter = yield* Effect.fork(cache.getOrWaitPrice("k-sync"));
				yield* Effect.sleep("1 millis");
				cache.setPriceSync("k-sync", entry);
				const result = yield* Fiber.join(waiter);
				expect(result).toEqual(entry);
			}),
		);
	});

	it("should resolve multiple waiters when setPriceSync is called", async () => {
		await run(
			Effect.gen(function* () {
				const cache = yield* createPriceCache<string, SampleValue>();
				const entry = sample({ n: 400, label: "multi" });
				const waiterA = yield* Effect.fork(cache.getOrWaitPrice("k3"));
				const waiterB = yield* Effect.fork(cache.getOrWaitPrice("k3"));
				yield* Effect.sleep("1 millis");
				cache.setPriceSync("k3", entry);
				const [a, b] = yield* Effect.all([
					Fiber.join(waiterA),
					Fiber.join(waiterB),
				]);
				expect(a).toEqual(entry);
				expect(b).toEqual(entry);
			}),
		);
	});

	it("should always return the latest price when price is updated", async () => {
		await run(
			Effect.gen(function* () {
				const cache = yield* createPriceCache<string, SampleValue>();
				const key = "k4";
				cache.setPriceSync(key, sample({ n: 100, label: "first" }));
				expect((yield* cache.getOrWaitPrice(key))?.n).toBe(100);

				cache.setPriceSync(key, sample({ n: 200, label: "second" }));
				const latest = yield* cache.getOrWaitPrice(key);
				expect(latest?.n).toBe(200);
				expect(latest?.label).toBe("second");
			}),
		);
	});

	it("should keep different keys independent", async () => {
		await run(
			Effect.gen(function* () {
				const cache = yield* createPriceCache<string, SampleValue>();
				cache.setPriceSync("a", sample({ n: 1, label: "a" }));
				cache.setPriceSync("b", sample({ n: 2, label: "b" }));
				const [p1, p2] = yield* Effect.all([
					cache.getOrWaitPrice("a"),
					cache.getOrWaitPrice("b"),
				]);
				expect(p1?.n).toBe(1);
				expect(p2?.n).toBe(2);
			}),
		);
	});

	it("should work with numeric keys", async () => {
		await run(
			Effect.gen(function* () {
				const cache = yield* createPriceCache<number, SampleValue>();
				cache.setPriceSync(42, sample({ n: 42, label: "id" }));
				expect((yield* cache.getOrWaitPrice(42))?.n).toBe(42);
			}),
		);
	});

	it("should delete a price and remove it from the cache", async () => {
		await run(
			Effect.gen(function* () {
				const cache = yield* createPriceCache<number, SampleValue>({
					timeout: Duration.millis(50),
				});

				cache.setPriceSync(1, sample({ n: 100, label: "stale" }));
				expect((yield* cache.getOrWaitPrice(1))?.n).toBe(100);

				yield* cache.deletePrice(1);

				expect(yield* cache.getOrWaitPrice(1)).toBeNull();
			}),
		);
	});

	it("should resolve a waiter to null when setPriceToError is called", async () => {
		await run(
			Effect.gen(function* () {
				const cache = yield* createPriceCache<number, SampleValue>();

				const fiber = yield* Effect.fork(cache.getOrWaitPrice(1));
				yield* Effect.sleep("1 millis");
				yield* cache.setPriceToError(1, "feed unstable");

				expect(yield* Fiber.join(fiber)).toBeNull();
			}),
		);
	});
});

describe("createPriceCache with LoTech-shaped payloads", () => {
	it("should round-trip string-keyed LoTech price rows", async () => {
		await run(
			Effect.gen(function* () {
				const cache = yield* createPriceCache<string, LoTechDataPrice>();
				const entry = loTechPrice("ETH-USDT", {
					price: 123.45,
					spread: 0.02,
				});
				cache.setPriceSync("ETH-USDT", entry);
				const got = yield* cache.getOrWaitPrice("ETH-USDT");
				expect(got).toEqual(entry);
				expect(got?.symbol).toBe("ETH-USDT");
			}),
		);
	});
});

describe("createPriceCache with Pyth Lazer-shaped payloads", () => {
	it("should round-trip numeric-keyed parsed feed payloads", async () => {
		await run(
			Effect.gen(function* () {
				const cache = yield* createPriceCache<number, ParsedFeedPayload>();
				const entry: ParsedFeedPayload = {
					price: "100",
					exponent: 18,
					feedUpdateTimestamp: 1000,
					priceFeedId: 1,
				};
				cache.setPriceSync(1, entry);
				const got = yield* cache.getOrWaitPrice(1);
				expect(got?.price).toBe("100");
				expect(got?.exponent).toBe(18);
				expect(got?.feedUpdateTimestamp).toBe(1000);
			}),
		);
	});
});

describe("getOrWaitPrice", () => {
	it("returns the cached value when one is present", async () => {
		await run(
			Effect.gen(function* () {
				const cache = yield* createPriceCache<string, SampleValue>();
				const entry = sample({ n: 7, label: "hit" });
				cache.setPriceSync("k", entry);
				expect(yield* cache.getOrWaitPrice("k")).toEqual(entry);
			}),
		);
	});

	it("returns null when the wait times out", async () => {
		await run(
			Effect.gen(function* () {
				const cache = yield* createPriceCache<string, SampleValue>({
					timeout: Duration.millis(10),
				});
				expect(yield* cache.getOrWaitPrice("missing")).toBeNull();
			}),
		);
	});

	it("resolves to the value when setPriceSync arrives during the wait", async () => {
		await run(
			Effect.gen(function* () {
				const cache = yield* createPriceCache<string, SampleValue>();
				const entry = sample({ n: 9, label: "late" });
				const waiter = yield* Effect.fork(cache.getOrWaitPrice("k"));
				yield* Effect.sleep("1 millis");
				cache.setPriceSync("k", entry);
				expect(yield* Fiber.join(waiter)).toEqual(entry);
			}),
		);
	});

	it("returns null when setPriceToError arrives during the wait", async () => {
		await run(
			Effect.gen(function* () {
				const cache = yield* createPriceCache<string, SampleValue>();
				const waiter = yield* Effect.fork(cache.getOrWaitPrice("k"));
				yield* Effect.sleep("1 millis");
				yield* cache.setPriceToError("k", "feed unstable");
				expect(yield* Fiber.join(waiter)).toBeNull();
			}),
		);
	});
});
