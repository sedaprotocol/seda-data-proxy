import { Clock, Duration, Effect, Layer, MutableHashMap, Option } from "effect";
import type { Route } from "../../config/config-parser";
import type {
	AssetCtx,
	HydromancerModuleConfig,
} from "../../config/hydromancer-module-config";
import { createErrorResponse } from "../../controllers/create-error-response";
import { forkIdleCleanup } from "../../utils/idle-cleanup";
import { replaceParams } from "../../utils/replace-params";
import { FailedToHandleRequest, ModuleService } from "../module";
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
			const ws = yield* createHydromancerWS(config, cache);
			const staleAfterMillis = Duration.toMillis(config.staleAfter);
			const lastRequestToCoin = MutableHashMap.empty<string, number>();

			const start = () =>
				Effect.gen(function* () {
					yield* Effect.logInfo("Hydromancer module started", {
						name: config.name,
					});

					yield* ws.start();

					for (const coin of config.subscriptionCoins) {
						yield* ws.subscribe(coin);
					}

					yield* forkIdleCleanup({
						lastRequest: lastRequestToCoin,
						ttl: config.coinsCleanupTtl,
						interval: config.coinsCleanupInterval,
						onExpire: (coin) =>
							Effect.gen(function* () {
								yield* Effect.logInfo("Cleaning up idle coin", { coin });
								yield* cache.remove(coin);
								yield* ws.unsubscribe(coin);
							}),
					});
				}).pipe(Effect.annotateLogs("_name", "hydromancer"));

			const handleRequest = (
				route: Route,
				params: Record<string, string>,
				_request: Request,
			) =>
				Effect.gen(function* () {
					if (route.type !== "hydromancer") {
						return yield* Effect.fail(
							new FailedToHandleRequest({
								msg: "Route is not a Hydromancer module",
							}),
						);
					}

					const coins = replaceParams(route.fetchFromModule, params).split(",");

					if (coins.length > config.maxCoinsPerRequest) {
						return yield* Effect.fail(
							new FailedToHandleHydromancerRequestError({
								error: `Too many coins, max is ${config.maxCoinsPerRequest} but got ${coins.length}`,
								status: 400,
							}),
						);
					}

					const now = yield* Clock.currentTimeMillis;
					const socketHealthy = !(yield* ws.hasError());

					for (const coin of coins) {
						yield* ws.subscribe(coin);
						MutableHashMap.set(lastRequestToCoin, coin, now);
					}

					const resolved: Record<string, AssetCtx> = {};
					const toFetch: string[] = [];

					for (const coin of coins) {
						if (
							socketHealthy &&
							(yield* cache.isFresh(coin, staleAfterMillis, now))
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
