import { describe, expect, it } from "bun:test";
import {
	type BinanceDepthSnapshot,
	type BinanceDepthUpdate,
	type DepthSyncState,
	onDepthUpdate,
	tryPromotePendingSnapshot,
} from "./binance-depth";

const book = (
	lastUpdateId: number,
	bids: Array<[string, string]> = [],
	asks: Array<[string, string]> = [],
): BinanceDepthSnapshot => ({ s: "BTCUSDT", lastUpdateId, bids, asks });

const update = (
	U: number,
	u: number,
	b: Array<[string, string]> = [],
	a: Array<[string, string]> = [],
): BinanceDepthUpdate => ({ U, u, b, a });

const emptyDepthSyncState = (): DepthSyncState => ({
	bufferedUpdates: [],
	book: null,
	pendingSnapshot: null,
});

describe("tryPromotePendingSnapshot", () => {
	it("holds the snapshot until a diff covers the next update id", () => {
		const state = emptyDepthSyncState();
		state.pendingSnapshot = book(100, [["1", "5"]], [["2", "5"]]);
		expect(tryPromotePendingSnapshot(state)).toEqual({
			action: "ignore",
		});
		expect(state.book).toBeNull();
		expect(state.pendingSnapshot?.lastUpdateId).toBe(100);

		expect(
			onDepthUpdate(
				state,
				update(101, 102, [
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
		state.bufferedUpdates.push(update(90, 95, [["9", "9"]]));
		state.bufferedUpdates.push(update(100, 104, [["1", "2"]]));
		state.pendingSnapshot = book(100, [["1", "5"]], [["2", "5"]]);

		expect(tryPromotePendingSnapshot(state)).toEqual({
			action: "write",
			book: {
				s: "BTCUSDT",
				lastUpdateId: 104,
				bids: [["1", "2"]],
				asks: [["2", "5"]],
			},
		});
	});

	it("reseeds when the snapshot is older than the first buffered diff", () => {
		const state = emptyDepthSyncState();
		const stale = update(200, 201, [["4", "1"]]);
		state.bufferedUpdates.push(stale);
		state.pendingSnapshot = book(100);

		expect(tryPromotePendingSnapshot(state)).toEqual({ action: "reseed" });
		expect(state.bufferedUpdates).toEqual([stale]);
		expect(state.pendingSnapshot).toBeNull();
		expect(state.book).toBeNull();
	});

	it("treats a diff that starts at lastUpdateId + 1 as the bridge", () => {
		const state = emptyDepthSyncState();
		state.bufferedUpdates.push(update(101, 101, [["1", "8"]]));
		state.pendingSnapshot = book(100, [["1", "5"]]);

		expect(tryPromotePendingSnapshot(state)).toEqual({
			action: "write",
			book: { s: "BTCUSDT", lastUpdateId: 101, bids: [["1", "8"]], asks: [] },
		});
	});
});

describe("onDepthUpdate", () => {
	it("ignores a diff the book already includes", () => {
		const state = emptyDepthSyncState();
		state.book = book(105, [["1", "1"]]);

		expect(onDepthUpdate(state, update(100, 105, [["1", "9"]]))).toEqual({
			action: "ignore",
		});
		expect(state.book).toEqual(book(105, [["1", "1"]]));
	});

	it("merges a continuing diff", () => {
		const state = emptyDepthSyncState();
		state.book = book(105, [["1", "1"]], [["2", "2"]]);

		expect(
			onDepthUpdate(
				state,
				update(
					106,
					108,
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

	it("clears the book and keeps the gapped diff for the next snapshot", () => {
		const state = emptyDepthSyncState();
		state.book = book(105, [["1", "1"]]);
		const gap = update(110, 111, [["8", "1"]]);

		expect(onDepthUpdate(state, gap)).toEqual({ action: "reseed" });
		expect(state.book).toBeNull();
		expect(state.bufferedUpdates).toEqual([gap]);
	});
});
