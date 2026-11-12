import { Duration, Effect, Fiber } from "effect";
import type { PriceCache } from "../shared/price-cache";
import type { ParsedTickerFrames } from "../shared/venue-ws";
import type { BinancePriceFrame } from "./binance-futures";

export const BINANCE_FUTURES_DEPTH_SNAPSHOT_URL =
	"https://fapi.binance.com/fapi/v1/depth";
// Valid limits are 5, 10, 20, 50, 100, 500, 1000; weight 20 at 1000 (REST
// weight limit is 2400/min on Futures, well above what 20 costs per reseed).
export const BINANCE_FUTURES_DEPTH_SNAPSHOT_LIMIT = 1000;
const DEPTH_SNAPSHOT_RETRY = Duration.seconds(1);

/** Pair [price, quantity] */
export type BinanceDepthLevel = [string, string];

export type BinanceDepthSnapshot = {
	s: string;
	/** Indicates that update ID up to this value is fully synced. */
	lastUpdateId: number;
	bids: BinanceDepthLevel[];
	asks: BinanceDepthLevel[];
};

export interface BinanceDepthUpdate {
	/** The first update ID in this event. */
	U: number;
	/** The last update ID in this event. */
	u: number;
	/**
	 * The previous event's final update ID. `-1` signals a re-init on
	 * Binance's side; it never equals a real `lastUpdateId`, so it always
	 * fails the continuity check below and triggers a reseed.
	 */
	pu: number;
	/** Bids. */
	b: BinanceDepthLevel[];
	/** Asks. */
	a: BinanceDepthLevel[];
}

export interface DepthSyncState {
	/** Synchronized live order book. */
	book: BinanceDepthSnapshot | null;
	/** Updates buffered while the book is not synced (book is null). */
	bufferedUpdates: BinanceDepthUpdate[];
	/** Snapshot held until it is promoted to book. */
	pendingSnapshot: BinanceDepthSnapshot | null;
}

export type DepthStep =
	| { action: "ignore" }
	| { action: "write"; book: BinanceDepthSnapshot }
	| { action: "reseed" };

const isUpdateId = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value);

const isZeroQty = (qty: string): boolean => Number(qty) === 0;

const readLevel = (value: unknown): BinanceDepthLevel | null => {
	if (!Array.isArray(value) || value.length < 2) return null;
	if (typeof value[0] !== "string" || typeof value[1] !== "string") return null;
	return [value[0], value[1]];
};

const readSide = (value: unknown): BinanceDepthLevel[] | null => {
	if (!Array.isArray(value)) return null;
	const levels: BinanceDepthLevel[] = [];
	for (const item of value) {
		const level = readLevel(item);
		if (level === null) return null;
		levels.push(level);
	}
	return levels;
};

const copySide = (levels: BinanceDepthLevel[]): BinanceDepthLevel[] =>
	levels.map((level) => [level[0], level[1]]);

const byPrice =
	(direction: 1 | -1) =>
	(left: BinanceDepthLevel, right: BinanceDepthLevel): number =>
		(Number(left[0]) - Number(right[0])) * direction;

const sortSides = (
	bids: BinanceDepthLevel[],
	asks: BinanceDepthLevel[],
): Pick<BinanceDepthSnapshot, "bids" | "asks"> => ({
	bids: copySide(bids).sort(byPrice(-1)),
	asks: copySide(asks).sort(byPrice(1)),
});

const sortBook = (book: BinanceDepthSnapshot): BinanceDepthSnapshot => {
	const sides = sortSides(book.bids, book.asks);
	return {
		s: book.s,
		lastUpdateId: book.lastUpdateId,
		bids: sides.bids,
		asks: sides.asks,
	};
};

/** Absolute quantity. `"0"` removes the price. New prices append. */
const mergeSide = (
	existing: BinanceDepthLevel[],
	updates: BinanceDepthLevel[],
): BinanceDepthLevel[] => {
	const levels = copySide(existing);
	for (const [price, qty] of updates) {
		const index = levels.findIndex((level) => level[0] === price);
		if (isZeroQty(qty)) {
			if (index !== -1) levels.splice(index, 1);
			continue;
		}
		if (index === -1) levels.push([price, qty]);
		else levels[index] = [price, qty];
	}
	return levels;
};

const mergeBook = (
	book: BinanceDepthSnapshot,
	event: BinanceDepthUpdate,
): BinanceDepthSnapshot =>
	sortBook({
		s: book.s,
		lastUpdateId: event.u,
		bids: mergeSide(book.bids, event.b),
		asks: mergeSide(book.asks, event.a),
	});

/**
 * Bridges a pending snapshot: the first diff applied to it must straddle the
 * snapshot's `lastUpdateId` (`U <= lastUpdateId <= u`). Unlike Spot there is
 * no `+1` offset; Futures docs state the bridge may overlap the snapshot.
 */
const bridges = (lastUpdateId: number, event: BinanceDepthUpdate): boolean =>
	event.U <= lastUpdateId && event.u >= lastUpdateId;

