import { Effect, MutableHashMap, Option } from "effect";
import type { AssetCtx } from "../../config/hydromancer-module-config";

export interface AssetCacheEntry {
	ctx: AssetCtx;
	lastUpdate: number;
}

export const createAssetCache = () =>
	Effect.gen(function* () {
		const entries = MutableHashMap.empty<string, AssetCacheEntry>();
		let socketError: string | undefined;

		const set = (coin: string, ctx: AssetCtx, now: number) =>
			Effect.sync(() => {
				MutableHashMap.set(entries, coin, { ctx, lastUpdate: now });
			});

		const get = (coin: string) =>
			Effect.sync(() => MutableHashMap.get(entries, coin));

		const remove = (coin: string) =>
			Effect.sync(() => {
				MutableHashMap.remove(entries, coin);
			});

		const markSocketError = (error: string) =>
			Effect.sync(() => {
				socketError = error;
			});

		const clearSocketError = () =>
			Effect.sync(() => {
				socketError = undefined;
			});

		const hasSocketError = () => Effect.sync(() => socketError !== undefined);

		const isFresh = (coin: string, staleAfterMillis: number, now: number) =>
			Effect.sync(() => {
				if (socketError !== undefined) return false;
				const entry = MutableHashMap.get(entries, coin);
				if (Option.isNone(entry)) return false;
				return now - entry.value.lastUpdate <= staleAfterMillis;
			});

		return {
			set,
			get,
			remove,
			isFresh,
			markSocketError,
			clearSocketError,
			hasSocketError,
		};
	});
