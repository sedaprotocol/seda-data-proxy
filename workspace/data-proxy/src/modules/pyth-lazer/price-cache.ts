import type { ParsedFeedPayload } from "@pythnetwork/pyth-lazer-sdk";
import { Deferred, Effect, MutableHashMap, Option } from "effect";

export const createPriceCache = () =>
	Effect.gen(function* () {
		const priceCache = MutableHashMap.empty<number, ParsedFeedPayload>();
		const priceWaiters = MutableHashMap.empty<number, Deferred.Deferred<ParsedFeedPayload>>();

		const setPrice = (priceFeedId: number, price: ParsedFeedPayload) =>
			Effect.gen(function* () {
				MutableHashMap.set(priceCache, priceFeedId, price);
				const waiter = MutableHashMap.get(priceWaiters, priceFeedId);

				if (Option.isSome(waiter)) {
					yield* Deferred.succeed(waiter.value, price);
				}

				MutableHashMap.set(priceCache, priceFeedId, price);
			});

		const getOrWaitPrice = (priceFeedId: number) =>
			Effect.gen(function* () {
				const price = MutableHashMap.get(priceCache, priceFeedId);

				if (Option.isSome(price)) {
					return price.value;
				}

				const waiter = MutableHashMap.get(priceWaiters, priceFeedId);
				if (Option.isSome(waiter)) {
					return yield* Deferred.await(waiter.value);
				}

				const deferred = yield* Deferred.make<ParsedFeedPayload>();
				MutableHashMap.set(priceWaiters, priceFeedId, deferred);
				return yield* Deferred.await(deferred);
			});

		const deletePrice = (priceFeedId: number) => {
			MutableHashMap.remove(priceCache, priceFeedId);
			MutableHashMap.remove(priceWaiters, priceFeedId);

			return Effect.void;
		};

		const size = () => {
			return MutableHashMap.size(priceCache);
		};

		return {
			getOrWaitPrice,
			setPrice,
			deletePrice,
			size,
		};
	});
