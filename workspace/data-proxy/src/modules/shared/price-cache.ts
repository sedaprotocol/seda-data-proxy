import {
	Data,
	Deferred,
	Duration,
	Effect,
	MutableHashMap,
	Option,
	SynchronizedRef,
} from "effect";

const PRICE_WAIT_TIMEOUT_MS = 3_000;

export class FailedToGetPriceError extends Data.TaggedError(
	"FailedToGetPriceError",
)<{
	error: string | unknown;
}> {
	message = `Failed to get price: ${this.error}`;
	status = 500;
}

export const createPriceCache = <K, V>() =>
	Effect.gen(function* () {
		const priceCache = MutableHashMap.empty<K, V>();
		const priceWaiters = yield* SynchronizedRef.make(
			MutableHashMap.empty<K, Deferred.Deferred<V, FailedToGetPriceError>>(),
		);

		const setPrice = (key: K, price: V) =>
			Effect.gen(function* () {
				MutableHashMap.set(priceCache, key, price);
				const waitersMap = yield* SynchronizedRef.get(priceWaiters);
				const waiter = MutableHashMap.get(waitersMap, key);

				if (Option.isSome(waiter)) {
					yield* Deferred.succeed(waiter.value, price);

					yield* deleteWaiter(key);
				}
			});

		const setPriceToError = (key: K, error: string) =>
			Effect.gen(function* () {
				const waitersMap = yield* SynchronizedRef.get(priceWaiters);
				const waiter = MutableHashMap.get(waitersMap, key);

				if (Option.isSome(waiter)) {
					yield* Deferred.fail(
						waiter.value,
						new FailedToGetPriceError({ error }),
					);

					yield* deleteWaiter(key);
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

						const deferred = yield* Deferred.make<V, FailedToGetPriceError>();
						MutableHashMap.set(waitersMap, key, deferred);
						return [deferred, waitersMap] as const;
					}),
				);

				return yield* Deferred.await(waiter).pipe(
					Effect.timeoutFail({
						duration: Duration.millis(PRICE_WAIT_TIMEOUT_MS),
						onTimeout: () =>
							new FailedToGetPriceError({
								error: `Timed out waiting for price of key ${key}`,
							}),
					}),
				);
			}).pipe(
				Effect.tapError(() => deletePrice(key)),
				Effect.withSpan("priceCache.getOrWaitPrice", { attributes: { key } }),
			);

		const deletePrice = (key: K) => {
			MutableHashMap.remove(priceCache, key);
			return deleteWaiter(key);
		};

		const deleteWaiter = (key: K) =>
			SynchronizedRef.update(priceWaiters, (waitersMap) => {
				MutableHashMap.remove(waitersMap, key);
				return waitersMap;
			});

		const size = () => MutableHashMap.size(priceCache);

		return {
			getOrWaitPrice,
			setPrice,
			deletePrice,
			setPriceToError,
			size,
		};
	});
