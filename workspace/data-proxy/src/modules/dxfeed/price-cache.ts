import {
	Deferred,
	Duration,
	Effect,
	MutableHashMap,
	Option,
	SynchronizedRef,
} from "effect";
import { FailedToGetPriceError } from "./errors";
import type { DxFeedDataPrice, DxFeedSymbol } from "./schema";

const PRICE_WAIT_TIMEOUT_MS = 3_000;

export const createPriceCache = () =>
	Effect.gen(function* () {
		const priceCache = MutableHashMap.empty<DxFeedSymbol, DxFeedDataPrice>();
		const priceWaiters = yield* SynchronizedRef.make(
			MutableHashMap.empty<
				DxFeedSymbol,
				Deferred.Deferred<DxFeedDataPrice, FailedToGetPriceError>
			>(),
		);

		const setPrice = (symbol: DxFeedSymbol, price: DxFeedDataPrice) =>
			Effect.gen(function* () {
				MutableHashMap.set(priceCache, symbol, price);
				const waitersMap = yield* SynchronizedRef.get(priceWaiters);
				const waiter = MutableHashMap.get(waitersMap, symbol);

				if (Option.isSome(waiter)) {
					yield* Deferred.succeed(waiter.value, price);
				}

				MutableHashMap.set(priceCache, symbol, price);
			});

		const setPriceToError = (symbol: DxFeedSymbol, error: string) =>
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

		const getOrWaitPrice = (symbol: DxFeedSymbol) =>
			Effect.gen(function* () {
				const price = MutableHashMap.get(priceCache, symbol);

				if (Option.isSome(price)) {
					return price.value;
				}

				const newWaitersMap = yield* SynchronizedRef.updateAndGetEffect(
					priceWaiters,
					Effect.fnUntraced(function* (waitersMap) {
						const currentWaiter = MutableHashMap.get(waitersMap, symbol);

						if (Option.isSome(currentWaiter)) {
							return waitersMap;
						}

						const deferred = yield* Deferred.make<
							DxFeedDataPrice,
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

				return yield* Deferred.await(waiter.value).pipe(
					Effect.timeoutFail({
						duration: Duration.millis(PRICE_WAIT_TIMEOUT_MS),
						onTimeout: () =>
							new FailedToGetPriceError({
								error: `Timed out waiting for price of symbol ${symbol}`,
							}),
					}),
				);
			});

		const deletePrice = (symbol: DxFeedSymbol) => {
			MutableHashMap.remove(priceCache, symbol);

			SynchronizedRef.update(priceWaiters, (waitersMap) => {
				MutableHashMap.remove(waitersMap, symbol);
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
