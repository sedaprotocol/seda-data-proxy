import { Clock, Effect } from "effect";

/** A socket must stay disconnected this long before `/health` reports it. */
export const WS_DISCONNECT_GRACE_MS = 30_000;

export interface StaleSocket {
	module: string;
	venue: string;
	disconnectedForMs: number;
}

export interface SocketWatch {
	connected(): void;
	disconnected(): void;
}

export interface SocketHealthReport {
	stale: StaleSocket[];
	/** Stale sockets whose current disconnect has not been reported yet. */
	newlyStale: StaleSocket[];
}

interface SocketSlot {
	module: string;
	venue: string;
	disconnectedSince: number | null;
	/** `disconnectedSince` value already included in `newlyStale`. */
	announcedSince: number | null;
}

/**
 * Read-time view of module sockets. `track` starts the clock immediately, so a
 * socket that never opens is stale after the grace. A reconnect clears it. A
 * second close while already down does not restart the grace.
 *
 * Time is a function so callers use `Clock` and tests can pin it. The registry
 * itself does not read the wall clock.
 */
export class SocketHealthRegistry {
	private readonly slots = new Map<string, SocketSlot>();

	track(
		identity: { module: string; venue: string },
		now: () => number,
	): SocketWatch {
		const current = this.slotFor(identity, now());
		return {
			connected() {
				current.disconnectedSince = null;
				current.announcedSince = null;
			},
			disconnected() {
				if (current.disconnectedSince !== null) return;
				current.disconnectedSince = now();
			},
		};
	}

	/** Sockets down for at least the grace. Does not mark them reported. */
	staleSockets(now: number, graceMs = WS_DISCONNECT_GRACE_MS): StaleSocket[] {
		return this.collect(now, graceMs, false).stale;
	}

	/** Same as `staleSockets`, and marks each new episode so a probe logs it once. */
	read(now: number, graceMs = WS_DISCONNECT_GRACE_MS): SocketHealthReport {
		return this.collect(now, graceMs, true);
	}

	private slotFor(
		identity: { module: string; venue: string },
		disconnectedSince: number,
	): SocketSlot {
		const key = `${identity.module}\0${identity.venue}`;
		const existing = this.slots.get(key);
		if (existing !== undefined) return existing;
		const created: SocketSlot = {
			module: identity.module,
			venue: identity.venue,
			disconnectedSince,
			announcedSince: null,
		};
		this.slots.set(key, created);
		return created;
	}

	private collect(
		now: number,
		graceMs: number,
		announce: boolean,
	): SocketHealthReport {
		const stale: StaleSocket[] = [];
		const newlyStale: StaleSocket[] = [];
		for (const slot of this.slots.values()) {
			if (slot.disconnectedSince === null) continue;
			const disconnectedForMs = now - slot.disconnectedSince;
			if (disconnectedForMs < graceMs) continue;
			const report: StaleSocket = {
				module: slot.module,
				venue: slot.venue,
				disconnectedForMs,
			};
			stale.push(report);
			if (slot.announcedSince === slot.disconnectedSince) continue;
			if (announce) slot.announcedSince = slot.disconnectedSince;
			newlyStale.push(report);
		}
		return { stale, newlyStale };
	}
}

/** Binds a module socket to `Clock`, which is the live clock unless a test replaces it. */
export const trackModuleSocket = (
	health: SocketHealthRegistry,
	identity: { module: string; venue: string },
) =>
	Clock.clockWith((clock) =>
		Effect.sync(() =>
			health.track(identity, () => clock.unsafeCurrentTimeMillis()),
		),
	);
