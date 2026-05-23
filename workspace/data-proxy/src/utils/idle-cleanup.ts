import {
	Clock,
	Duration,
	Effect,
	type Fiber,
	MutableHashMap,
	Option,
	Schedule,
} from "effect";

/** First N consecutive failures log at warn; everything after logs at error. */
const WARN_FAILURE_BUDGET = 3;

export interface ForkIdleCleanupOptions<K> {
	/** Map of key to "last requested at" timestamp in milliseconds. */
	lastRequest: MutableHashMap.MutableHashMap<K, number>;
	/** Entries older than this are considered stale and removed. */
	ttl: Duration.Duration;
	/** Cadence at which the cleanup pass runs. */
	interval: Duration.Duration;
	/** Called once per stale key. The entry is removed only after this succeeds. */
	onExpire: (key: K) => Effect.Effect<void, unknown>;
}

/**
 * Runs a forked daemon that periodically removes idle entries from
 * `lastRequest` and calls `onExpire` for each removed key.
 *
 * Used by stream-subscription modules to drop subscriptions for keys nobody
 * has asked for in a while. A failing `onExpire` keeps its entry and retries
 * on every subsequent pass; the failure count only escalates log severity
 * (warn for the first {@link WARN_FAILURE_BUDGET} attempts, error after),
 * so the resource the callback is supposed to release does not leak.
 */
export const forkIdleCleanup = <K>(
	options: ForkIdleCleanupOptions<K>,
): Effect.Effect<Fiber.RuntimeFiber<unknown, unknown>, never, never> => {
	const failures = MutableHashMap.empty<K, number>();

	return Effect.forkDaemon(
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis;
			const ttlMs = Duration.toMillis(options.ttl);
			for (const [key, lastTs] of options.lastRequest) {
				if (now - lastTs <= ttlMs) continue;

				const result = yield* Effect.either(options.onExpire(key));
				if (result._tag === "Right") {
					MutableHashMap.remove(options.lastRequest, key);
					MutableHashMap.remove(failures, key);
					continue;
				}

				const count =
					Option.getOrElse(MutableHashMap.get(failures, key), () => 0) + 1;
				MutableHashMap.set(failures, key, count);

				const logAt =
					count <= WARN_FAILURE_BUDGET ? Effect.logWarning : Effect.logError;
				yield* logAt("idle-cleanup onExpire failed; will retry next pass", {
					error: result.left,
					failures: count,
				});
			}
		}).pipe(Effect.schedule(Schedule.spaced(options.interval))),
	);
};
