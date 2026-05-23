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
import { createFreshnessCache } from "../shared/freshness-cache";
import { createPriceCache } from "../shared/price-cache";
import { FailedToHandleHydromancerRequestError } from "./errors";
import { fetchAssetContextsFromRest } from "./rest-fallback";
import { type HydromancerChannel, createHydromancerWS } from "./ws-client";

export const HydromancerModuleService = (config: HydromancerModuleConfig) =>
	Layer.effect(
		ModuleService,
		Effect.gen(function* () {
			yield* Effect.logInfo("Initializing Hydromancer module", {
				name: config.name,
				wsUrl: config.wsUrl,
				restBaseUrl: config.restBaseUrl,
			});

			// Two caches with deliberately different shapes. assetContext is
			// freshness-keyed: a stale read falls back to a REST fetch. l2Book is
			// waiter-keyed: a request waits briefly for the first WS frame and
			// returns null on timeout, with no REST fallback.
			const cache = yield* createFreshnessCache<string, AssetCtx>();
			const bookCache = yield* createPriceCache<string, BookSnapshot>({
				timeout: config.l2BookWaitTimeout,
			});
			const ws = yield* createHydromancerWS(config, cache, bookCache);
			const assetCtxStaleAfterMillis = Duration.toMillis(config.staleAfter);

			const lastRequestToCoin = MutableHashMap.empty<string, number>();
			const lastRequestToBookCoin = MutableHashMap.empty<string, number>();

			// Each entry binds one WS channel to the bookkeeping its idle-cleanup
			// daemon needs: the last-request map it scans, the TTL/interval that
			// govern cadence, and the cache eviction that runs just before the
			// daemon unsubscribes the coin. The loop below forks one daemon per
			// entry.
			const subscriptionKinds = [
				{
					name: "assetContext",
					channel: "activeAssetCtx" as HydromancerChannel,
					lastRequest: lastRequestToCoin,
					ttl: config.coinsCleanupTtl,
					interval: config.coinsCleanupInterval,
					onEvict: (coin: string) => Effect.sync(() => cache.remove(coin)),
				},
				{
					name: "l2Book",
					channel: "l2Book" as HydromancerChannel,
					lastRequest: lastRequestToBookCoin,
					ttl: config.l2BookCleanupTtl,
					interval: config.l2BookCleanupInterval,
					onEvict: (coin: string) =>
						Effect.gen(function* () {
							// Fail an in-flight waiter before dropping the entry so a
							// concurrent request resolves now instead of hanging until
							// its own timeout fires.
							yield* bookCache.setPriceToError(coin, "unsubscribed");
							yield* bookCache.deletePrice(coin);
						}),
				},
			];

			// Seed the configured coins and fork the idle-cleanup daemons at
			// layer construction so they run exactly once, however often
			// start() is called. The daemons run for the process lifetime.
			for (const coin of config.subscriptionCoins) {
				yield* ws.subscribe("activeAssetCtx", coin);
			}
			for (const coin of config.l2BookSubscriptionCoins) {
				yield* ws.subscribe("l2Book", coin);
			}

			for (const kind of subscriptionKinds) {
				yield* forkIdleCleanup({
					lastRequest: kind.lastRequest,
					ttl: kind.ttl,
					interval: kind.interval,
					onExpire: (coin) =>
						Effect.gen(function* () {
							yield* Effect.logInfo(`Cleaning up idle ${kind.name} coin`, {
								coin,
							});
							yield* kind.onEvict(coin);
							yield* ws.unsubscribe(kind.channel, coin);
						}),
				});
			}

			// The WS daemon owns reconnect; ws.start() is cached, so start() is
			// idempotent and the daemon runs for the process lifetime.
			const start = () => Effect.asVoid(ws.start());

			// Shared prologue for both request flows: bound the batch, stamp the
			// last-request time, subscribe every coin, and pre-seed the response
			// so the shape matches Hydromancer's native /info (one key per coin).
			const prepareRequest = <V>(
				coins: string[],
				max: number,
				channel: HydromancerChannel,
				lastRequest: MutableHashMap.MutableHashMap<string, number>,
			) =>
				Effect.gen(function* () {
					if (coins.length > max) {
						return yield* Effect.fail(
							new FailedToHandleHydromancerRequestError({
								error: `Too many coins, max is ${max} but got ${coins.length}`,
								status: 400,
							}),
						);
					}
					const now = yield* Clock.currentTimeMillis;
					for (const coin of coins) {
						yield* ws.subscribe(channel, coin);
						MutableHashMap.set(lastRequest, coin, now);
					}
					const resolved: Record<string, V | null> = {};
					for (const coin of coins) resolved[coin] = null;
					return { now, resolved };
				});

			const handleAssetContextRequest = (coins: string[]) =>
				Effect.gen(function* () {
					const { now, resolved } = yield* prepareRequest<AssetCtx>(
						coins,
						config.maxCoinsPerRequest,
						"activeAssetCtx",
						lastRequestToCoin,
					);
					const socketHealthy = !(yield* ws.hasError());

					const toFetch: string[] = [];
					for (const coin of coins) {
						if (socketHealthy) {
							const fresh = cache.get(coin, assetCtxStaleAfterMillis, now);
							if (Option.isSome(fresh)) {
								resolved[coin] = fresh.value;
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
								cache.set(coin, ctx, now);
								resolved[coin] = ctx;
							}
						}
					}

					return new Response(JSON.stringify(resolved), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}).pipe(
					Effect.withSpan("handleAssetContextRequest", {
						attributes: { coins },
					}),
				);

			const handleL2BookRequest = (coins: string[]) =>
				Effect.gen(function* () {
					const { resolved } = yield* prepareRequest<BookSnapshot>(
						coins,
						config.l2BookMaxCoinsPerRequest,
						"l2Book",
						lastRequestToBookCoin,
					);

					for (const coin of coins) {
						resolved[coin] = yield* bookCache.tryGetOrWait(coin);
					}

					return new Response(JSON.stringify(resolved), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}).pipe(
					Effect.withSpan("handleL2BookRequest", { attributes: { coins } }),
				);

			const handleRequest = (
				route: Route,
				_params: Record<string, string>,
				_request: Request,
				body: string,
			) =>
				Effect.gen(function* () {
					if (route.type !== "hydromancer") {
						return yield* Effect.fail(
							new FailedToHandleRequest({
								msg: "Route is not a Hydromancer module",
							}),
						);
					}

					const parsed = parseHydromancerBody(body);
					if (Option.isNone(parsed)) {
						return yield* Effect.fail(
							new FailedToHandleHydromancerRequestError({
								error:
									"Hydromancer module only handles assetContext or l2Book bodies",
								status: 400,
							}),
						);
					}

					if (parsed.value.type === "l2Book") {
						return yield* handleL2BookRequest(parsed.value.coins);
					}
					return yield* handleAssetContextRequest(parsed.value.coins);
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
		}).pipe(Effect.annotateLogs("_name", "hydromancer")),
	);
