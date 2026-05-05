import {
	Deferred,
	Effect,
	MutableHashMap,
	Option,
	SynchronizedRef,
} from "effect";

export type CreatePriceCacheOptions<E> = {
	createError: (error: string) => E;
};

export const createPriceCache = <K, V, E>({
	createError,
}: CreatePriceCacheOptions<E>) =>
	Effect.gen(function* () {
		const priceCache = MutableHashMap.empty<K, V>();
		const priceWaiters = yield* SynchronizedRef.make(
			MutableHashMap.empty<K, Deferred.Deferred<V, E>>(),
		);

		const setPrice = (key: K, price: V) =>
			Effect.gen(function* () {
				MutableHashMap.set(priceCache, key, price);
				const waitersMap = yield* SynchronizedRef.get(priceWaiters);
				const waiter = MutableHashMap.get(waitersMap, key);

				if (Option.isSome(waiter)) {
					yield* Deferred.succeed(waiter.value, price);
				}
			});

		const setPriceToError = (key: K, error: string) =>
			Effect.gen(function* () {
				const waitersMap = yield* SynchronizedRef.get(priceWaiters);
				const waiter = MutableHashMap.get(waitersMap, key);

				if (Option.isSome(waiter)) {
					yield* Deferred.fail(waiter.value, createError(error));
				}
			});

		const getOrWaitPrice = (key: K) =>
			Effect.gen(function* () {
				const price = MutableHashMap.get(priceCache, key);

				if (Option.isSome(price)) {
					return price.value;
				}

				const waiter = yield* SynchronizedRef.modifyEffect(
					priceWaiters,
					Effect.fnUntraced(function* (waitersMap) {
						const currentWaiter = MutableHashMap.get(waitersMap, key);

						if (Option.isSome(currentWaiter)) {
							return [currentWaiter.value, waitersMap] as const;
						}

						const deferred = yield* Deferred.make<V, E>();
						MutableHashMap.set(waitersMap, key, deferred);
						return [deferred, waitersMap] as const;
					}),
				);
				return yield* Deferred.await(waiter);
			});

		const deletePrice = (key: K) => {
			MutableHashMap.remove(priceCache, key);

			SynchronizedRef.update(priceWaiters, (waitersMap) => {
				MutableHashMap.remove(waitersMap, key);
				return waitersMap;
			});

			return Effect.void;
		};

		const size = () => MutableHashMap.size(priceCache);

		return {
			getOrWaitPrice,
			setPrice,
			deletePrice,
			setPriceToError,
			size,
		};
	});
