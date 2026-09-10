import { Data, Duration, Effect, MutableHashMap, Option } from "effect";

const PRICE_WAIT_TIMEOUT_MS = 3_000;

export class FailedToGetPriceError extends Data.TaggedError(
	"FailedToGetPriceError",
)<{
	error: string | unknown;
}> {
	message = `Failed to get price: ${this.error}`;
	status = 500;
}

// Avoid Effect overhead for price waiters
type PriceWaiter<V> = {
	promise: Promise<V>;
	resolve: (value: V) => void;
	reject: (error: FailedToGetPriceError) => void;
};

const makeWaiter = <V>(): PriceWaiter<V> => {
	let resolve!: (value: V) => void;
	let reject!: (error: FailedToGetPriceError) => void;
	const promise = new Promise<V>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};

export interface PriceCache<K, V> {
	getOrWaitPrice: (key: K) => Effect.Effect<V, FailedToGetPriceError>;
	setPriceSync: (key: K, price: V) => void;
	deletePrice: (key: K) => Effect.Effect<void>;
	setPriceToError: (key: K, error: string) => Effect.Effect<void>;
	size: () => number;
}

export const createPriceCache = <K, V>(): Effect.Effect<PriceCache<K, V>> =>
	Effect.sync(() => {
		const priceCache = MutableHashMap.empty<K, V>();
		const priceWaiters = MutableHashMap.empty<K, PriceWaiter<V>>();

		/** WS ingest write. Avoids the Effect interpreter on the tick path. */
		const setPriceSync = (key: K, price: V): void => {
			MutableHashMap.set(priceCache, key, price);
			const waiter = MutableHashMap.get(priceWaiters, key);
			if (Option.isSome(waiter)) {
				MutableHashMap.remove(priceWaiters, key);
				waiter.value.resolve(price);
			}
		};

		const setPriceToError = (key: K, error: string) =>
			Effect.sync(() => {
				const waiter = MutableHashMap.get(priceWaiters, key);
				if (Option.isSome(waiter)) {
					MutableHashMap.remove(priceWaiters, key);
					waiter.value.reject(new FailedToGetPriceError({ error }));
				}
			});

		const getOrWaitPrice = (key: K): Effect.Effect<V, FailedToGetPriceError> =>
			Effect.gen(function* () {
				const cached = MutableHashMap.get(priceCache, key);
				if (Option.isSome(cached)) {
					return cached.value;
				}

				const existingWaiter = MutableHashMap.get(priceWaiters, key);
				let pending: PriceWaiter<V>;
				if (Option.isSome(existingWaiter)) {
					pending = existingWaiter.value;
				} else {
					pending = makeWaiter<V>();
					MutableHashMap.set(priceWaiters, key, pending);
				}

				const raced = MutableHashMap.get(priceCache, key);
				if (Option.isSome(raced)) {
					MutableHashMap.remove(priceWaiters, key);
					pending.resolve(raced.value);
					return raced.value;
				}

				return yield* Effect.tryPromise({
					try: () => pending.promise,
					catch: (error) =>
						error instanceof FailedToGetPriceError
							? error
							: new FailedToGetPriceError({ error }),
				});
			}).pipe(
				Effect.timeoutFail({
					duration: Duration.millis(PRICE_WAIT_TIMEOUT_MS),
					onTimeout: () =>
						new FailedToGetPriceError({
							error: `Timed out waiting for price of key ${key}`,
						}),
				}),
				Effect.tapError(() => deletePrice(key)),
				Effect.withSpan("priceCache.getOrWaitPrice", { attributes: { key } }),
			);

		const deletePrice = (key: K) =>
			Effect.sync(() => {
				MutableHashMap.remove(priceCache, key);
				MutableHashMap.remove(priceWaiters, key);
			});

		const size = () => MutableHashMap.size(priceCache);

		return {
			getOrWaitPrice,
			setPriceSync,
			deletePrice,
			setPriceToError,
			size,
		};
	});
