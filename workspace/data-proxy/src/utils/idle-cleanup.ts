import {
	Clock,
	Duration,
	Effect,
	type Fiber,
	MutableHashMap,
	Option,
	Schedule,
} from "effect";

/** A key whose onExpire fails this many passes in a row is force-removed. */
const MAX_ON_EXPIRE_FAILURES = 10;

export interface ForkIdleCleanupOptions<K> {
	/** Map of key to "last requested at" timestamp in milliseconds. */
	lastRequest: MutableHashMap.MutableHashMap<K, number>;
	/** Entries older than this are considered stale and removed. */
	ttl: Duration.Duration;
	/** Cadence at which the cleanup pass runs. */
	interval: Duration.Duration;
	/** Called once per stale key. The entry is removed only after this succeeds, so a failure is retried on the next pass. */
	onExpire: (key: K) => Effect.Effect<void, unknown>;
}

/**
 * Runs a forked daemon that periodically removes idle entries from
 * `lastRequest` and calls `onExpire` for each removed key.
 *
 * Used by stream-subscription modules to drop subscriptions for
 * keys nobody has asked for in a while.
 */
export const forkIdleCleanup = <K>(
	options: ForkIdleCleanupOptions<K>,
): Effect.Effect<Fiber.RuntimeFiber<unknown, unknown>, never, never> => {
	// Consecutive onExpire failures per key. A key that keeps failing is
	// force-removed once it reaches the cap so the map cannot grow forever.
	const failures = MutableHashMap.empty<K, number>();

	return Effect.forkDaemon(
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis;
			const ttlMs = Duration.toMillis(options.ttl);
			for (const [key, lastTs] of options.lastRequest) {
				if (now - lastTs > ttlMs) {
					const result = yield* Effect.either(options.onExpire(key));
					if (result._tag === "Left") {
						const count =
							Option.getOrElse(MutableHashMap.get(failures, key), () => 0) + 1;
						if (count < MAX_ON_EXPIRE_FAILURES) {
							MutableHashMap.set(failures, key, count);
							yield* Effect.logWarning(
								"idle-cleanup onExpire failed; will retry next pass",
								{ error: result.left, failures: count },
							);
							continue;
						}
						yield* Effect.logError(
							"idle-cleanup onExpire failed repeatedly; dropping key",
							{ error: result.left, failures: count },
						);
					}
					MutableHashMap.remove(options.lastRequest, key);
					MutableHashMap.remove(failures, key);
				}
			}
		}).pipe(Effect.schedule(Schedule.spaced(options.interval))),
	);
};
