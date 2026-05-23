import { describe, expect, it } from "bun:test";
import {
	Clock,
	Duration,
	Effect,
	Fiber,
	LogLevel,
	Logger,
	MutableHashMap,
	Option,
	TestClock,
	TestContext,
} from "effect";
import { forkIdleCleanup } from "./idle-cleanup";

const provideTestClock = <A, E>(effect: Effect.Effect<A, E, never>) =>
	Effect.runPromise(
		effect.pipe(
			Effect.provide(TestContext.TestContext),
			Logger.withMinimumLogLevel(LogLevel.None),
		),
	);

describe("forkIdleCleanup", () => {
	it("removes an entry that has been idle past the TTL and calls onExpire once", async () => {
		const lastRequest = MutableHashMap.empty<string, number>();
		const expired: string[] = [];

		await provideTestClock(
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis;
				MutableHashMap.set(lastRequest, "BTC", now);

				const fiber = yield* forkIdleCleanup({
					lastRequest,
					ttl: Duration.seconds(60),
					interval: Duration.seconds(30),
					onExpire: (key) =>
						Effect.sync(() => {
							expired.push(key);
						}),
				});

				yield* TestClock.adjust(Duration.seconds(91));

				expect(Option.isNone(MutableHashMap.get(lastRequest, "BTC"))).toBe(
					true,
				);
				expect(expired).toEqual(["BTC"]);

				yield* Fiber.interrupt(fiber);
			}),
		);
	});

	it("leaves a fresh entry alone within the TTL window", async () => {
		const lastRequest = MutableHashMap.empty<string, number>();
		const expired: string[] = [];

		await provideTestClock(
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis;
				MutableHashMap.set(lastRequest, "BTC", now);

				const fiber = yield* forkIdleCleanup({
					lastRequest,
					ttl: Duration.seconds(60),
					interval: Duration.seconds(30),
					onExpire: (key) =>
						Effect.sync(() => {
							expired.push(key);
						}),
				});

				yield* TestClock.adjust(Duration.seconds(45));

				expect(Option.isSome(MutableHashMap.get(lastRequest, "BTC"))).toBe(
					true,
				);
				expect(expired).toEqual([]);

				yield* Fiber.interrupt(fiber);
			}),
		);
	});

	it("preserves an entry whose timestamp is refreshed before the next pass", async () => {
		const lastRequest = MutableHashMap.empty<string, number>();
		const expired: string[] = [];

		await provideTestClock(
			Effect.gen(function* () {
				const start = yield* Clock.currentTimeMillis;
				MutableHashMap.set(lastRequest, "BTC", start);

				const fiber = yield* forkIdleCleanup({
					lastRequest,
					ttl: Duration.seconds(60),
					interval: Duration.seconds(30),
					onExpire: (key) =>
						Effect.sync(() => {
							expired.push(key);
						}),
				});

				yield* TestClock.adjust(Duration.seconds(45));
				const refreshed = yield* Clock.currentTimeMillis;
				MutableHashMap.set(lastRequest, "BTC", refreshed);

				yield* TestClock.adjust(Duration.seconds(45));

				expect(Option.isSome(MutableHashMap.get(lastRequest, "BTC"))).toBe(
					true,
				);
				expect(expired).toEqual([]);

				yield* Fiber.interrupt(fiber);
			}),
		);
	});

	it("expires only the stale entries when both ages are present at start", async () => {
		const lastRequest = MutableHashMap.empty<string, number>();
		const expired: string[] = [];

		await provideTestClock(
			Effect.gen(function* () {
				yield* TestClock.adjust(Duration.seconds(100));
				const now = yield* Clock.currentTimeMillis;
				MutableHashMap.set(lastRequest, "STALE", now - 90_000);
				MutableHashMap.set(lastRequest, "FRESH", now - 5_000);

				const fiber = yield* forkIdleCleanup({
					lastRequest,
					ttl: Duration.seconds(60),
					interval: Duration.seconds(30),
					onExpire: (key) =>
						Effect.sync(() => {
							expired.push(key);
						}),
				});

				yield* TestClock.adjust(Duration.seconds(31));

				expect(Option.isNone(MutableHashMap.get(lastRequest, "STALE"))).toBe(
					true,
				);
				expect(Option.isSome(MutableHashMap.get(lastRequest, "FRESH"))).toBe(
					true,
				);
				expect(expired).toEqual(["STALE"]);

				yield* Fiber.interrupt(fiber);
			}),
		);
	});

	it("does not call onExpire while every entry is still fresh", async () => {
		const lastRequest = MutableHashMap.empty<string, number>();

		await provideTestClock(
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis;
				MutableHashMap.set(lastRequest, "BTC", now);
				MutableHashMap.set(lastRequest, "ETH", now);

				const fiber = yield* forkIdleCleanup({
					lastRequest,
					ttl: Duration.seconds(60),
					interval: Duration.seconds(30),
					onExpire: () =>
						Effect.die("onExpire must not be called while entries are fresh"),
				});

				yield* TestClock.adjust(Duration.seconds(45));

				expect(MutableHashMap.size(lastRequest)).toBe(2);

				yield* Fiber.interrupt(fiber);
			}),
		);
	});

	it("keeps retrying onExpire on every pass when it keeps failing, never force-removing", async () => {
		const lastRequest = MutableHashMap.empty<string, number>();
		let attempts = 0;

		await provideTestClock(
			Effect.gen(function* () {
				yield* TestClock.adjust(Duration.seconds(100));
				const now = yield* Clock.currentTimeMillis;
				MutableHashMap.set(lastRequest, "BTC", now - 90_000);

				const fiber = yield* forkIdleCleanup({
					lastRequest,
					ttl: Duration.seconds(60),
					interval: Duration.seconds(30),
					onExpire: () =>
						Effect.gen(function* () {
							attempts += 1;
							return yield* Effect.fail(new Error("downstream unhealthy"));
						}),
				});

				// Five passes, every one failing. The key must still be present
				// (no force-removal) and onExpire must have been invoked each pass.
				yield* TestClock.adjust(Duration.seconds(151));

				expect(Option.isSome(MutableHashMap.get(lastRequest, "BTC"))).toBe(
					true,
				);
				expect(attempts).toBeGreaterThanOrEqual(5);

				yield* Fiber.interrupt(fiber);
			}),
		);
	});

	it("retains an entry on onExpire failure and removes it on the next pass", async () => {
		const lastRequest = MutableHashMap.empty<string, number>();
		const expired: string[] = [];
		let failOnce = true;

		await provideTestClock(
			Effect.gen(function* () {
				yield* TestClock.adjust(Duration.seconds(100));
				const now = yield* Clock.currentTimeMillis;
				MutableHashMap.set(lastRequest, "BTC", now - 90_000);

				const fiber = yield* forkIdleCleanup({
					lastRequest,
					ttl: Duration.seconds(60),
					interval: Duration.seconds(30),
					onExpire: (key) =>
						Effect.gen(function* () {
							if (failOnce) {
								failOnce = false;
								return yield* Effect.fail(new Error("boom"));
							}
							expired.push(key);
						}),
				});

				yield* TestClock.adjust(Duration.seconds(31));
				expect(Option.isSome(MutableHashMap.get(lastRequest, "BTC"))).toBe(
					true,
				);
				expect(expired).toEqual([]);

				yield* TestClock.adjust(Duration.seconds(30));
				expect(Option.isNone(MutableHashMap.get(lastRequest, "BTC"))).toBe(
					true,
				);
				expect(expired).toEqual(["BTC"]);

				yield* Fiber.interrupt(fiber);
			}),
		);
	});
});
