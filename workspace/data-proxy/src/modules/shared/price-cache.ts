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
	getOrWaitPrice: (key: K) => Effect.Effect<V | null>;
	/** Retrieves the cached value without waiting, returning undefined if not present. */
	getCached: (key: K) => V | undefined;
	setPriceSync: (key: K, price: V) => void;
	/** Overwrites an existing entry without waking waiters. */
	replaceCached: (key: K, price: V) => void;
	/** Drops the cached value without resolving any waiters. */
	deleteCached: (key: K) => void;
	deletePrice: (key: K) => Effect.Effect<void>;
	setPriceToError: (key: K, error: string) => Effect.Effect<void>;
	size: () => number;
}

export type PriceCacheApply<V> = (prev: V | undefined, next: V) => V;

const replace = <V>(_prev: V | undefined, next: V): V => next;

export const createPriceCache = <K, V>(options?: {
	/** The timeout for a price wait. Defaults to 3 seconds. */
	timeout?: Duration.Duration;
	/** Produces the value to store from the cached value, if any, and the incoming one. */
	apply?: PriceCacheApply<V>;
}): Effect.Effect<PriceCache<K, V>> =>
	Effect.sync(() => {
		const waitTimeout =
			options?.timeout ?? Duration.millis(PRICE_WAIT_TIMEOUT_MS);
		const apply = options?.apply ?? replace;
		const priceCache = MutableHashMap.empty<K, V>();
		const priceWaiters = MutableHashMap.empty<K, PriceWaiter<V>>();

		/** WS ingest write. Avoids the Effect interpreter on the tick path. */
		const setPriceSync = (key: K, price: V): void => {
			const prev = MutableHashMap.get(priceCache, key);
			const next = apply(Option.isSome(prev) ? prev.value : undefined, price);
			MutableHashMap.set(priceCache, key, next);

			const waiter = MutableHashMap.get(priceWaiters, key);
			if (Option.isSome(waiter)) {
				MutableHashMap.remove(priceWaiters, key);
				waiter.value.resolve(next);
			}
		};

		const replaceCached = (key: K, price: V): void => {
			if (Option.isNone(MutableHashMap.get(priceCache, key))) return;
			MutableHashMap.set(priceCache, key, price);
		};

		const setPriceToError = (key: K, error: string) =>
			Effect.sync(() => {
				const waiter = MutableHashMap.get(priceWaiters, key);
				if (Option.isSome(waiter)) {
					MutableHashMap.remove(priceWaiters, key);
					waiter.value.reject(new FailedToGetPriceError({ error }));
				}
			});

		const getCached = (key: K): V | undefined => {
			const cached = MutableHashMap.get(priceCache, key);
			return Option.isSome(cached) ? cached.value : undefined;
		};

		const getOrWaitPrice = (key: K): Effect.Effect<V | null> =>
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

				return yield* Effect.tryPromise({
					try: () => pending.promise,
					catch: (error) =>
						error instanceof FailedToGetPriceError
							? error
							: new FailedToGetPriceError({ error }),
				});
			}).pipe(
				Effect.timeoutFail({
					duration: waitTimeout,
					onTimeout: () =>
						new FailedToGetPriceError({
							error: `Timed out waiting for price of key ${key}`,
						}),
				}),
				Effect.tapError(() => deletePrice(key)),
				Effect.catchTag("FailedToGetPriceError", () => Effect.succeed(null)),
				Effect.withSpan("priceCache.getOrWaitPrice", { attributes: { key } }),
			);

		const deleteCached = (key: K): void => {
			MutableHashMap.remove(priceCache, key);
		};

		const deletePrice = (key: K) =>
			Effect.sync(() => {
				MutableHashMap.remove(priceCache, key);
				MutableHashMap.remove(priceWaiters, key);
			});

		const size = () => MutableHashMap.size(priceCache);

		return {
			getCached,
			getOrWaitPrice,
			setPriceSync,
			replaceCached,
			deleteCached,
			deletePrice,
			setPriceToError,
			size,
		};
	});
