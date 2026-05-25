import { Effect, MutableHashMap, Option } from "effect";

interface FreshnessEntry<V> {
	value: V;
	lastUpdate: number;
}

/**
 * A push-on-write cache whose reads are gated by freshness. `get` returns a
 * value only when it was written within the supplied staleness window; a
 * stale or absent key returns `None`, leaving the caller free to fall back
 * to a pull such as a REST fetch. It has no waiters and no timeouts.
 */
export interface FreshnessCache<K, V> {
	set(key: K, value: V, now: number): void;
	get(key: K, staleAfterMillis: number, now: number): Option.Option<V>;
	remove(key: K): void;
}

export const createFreshnessCache = <K, V>(): Effect.Effect<
	FreshnessCache<K, V>
> =>
	Effect.sync(() => {
		const entries = MutableHashMap.empty<K, FreshnessEntry<V>>();

		const set = (key: K, value: V, now: number) => {
			MutableHashMap.set(entries, key, { value, lastUpdate: now });
		};

		const get = (key: K, staleAfterMillis: number, now: number) => {
			const entry = MutableHashMap.get(entries, key);
			if (Option.isNone(entry)) return Option.none<V>();
			if (now - entry.value.lastUpdate > staleAfterMillis) {
				return Option.none<V>();
			}
			return Option.some(entry.value.value);
		};

		const remove = (key: K) => {
			MutableHashMap.remove(entries, key);
		};

		return { set, get, remove } satisfies FreshnessCache<K, V>;
	});
