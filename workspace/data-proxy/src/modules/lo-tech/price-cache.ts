import {
	Deferred,
	Effect,
	MutableHashMap,
	Option,
	SynchronizedRef,
} from "effect";
import { FailedToGetPriceError } from "./errors";
import type { PriceFeedSymbol } from "./lo-tech";
import type { LoTechDataPrice } from "./schema";

export const createPriceCache = () =>
	Effect.gen(function* () {
		const priceCache = MutableHashMap.empty<PriceFeedSymbol, LoTechDataPrice>();
		const priceWaiters = yield* SynchronizedRef.make(
			MutableHashMap.empty<
				PriceFeedSymbol,
				Deferred.Deferred<LoTechDataPrice, FailedToGetPriceError>
			>(),
		);

		const setPrice = (symbol: PriceFeedSymbol, price: LoTechDataPrice) =>
			Effect.gen(function* () {
				MutableHashMap.set(priceCache, symbol, price);
				const waitersMap = yield* SynchronizedRef.get(priceWaiters);
				const waiter = MutableHashMap.get(waitersMap, symbol);

				if (Option.isSome(waiter)) {
					yield* Deferred.succeed(waiter.value, price);
				}

				MutableHashMap.set(priceCache, symbol, price);
			});

		const setPriceToError = (symbol: PriceFeedSymbol, error: string) =>
			Effect.gen(function* () {
				const waitersMap = yield* SynchronizedRef.get(priceWaiters);
				const waiter = MutableHashMap.get(waitersMap, symbol);

				if (Option.isSome(waiter)) {
					yield* Deferred.fail(
						waiter.value,
						new FailedToGetPriceError({ error }),
					);
				}
			});

		const getOrWaitPrice = (symbol: PriceFeedSymbol) =>
			Effect.gen(function* () {
				const price = MutableHashMap.get(priceCache, symbol);

				if (Option.isSome(price)) {
					return price.value;
				}

				const newWaitersMap = yield* SynchronizedRef.updateAndGetEffect(
					priceWaiters,
					Effect.fnUntraced(function* (waitersMap) {
						const currentWaiter = MutableHashMap.get(waitersMap, symbol);

						// Don't modify the map if the price feed id already has a waiter
						if (Option.isSome(currentWaiter)) {
							return waitersMap;
						}

						// We can safely create the new waiter
						const deferred = yield* Deferred.make<
							LoTechDataPrice,
							FailedToGetPriceError
						>();
						MutableHashMap.set(waitersMap, symbol, deferred);
						return waitersMap;
					}),
				);

				const waiter = MutableHashMap.get(newWaitersMap, symbol);

				if (Option.isNone(waiter)) {
					return yield* Effect.fail(
						new FailedToGetPriceError({ error: "Price feed waiter not found" }),
					);
				}

				return yield* Deferred.await(waiter.value);
			});

		const deletePrice = (symbol: PriceFeedSymbol) => {
			MutableHashMap.remove(priceCache, symbol);

			SynchronizedRef.update(priceWaiters, (waitersMap) => {
				MutableHashMap.remove(waitersMap, symbol);
				return waitersMap;
			});

			return Effect.void;
		};

		const size = () => {
			return MutableHashMap.size(priceCache);
		};

		return {
			getOrWaitPrice,
			setPrice,
			deletePrice,
			setPriceToError,
			size,
		};
	});
