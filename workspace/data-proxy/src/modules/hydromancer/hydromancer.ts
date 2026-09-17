import {
	Clock,
	Duration,
	Effect,
	Layer,
	Match,
	MutableHashMap,
	Option,
} from "effect";
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
import {
	executeHydromancerRestRequest,
	fetchAssetContextsFromRest,
} from "./rest-fallback";
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

			// Two caches with deliberately different shapes.
			// assetContext is freshness-keyed: a stale read falls back to a REST fetch.
			// l2Book is waiter-keyed: a request waits briefly and returns null on timeout.
			const cache = yield* createFreshnessCache<string, AssetCtx>();
			const bookCache = yield* createPriceCache<string, BookSnapshot>({
				timeout: config.l2BookWaitTimeout,
			});
			const assetCtxStaleAfterMillis = Duration.toMillis(config.staleAfter);
			const ws = yield* createHydromancerWS(config, cache, bookCache);

			const lastRequestToCoin = MutableHashMap.empty<string, number>();
			const lastRequestToBookCoin = MutableHashMap.empty<string, number>();

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

			const start = () =>
				Effect.gen(function* () {
					yield* Effect.logInfo("Hydromancer module started", {
						name: config.name,
					});

					yield* ws.start();

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
				}).pipe(Effect.annotateLogs("_name", "hydromancer"), Effect.asVoid);

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

					// Pre-seed the response so the shape matches Hydromancer's native /info (one key per coin)
					const resolved: Record<string, V | null> = {};
					for (const coin of coins) resolved[coin] = null;
					return { now, resolved };
				});

			const handleAssetContextRequest = ({
				type,
				coins,
			}: { type: "single" | "batch"; coins: string[] }) =>
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
						).pipe(
							Effect.annotateSpans(
								"restFallbackReason",
								socketHealthy ? "stale-cache" : "socket-error",
							),
						);
						for (const coin of toFetch) {
							const ctx = restBatch[coin];
							if (ctx) {
								yield* cache.set(coin, ctx, now);
								resolved[coin] = ctx;
							}
						}
					}

					if (type === "single") {
						return new Response(JSON.stringify(resolved[coins[0]]), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						});
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
						resolved[coin] = yield* bookCache.getOrWaitPrice(coin);
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

					if (body === undefined) {
						return yield* Effect.fail(
							new FailedToHandleHydromancerRequestError({
								error: "Missing request body",
								status: 400,
							}),
						);
					}

					const parsedBody = parseHydromancerBody(body);
					if (Option.isNone(parsedBody)) {
						yield* Effect.logDebug(
							"Hydromancer module received unsupported body, forwarding to REST",
						);
						return yield* executeHydromancerRestRequest(config, body).pipe(
							Effect.annotateSpans("restFallbackReason", "unsupported-body"),
						);
					}

					// Normalize coins and expand comma-separated values
					// (e.g. "BTC,ETH" or ["BTC,ETH"] from multi-route path params).
					const expandCoins = (tokens: string | string[]) =>
						(typeof tokens === "string" ? [tokens] : tokens).flatMap((token) =>
							token
								.split(",")
								.map((coin) => coin.trim())
								.filter((coin) => coin.length > 0),
						);

					return yield* Match.value(parsedBody.value).pipe(
						Match.when({ type: "assetContext", coins: Match.any }, (body) =>
							handleAssetContextRequest({
								type: "batch",
								coins: expandCoins(body.coins),
							}),
						),
						Match.when({ type: "assetContext", coin: Match.any }, (body) =>
							handleAssetContextRequest({
								type: "single",
								coins: [body.coin],
							}),
						),
						Match.when({ type: "l2Book", coins: Match.any }, (body) =>
							handleL2BookRequest(expandCoins(body.coins)),
						),
						Match.exhaustive,
					);
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
