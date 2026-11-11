import { describe, expect, it } from "bun:test";
import { Context, Effect, Layer, Option } from "effect";
import {
	SocketHealth,
	SocketHealthRegistry,
	WS_DISCONNECT_GRACE_MS,
} from "./socket-health";

const identity = { module: "binance-main", venue: "binance" };

describe("SocketHealthRegistry", () => {
	it("stays healthy through a disconnect shorter than the grace", () => {
		const registry = new SocketHealthRegistry();
		const watch = registry.track(identity, 0);
		watch.connected();
		watch.disconnected(10_000);

		expect(registry.staleSockets(10_000 + WS_DISCONNECT_GRACE_MS - 1)).toEqual(
			[],
		);
	});

	it("is unhealthy once the disconnect reaches the grace", () => {
		const registry = new SocketHealthRegistry();
		const watch = registry.track(identity, 0);
		watch.connected();
		watch.disconnected(10_000);

		expect(registry.staleSockets(10_000 + WS_DISCONNECT_GRACE_MS)).toEqual([
			{
				module: "binance-main",
				venue: "binance",
				disconnectedForMs: WS_DISCONNECT_GRACE_MS,
			},
		]);
	});

	it("clears the clock when the socket reconnects", () => {
		const registry = new SocketHealthRegistry();
		const watch = registry.track(identity, 0);

		expect(registry.staleSockets(WS_DISCONNECT_GRACE_MS)).toHaveLength(1);

		watch.connected();

		expect(registry.staleSockets(WS_DISCONNECT_GRACE_MS * 10)).toEqual([]);
	});

	it("does not restart the grace when close fires again while already down", () => {
		const registry = new SocketHealthRegistry();
		const watch = registry.track(identity, 0);
		watch.disconnected(5_000);
		watch.disconnected(20_000);

		expect(registry.staleSockets(WS_DISCONNECT_GRACE_MS)).toEqual([
			{
				module: "binance-main",
				venue: "binance",
				disconnectedForMs: WS_DISCONNECT_GRACE_MS,
			},
		]);
	});

	it("treats a socket that never opens as stale after the grace", () => {
		const registry = new SocketHealthRegistry();
		registry.track(identity, 0);

		expect(registry.staleSockets(WS_DISCONNECT_GRACE_MS - 1)).toEqual([]);
		expect(registry.staleSockets(WS_DISCONNECT_GRACE_MS)).toEqual([
			{
				module: "binance-main",
				venue: "binance",
				disconnectedForMs: WS_DISCONNECT_GRACE_MS,
			},
		]);
	});

	it("reports a stale episode once", () => {
		const registry = new SocketHealthRegistry();
		registry.track(identity, 0);

		expect(registry.newlyStale(WS_DISCONNECT_GRACE_MS)).toHaveLength(1);
		expect(registry.newlyStale(WS_DISCONNECT_GRACE_MS + 5_000)).toEqual([]);

		const watch = registry.track(identity, 0);
		watch.connected();
		watch.disconnected(WS_DISCONNECT_GRACE_MS);

		expect(registry.newlyStale(WS_DISCONNECT_GRACE_MS * 2)).toHaveLength(1);
	});

	it("is visible inside a module layer that does not require it", async () => {
		class Probe extends Context.Tag("SocketHealthProbe")<
			Probe,
			Option.Option<SocketHealthRegistry>
		>() {}

		const registry = new SocketHealthRegistry();
		const memoized = await Effect.runPromise(
			Layer.memoize(
				Layer.effect(
					Probe,
					Effect.gen(function* () {
						return yield* Effect.serviceOption(SocketHealth);
					}),
				),
			).pipe(Effect.scoped),
		);
		const layer = memoized.pipe(
			Layer.provide(Layer.succeed(SocketHealth, registry)),
		);
		const seen = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* Probe;
			}).pipe(Effect.provide(layer), Effect.scoped),
		);

		expect(Option.isSome(seen)).toBe(true);
		if (Option.isSome(seen)) {
			expect(seen.value).toBe(registry);
		}
	});
});
