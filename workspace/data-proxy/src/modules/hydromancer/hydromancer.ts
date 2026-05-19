import { Clock, Duration, Effect, Layer, MutableHashMap, Option } from "effect";
import type { Route } from "../../config/config-parser";
import {
	type AssetCtx,
	type BookSnapshot,
	type HydromancerModuleConfig,
	parseHydromancerBody,
} from "../../config/hydromancer-module-config";
import { createErrorResponse } from "../../controllers/create-error-response";
import { forkIdleCleanup } from "../../utils/idle-cleanup";
import { FailedToHandleRequest, ModuleService } from "../module";
import { createPriceCache } from "../shared/price-cache";
import { createAssetCache } from "./asset-cache";
import { FailedToHandleHydromancerRequestError } from "./errors";
import { fetchAssetContextsFromRest } from "./rest-fallback";
import { createHydromancerWS } from "./ws-client";

export const HydromancerModuleService = (config: HydromancerModuleConfig) =>
	Layer.effect(
		ModuleService,
		Effect.gen(function* () {
			yield* Effect.logInfo("Initializing Hydromancer module", {
				name: config.name,
				wsUrl: config.wsUrl,
				restBaseUrl: config.restBaseUrl,
			});

			const cache = yield* createAssetCache();
			const bookCache = yield* createPriceCache<string, BookSnapshot>({
				timeout: config.l2BookWaitTimeout,
			});
			const ws = yield* createHydromancerWS(config, cache, bookCache);
			const assetCtxStaleAfterMillis = Duration.toMillis(config.assetCtxStaleAfter);
			const lastRequestToCoin = MutableHashMap.empty<string, number>();
			const lastRequestToBookCoin = MutableHashMap.empty<string, number>();

			const start = () =>
				Effect.gen(function* () {
					yield* Effect.logInfo("Hydromancer module started", {
						name: config.name,
					});

					yield* ws.start();

					for (const coin of config.assetCtxSubscriptionCoins) {
						yield* ws.subscribeAssetCtx(coin);
					}
					for (const coin of config.l2BookSubscriptionCoins) {
						yield* ws.subscribeBook(coin);
					}

					yield* forkIdleCleanup({
						lastRequest: lastRequestToCoin,
						ttl: config.assetCtxCleanupTtl,
						interval: config.assetCtxCleanupInterval,
						onExpire: (coin) =>
							Effect.gen(function* () {
								yield* Effect.logInfo("Cleaning up idle coin", { coin });
								yield* cache.remove(coin);
								yield* ws.unsubscribeAssetCtx(coin);
							}),
					});

					yield* forkIdleCleanup({
						lastRequest: lastRequestToBookCoin,
						ttl: config.l2BookCleanupTtl,
						interval: config.l2BookCleanupInterval,
						onExpire: (coin) =>
							Effect.gen(function* () {
								yield* Effect.logInfo("Cleaning up idle book coin", { coin });
								yield* bookCache.deletePrice(coin);
								yield* ws.unsubscribeBook(coin);
							}),
					});
				}).pipe(Effect.annotateLogs("_name", "hydromancer"));

			const handleAssetContextRequest = (coins: string[]) =>
				Effect.gen(function* () {
					if (coins.length > config.assetCtxMaxCoinsPerRequest) {
						return yield* Effect.fail(
							new FailedToHandleHydromancerRequestError({
								error: `Too many coins, max is ${config.assetCtxMaxCoinsPerRequest} but got ${coins.length}`,
								status: 400,
							}),
						);
					}

					const now = yield* Clock.currentTimeMillis;
					const socketHealthy = !(yield* ws.hasError());

					for (const coin of coins) {
						yield* ws.subscribeAssetCtx(coin);
						MutableHashMap.set(lastRequestToCoin, coin, now);
					}

					// Pre-seed every requested coin to null so the response shape matches
					// Hydromancer's native /info: a key per coin, unresolved ones stay null.
					const resolved: Record<string, AssetCtx | null> = {};
					for (const coin of coins) resolved[coin] = null;

					const toFetch: string[] = [];

					for (const coin of coins) {
						if (
							socketHealthy &&
							(yield* cache.isFresh(coin, assetCtxStaleAfterMillis, now))
						) {
							const entry = yield* cache.get(coin);
							if (Option.isSome(entry)) {
								resolved[coin] = entry.value.ctx;
								continue;
							}
						}
						toFetch.push(coin);
					}

					if (toFetch.length > 0) {
						const restBatch = yield* fetchAssetContextsFromRest(
							config,
							toFetch,
						);
						for (const coin of toFetch) {
							const ctx = restBatch[coin];
							if (ctx) {
								yield* cache.set(coin, ctx, now);
								resolved[coin] = ctx;
							}
						}
					}

					return new Response(JSON.stringify(resolved), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				});

			const handleL2BookRequest = (coins: string[]) =>
				Effect.gen(function* () {
					if (coins.length > config.l2BookMaxCoinsPerRequest) {
						return yield* Effect.fail(
							new FailedToHandleHydromancerRequestError({
								error: `Too many coins, max is ${config.l2BookMaxCoinsPerRequest} but got ${coins.length}`,
								status: 400,
							}),
						);
					}

					const now = yield* Clock.currentTimeMillis;

					for (const coin of coins) {
						yield* ws.subscribeBook(coin);
						MutableHashMap.set(lastRequestToBookCoin, coin, now);
					}

					const resolved: Record<string, BookSnapshot | null> = {};
					for (const coin of coins) resolved[coin] = null;

					for (const coin of coins) {
						resolved[coin] = yield* bookCache.getOrWaitPrice(coin).pipe(
							Effect.catchTag("FailedToGetPriceError", () =>
								Effect.succeed(null),
							),
						);
					}

					return new Response(JSON.stringify(resolved), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				});

			const handleRequest = (
				route: Route,
				_params: Record<string, string>,
				_request: Request,
				body?: string,
			) =>
				Effect.gen(function* () {
					if (route.type !== "hydromancer") {
						return yield* Effect.fail(
							new FailedToHandleRequest({
								msg: "Route is not a Hydromancer module",
							}),
						);
					}

					const parsed = parseHydromancerBody(body ?? "");
					if (Option.isNone(parsed)) {
						return yield* Effect.fail(
							new FailedToHandleHydromancerRequestError({
								error:
									"Hydromancer module only handles assetContext or l2Book bodies",
								status: 400,
							}),
						);
					}

					if (parsed.value.kind === "l2Book") {
						return yield* handleL2BookRequest(parsed.value.body.coins);
					}
					return yield* handleAssetContextRequest(parsed.value.body.coins);
				}).pipe(
					Effect.withSpan("handleHydromancerRequest"),
					Effect.catchAll((error) =>
						Effect.succeed(createErrorResponse(error, error.status)),
					),
				);

			return {
				start,
				handleRequest,
			};
		}),
	);
