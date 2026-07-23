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
	type HydromancerModuleConfig,
	parseAssetContextRequestBody,
} from "../../config/hydromancer-module-config";
import { createErrorResponse } from "../../controllers/create-error-response";
import { forkIdleCleanup } from "../../utils/idle-cleanup";
import { FailedToHandleRequest, ModuleService } from "../module";
import { createAssetCache } from "./asset-cache";
import { FailedToHandleHydromancerRequestError } from "./errors";
import {
	executeHydromancerRestRequest,
	fetchAssetContextsFromRest,
} from "./rest-fallback";
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

					const parsedBody = parseAssetContextRequestBody(body ?? "");
					if (Option.isNone(parsedBody)) {
						yield* Effect.logDebug(
							"Hydromancer module received unsupported body, forwarding to REST",
						);
						return yield* executeHydromancerRestRequest(config, body);
					}

					// Normalize coins (string or string[]) and expand comma-separated
					// values (e.g. "BTC,ETH" or ["BTC,ETH"] from multi-route path params).
					const expandCoins = (tokens: string | string[]) =>
						(typeof tokens === "string" ? [tokens] : tokens).flatMap((token) =>
							token
								.split(",")
								.map((coin) => coin.trim())
								.filter((coin) => coin.length > 0),
						);

					const assetRequest = Match.value(parsedBody.value).pipe(
						Match.when(
							{ type: "assetContext", coins: Match.any },
							(body) =>
								({
									type: "batch",
									coins: expandCoins(body.coins),
								}) as const,
						),
						Match.when(
							{ type: "assetContext", coin: Match.any },
							(body) =>
								({
									type: "single",
									coins: [body.coin],
								}) as const,
						),
						Match.exhaustive,
					);

					if (assetRequest.coins.length > config.maxCoinsPerRequest) {
						return yield* Effect.fail(
							new FailedToHandleHydromancerRequestError({
								error: `Too many coins, max is ${config.maxCoinsPerRequest} but got ${assetRequest.coins.length}`,
								status: 400,
							}),
						);
					}

					const now = yield* Clock.currentTimeMillis;
					const socketHealthy = !(yield* ws.hasError());

					for (const coin of assetRequest.coins) {
						yield* ws.subscribe(coin);
						MutableHashMap.set(lastRequestToCoin, coin, now);
					}

					// Pre-seed every requested coin to null so the response shape matches
					// Hydromancer's native /info: a key per coin, unresolved ones stay null.
					const resolved: Record<string, AssetCtx | null> = {};
					for (const coin of assetRequest.coins) resolved[coin] = null;

					const toFetch: string[] = [];

					for (const coin of assetRequest.coins) {
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

					if (assetRequest.type === "single") {
						return new Response(
							JSON.stringify(resolved[assetRequest.coins[0]]),
							{
								status: 200,
								headers: { "Content-Type": "application/json" },
							},
						);
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
