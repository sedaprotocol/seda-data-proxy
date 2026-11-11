/** A socket must stay disconnected this long before `/health` reports it. */
export const WS_DISCONNECT_GRACE_MS = 30_000;

export interface StaleSocket {
	module: string;
	venue: string;
	disconnectedForMs: number;
}

export interface SocketWatch {
	connected(): void;
	disconnected(at?: number): void;
}

interface SocketSlot {
	module: string;
	venue: string;
	disconnectedSince: number | null;
	staleLogged: boolean;
}

/**
 * Read-time view of module sockets. `track` starts the clock immediately, so a
 * socket that never opens is stale after the grace. A reconnect clears it. A
 * second close while already down does not restart the grace.
 */
export class SocketHealthRegistry {
	private readonly slots = new Map<string, SocketSlot>();

	track(
		identity: { module: string; venue: string },
		now = Date.now(),
	): SocketWatch {
		const key = `${identity.module}\0${identity.venue}`;
		let slot = this.slots.get(key);
		if (slot === undefined) {
			slot = {
				module: identity.module,
				venue: identity.venue,
				disconnectedSince: now,
				staleLogged: false,
			};
			this.slots.set(key, slot);
		}
		const current = slot;
		return {
			connected() {
				current.disconnectedSince = null;
				current.staleLogged = false;
			},
			disconnected(at = Date.now()) {
				if (current.disconnectedSince !== null) return;
				current.disconnectedSince = at;
				current.staleLogged = false;
			},
		};
	}

	staleSockets(
		now = Date.now(),
		graceMs = WS_DISCONNECT_GRACE_MS,
	): StaleSocket[] {
		const stale: StaleSocket[] = [];
		for (const slot of this.slots.values()) {
			if (slot.disconnectedSince === null) continue;
			const disconnectedForMs = now - slot.disconnectedSince;
			if (disconnectedForMs < graceMs) continue;
			stale.push({
				module: slot.module,
				venue: slot.venue,
				disconnectedForMs,
			});
		}
		return stale;
	}

	/** Sockets that crossed the grace since the previous call. Probes should log these once. */
	newlyStale(
		now = Date.now(),
		graceMs = WS_DISCONNECT_GRACE_MS,
	): StaleSocket[] {
		const fresh: StaleSocket[] = [];
		for (const slot of this.slots.values()) {
			if (slot.disconnectedSince === null || slot.staleLogged) continue;
			const disconnectedForMs = now - slot.disconnectedSince;
			if (disconnectedForMs < graceMs) continue;
			slot.staleLogged = true;
			fresh.push({
				module: slot.module,
				venue: slot.venue,
				disconnectedForMs,
			});
		}
		return fresh;
	}
}
