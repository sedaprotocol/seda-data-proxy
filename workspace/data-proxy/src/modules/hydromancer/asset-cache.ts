import { Effect, MutableHashMap, Option } from "effect";
import type { AssetCtx } from "../../config/hydromancer-module-config";

export interface AssetCacheEntry {
	ctx: AssetCtx;
	lastUpdate: number;
}

export const createAssetCache = () =>
	Effect.gen(function* () {
		const entries = MutableHashMap.empty<string, AssetCacheEntry>();

		const set = (coin: string, ctx: AssetCtx, now: number) =>
			Effect.sync(() => {
				setSync(coin, ctx, now);
			});

		const setSync = (coin: string, ctx: AssetCtx, now: number): void => {
			MutableHashMap.set(entries, coin, { ctx, lastUpdate: now });
		};

		const get = (coin: string) =>
			Effect.sync(() => MutableHashMap.get(entries, coin));

		const remove = (coin: string) =>
			Effect.sync(() => {
				MutableHashMap.remove(entries, coin);
			});

		const isFresh = (coin: string, staleAfterMillis: number, now: number) =>
			Effect.sync(() => {
				const entry = MutableHashMap.get(entries, coin);
				if (Option.isNone(entry)) return false;
				return now - entry.value.lastUpdate <= staleAfterMillis;
			});

		return {
			set,
			setSync,
			get,
			remove,
			isFresh,
		};
	});

export type AssetCache = Effect.Effect.Success<
	ReturnType<typeof createAssetCache>
>;
