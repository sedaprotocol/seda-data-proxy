import { describe, expect, it } from "bun:test";
import {
	Clock,
	Duration,
	Effect,
	Fiber,
	MutableHashMap,
	Option,
	TestClock,
	TestContext,
} from "effect";
import { forkIdleCleanup } from "./idle-cleanup";

const provideTestClock = <A, E>(effect: Effect.Effect<A, E, never>) =>
	Effect.runPromise(effect.pipe(Effect.provide(TestContext.TestContext)));

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

	it("expires only the stale entries when ages are mixed", async () => {
		const lastRequest = MutableHashMap.empty<string, number>();
		const expired: string[] = [];

		await provideTestClock(
			Effect.gen(function* () {
				const start = yield* Clock.currentTimeMillis;
				MutableHashMap.set(lastRequest, "OLD", start);

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
				const fresherStamp = yield* Clock.currentTimeMillis;
				MutableHashMap.set(lastRequest, "FRESH", fresherStamp);

				yield* TestClock.adjust(Duration.seconds(45));

				expect(Option.isNone(MutableHashMap.get(lastRequest, "OLD"))).toBe(
					true,
				);
				expect(Option.isSome(MutableHashMap.get(lastRequest, "FRESH"))).toBe(
					true,
				);
				expect(expired).toEqual(["OLD"]);

				yield* Fiber.interrupt(fiber);
			}),
		);
	});

	it("is a no-op when the map is empty across many ticks", async () => {
		const lastRequest = MutableHashMap.empty<string, number>();
		const expired: string[] = [];

		await provideTestClock(
			Effect.gen(function* () {
				const fiber = yield* forkIdleCleanup({
					lastRequest,
					ttl: Duration.seconds(60),
					interval: Duration.seconds(30),
					onExpire: (key) =>
						Effect.sync(() => {
							expired.push(key);
						}),
				});

				yield* TestClock.adjust(Duration.seconds(600));

				expect(MutableHashMap.size(lastRequest)).toBe(0);
				expect(expired).toEqual([]);

				yield* Fiber.interrupt(fiber);
			}),
		);
	});

	it("survives an onExpire failure and continues expiring on the next pass", async () => {
		const lastRequest = MutableHashMap.empty<string, number>();
		const expired: string[] = [];
		let failOnce = true;

		await provideTestClock(
			Effect.gen(function* () {
				const start = yield* Clock.currentTimeMillis;
				MutableHashMap.set(lastRequest, "FIRST", start);

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

				// First pass: FIRST goes stale, onExpire fails, the entry is still removed
				// (failure is in onExpire, after MutableHashMap.remove).
				yield* TestClock.adjust(Duration.seconds(91));
				expect(Option.isNone(MutableHashMap.get(lastRequest, "FIRST"))).toBe(
					true,
				);
				expect(expired).toEqual([]);

				// Add another entry; daemon should still be alive.
				const stamp = yield* Clock.currentTimeMillis;
				MutableHashMap.set(lastRequest, "SECOND", stamp);

				yield* TestClock.adjust(Duration.seconds(91));
				expect(Option.isNone(MutableHashMap.get(lastRequest, "SECOND"))).toBe(
					true,
				);
				expect(expired).toEqual(["SECOND"]);

				yield* Fiber.interrupt(fiber);
			}),
		);
	});

	it("expires entries across multiple sweeps as time advances", async () => {
		const lastRequest = MutableHashMap.empty<string, number>();
		const expired: string[] = [];

		await provideTestClock(
			Effect.gen(function* () {
				const start = yield* Clock.currentTimeMillis;
				MutableHashMap.set(lastRequest, "A", start);

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
				expect(expired).toEqual(["A"]);

				const stamp = yield* Clock.currentTimeMillis;
				MutableHashMap.set(lastRequest, "B", stamp);

				yield* TestClock.adjust(Duration.seconds(91));
				expect(expired).toEqual(["A", "B"]);

				yield* Fiber.interrupt(fiber);
			}),
		);
	});

	it("stops the cleanup pass when the fiber is interrupted", async () => {
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

				yield* Fiber.interrupt(fiber);

				// Even though we advance well past TTL, the daemon is dead.
				yield* TestClock.adjust(Duration.seconds(600));

				expect(Option.isSome(MutableHashMap.get(lastRequest, "BTC"))).toBe(
					true,
				);
				expect(expired).toEqual([]);
			}),
		);
	});
});
