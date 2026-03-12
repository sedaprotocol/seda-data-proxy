import {
	type ParsedFeedPayload,
	type ParsedPayload,
	PythLazerClient,
} from "@pythnetwork/pyth-lazer-sdk";
import {
	Clock,
	Data,
	Duration,
	Effect,
	Layer,
	MutableHashMap,
	Option,
	Queue,
	Runtime,
	Schedule,
} from "effect";
import type { Route } from "../../config/config-parser";
import type { PythLazerModuleConfig } from "../../config/pyth-lazer-module-config";
import { createErrorResponse } from "../../controllers/create-error-response";
import { replaceParams } from "../../utils/replace-params";
import { FailedToHandleRequest, ModuleService } from "../module";
import { FailedToHandlePythLazerRequestError } from "./errors";
import { getPriceIdBySymbol } from "./get-symbol-price-id";
import { createPriceCache } from "./price-cache";

export class FailedToCreateLazerClientError extends Data.TaggedError(
	"FailedToCreateLazerClientError",
)<{ error: string | unknown }> {
	message = `Failed to create Pyth Lazer client: ${this.error}`;
}

type PriceFeedId = number;
type PriceFeedSymbol = string;

interface PriceFeedWithSymbol extends ParsedFeedPayload {
	symbol?: string;
}

