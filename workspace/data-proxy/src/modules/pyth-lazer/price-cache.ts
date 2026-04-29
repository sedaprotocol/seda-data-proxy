import type { ParsedFeedPayload } from "@pythnetwork/pyth-lazer-sdk";
import {
	Deferred,
	Effect,
	MutableHashMap,
	Option,
	SynchronizedRef,
} from "effect";
import { FailedToGetPriceError } from "./errors";

export const createPriceCache = () =>
	Effect.gen(function* () {
		const priceCache = MutableHashMap.empty<number, ParsedFeedPayload>();
		const priceWaiters = yield* SynchronizedRef.make(
			MutableHashMap.empty<
				number,
				Deferred.Deferred<ParsedFeedPayload, FailedToGetPriceError>
			>(),
		);

		const setPrice = (priceFeedId: number, price: ParsedFeedPayload) =>
			Effect.gen(function* () {
				MutableHashMap.set(priceCache, priceFeedId, price);
				const waitersMap = yield* SynchronizedRef.get(priceWaiters);
				const waiter = MutableHashMap.get(waitersMap, priceFeedId);

				if (Option.isSome(waiter)) {
					yield* Deferred.succeed(waiter.value, price);

					yield* deleteWaiter(priceFeedId);
				}
			});

		const setPriceToError = (priceFeedId: number, error: string) =>
			Effect.gen(function* () {
				const waitersMap = yield* SynchronizedRef.get(priceWaiters);
				const waiter = MutableHashMap.get(waitersMap, priceFeedId);

				if (Option.isSome(waiter)) {
					yield* Deferred.fail(
						waiter.value,
						new FailedToGetPriceError({ error }),
					);

					yield* deleteWaiter(priceFeedId);
				}
			});

		const getOrWaitPrice = (priceFeedId: number) =>
			Effect.gen(function* () {
				const price = MutableHashMap.get(priceCache, priceFeedId);

				if (Option.isSome(price)) {
					return price.value;
				}

				const newWaitersMap = yield* SynchronizedRef.updateAndGetEffect(
					priceWaiters,
					Effect.fnUntraced(function* (waitersMap) {
						const currentWaiter = MutableHashMap.get(waitersMap, priceFeedId);

						// Don't modify the map if the price feed id already has a waiter
						if (Option.isSome(currentWaiter)) {
							return waitersMap;
						}

						// We can safely create the new waiter
						const deferred = yield* Deferred.make<
							ParsedFeedPayload,
							FailedToGetPriceError
						>();
						MutableHashMap.set(waitersMap, priceFeedId, deferred);
						return waitersMap;
					}),
				);

				const waiter = MutableHashMap.get(newWaitersMap, priceFeedId);

				if (Option.isNone(waiter)) {
					return yield* Effect.fail(
						new FailedToGetPriceError({ error: "Price feed waiter not found" }),
					);
				}

				return yield* Deferred.await(waiter.value);
			});

		const deletePrice = (priceFeedId: number) => {
			MutableHashMap.remove(priceCache, priceFeedId);

			return deleteWaiter(priceFeedId);
		};

		const deleteWaiter = (priceFeedId: number) =>
			SynchronizedRef.update(priceWaiters, (waitersMap) => {
				MutableHashMap.remove(waitersMap, priceFeedId);
				return waitersMap;
			});

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
