import { describe, expect, it } from "bun:test";
import { Effect, Fiber } from "effect";
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
					timestamp: 1000,
					id: 1,
				});
				const price = yield* priceCache.getOrWaitPrice(1);
				expect(price.price).toBe("100");
				expect(price.exponent).toBe(18);
				expect(price.timestamp).toBe(1000);
			}),
		);
	});

	it("should return cached price when getOrWaitPrice is called after setPrice", async () => {
		await run(
			Effect.gen(function* () {
				const priceCache = yield* createPriceCache();
				yield* priceCache.setPrice(42, {
					price: "200",
					exponent: 8,
					timestamp: 2000,
					id: 42,
				});
				const price = yield* priceCache.getOrWaitPrice(42);
				expect(price.price).toBe("200");
				expect(price.id).toBe(42);
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
					timestamp: 3000,
					id: 10,
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
					timestamp: 4000,
					id: 99,
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
					timestamp: 1000,
					id: 1,
				});
				const first = yield* priceCache.getOrWaitPrice(1);
				expect(first.price).toBe("100");

				yield* priceCache.setPrice(1, {
					price: "200",
					exponent: 8,
					timestamp: 2000,
					id: 1,
				});
				const latest = yield* priceCache.getOrWaitPrice(1);
				expect(latest.price).toBe("200");
				expect(latest.timestamp).toBe(2000);
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
					timestamp: 1000,
					id: 1,
				});
				yield* priceCache.setPrice(2, {
					price: "200",
					exponent: 8,
					timestamp: 2000,
					id: 2,
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
});
