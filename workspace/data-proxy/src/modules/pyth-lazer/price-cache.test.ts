import { describe, expect, it } from "bun:test";
import { Effect, Either, Fiber } from "effect";
import { createPriceCache } from "./price-cache";

const run = <A, E>(program: Effect.Effect<A, E>) => Effect.runPromise(program);

describe("createPriceCache", () => {
	it("should set and get a price", async () => {
		await run(
			Effect.gen(function* () {
				const priceCache = yield* createPriceCache();
				yield* priceCache.setPrice(1, {
					price: "100",
					exponent: 18,
					feedUpdateTimestamp: 1000,
					priceFeedId: 1,
				});
				const price = yield* priceCache.getOrWaitPrice(1);
				expect(price.price).toBe("100");
				expect(price.exponent).toBe(18);
				expect(price.feedUpdateTimestamp).toBe(1000);
			}),
		);
	});

	it("should wait for price when getOrWaitPrice is called before setPrice", async () => {
		await run(
			Effect.gen(function* () {
				const priceCache = yield* createPriceCache();
				const entry = {
					price: "300",
					exponent: 6,
					feedUpdateTimestamp: 3000,
					priceFeedId: 10,
				};
				const waiter = yield* Effect.fork(priceCache.getOrWaitPrice(10));
				yield* priceCache.setPrice(10, entry);
				const result = yield* Fiber.join(waiter);
				expect(result).toEqual(entry);
			}),
		);
	});

	it("should resolve multiple waiters when setPrice is called", async () => {
		await run(
			Effect.gen(function* () {
				const priceCache = yield* createPriceCache();
				const entry = {
					price: "400",
					exponent: 18,
					feedUpdateTimestamp: 4000,
					priceFeedId: 99,
				};
				const waiterA = yield* Effect.fork(priceCache.getOrWaitPrice(99));
				const waiterB = yield* Effect.fork(priceCache.getOrWaitPrice(99));
				yield* priceCache.setPrice(99, entry);
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
				const priceCache = yield* createPriceCache();
				yield* priceCache.setPrice(1, {
					price: "100",
					exponent: 18,
					feedUpdateTimestamp: 1000,
					priceFeedId: 1,
				});
				const first = yield* priceCache.getOrWaitPrice(1);
				expect(first.price).toBe("100");

				yield* priceCache.setPrice(1, {
					price: "200",
					exponent: 8,
					feedUpdateTimestamp: 2000,
					priceFeedId: 1,
				});
				const latest = yield* priceCache.getOrWaitPrice(1);
				expect(latest.price).toBe("200");
				expect(latest.feedUpdateTimestamp).toBe(2000);
				expect(latest.exponent).toBe(8);
			}),
		);
	});

	it("should keep different feed ids independent", async () => {
		await run(
			Effect.gen(function* () {
				const priceCache = yield* createPriceCache();
				yield* priceCache.setPrice(1, {
					price: "100",
					exponent: 18,
					feedUpdateTimestamp: 1000,
					priceFeedId: 1,
				});
				yield* priceCache.setPrice(2, {
					price: "200",
					exponent: 8,
					feedUpdateTimestamp: 2000,
					priceFeedId: 2,
				});
				const [p1, p2] = yield* Effect.all([
					priceCache.getOrWaitPrice(1),
					priceCache.getOrWaitPrice(2),
				]);
				expect(p1.price).toBe("100");
				expect(p2.price).toBe("200");
			}),
		);
	});

	it("should delete a price and remove it from the cache", async () => {
		const result = await run(
			Effect.gen(function* () {
				const cache = yield* createPriceCache();

				const stale = {
					price: "100",
					exponent: 18,
					feedUpdateTimestamp: 1000,
					priceFeedId: 1,
				};

				const fiber = yield* Effect.fork(cache.getOrWaitPrice(1));
				// Simulate a delay between getting the price and setting it, otherwise no waiter is created
				yield* Effect.sleep("1 millis");
				yield* cache.setPrice(1, stale);

				const first = yield* Fiber.join(fiber);
				expect(first.price).toBe("100");

				// Delete the price and attempt to get it again
				yield* cache.deletePrice(1);

				return yield* Effect.either(
					cache.getOrWaitPrice(1).pipe(Effect.timeout("100 millis")),
				);
			}),
		);

		expect(Either.isLeft(result), "Expected getOrWaitPrice to fail").toBe(true);

		if (Either.isLeft(result)) {
			expect(result.left._tag, "Expected timeout error").toBe(
				"TimeoutException",
			);
		}
	});

	it("should resolve a waiter when setPriceToError is called and invalidate the cache", async () => {
		const result = await run(
			Effect.gen(function* () {
				const cache = yield* createPriceCache();

				const fiber = yield* Effect.fork(
					cache.getOrWaitPrice(1).pipe(Effect.either),
				);
				// Simulate a delay between getting the price and setting it, otherwise no waiter is created
				yield* Effect.sleep("1 millis");
				yield* cache.setPriceToError(1, "feed unstable");

				const first = yield* Fiber.join(fiber);
				expect(Either.isLeft(first)).toBe(true);
				if (Either.isLeft(first)) {
					expect(first.left._tag, "Expected FailedToGetPriceError").toBe(
						"FailedToGetPriceError",
					);
				}

				return yield* Effect.either(
					cache.getOrWaitPrice(1).pipe(Effect.timeout("100 millis")),
				);
			}),
		);

		expect(Either.isLeft(result), "Expected getOrWaitPrice to fail").toBe(true);

		if (Either.isLeft(result)) {
			expect(result.left._tag, "Expected timeout error").toBe(
				"TimeoutException",
			);
		}
	});
});
