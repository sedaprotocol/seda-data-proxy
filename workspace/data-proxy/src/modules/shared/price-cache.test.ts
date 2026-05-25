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
				yield* cache.setPrice("k1", entry);
				const got = yield* cache.tryGetOrWait("k1");
				expect(got).toEqual(entry);
			}),
		);
	});

	it("should resolve a waiter when setPrice arrives", async () => {
		await run(
			Effect.gen(function* () {
				const cache = yield* createPriceCache<string, SampleValue>();
				const entry = sample({ n: 300, label: "wait" });
				const waiter = yield* Effect.fork(cache.getOrWaitOrEvict("k2"));
				yield* Effect.sleep("1 millis");
				yield* cache.setPrice("k2", entry);
				const result = yield* Fiber.join(waiter);
				expect(result).toEqual(entry);
			}),
		);
	});

	it("should resolve multiple waiters when setPrice is called", async () => {
		await run(
			Effect.gen(function* () {
				const cache = yield* createPriceCache<string, SampleValue>();
				const entry = sample({ n: 400, label: "multi" });
				const waiterA = yield* Effect.fork(cache.getOrWaitOrEvict("k3"));
				const waiterB = yield* Effect.fork(cache.getOrWaitOrEvict("k3"));
				yield* Effect.sleep("1 millis");
				yield* cache.setPrice("k3", entry);
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
				yield* cache.setPrice(key, sample({ n: 100, label: "first" }));
				expect((yield* cache.tryGetOrWait(key))?.n).toBe(100);

				yield* cache.setPrice(key, sample({ n: 200, label: "second" }));
				const latest = yield* cache.tryGetOrWait(key);
				expect(latest?.n).toBe(200);
				expect(latest?.label).toBe("second");
			}),
		);
	});

	it("should keep different keys independent", async () => {
		await run(
			Effect.gen(function* () {
				const cache = yield* createPriceCache<string, SampleValue>();
				yield* cache.setPrice("a", sample({ n: 1, label: "a" }));
				yield* cache.setPrice("b", sample({ n: 2, label: "b" }));
				const [p1, p2] = yield* Effect.all([
					cache.tryGetOrWait("a"),
					cache.tryGetOrWait("b"),
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
				yield* cache.setPrice(42, sample({ n: 42, label: "id" }));
				expect((yield* cache.tryGetOrWait(42))?.n).toBe(42);
			}),
		);
	});

	it("should delete a price and remove it from the cache", async () => {
		const result = await run(
			Effect.gen(function* () {
				const cache = yield* createPriceCache<number, SampleValue>({
					timeout: Duration.millis(50),
				});

				yield* cache.setPrice(1, sample({ n: 100, label: "stale" }));
				expect((yield* cache.tryGetOrWait(1))?.n).toBe(100);

				yield* cache.deletePrice(1);

				return yield* Effect.either(cache.getOrWaitOrEvict(1));
			}),
		);

		expect(
			Either.isLeft(result),
			"Expected getOrWaitOrEvict to fail after delete",
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
					cache.getOrWaitOrEvict(1).pipe(Effect.either),
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
				yield* cache.setPrice("ETH-USDT", entry);
				const got = yield* cache.tryGetOrWait("ETH-USDT");
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
				yield* cache.setPrice(1, entry);
				const got = yield* cache.tryGetOrWait(1);
				expect(got?.price).toBe("100");
				expect(got?.exponent).toBe(18);
				expect(got?.feedUpdateTimestamp).toBe(1000);
			}),
		);
	});
});

describe("tryGetOrWait", () => {
	it("returns the cached value when one is present", async () => {
		await run(
			Effect.gen(function* () {
				const cache = yield* createPriceCache<string, SampleValue>();
				const entry = sample({ n: 7, label: "hit" });
				yield* cache.setPrice("k", entry);
				expect(yield* cache.tryGetOrWait("k")).toEqual(entry);
			}),
		);
	});

	it("returns null when the wait times out", async () => {
		await run(
			Effect.gen(function* () {
				const cache = yield* createPriceCache<string, SampleValue>({
					timeout: Duration.millis(10),
				});
				expect(yield* cache.tryGetOrWait("missing")).toBeNull();
			}),
		);
	});

	it("resolves to the value when setPrice arrives during the wait", async () => {
		await run(
			Effect.gen(function* () {
				const cache = yield* createPriceCache<string, SampleValue>();
				const entry = sample({ n: 9, label: "late" });
				const waiter = yield* Effect.fork(cache.tryGetOrWait("k"));
				yield* Effect.sleep("1 millis");
				yield* cache.setPrice("k", entry);
				expect(yield* Fiber.join(waiter)).toEqual(entry);
			}),
		);
	});
});

describe("getOrWaitOrEvict", () => {
	it("returns the cached value when one is present", async () => {
		await run(
			Effect.gen(function* () {
				const cache = yield* createPriceCache<string, SampleValue>();
				const entry = sample({ n: 3, label: "hit" });
				yield* cache.setPrice("k", entry);
				expect(yield* cache.getOrWaitOrEvict("k")).toEqual(entry);
			}),
		);
	});

	it("fails with FailedToGetPriceError when the wait times out", async () => {
		const result = await run(
			Effect.gen(function* () {
				const cache = yield* createPriceCache<string, SampleValue>({
					timeout: Duration.millis(10),
				});
				return yield* Effect.either(cache.getOrWaitOrEvict("missing"));
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
					cache.getOrWaitOrEvict("k").pipe(Effect.either),
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
