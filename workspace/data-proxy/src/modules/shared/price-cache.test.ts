import { describe, expect, it } from "bun:test";
import type { ParsedFeedPayload } from "@pythnetwork/pyth-lazer-sdk";
import { Duration, Effect, Either, Fiber } from "effect";
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
				const got = yield* cache.getOrWaitPriceOrNull("k1");
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
				expect((yield* cache.getOrWaitPriceOrNull(key))?.n).toBe(100);

				cache.setPriceSync(key, sample({ n: 200, label: "second" }));
				const latest = yield* cache.getOrWaitPriceOrNull(key);
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
					cache.getOrWaitPriceOrNull("a"),
					cache.getOrWaitPriceOrNull("b"),
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
				expect((yield* cache.getOrWaitPriceOrNull(42))?.n).toBe(42);
			}),
		);
	});

	it("should delete a price and remove it from the cache", async () => {
		const result = await run(
			Effect.gen(function* () {
				const cache = yield* createPriceCache<number, SampleValue>({
					timeout: Duration.millis(50),
				});

				cache.setPriceSync(1, sample({ n: 100, label: "stale" }));
				expect((yield* cache.getOrWaitPriceOrNull(1))?.n).toBe(100);

				yield* cache.deletePrice(1);

				return yield* Effect.either(cache.getOrWaitPrice(1));
			}),
		);

		expect(
			Either.isLeft(result),
			"Expected getOrWaitPrice to fail after delete",
		).toBe(true);

		if (Either.isLeft(result)) {
			expect(result.left._tag).toBe("FailedToGetPriceError");
		}
	});

	it("should resolve a waiter when setPriceToError is called", async () => {
		await run(
			Effect.gen(function* () {
				const cache = yield* createPriceCache<number, SampleValue>();

				const fiber = yield* Effect.fork(
					cache.getOrWaitPrice(1).pipe(Effect.either),
				);
				yield* Effect.sleep("1 millis");
				yield* cache.setPriceToError(1, "feed unstable");

				const first = yield* Fiber.join(fiber);
				expect(Either.isLeft(first)).toBe(true);
				if (Either.isLeft(first)) {
					expect(first.left._tag).toBe("FailedToGetPriceError");
				}
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
				const got = yield* cache.getOrWaitPriceOrNull("ETH-USDT");
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
				const got = yield* cache.getOrWaitPriceOrNull(1);
				expect(got?.price).toBe("100");
				expect(got?.exponent).toBe(18);
				expect(got?.feedUpdateTimestamp).toBe(1000);
			}),
		);
	});
});

describe("getOrWaitPriceOrNull", () => {
	it("returns the cached value when one is present", async () => {
		await run(
			Effect.gen(function* () {
				const cache = yield* createPriceCache<string, SampleValue>();
				const entry = sample({ n: 7, label: "hit" });
				cache.setPriceSync("k", entry);
				expect(yield* cache.getOrWaitPriceOrNull("k")).toEqual(entry);
			}),
		);
	});

	it("returns null when the wait times out", async () => {
		await run(
			Effect.gen(function* () {
				const cache = yield* createPriceCache<string, SampleValue>({
					timeout: Duration.millis(10),
				});
				expect(yield* cache.getOrWaitPriceOrNull("missing")).toBeNull();
			}),
		);
	});

	it("resolves to the value when setPriceSync arrives during the wait", async () => {
		await run(
			Effect.gen(function* () {
				const cache = yield* createPriceCache<string, SampleValue>();
				const entry = sample({ n: 9, label: "late" });
				const waiter = yield* Effect.fork(cache.getOrWaitPriceOrNull("k"));
				yield* Effect.sleep("1 millis");
				cache.setPriceSync("k", entry);
				expect(yield* Fiber.join(waiter)).toEqual(entry);
			}),
		);
	});
});

describe("getOrWaitPrice", () => {
	it("returns the cached value when one is present", async () => {
		await run(
			Effect.gen(function* () {
				const cache = yield* createPriceCache<string, SampleValue>();
				const entry = sample({ n: 3, label: "hit" });
				cache.setPriceSync("k", entry);
				expect(yield* cache.getOrWaitPrice("k")).toEqual(entry);
			}),
		);
	});

	it("fails with FailedToGetPriceError when the wait times out", async () => {
		const result = await run(
			Effect.gen(function* () {
				const cache = yield* createPriceCache<string, SampleValue>({
					timeout: Duration.millis(10),
				});
				return yield* Effect.either(cache.getOrWaitPrice("missing"));
			}),
		);

		expect(Either.isLeft(result)).toBe(true);
		if (Either.isLeft(result)) {
			expect(result.left._tag).toBe("FailedToGetPriceError");
		}
	});

	it("fails when setPriceToError arrives during the wait", async () => {
		const result = await run(
			Effect.gen(function* () {
				const cache = yield* createPriceCache<string, SampleValue>();
				const waiter = yield* Effect.fork(
					cache.getOrWaitPrice("k").pipe(Effect.either),
				);
				yield* Effect.sleep("1 millis");
				yield* cache.setPriceToError("k", "feed unstable");
				return yield* Fiber.join(waiter);
			}),
		);

		expect(Either.isLeft(result)).toBe(true);
		if (Either.isLeft(result)) {
			expect(result.left._tag).toBe("FailedToGetPriceError");
		}
	});
});
