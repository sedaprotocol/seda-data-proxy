import { Effect, MutableHashMap, Option, SynchronizedRef } from "effect";
import type { AssetCtx } from "../../config/hydromancer-module-config";

export interface AssetCacheEntry {
	ctx: AssetCtx;
	lastUpdate: number;
}

export const createAssetCache = () =>
	Effect.gen(function* () {
		const entries = MutableHashMap.empty<string, AssetCacheEntry>();
		const socketError = yield* SynchronizedRef.make<string | undefined>(
			undefined,
		);

		const set = (coin: string, ctx: AssetCtx, now: number) =>
			Effect.sync(() => {
				MutableHashMap.set(entries, coin, { ctx, lastUpdate: now });
			});

		const get = (coin: string) =>
			Effect.sync(() => MutableHashMap.get(entries, coin));

		const markSocketError = (error: string) =>
			SynchronizedRef.set(socketError, error as string | undefined);

		const clearSocketError = () => SynchronizedRef.set(socketError, undefined);

		const hasSocketError = () =>
			Effect.map(SynchronizedRef.get(socketError), (e) => e !== undefined);

		const isFresh = (coin: string, staleAfterMillis: number, now: number) =>
			Effect.gen(function* () {
				const error = yield* SynchronizedRef.get(socketError);
				if (error !== undefined) return false;
				const entry = MutableHashMap.get(entries, coin);
				if (Option.isNone(entry)) return false;
				return now - entry.value.lastUpdate <= staleAfterMillis;
			});

		return {
			set,
			get,
			isFresh,
			markSocketError,
			clearSocketError,
			hasSocketError,
		};
	});