/**
 * Continues an already-synced book: each event's `pu` must equal the prior
 * event's `u`, which is exactly the book's current `lastUpdateId`.
 */
const continuesStream = (
	lastUpdateId: number,
	event: BinanceDepthUpdate,
): boolean => event.pu === lastUpdateId;

/** Promotes `pendingSnapshot` into `book` when there is an applicable update. */
export const tryPromotePendingSnapshot = (state: DepthSyncState): DepthStep => {
	if (state.pendingSnapshot === null) return { action: "ignore" };

	// Drop events the snapshot already covers; Binance sends updates in
	// order, and they are stored in arrival order.
	let startIndex = 0;
	for (const update of state.bufferedUpdates) {
		if (update.u > state.pendingSnapshot.lastUpdateId) break;
		startIndex++;
	}
	const applicableUpdates = state.bufferedUpdates.slice(startIndex);

	// If all buffered events are stale, drop them and wait for new updates.
	if (applicableUpdates.length === 0) {
		state.bufferedUpdates = [];
		return { action: "ignore" };
	}

	// The first applicable event must bridge the snapshot; later ones chain
	// through `pu`. Apply them all and promote to book.
	const bridge = applicableUpdates[0];
	if (!bridges(state.pendingSnapshot.lastUpdateId, bridge)) {
		state.bufferedUpdates = applicableUpdates;
		state.book = null;
		state.pendingSnapshot = null;
		return { action: "reseed" };
	}

	let next = mergeBook(state.pendingSnapshot, bridge);
	for (let index = 1; index < applicableUpdates.length; index++) {
		const event = applicableUpdates[index];
		if (!continuesStream(next.lastUpdateId, event)) {
			state.bufferedUpdates = applicableUpdates.slice(index);
			state.book = null;
			state.pendingSnapshot = null;
			return { action: "reseed" };
		}
		next = mergeBook(next, event);
	}
	state.bufferedUpdates = [];
	state.pendingSnapshot = null;
	state.book = next;
	return { action: "write", book: next };
};

export const onDepthUpdate = (
	state: DepthSyncState,
	event: BinanceDepthUpdate,
): DepthStep => {
	// No live book yet.
	if (state.book === null) {
		state.bufferedUpdates.push(event);
		if (state.pendingSnapshot === null) return { action: "ignore" };
		return tryPromotePendingSnapshot(state);
	}

	// The update event brings nothing new.
	if (event.u <= state.book.lastUpdateId) return { action: "ignore" };

	// A gap (or an explicit `pu: -1` re-init signal). Clear the book and
	// reseed.
	if (!continuesStream(state.book.lastUpdateId, event)) {
		state.bufferedUpdates = [event];
		state.book = null;
		state.pendingSnapshot = null;
		return { action: "reseed" };
	}

	// The update event continues the book.
	state.book = mergeBook(state.book, event);
	return { action: "write", book: state.book };
};

export const readDepthBook = (
	symbol: string,
	value: unknown,
): BinanceDepthSnapshot | null => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const record = value as Record<string, unknown>;
	if (!isUpdateId(record.lastUpdateId)) return null;

	const bids = readSide(record.bids);
	const asks = readSide(record.asks);
	if (bids === null || asks === null) return null;

	const sides = sortSides(
		bids.filter((level) => !isZeroQty(level[1])),
		asks.filter((level) => !isZeroQty(level[1])),
	);
	return {
		s: symbol.toUpperCase(),
		lastUpdateId: record.lastUpdateId,
		bids: sides.bids,
		asks: sides.asks,
	};
};

export const readDepthUpdate = (
	payload: Record<string, unknown>,
	symbol: string,
): { key: string; event: BinanceDepthUpdate } | "invalid" | null => {
	if (payload.e !== "depthUpdate") return null;
	if (
		!isUpdateId(payload.U) ||
		!isUpdateId(payload.u) ||
		!isUpdateId(payload.pu)
	) {
		return "invalid";
	}

	const bids = readSide(payload.b);
	const asks = readSide(payload.a);
	if (bids === null || asks === null) return "invalid";
	return {
		key: symbol.toUpperCase(),
		event: { U: payload.U, u: payload.u, pu: payload.pu, b: bids, a: asks },
	};
};

const emptyBook = (symbol: string): BinanceDepthSnapshot => ({
	s: symbol.toUpperCase(),
	lastUpdateId: 0,
	bids: [],
	asks: [],
});

interface KeyState extends DepthSyncState {
	generation: number;
}

export interface DepthSync {
	start: (keys: string[]) => Effect.Effect<void, never, never>;
	stop: (keys: string[]) => Effect.Effect<void, never, never>;
	restart: (keys: string[]) => Effect.Effect<void, never, never>;
	ingest: (
		payload: Record<string, unknown>,
		symbol: string,
	) => ParsedTickerFrames<string, BinancePriceFrame> | null;
}

