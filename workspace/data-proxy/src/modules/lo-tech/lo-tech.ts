import {
	Clock,
	Duration,
	Effect,
	Layer,
	Match,
	MutableHashMap,
	Option,
	Queue,
	Schedule,
} from "effect";
import type WebSocket from "ws";
import type { Route } from "../../config/config-parser";
import type { LoTechModuleConfig } from "../../config/lo-tech-module-config";
import { createErrorResponse } from "../../controllers/create-error-response";
import { replaceParams } from "../../utils/replace-params";
import { FailedToHandleRequest, ModuleService } from "../module";
import { FailedToHandleLoTechRequestError } from "./errors";
import { createPriceCache } from "./price-cache";
import type { LoTechData, LoTechDataPrice } from "./schema";
import { makeLoTechWebSocketService } from "./ws-client";

export type PriceFeedSymbol = string;

export const LoTechModuleService = (config: LoTechModuleConfig) =>
	Layer.effect(
		ModuleService,
		Effect.gen(function* () {
			yield* Effect.logInfo("Initializing LO:TECH module");

			const runtime = yield* Effect.runtime();
			const priceCache = yield* createPriceCache();
			const priceFeeds = MutableHashMap.empty<PriceFeedSymbol, number>();
			const newPriceFeedRequests = yield* Queue.unbounded<PriceFeedSymbol>();
			// The timestamp of the last request to the price feed used for cleanup.
			const lastRequestToPriceFeed = MutableHashMap.empty<
				PriceFeedSymbol,
				number
			>();

			let priceFeedId = 0;

			const updatePrice = (data: LoTechDataPrice) =>
				Effect.gen(function* () {
					yield* Effect.logTrace("Received message from LO:TECH client", data);

					// Set the price if the symbol is subscribed to.
					const { symbol } = data;
					if (!MutableHashMap.has(priceFeeds, symbol)) {
						return;
					}
					yield* priceCache.setPrice(symbol, data);
				});

			const handleDataMessage = (data: LoTechData) =>
				Effect.gen(function* () {
					yield* Match.value(data).pipe(
						Match.when({ type: "PRICE" }, (priceData: LoTechDataPrice) => {
							return updatePrice(priceData);
						}),
						Match.orElse(() =>
							Effect.logError("Unexpected LO:TECH data message type", data),
						),
					);
				});

			const onOpen = (socket: WebSocket): void => {
				for (const [symbol, priceFeedId] of priceFeeds) {
					socket.send(
						JSON.stringify({
							op: "SUBSCRIBE",
							topics: [{ symbol, type: "PRICE" }],
							id: priceFeedId,
						}),
					);
				}
			};

			const loTechWs = yield* makeLoTechWebSocketService({
				config,
				runtime,
				onOpen,
				handleDataMessage,
			});

			const start = () =>
				Effect.gen(function* () {
					yield* Effect.logInfo("Starting LO:TECH module");

					for (const priceFeed of config.priceFeeds) {
						yield* newPriceFeedRequests.offer(priceFeed.symbol);
					}

					yield* Effect.forkDaemon(
						Effect.gen(function* () {
							const newSymbol = yield* newPriceFeedRequests.take;

							yield* Effect.logInfo(`Subscribing to price feed ${newSymbol}`);

							const newSubscriptionId = priceFeedId++;

							MutableHashMap.set(priceFeeds, newSymbol, newSubscriptionId);

							const now = yield* Clock.currentTimeMillis;
							MutableHashMap.set(lastRequestToPriceFeed, newSymbol, now);

							yield* loTechWs.sendIfOpen(
								JSON.stringify({
									op: "SUBSCRIBE",
									topics: [{ symbol: newSymbol, type: "PRICE" }],
									// id: newSubscriptionId, // TODO Handle ack
								}),
							);
						}).pipe(Effect.forever),
					);

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
										yield* loTechWs.sendIfOpen(
											JSON.stringify({
												op: "UNSUBSCRIBE",
												topics: [{ symbol, type: "PRICE" }],
												// id: priceFeedId.value, // TODO Handle ack
											}),
										);
										MutableHashMap.remove(priceFeeds, symbol);
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

					yield* Effect.logInfo("Handling LO:TECH request", { route, params });

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

					const prices: LoTechDataPrice[] = [];
					const now = yield* Clock.currentTimeMillis;

					for (const symbol of symbols) {
						// Set the last request timestamp.
						const lastRequestTimestamp = MutableHashMap.get(
							lastRequestToPriceFeed,
							symbol,
						);
						if (Option.isNone(lastRequestTimestamp)) {
							yield* newPriceFeedRequests.offer(symbol);
						}
						MutableHashMap.set(lastRequestToPriceFeed, symbol, now);

						// Get the price from the cache.
						const price = yield* priceCache.getOrWaitPrice(symbol).pipe(
							Effect.catchTag("FailedToGetPriceError", (error) =>
								Effect.gen(function* () {
									yield* priceCache.deletePrice(symbol);
									return yield* Effect.fail(error);
								}),
							),
						);
						prices.push(price);
					}

					return yield* Effect.succeed(
						new Response(JSON.stringify(prices), { status: 200 }),
					);
				}).pipe(
					Effect.withSpan("handleLoTechRequest"),
					Effect.catchAll((error) => {
						// TODO: Handle error properly
						return Effect.succeed(createErrorResponse(error, 500));
					}),
				);

			return {
				start,
				handleRequest,
			};
		}),
	);
