import { describe, expect, it } from "bun:test";
import { SocketHealthRegistry, WS_DISCONNECT_GRACE_MS } from "./socket-health";

const identity = { module: "binance-main", venue: "binance" };

const pinned = (start = 0) => {
	let time = start;
	return {
		now: () => time,
		set: (next: number) => {
			time = next;
		},
	};
};

describe("SocketHealthRegistry", () => {
	it("stays healthy through a disconnect shorter than the grace", () => {
		const registry = new SocketHealthRegistry();
		const time = pinned();
		const watch = registry.track(identity, time.now);
		watch.connected();
		time.set(10_000);
		watch.disconnected();

		expect(
			registry.staleSockets(time.now() + WS_DISCONNECT_GRACE_MS - 1),
		).toEqual([]);
	});

	it("is unhealthy once the disconnect reaches the grace", () => {
		const registry = new SocketHealthRegistry();
		const time = pinned();
		const watch = registry.track(identity, time.now);
		watch.connected();
		time.set(10_000);
		watch.disconnected();

		expect(registry.staleSockets(time.now() + WS_DISCONNECT_GRACE_MS)).toEqual([
			{
				module: "binance-main",
				venue: "binance",
				disconnectedForMs: WS_DISCONNECT_GRACE_MS,
			},
		]);
	});

	it("clears the clock when the socket reconnects", () => {
		const registry = new SocketHealthRegistry();
		const time = pinned();
		const watch = registry.track(identity, time.now);

		expect(registry.staleSockets(WS_DISCONNECT_GRACE_MS)).toHaveLength(1);

		watch.connected();

		expect(registry.staleSockets(WS_DISCONNECT_GRACE_MS * 10)).toEqual([]);
	});

	it("does not restart the grace when close fires again while already down", () => {
		const registry = new SocketHealthRegistry();
		const time = pinned();
		const watch = registry.track(identity, time.now);
		time.set(5_000);
		watch.disconnected();
		time.set(20_000);
		watch.disconnected();

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
		registry.track(identity, pinned().now);

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
		const time = pinned();
		const watch = registry.track(identity, time.now);

		expect(registry.read(WS_DISCONNECT_GRACE_MS).newlyStale).toHaveLength(1);
		expect(registry.read(WS_DISCONNECT_GRACE_MS + 5_000).newlyStale).toEqual(
			[],
		);

		watch.connected();
		time.set(WS_DISCONNECT_GRACE_MS);
		watch.disconnected();

		expect(registry.read(WS_DISCONNECT_GRACE_MS * 2).newlyStale).toHaveLength(
			1,
		);
	});
});
