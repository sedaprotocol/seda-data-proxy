import {
	Clock,
	Duration,
	Effect,
	Layer,
	MutableHashMap,
	Option,
	Queue,
} from "effect";
import type { Route } from "../../config/config-parser";
import type {
	AssetCtx,
	HydromancerModuleConfig,
} from "../../config/hydromancer-module-config";
import { createErrorResponse } from "../../controllers/create-error-response";
import { replaceParams } from "../../utils/replace-params";
import { FailedToHandleRequest, ModuleService } from "../module";
import { createAssetCache } from "./asset-cache";
import { FailedToHandleHydromancerRequestError } from "./errors";
import {
	type BatchAssetContexts,
	fetchAssetContextsFromRest,
} from "./rest-fallback";
import { buildSubscribeFrame, startWebSocketDaemon } from "./ws-client";

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
			const staleAfterMillis = Duration.toMillis(config.staleAfter);
			const newCoinQueue = yield* Queue.unbounded<string>();
			const lastRequestToCoin = MutableHashMap.empty<string, number>();
			const desiredCoins = MutableHashMap.empty<string, true>();
			const currentWS: { value: WebSocket | null } = { value: null };

			const start = () =>
				Effect.gen(function* () {
					yield* Effect.logInfo("Hydromancer module started", {
						name: config.name,
					});

					for (const coin of config.subscriptionCoins) {
						yield* Queue.offer(newCoinQueue, coin);
					}

					yield* startWebSocketDaemon(config, cache, desiredCoins, currentWS);

					yield* Effect.forkDaemon(
						Effect.gen(function* () {
							const coin = yield* Queue.take(newCoinQueue);
							MutableHashMap.set(desiredCoins, coin, true);
							const ws = currentWS.value;
							if (ws !== null && ws.readyState === WebSocket.OPEN) {
								ws.send(buildSubscribeFrame(coin));
							}
						}).pipe(Effect.forever),
					);
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

					for (const coin of coins) {
						if (Option.isNone(MutableHashMap.get(lastRequestToCoin, coin))) {
							yield* Queue.offer(newCoinQueue, coin);
						}
						MutableHashMap.set(lastRequestToCoin, coin, now);
					}

					const cached = new Map<string, AssetCtx>();
					const toFetch: string[] = [];

					for (const coin of coins) {
						if (yield* cache.isFresh(coin, staleAfterMillis, now)) {
							const entry = yield* cache.get(coin);
							if (Option.isSome(entry)) {
								cached.set(coin, entry.value.ctx);
								continue;
							}
						}
						toFetch.push(coin);
					}

					let restBatch: BatchAssetContexts = {};
					if (toFetch.length > 0) {
						restBatch = yield* fetchAssetContextsFromRest(config, toFetch);
						for (const coin of toFetch) {
							const ctx = restBatch[coin];
							if (ctx) {
								yield* cache.set(coin, ctx, now);
							}
						}
					}

					const resolved: Array<{ coin: string } & AssetCtx> = [];
					for (const coin of coins) {
						const ctx = cached.get(coin) ?? restBatch[coin];
						if (ctx) {
							resolved.push({ coin, ...ctx });
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
