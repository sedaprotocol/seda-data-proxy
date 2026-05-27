import {
	Clock,
	Duration,
	Effect,
	Either,
	Layer,
	Match,
	MutableHashMap,
	Option,
	Queue,
	Schedule,
} from "effect";
import type { Route } from "../../config/config-parser";
import {
	LO_TECH_DATA_TYPE_PRICE,
	type LoTechModuleConfig,
} from "../../config/lo-tech-module-config";
import { HAS_PRICE_KEY } from "../../constants";
import { createErrorResponse } from "../../controllers/create-error-response";
import { replaceParams } from "../../utils/replace-params";
import { FailedToHandleRequest, ModuleService } from "../module";
import { createPriceCache } from "../shared/price-cache";
import { FailedToHandleLoTechRequestError } from "./errors";
import type {
	LoTechAck,
	LoTechDataPrice,
	LoTechParsedData,
	LoTechResponse,
} from "./schema";
import { makeLoTechWebSocketService } from "./ws-client";

export type PriceFeedSymbol = string;

export const LoTechModuleService = (config: LoTechModuleConfig) =>
	Layer.effect(
		ModuleService,
		Effect.gen(function* () {
			yield* Effect.logInfo("Initializing LO:TECH module");

			const runtime = yield* Effect.runtime();

			// Monotonically increasing counter for price feed IDs.
			let latestPriceFeedId = 0;
			// Map from price feed IDs to symbols. (Used to process acks)
			const priceFeedIds = MutableHashMap.empty<number, PriceFeedSymbol>();
			// Map from subscribed symbols to price feed IDs.
			const priceFeeds = MutableHashMap.empty<PriceFeedSymbol, number>();
			// Queue of new symbols to subscribe to.
			const newPriceFeedQueue = yield* Queue.unbounded<PriceFeedSymbol>();
			// Timestamp of the last request to the price feed. (Used for cleanup)
			const lastRequestToPriceFeed = MutableHashMap.empty<
				PriceFeedSymbol,
				number
			>();
			const priceCache = yield* createPriceCache<
				PriceFeedSymbol,
				LoTechDataPrice
			>();

			const updatePrice = (data: LoTechDataPrice) =>
				Effect.gen(function* () {
					yield* Effect.logDebug("Received message from LO:TECH client", data);

					// Set the price if the symbol is subscribed to.
					const { symbol } = data;
					if (!MutableHashMap.has(priceFeeds, symbol)) {
						return;
					}
					yield* priceCache.setPrice(symbol, data);
				});

			const handleDataMessage = (data: LoTechParsedData) =>
				Match.value(data).pipe(
					Match.discriminatorsExhaustive("type")({
						[LO_TECH_DATA_TYPE_PRICE]: (priceData) => updatePrice(priceData),
					}),
				);

			const handleAckMessage = (msg: LoTechAck) =>
				Effect.gen(function* () {
					yield* Effect.logDebug("handling ack", { msg });

					const symbol = MutableHashMap.get(priceFeedIds, msg.ack.id);
					if (Option.isNone(symbol)) {
						yield* Effect.logWarning("Received ack for unknown price feed ID", {
							msg,
						});
						return;
					}

					MutableHashMap.set(priceFeeds, symbol.value, msg.ack.id);

					const now = yield* Clock.currentTimeMillis;
					MutableHashMap.set(lastRequestToPriceFeed, symbol.value, now);
				});

			const loTechWs = yield* makeLoTechWebSocketService({
				config,
				runtime,
				onConnected: (api) =>
					Effect.gen(function* () {
						for (const priceFeed of config.priceFeeds) {
							yield* Effect.logInfo(
								`Subscribing to price feed ${priceFeed.symbol}`,
							);

							const newSubscriptionId = latestPriceFeedId++;
							MutableHashMap.set(
								priceFeedIds,
								newSubscriptionId,
								priceFeed.symbol,
							);

							yield* api.subscribePrice(priceFeed.symbol, newSubscriptionId);
						}
					}),
				handleDataMessage,
				handleAckMessage,
			});

			const start = () =>
				Effect.gen(function* () {
					yield* Effect.logInfo("Starting LO:TECH module");

					// Background fiber for handling new price feed subscriptions
					yield* Effect.forkDaemon(
						Effect.gen(function* () {
							const newSymbol = yield* newPriceFeedQueue.take;

							yield* Effect.logInfo(`Subscribing to price feed ${newSymbol}`);

							const newSubscriptionId = latestPriceFeedId++;
							MutableHashMap.set(priceFeedIds, newSubscriptionId, newSymbol);

							yield* loTechWs.subscribePrice(newSymbol, newSubscriptionId);
						}).pipe(Effect.forever),
					);

					// Background fiber for cleaning up price feeds subscriptions
					yield* Effect.forkDaemon(
						Effect.gen(function* () {
							const now = yield* Clock.currentTimeMillis;
							yield* Effect.logDebug(
								`Cleaning up price feeds (currently running ${priceCache.size()} price feeds)..`,
							);

							for (const [
								symbol,
								lastRequestTimestamp,
							] of lastRequestToPriceFeed) {
								const cleanupInterval = Duration.toMillis(
									config.priceFeedsCleanupTtl,
								);
								const timeSinceLastRequest = now - lastRequestTimestamp;

								yield* Effect.logDebug(
									`Time since last request for price feed ${symbol}: ${Duration.format(Duration.decode(timeSinceLastRequest))}`,
								);

								if (timeSinceLastRequest > cleanupInterval) {
									yield* Effect.logInfo(`Cleaning up price feed ${symbol}`);
									MutableHashMap.remove(lastRequestToPriceFeed, symbol);
									yield* priceCache.deletePrice(symbol);

									const priceFeedId = MutableHashMap.get(priceFeeds, symbol);

									if (Option.isSome(priceFeedId)) {
										yield* loTechWs.unsubscribePrice(symbol);
										MutableHashMap.remove(priceFeeds, symbol);
										MutableHashMap.remove(priceFeedIds, priceFeedId.value);
									} else {
										yield* Effect.logError(
											"Failed to find price feed ID for symbol",
											{
												symbol,
											},
										);
									}
								}
							}
						}).pipe(
							Effect.schedule(
								Schedule.spaced(config.priceFeedsCleanupInterval),
							),
						),
					);
				}).pipe(Effect.annotateLogs("_name", "lo-tech"));

			const handleRequest = (
				route: Route,
				params: Record<string, string>,
				request: Request,
			) =>
				Effect.gen(function* () {
					if (route.type !== "lo-tech") {
						return yield* Effect.fail(
							new FailedToHandleRequest({
								msg: "Route is not a LO:TECH module",
							}),
						);
					}

					yield* Effect.logDebug("Handling LO:TECH request", { route, params });

					const symbols = replaceParams(route.fetchFromModule, params).split(
						",",
					);

					if (symbols.length > config.maxFeedsPerRequest) {
						return yield* Effect.succeed(
							createErrorResponse(
								new FailedToHandleLoTechRequestError({
									error: `Too many symbols requested, max is ${config.maxFeedsPerRequest} but got ${symbols.length}`,
								}),
								400,
							),
						);
					}

					const responses: LoTechResponse[] = [];
					const now = yield* Clock.currentTimeMillis;

					// Subscribe to the symbols that we have not subscribed to yet.
					for (const symbol of symbols) {
						if (!MutableHashMap.has(priceFeeds, symbol)) {
							yield* newPriceFeedQueue.offer(symbol);
						}

						if (MutableHashMap.has(lastRequestToPriceFeed, symbol)) {
							MutableHashMap.set(lastRequestToPriceFeed, symbol, now);
						}
					}

					const prices = yield* Effect.forEach(
						symbols,
						(symbol) => Effect.either(priceCache.getOrWaitPrice(symbol)),
						{ concurrency: "unbounded" },
					);

					for (let i = 0; i < symbols.length; i++) {
						const symbol = symbols[i];
						const price = prices[i];

						if (Either.isLeft(price)) {
							responses.push({
								symbol,
								[HAS_PRICE_KEY]: false,
							});
						} else {
							responses.push({
								...price.right,
								[HAS_PRICE_KEY]: true,
							});
						}
					}

					return yield* Effect.succeed(
						new Response(JSON.stringify(responses), { status: 200 }),
					);
				}).pipe(
					Effect.withSpan("handleLoTechRequest"),
					Effect.catchAll((error) => {
						return Effect.succeed(createErrorResponse(error, 500));
					}),
				);

			return {
				start,
				handleRequest,
			};
		}),
	);
