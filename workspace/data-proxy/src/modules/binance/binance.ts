import { Clock, Effect, Either, Layer, MutableHashMap } from "effect";
import type { BinanceModuleConfig } from "../../config/binance-module-config";
import type { Route } from "../../config/config-parser";
import { HAS_PRICE_KEY } from "../../constants";
import { createErrorResponse } from "../../controllers/create-error-response";
import { forkIdleCleanup } from "../../utils/idle-cleanup";
import { replaceParams } from "../../utils/replace-params";
import { FailedToHandleRequest, ModuleService } from "../module";
import { createPriceCache } from "../shared/price-cache";
import { FailedToHandleBinanceRequestError } from "./errors";
import { type BinancePriceFrame, createBinanceWS } from "./ws-client";

type BinancePriceEntry =
	| ({ symbol: string } & BinancePriceFrame & { [HAS_PRICE_KEY]: true })
	| { symbol: string; [HAS_PRICE_KEY]: false };

export const BinanceModuleService = (config: BinanceModuleConfig) =>
	Layer.effect(
		ModuleService,
		Effect.gen(function* () {
			yield* Effect.logInfo("Initializing Binance module", {
				name: config.name,
				wsUrl: config.wsUrl,
				streamType: config.streamType,
			});

			const cache = yield* createPriceCache<string, BinancePriceFrame>();
			const ws = yield* createBinanceWS(config, cache);
			// Symbol -> timestamp of the last request, drives the idle cleanup pass.
			const lastRequestToSymbol = MutableHashMap.empty<string, number>();

			const start = () =>
				Effect.gen(function* () {
					yield* Effect.logInfo("Starting Binance module", {
						name: config.name,
					});

					yield* ws.start();

					if (config.subscriptionSymbols.length > 0) {
						const now = yield* Clock.currentTimeMillis;
						const seeded = config.subscriptionSymbols.map((symbol) =>
							symbol.toUpperCase(),
						);
						for (const symbol of seeded) {
							MutableHashMap.set(lastRequestToSymbol, symbol, now);
						}
						yield* ws.subscribe(seeded);
					}

					yield* forkIdleCleanup({
						lastRequest: lastRequestToSymbol,
						ttl: config.symbolsCleanupTtl,
						interval: config.symbolsCleanupInterval,
						onExpire: (symbol) =>
							Effect.gen(function* () {
								yield* Effect.logInfo("Cleaning up idle symbol", { symbol });
								yield* cache.deletePrice(symbol);
								yield* ws.unsubscribe([symbol]);
							}),
					});
				}).pipe(Effect.annotateLogs("_name", "binance"));

			const handleRequest = (
				route: Route,
				params: Record<string, string>,
				_request: Request,
			) =>
				Effect.gen(function* () {
					if (route.type !== "binance") {
						return yield* Effect.fail(
							new FailedToHandleRequest({
								msg: "Route is not a Binance module",
							}),
						);
					}

					const requestedSymbols = replaceParams(route.fetchFromModule, params)
						.split(",")
						.map((symbol) => symbol.trim())
						.filter((symbol) => symbol.length > 0);

					if (requestedSymbols.length > config.maxSymbolsPerRequest) {
						return yield* Effect.fail(
							new FailedToHandleBinanceRequestError({
								error: `Too many symbols, max is ${config.maxSymbolsPerRequest} but got ${requestedSymbols.length}`,
								status: 400,
							}),
						);
					}

					const now = yield* Clock.currentTimeMillis;
					const newSymbols: string[] = [];
					for (const requested of requestedSymbols) {
						const symbol = requested.toUpperCase();
						if (!MutableHashMap.has(lastRequestToSymbol, symbol)) {
							newSymbols.push(symbol);
						}
						MutableHashMap.set(lastRequestToSymbol, symbol, now);
					}

					if (newSymbols.length > 0) {
						yield* ws.subscribe(newSymbols);
					}

					// Subscriptions are in-flight; resolve every requested symbol concurrently.
					const results = yield* Effect.forEach(
						requestedSymbols,
						(requested) =>
							Effect.either(cache.getOrWaitPrice(requested.toUpperCase())),
						{ concurrency: "unbounded" },
					);

					const prices: BinancePriceEntry[] = [];
					for (let i = 0; i < requestedSymbols.length; i++) {
						const requested = requestedSymbols[i];
						const result = results[i];

						if (Either.isLeft(result)) {
							prices.push({ symbol: requested, [HAS_PRICE_KEY]: false });
						} else {
							prices.push({
								symbol: requested,
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
					Effect.withSpan("handleBinanceRequest"),
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
