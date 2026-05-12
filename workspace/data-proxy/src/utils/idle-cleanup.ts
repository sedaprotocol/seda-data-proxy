import {
	Clock,
	Duration,
	Effect,
	type Fiber,
	MutableHashMap,
	Schedule,
} from "effect";

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
): Effect.Effect<Fiber.RuntimeFiber<unknown, unknown>, never, never> =>
	Effect.forkDaemon(
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis;
			const ttlMs = Duration.toMillis(options.ttl);
			for (const [key, lastTs] of options.lastRequest) {
				if (now - lastTs > ttlMs) {
					const result = yield* Effect.either(options.onExpire(key));
					if (result._tag === "Left") {
						yield* Effect.logWarning(
							"idle-cleanup onExpire failed; will retry next pass",
							{ error: result.left },
						);
						continue;
					}
					MutableHashMap.remove(options.lastRequest, key);
				}
			}
		}).pipe(Effect.schedule(Schedule.spaced(options.interval))),
	);