export const fetchBinanceFuturesDepthSnapshot = (symbol: string) =>
	Effect.async<BinanceDepthSnapshot, Error>((resume) => {
		const controller = new AbortController();
		const url = new URL(BINANCE_FUTURES_DEPTH_SNAPSHOT_URL);
		url.searchParams.set("symbol", symbol);
		url.searchParams.set("limit", String(BINANCE_FUTURES_DEPTH_SNAPSHOT_LIMIT));
		fetch(url, { signal: controller.signal })
			.then(async (response) => {
				if (!response.ok) {
					resume(
						Effect.fail(
							new Error(
								`Binance futures depth snapshot failed: ${response.status}`,
							),
						),
					);
					return;
				}
				const body: unknown = await response.json();
				const book = readDepthBook(symbol, body);
				if (book === null) {
					resume(
						Effect.fail(
							new Error("Binance futures depth snapshot was invalid"),
						),
					);
					return;
				}
				resume(Effect.succeed(book));
			})
			.catch((error: unknown) => {
				if (controller.signal.aborted) return;
				resume(
					Effect.fail(
						error instanceof Error ? error : new Error(String(error)),
					),
				);
			});
		return Effect.sync(() => {
			controller.abort();
		});
	});

export const createDepthSync = (
	venueCache: Pick<
		PriceCache<string, BinanceDepthSnapshot>,
		"setPriceSync" | "deleteCached"
	>,
): DepthSync => {
	const states = new Map<string, KeyState>();
	const fibers = new Map<string, Fiber.RuntimeFiber<void, never>>();

	/** Fetch a seed snapshot until it is promoted to the live book. */
	const snapshotLoop = (key: string, generation: number) =>
		Effect.gen(function* () {
			while (true) {
				const state = states.get(key);
				if (state === undefined || state.generation !== generation) return;

				const snapshot = yield* fetchBinanceFuturesDepthSnapshot(key).pipe(
					Effect.catchAll((error) =>
						Effect.logWarning("Binance futures depth snapshot failed", {
							symbol: key,
							error: String(error),
						}).pipe(Effect.as(null)),
					),
				);

				// Check the state again after the async fetch.
				const current = states.get(key);
				if (
					current === undefined ||
					current !== state ||
					current.generation !== generation
				) {
					return;
				}
				if (snapshot === null) {
					yield* Effect.sleep(DEPTH_SNAPSHOT_RETRY);
					continue;
				}

				current.pendingSnapshot = snapshot;
				const step = tryPromotePendingSnapshot(current);

				if (step.action === "write") {
					venueCache.setPriceSync(key, step.book);
					return;
				}
				if (step.action === "ignore") return;

				yield* Effect.sleep(DEPTH_SNAPSHOT_RETRY);
			}
		});

	const forkLoop = (key: string, generation: number) =>
		Effect.gen(function* () {
			const prevFiber = fibers.get(key);
			const newFiber = yield* Effect.forkDaemon(snapshotLoop(key, generation));
			fibers.set(key, newFiber);
			if (prevFiber !== undefined) {
				yield* Fiber.interrupt(prevFiber);
			}
		});

	const start = (keys: string[]) =>
		Effect.gen(function* () {
			for (const key of keys) {
				const generation = (states.get(key)?.generation ?? 0) + 1;
				states.set(key, {
					generation,
					bufferedUpdates: [],
					book: null,
					pendingSnapshot: null,
				});
				venueCache.deleteCached(key);
				yield* forkLoop(key, generation);
			}
		});

	const stop = (keys: string[]) =>
		Effect.gen(function* () {
			for (const key of keys) {
				const fiber = fibers.get(key);
				fibers.delete(key);
				states.delete(key);
				venueCache.deleteCached(key);
				if (fiber !== undefined) yield* Fiber.interrupt(fiber);
			}
		});

	const restart = (keys: string[]) =>
		Effect.gen(function* () {
			for (const key of keys) {
				const previous = states.get(key);
				const generation = (previous?.generation ?? 0) + 1;
				states.set(key, {
					generation,
					bufferedUpdates: previous?.bufferedUpdates.slice() ?? [],
					book: null,
					pendingSnapshot: null,
				});

				venueCache.deleteCached(key);
				yield* Effect.logWarning("Binance futures depth book out of sync", {
					symbol: key,
				});
				yield* forkLoop(key, generation);
			}
		});

	const ingest = (
		payload: Record<string, unknown>,
		symbol: string,
	): ParsedTickerFrames<string, BinancePriceFrame> | null => {
		const update = readDepthUpdate(payload, symbol);
		if (update === null) return null;
		if (update === "invalid") {
			const key = symbol.toUpperCase();
			const state = states.get(key);
			if (state === undefined) return null;

			state.bufferedUpdates = [];
			state.book = null;
			state.pendingSnapshot = null;
			return [{ key, action: "reseed", frame: emptyBook(symbol) }];
		}

		const state = states.get(update.key);
		if (state === undefined) return null;

		const step = onDepthUpdate(state, update.event);
		if (step.action === "write") {
			return [{ key: update.key, action: "write", frame: step.book }];
		}
		if (step.action === "reseed") {
			return [{ key: update.key, action: "reseed", frame: emptyBook(symbol) }];
		}
		return [{ key: update.key, action: "ignore", frame: emptyBook(symbol) }];
	};

	return { start, stop, restart, ingest };
};
