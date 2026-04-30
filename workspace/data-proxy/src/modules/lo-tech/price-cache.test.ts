import { describe, expect, it } from "bun:test";
import { Effect, Fiber } from "effect";
import { createPriceCache } from "./price-cache";
import type { LoTechDataPrice } from "./schema";

const run = <A, E>(program: Effect.Effect<A, E>) => Effect.runPromise(program);

const price = (
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
				const priceCache = yield* createPriceCache();
				const entry = price("ETH-USDT", { price: 123.45, spread: 0.02 });
				yield* priceCache.setPrice("ETH-USDT", entry);
				const got = yield* priceCache.getOrWaitPrice("ETH-USDT");
				expect(got).toEqual(entry);
				expect(got.price).toBe(123.45);
				expect(got.spread).toBe(0.02);
			}),
		);
	});

	it("should wait for price when getOrWaitPrice is called before setPrice", async () => {
		await run(
			Effect.gen(function* () {
				const priceCache = yield* createPriceCache();
				const entry = price("SOL-USDT", {
					price: 300,
					spread: 2,
					ingress_ts: 3000,
				});
				const waiter = yield* Effect.fork(
					priceCache.getOrWaitPrice("SOL-USDT"),
				);
				yield* priceCache.setPrice("SOL-USDT", entry);
				const result = yield* Fiber.join(waiter);
				expect(result).toEqual(entry);
			}),
		);
	});

	it("should resolve multiple waiters when setPrice is called", async () => {
		await run(
			Effect.gen(function* () {
				const priceCache = yield* createPriceCache();
				const sym = "ARB-USDT";
				const entry = price(sym, { price: 400, spread: 3 });
				const waiterA = yield* Effect.fork(priceCache.getOrWaitPrice(sym));
				const waiterB = yield* Effect.fork(priceCache.getOrWaitPrice(sym));
				yield* priceCache.setPrice(sym, entry);
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
				const sym = "BTC-USDT";
				yield* priceCache.setPrice(sym, price(sym, { price: 100 }));
				const first = yield* priceCache.getOrWaitPrice(sym);
				expect(first.price).toBe(100);

				yield* priceCache.setPrice(
					sym,
					price(sym, {
						price: 200,
						spread: 8,
						ingress_ts: 2000,
						transaction_ts: 2000,
					}),
				);
				const latest = yield* priceCache.getOrWaitPrice(sym);
				expect(latest.price).toBe(200);
				expect(latest.ingress_ts).toBe(2000);
				expect(latest.spread).toBe(8);
			}),
		);
	});

	it("should keep different symbols independent", async () => {
		await run(
			Effect.gen(function* () {
				const priceCache = yield* createPriceCache();
				yield* priceCache.setPrice(
					"AAA-USDT",
					price("AAA-USDT", { price: 100 }),
				);
				yield* priceCache.setPrice(
					"BBB-USDT",
					price("BBB-USDT", { price: 200, spread: 2 }),
				);
				const [p1, p2] = yield* Effect.all([
					priceCache.getOrWaitPrice("AAA-USDT"),
					priceCache.getOrWaitPrice("BBB-USDT"),
				]);
				expect(p1.price).toBe(100);
				expect(p2.price).toBe(200);
			}),
		);
	});
});
