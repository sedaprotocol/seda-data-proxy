import { Clock, Effect, Either, Layer, MutableHashMap } from "effect";
import type { Route } from "../../config/config-parser";
import type { LighterModuleConfig } from "../../config/lighter-module-config";
import { HAS_PRICE_KEY } from "../../constants";
import { createErrorResponse } from "../../controllers/create-error-response";
import { forkIdleCleanup } from "../../utils/idle-cleanup";
import { replaceParams } from "../../utils/replace-params";
import { FailedToHandleRequest, ModuleService } from "../module";
import { FailedToGetPriceError, createPriceCache } from "../shared/price-cache";
import { FailedToHandleLighterRequestError } from "./errors";
import { type LighterPriceFrame, createLighterWS } from "./ws-client";

type LighterPriceEntry =
	| ({ marketId: string } & LighterPriceFrame & { [HAS_PRICE_KEY]: true })
	| { marketId: string; [HAS_PRICE_KEY]: false };

// Request tokens are Lighter numeric market ids (e.g. "1" for BTC). A token that
// is not a non-negative integer can never name a market, so it resolves to a miss.
const parseMarketId = (token: string): number | null => {
	const id = Number(token);
	return Number.isInteger(id) && id >= 0 ? id : null;
};

export const LighterModuleService = (config: LighterModuleConfig) =>
	Layer.effect(
		ModuleService,
		Effect.gen(function* () {
			yield* Effect.logInfo("Initializing Lighter module", {
				name: config.name,
				wsUrl: config.wsUrl,
			});

			const cache = yield* createPriceCache<number, LighterPriceFrame>();
			const ws = yield* createLighterWS(config, cache);
			// Market id -> timestamp of the last request, drives the idle cleanup pass.
			const lastRequestToMarketId = MutableHashMap.empty<number, number>();

			const start = () =>
				Effect.gen(function* () {
					yield* Effect.logInfo("Starting Lighter module", {
						name: config.name,
					});

					yield* ws.start();

					if (config.subscriptionMarketIds.length > 0) {
						const now = yield* Clock.currentTimeMillis;
						for (const marketId of config.subscriptionMarketIds) {
							MutableHashMap.set(lastRequestToMarketId, marketId, now);
						}
						yield* ws.subscribe(config.subscriptionMarketIds);
					}

					yield* forkIdleCleanup({
						lastRequest: lastRequestToMarketId,
						ttl: config.marketsCleanupTtl,
						interval: config.marketsCleanupInterval,
						onExpire: (marketId) =>
							Effect.gen(function* () {
								yield* Effect.logInfo("Cleaning up idle market", { marketId });
								yield* cache.deletePrice(marketId);
								yield* ws.unsubscribe([marketId]);
							}),
					});
				}).pipe(Effect.annotateLogs("_name", "lighter"));

			const handleRequest = (
				route: Route,
				params: Record<string, string>,
				_request: Request,
			) =>
				Effect.gen(function* () {
					if (route.type !== "lighter") {
						return yield* Effect.fail(
							new FailedToHandleRequest({
								msg: "Route is not a Lighter module",
							}),
						);
					}

					const requestedTokens = replaceParams(route.fetchFromModule, params)
						.split(",")
						.map((token) => token.trim())
						.filter((token) => token.length > 0);

					if (requestedTokens.length > config.maxMarketsPerRequest) {
						return yield* Effect.fail(
							new FailedToHandleLighterRequestError({
								error: `Too many markets, max is ${config.maxMarketsPerRequest} but got ${requestedTokens.length}`,
								status: 400,
							}),
						);
					}

					const requested = requestedTokens.map((token) => ({
						token,
						marketId: parseMarketId(token),
					}));

					const now = yield* Clock.currentTimeMillis;
					const socketHealthy = !(yield* ws.hasError());
					const newMarketIds: number[] = [];
					for (const { marketId } of requested) {
						if (marketId === null) continue;
						if (!MutableHashMap.has(lastRequestToMarketId, marketId)) {
							newMarketIds.push(marketId);
						}
						MutableHashMap.set(lastRequestToMarketId, marketId, now);
					}

					if (newMarketIds.length > 0) {
						yield* ws.subscribe(newMarketIds);
					}

					// Subscriptions are in-flight; resolve every requested market concurrently.
					// A token that is not a market id can never land in the cache, so it
					// short-circuits to a miss instead of blocking on the wait.
					const results = yield* Effect.forEach(
						requested,
						({ token, marketId }) => {
							if (marketId === null) {
								return Effect.succeed(
									Either.left(
										new FailedToGetPriceError({
											error: `Invalid market id ${token}`,
										}),
									),
								);
							}
							return Effect.either(cache.getOrWaitPrice(marketId));
						},
						{ concurrency: "unbounded" },
					);

					const prices: LighterPriceEntry[] = [];
					for (let i = 0; i < requested.length; i++) {
						const { token } = requested[i];
						const result = results[i];

						if (Either.isLeft(result) || !socketHealthy) {
							prices.push({ marketId: token, [HAS_PRICE_KEY]: false });
						} else {
							prices.push({
								marketId: token,
								...result.right,
								[HAS_PRICE_KEY]: true,
							});
						}
					}

					return new Response(JSON.stringify(prices), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}).pipe(
					Effect.withSpan("handleLighterRequest"),
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
