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
	/** Called once per removed key. Failures are logged and swallowed so the daemon survives. */
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
			for (const [key, lastTs] of MutableHashMap.fromIterable(
				options.lastRequest,
			)) {
				if (now - lastTs > ttlMs) {
					MutableHashMap.remove(options.lastRequest, key);
					yield* options
						.onExpire(key)
						.pipe(
							Effect.catchAll((error) =>
								Effect.logWarning("idle-cleanup onExpire failed", { error }),
							),
						);
				}
			}
		}).pipe(Effect.schedule(Schedule.spaced(options.interval))),
	);