export const PythLazerModuleService = (config: PythLazerModuleConfig) =>
	Layer.effect(
		ModuleService,
		Effect.gen(function* () {
			yield* Effect.logInfo("Initializing Pyth Lazer module");
			const runtime = yield* Effect.runtime();
			const priceCache = yield* createPriceCache();
			// The timestamp of the last request to the price feed
			const lastRequestToPriceFeed = MutableHashMap.empty<
				PriceFeedId,
				number
			>();
			const newPriceFeedRequests = yield* Queue.unbounded<PriceFeedId>();
			// price feed id -> subscription id
			const subscriptions = MutableHashMap.empty<PriceFeedId, number>();
			const symbolsToId = MutableHashMap.empty<PriceFeedSymbol, PriceFeedId>();

			let subscriptionId = 0;

			const lazerClient = yield* Effect.tryPromise({
				try: () =>
					PythLazerClient.create({
						token: config.pythLazerApiKey,
						webSocketPoolConfig: {
							onWebSocketPoolError: (error) => {
								Runtime.runSync(
									runtime,
									Effect.logError("Error in Pyth Lazer client web socket pool"),
								);

								// For some reason the error is encoded to an empty object, the regular console.error does show the actual error
								console.error(error);
							},
							onWebSocketError: (error) => {
								Runtime.runSync(
									runtime,
									Effect.logError("Error in Pyth Lazer client web socket", {
										error,
									}),
								);

								console.error(error);
							},
						},
					}),
				catch: (error) => new FailedToCreateLazerClientError({ error }),
			});

			lazerClient.addAllConnectionsDownListener(() =>
				Runtime.runSync(
					runtime,
					Effect.logFatal("All connections are down for Pyth Lazer client"),
				),
			);

			lazerClient.addMessageListener((message) => {
				Runtime.runSync(
					runtime,
					Effect.gen(function* () {
						yield* Effect.logTrace(
							"Received message from Pyth Lazer client",
							message,
						);

						if (message.type === "json") {
							if (message.value.type === "streamUpdated") {
								if (!message.value.parsed) {
									return yield* Effect.logWarning("No parsed message found", {
										message,
									});
								}

								yield* handleStreamUpdatedMessage(message.value.parsed);
							}
						}
					}),
				);
			});

			const handleStreamUpdatedMessage = (message: ParsedPayload) =>
				Effect.gen(function* () {
					yield* Effect.logTrace(
						"Received message from Pyth Lazer client",
						message,
					);

					for (const priceFeed of message.priceFeeds) {
						// To make sure that we don't set the price for a price feed that we are not subscribed to
						// otherwise requests may get an outdated price
						if (!MutableHashMap.has(subscriptions, priceFeed.priceFeedId)) {
							continue;
						}

						yield* priceCache.setPrice(priceFeed.priceFeedId, priceFeed);
					}
				});

			const start = () =>
				Effect.gen(function* () {
					yield* Effect.logInfo("Starting Pyth Lazer module");

					for (const priceFeed of config.priceFeedIds) {
						yield* newPriceFeedRequests.offer(priceFeed.id);
					}

					yield* Effect.forkDaemon(
						Effect.gen(function* () {
							const newPriceFeedId = yield* newPriceFeedRequests.take;

							yield* Effect.logInfo(
								`Subscribing to price feed ${newPriceFeedId}`,
							);

							const newSubscriptionId = subscriptionId++;

							MutableHashMap.set(
								subscriptions,
								newPriceFeedId,
								newSubscriptionId,
							);

							lazerClient.subscribe({
								type: "subscribe",
								channel: config.channel,
								formats: ["solana"],
								properties: [
									"bestAskPrice",
									"bestBidPrice",
									"confidence",
									"emaConfidence",
									"emaPrice",
									"exponent",
									"feedUpdateTimestamp",
									"fundingRate",
									"fundingRateInterval",
									"fundingTimestamp",
									"marketSession",
									"price",
									"publisherCount",
								],
								subscriptionId: newSubscriptionId,
								priceFeedIds: [newPriceFeedId],
							});
						}).pipe(Effect.forever),
					);

					yield* Effect.forkDaemon(
						Effect.gen(function* () {
							const now = yield* Clock.currentTimeMillis;
							yield* Effect.logDebug(
								`Cleaning up price feeds (currently running ${priceCache.size()} price feeds)..`,
							);

							for (const [
								priceFeedId,
								lastRequestTimestamp,
							] of MutableHashMap.fromIterable(lastRequestToPriceFeed)) {
								const cleanupInterval = Duration.toMillis(
									config.priceFeedsCleanupTtl,
								);
								const timeSinceLastRequest = now - lastRequestTimestamp;

								yield* Effect.logDebug(
									`Time since last request for price feed ${priceFeedId}: ${Duration.format(Duration.decode(timeSinceLastRequest))}`,
								);

								if (timeSinceLastRequest > cleanupInterval) {
									yield* Effect.logInfo(
										`Cleaning up price feed ${priceFeedId}`,
									);
									MutableHashMap.remove(lastRequestToPriceFeed, priceFeedId);
									yield* priceCache.deletePrice(priceFeedId);

									const subscriptionId = MutableHashMap.get(
										subscriptions,
										priceFeedId,
									);

									if (Option.isSome(subscriptionId)) {
										lazerClient.unsubscribe(subscriptionId.value);
										MutableHashMap.remove(subscriptions, priceFeedId);
									}
								}
							}
						}).pipe(
							Effect.schedule(
								Schedule.spaced(config.priceFeedsCleanupInterval),
							),
						),
					);
				}).pipe(Effect.annotateLogs("_name", "pyth-lazer"));

			const handleRequest = (
				route: Route,
				params: Record<string, string>,
				request: Request,
			) =>
				Effect.gen(function* () {
					if (route.type !== "pyth-lazer") {
						return yield* Effect.fail(
							new FailedToHandleRequest({
								msg: "Route is not a Pyth Lazer module",
							}),
						);
					}

					const priceFeedIdsRaw = replaceParams(
						route.fetchFromModule,
						params,
					).split(",");

					if (priceFeedIdsRaw.length > config.maxFeedsPerRequest) {
						return yield* Effect.succeed(
							createErrorResponse(
								new FailedToHandlePythLazerRequestError({
									error: `Too many price feed IDs, max is ${config.maxFeedsPerRequest} but got ${priceFeedIdsRaw.length}`,
								}),
								400,
							),
						);
					}

					const priceFeedIds: number[] = [];

					// Normalize the ids or symbols to price feed ids
					for (const symbolOrId of priceFeedIdsRaw) {
						if (Number.isNaN(Number(symbolOrId))) {
							// Let's check if the symbol exists otherwise
							const cachedSymbolToPriceFeedId = MutableHashMap.get(
								symbolsToId,
								symbolOrId,
							);

							if (Option.isSome(cachedSymbolToPriceFeedId)) {
								priceFeedIds.push(cachedSymbolToPriceFeedId.value);
								continue;
							}

							const priceFeedId = yield* getPriceIdBySymbol(
								symbolOrId,
								lazerClient,
							);

							MutableHashMap.set(symbolsToId, symbolOrId, priceFeedId);
							priceFeedIds.push(priceFeedId);
						} else {
							priceFeedIds.push(Number(symbolOrId));
						}
					}

					const prices: PriceFeedWithSymbol[] = [];
					const now = yield* Clock.currentTimeMillis;

					for (const [index, priceFeedId] of priceFeedIds.entries()) {
						const lastRequestTimestamp = MutableHashMap.get(
							lastRequestToPriceFeed,
							priceFeedId,
						);
						if (Option.isNone(lastRequestTimestamp)) {
							yield* newPriceFeedRequests.offer(priceFeedId);
						}

						MutableHashMap.set(lastRequestToPriceFeed, priceFeedId, now);
						const price = yield* priceCache.getOrWaitPrice(priceFeedId);
						prices.push({
							symbol: priceFeedIdsRaw.at(index),
							...price,
						});
					}

					return yield* Effect.succeed(
						new Response(JSON.stringify(prices), { status: 200 }),
					);
				}).pipe(
					Effect.withSpan("handlePythLazerRequest"),
					Effect.catchAll((error) => {
						return Effect.succeed(createErrorResponse(error, error.status));
					}),
				);

			return {
				start,
				handleRequest,
			};
		}),
	);
