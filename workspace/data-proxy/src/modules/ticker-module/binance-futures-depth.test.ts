import { describe, expect, it } from "bun:test";
import {
	type BinanceDepthSnapshot,
	type BinanceDepthUpdate,
	type DepthSyncState,
	onDepthUpdate,
	tryPromotePendingSnapshot,
} from "./binance-futures-depth";

const book = (
	lastUpdateId: number,
	bids: Array<[string, string]> = [],
	asks: Array<[string, string]> = [],
): BinanceDepthSnapshot => ({ s: "BTCUSDT", lastUpdateId, bids, asks });

const update = (
	U: number,
	u: number,
	pu: number,
	b: Array<[string, string]> = [],
	a: Array<[string, string]> = [],
): BinanceDepthUpdate => ({ U, u, pu, b, a });

const emptyDepthSyncState = (): DepthSyncState => ({
	bufferedUpdates: [],
	book: null,
	pendingSnapshot: null,
});

describe("tryPromotePendingSnapshot", () => {
	it("holds the snapshot until a diff brackets its lastUpdateId (U <= last <= u)", () => {
		const state = emptyDepthSyncState();
		state.pendingSnapshot = book(100, [["1", "5"]], [["2", "5"]]);
		expect(tryPromotePendingSnapshot(state)).toEqual({ action: "ignore" });
		expect(state.book).toBeNull();
		expect(state.pendingSnapshot?.lastUpdateId).toBe(100);

		// Unlike Spot, the bridge may start at or before lastUpdateId; there is
		// no `+1` offset since Futures uses `pu` for continuity after the bridge.
		expect(
			onDepthUpdate(
				state,
				update(95, 102, 94, [
					["1", "0"],
					["3", "1"],
				]),
			),
		).toEqual({
			action: "write",
			book: {
				s: "BTCUSDT",
				lastUpdateId: 102,
				bids: [["3", "1"]],
				asks: [["2", "5"]],
			},
		});
		expect(state.pendingSnapshot).toBeNull();
		expect(state.bufferedUpdates).toEqual([]);
	});

	it("drops diffs already included in the snapshot and applies the rest", () => {
		const state = emptyDepthSyncState();
		state.bufferedUpdates.push(update(85, 95, 84, [["9", "9"]]));
		state.bufferedUpdates.push(update(98, 105, 95, [["1", "2"]]));
		state.pendingSnapshot = book(100, [["1", "5"]], [["2", "5"]]);

		expect(tryPromotePendingSnapshot(state)).toEqual({
			action: "write",
			book: {
				s: "BTCUSDT",
				lastUpdateId: 105,
				bids: [["1", "2"]],
				asks: [["2", "5"]],
			},
		});
	});

	it("reseeds when the first applicable diff starts after the snapshot's lastUpdateId", () => {
		const state = emptyDepthSyncState();
		const gapped = update(200, 201, 199, [["4", "1"]]);
		state.bufferedUpdates.push(gapped);
		state.pendingSnapshot = book(100);

		expect(tryPromotePendingSnapshot(state)).toEqual({ action: "reseed" });
		expect(state.bufferedUpdates).toEqual([gapped]);
		expect(state.pendingSnapshot).toBeNull();
		expect(state.book).toBeNull();
	});

	it("chains multiple buffered diffs through pu once the bridge lands", () => {
		const state = emptyDepthSyncState();
		// Bridges at lastUpdateId=100 (U <= 100, u > 100 so it survives the
		// staleness filter, which drops u <= lastUpdateId).
		state.bufferedUpdates.push(update(99, 101, 98, [["1", "6"]]));
		// Continues via pu === 101 (the bridge's u).
		state.bufferedUpdates.push(update(102, 102, 101, [["1", "7"]]));
		state.pendingSnapshot = book(100, [["1", "5"]]);

		expect(tryPromotePendingSnapshot(state)).toEqual({
			action: "write",
			book: { s: "BTCUSDT", lastUpdateId: 102, bids: [["1", "7"]], asks: [] },
		});
	});

	it("reseeds and keeps the broken diff when pu breaks mid-chain", () => {
		const state = emptyDepthSyncState();
		state.bufferedUpdates.push(update(99, 101, 98, [["1", "6"]]));
		const broken = update(103, 104, 99, [["1", "9"]]); // expected pu 101
		state.bufferedUpdates.push(broken);
		state.pendingSnapshot = book(100, [["1", "5"]]);

		expect(tryPromotePendingSnapshot(state)).toEqual({ action: "reseed" });
		expect(state.bufferedUpdates).toEqual([broken]);
		expect(state.pendingSnapshot).toBeNull();
		expect(state.book).toBeNull();
	});
});

describe("onDepthUpdate", () => {
	it("ignores a diff the book already includes", () => {
		const state = emptyDepthSyncState();
		state.book = book(105, [["1", "1"]]);

		expect(onDepthUpdate(state, update(50, 90, 49, [["1", "9"]]))).toEqual({
			action: "ignore",
		});
		expect(state.book).toEqual(book(105, [["1", "1"]]));
	});

	it("merges a diff whose pu matches the book's lastUpdateId", () => {
		const state = emptyDepthSyncState();
		state.book = book(105, [["1", "1"]], [["2", "2"]]);

		expect(
			onDepthUpdate(
				state,
				update(
					106,
					108,
					105,
					[],
					[
						["2", "9"],
						["4", "1"],
					],
				),
			),
		).toEqual({
			action: "write",
			book: {
				s: "BTCUSDT",
				lastUpdateId: 108,
				bids: [["1", "1"]],
				asks: [
					["2", "9"],
					["4", "1"],
				],
			},
		});
	});

	it("clears the book and keeps the diff when pu does not match", () => {
		const state = emptyDepthSyncState();
		state.book = book(105, [["1", "1"]]);
		const mismatch = update(106, 108, 104, [["8", "1"]]); // expected pu 105

		expect(onDepthUpdate(state, mismatch)).toEqual({ action: "reseed" });
		expect(state.book).toBeNull();
		expect(state.bufferedUpdates).toEqual([mismatch]);
	});

	it("treats Binance's pu: -1 re-init signal as a gap", () => {
		const state = emptyDepthSyncState();
		state.book = book(105, [["1", "1"]]);
		const reinit = update(106, 108, -1, [["8", "1"]]);

		expect(onDepthUpdate(state, reinit)).toEqual({ action: "reseed" });
		expect(state.book).toBeNull();
		expect(state.bufferedUpdates).toEqual([reinit]);
	});
});
