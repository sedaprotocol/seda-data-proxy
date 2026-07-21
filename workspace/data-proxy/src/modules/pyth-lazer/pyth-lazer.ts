import {
	type Channel,
	type ParsedFeedPayload,
	type ParsedPayload,
	PythLazerClient,
} from "@pythnetwork/pyth-lazer-sdk";
import {
	Clock,
	Data,
	Effect,
	Either,
	Layer,
	Metric,
	MetricBoundaries,
	MutableHashMap,
	Option,
	Queue,
	Runtime,
} from "effect";
import type { Route } from "../../config/config-parser";
import type { PythLazerModuleConfig } from "../../config/pyth-lazer-module-config";
import { HAS_PRICE_KEY } from "../../constants";
import { createErrorResponse } from "../../controllers/create-error-response";
import { forkIdleCleanup } from "../../utils/idle-cleanup";
import { replaceParams } from "../../utils/replace-params";
import { FailedToHandleRequest, ModuleService } from "../module";
import { createPriceCache } from "../shared/price-cache";
import {
	FailedToHandlePythLazerRequestError,
	extractPriceFeedIdFromErrorMessage,
} from "./errors";
import { getPriceIdBySymbol } from "./get-symbol-price-id";

export class FailedToCreateLazerClientError extends Data.TaggedError(
	"FailedToCreateLazerClientError",
)<{ error: string | unknown }> {
	message = `Failed to create Pyth Lazer client: ${this.error}`;
}

type PriceFeedId = number;
type PriceFeedSymbol = string;
type PriceFeedSubscriptionKey = `${Channel}:${PriceFeedId}`;

interface PriceFeedSubscription {
	channel: Channel;
	priceFeedId: PriceFeedId;
}

export const priceFeedSubscriptionKey = (
	priceFeedId: PriceFeedId,
	channel: Channel,
): PriceFeedSubscriptionKey => `${channel}:${priceFeedId}`;

const priceFeedIdFromSubscriptionKey = (
	key: PriceFeedSubscriptionKey,
): PriceFeedId => Number(key.slice(key.lastIndexOf(":") + 1));

interface PriceFeedWithSymbol extends ParsedFeedPayload {
	symbol?: string;
	[HAS_PRICE_KEY]: boolean;
}

/** Pyth Lazer timestamps are Unix microseconds; returns lag in ms, or undefined if missing/invalid. */
export const lagMsFromTimestampUs = (
	nowMs: number,
	timestampUs: number | string | undefined,
): number | undefined => {
	if (timestampUs === undefined) {
		return undefined;
	}
	const us =
		typeof timestampUs === "string" ? Number(timestampUs) : timestampUs;
	if (!Number.isFinite(us)) {
		return undefined;
	}
	return nowMs - us / 1000;
};

/** Metrics for the Pyth Lazer module. */
const messageLagMs = Metric.histogram(
	"pyth_lazer_message_lag_ms",
	MetricBoundaries.fromIterable([
		1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000,
	]),
	"Lag in ms between Pyth Lazer update timestampUs and local receive time",
);

const messageHandleDurationMs = Metric.timerWithBoundaries(
	"pyth_lazer_message_handle_duration_ms",
	[0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000],
	"Duration in ms of the Pyth Lazer addMessageListener callback",
);

const activeSubscriptions = Metric.gauge("pyth_lazer_active_subscriptions", {
	description: "Number of active Pyth Lazer price feed subscriptions",
});

export const PythLazerModuleService = (config: PythLazerModuleConfig) =>
	Layer.effect(
		ModuleService,
		Effect.gen(function* () {
			yield* Effect.logInfo("Initializing Pyth Lazer module");
			const runtime = yield* Effect.runtime();
			const priceCache = yield* createPriceCache<
				PriceFeedSubscriptionKey,
				ParsedFeedPayload
			>();
			// The timestamp of the last request to the price feed
			const lastRequestToPriceFeed = MutableHashMap.empty<
				PriceFeedSubscriptionKey,
				number
			>();
			const newPriceFeedRequests =
				yield* Queue.unbounded<PriceFeedSubscription>();
			// channel + price feed id -> subscription id
			const subscriptions = MutableHashMap.empty<
				PriceFeedSubscriptionKey,
				number
			>();
			// subscription id -> channel, used to route incoming updates to the correct cache
			const subscriptionChannels = MutableHashMap.empty<number, Channel>();
			// symbol -> price feed id, to support requests with symbols
			const symbolToFeedId = MutableHashMap.empty<
				PriceFeedSymbol,
				PriceFeedId
			>();

			const getSymbolByPriceFeedId = (priceFeedId: PriceFeedId) => {
				for (const [symbol, id] of MutableHashMap.fromIterable(
					symbolToFeedId,
				)) {
					if (id === priceFeedId) {
						return Option.some(symbol);
					}
				}

				return Option.none();
			};

			let subscriptionId = 0;

			const lazerClient = yield* Effect.tryPromise({
				try: () =>
					PythLazerClient.create({
						token: config.pythLazerApiKey,
						metadataServiceUrl: "https://pyth.dourolabs.app",
						webSocketPoolConfig: {
							urls: [
								"wss://pyth-lazer-0.dourolabs.app/v1/stream",
								"wss://pyth-lazer-1.dourolabs.app/v1/stream",
								"wss://pyth-lazer-2.dourolabs.app/v1/stream",
							],
							onWebSocketPoolError: (error) => {
								Runtime.runSync(
									runtime,
									Effect.logError("Error in Pyth Lazer client web socket pool"),
								);

								const priceFeedId = extractPriceFeedIdFromErrorMessage(
									`${error}`,
								);

								// If price feed id is given, then set the cache to error
								// for all subscriptions to this price feed id.
								if (Option.isSome(priceFeedId)) {
									const symbol = getSymbolByPriceFeedId(priceFeedId.value);

									Runtime.runSync(
										runtime,
										Effect.forEach(subscriptions, ([key]) =>
											priceFeedIdFromSubscriptionKey(key) === priceFeedId.value
												? priceCache.setPriceToError(
														key,
														`(${Option.getOrElse(symbol, () => "Unknown/Symbol")}) ${error}`,
													)
												: Effect.void,
										),
									);
								}

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
					Effect.logError("All connections are down for Pyth Lazer client"),
				),
			);

			lazerClient.addConnectionTimeoutListener((connectionIndex, endpoint) =>
				Runtime.runSync(
					runtime,
					Effect.logWarning("Connection timeout for Pyth Lazer client").pipe(
						Effect.annotateLogs({
							connectionIndex,
							endpoint,
						}),
					),
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

								yield* handleStreamUpdatedMessage(
									message.value.subscriptionId,
									message.value.parsed,
								);
							}
						}
					}).pipe(Metric.trackDuration(messageHandleDurationMs)),
				);
			});

			const handleStreamUpdatedMessage = (
				subscriptionId: number,
				message: ParsedPayload,
			) =>
				Effect.gen(function* () {
					const channel = MutableHashMap.get(
						subscriptionChannels,
						subscriptionId,
					);
					if (Option.isNone(channel)) {
						return;
					}

					const nowMs = yield* Clock.currentTimeMillis;
					const lagMs = lagMsFromTimestampUs(nowMs, message.timestampUs);

					if (lagMs !== undefined) {
						yield* Metric.update(messageLagMs, lagMs);
					}

					for (const priceFeed of message.priceFeeds) {
						const key = priceFeedSubscriptionKey(
							priceFeed.priceFeedId,
							channel.value,
						);
						// To make sure that we don't set the price for a price feed that we are not subscribed to
						// otherwise requests may get an outdated price
						if (!MutableHashMap.has(subscriptions, key)) {
							continue;
						}

						yield* priceCache.setPrice(key, priceFeed);
					}
				});

			const start = () =>
				Effect.gen(function* () {
					yield* Effect.logInfo("Starting Pyth Lazer module");

					const now = yield* Clock.currentTimeMillis;
					for (const priceFeed of config.priceFeedIds) {
						const subscription = {
							channel: priceFeed.channel,
							priceFeedId: priceFeed.id,
						};
						const key = priceFeedSubscriptionKey(
							subscription.priceFeedId,
							subscription.channel,
						);
						yield* newPriceFeedRequests.offer(subscription);
						// Add a request timestamp so it is tracked in the cleanup interval
						MutableHashMap.set(lastRequestToPriceFeed, key, now);
					}

					yield* Effect.forkDaemon(
						Effect.gen(function* () {
							const newPriceFeed = yield* newPriceFeedRequests.take;
							const key = priceFeedSubscriptionKey(
								newPriceFeed.priceFeedId,
								newPriceFeed.channel,
							);

							if (MutableHashMap.has(subscriptions, key)) {
								yield* Effect.logDebug(
									`Price feed ${newPriceFeed.priceFeedId} is already subscribed to ${newPriceFeed.channel}`,
								);
								return;
							}

							yield* Effect.logInfo(
								`Subscribing to price feed ${newPriceFeed.priceFeedId} on ${newPriceFeed.channel}`,
							);

							const newSubscriptionId = subscriptionId++;

							MutableHashMap.set(subscriptions, key, newSubscriptionId);
							MutableHashMap.set(
								subscriptionChannels,
								newSubscriptionId,
								newPriceFeed.channel,
							);

							yield* Metric.set(
								activeSubscriptions,
								MutableHashMap.size(subscriptions),
							);

							lazerClient.subscribe({
								type: "subscribe",
								channel: newPriceFeed.channel,
								formats: [],
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
								priceFeedIds: [newPriceFeed.priceFeedId],
								// Recommended by Pyth case a previously valid feed id becomes invalid (delisting, id changed, etc.)
								ignoreInvalidFeedIds: true,
							});
						}).pipe(Effect.forever),
					);

					yield* forkIdleCleanup({
						lastRequest: lastRequestToPriceFeed,
						ttl: config.priceFeedsCleanupTtl,
						interval: config.priceFeedsCleanupInterval,
						onExpire: (key) =>
							Effect.gen(function* () {
								const priceFeedId = priceFeedIdFromSubscriptionKey(key);
								yield* Effect.logInfo(`Cleaning up price feed ${key}`);
								yield* priceCache.deletePrice(key);

								const subscriptionId = MutableHashMap.get(subscriptions, key);
								if (Option.isSome(subscriptionId)) {
									lazerClient.unsubscribe(subscriptionId.value);
									MutableHashMap.remove(subscriptions, key);
									MutableHashMap.remove(
										subscriptionChannels,
										subscriptionId.value,
									);

									yield* Metric.set(
										activeSubscriptions,
										MutableHashMap.size(subscriptions),
									);

									// If there are no other subscriptions to this price feed id under
									// different channels, then remove the symbol to price feed id mapping.
									const hasOtherRate = Array.from(subscriptions).some(
										([subscriptionKey]) =>
											priceFeedIdFromSubscriptionKey(subscriptionKey) ===
											priceFeedId,
									);
									if (!hasOtherRate) {
										const symbol = getSymbolByPriceFeedId(priceFeedId);
										if (Option.isSome(symbol)) {
											MutableHashMap.remove(symbolToFeedId, symbol.value);
										}
									}

									yield* Effect.logInfo(`Unsubscribed from price feed ${key}`);
								}
							}),
					});
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
								symbolToFeedId,
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

							MutableHashMap.set(symbolToFeedId, symbolOrId, priceFeedId);
							priceFeedIds.push(priceFeedId);
						} else {
							priceFeedIds.push(Number(symbolOrId));
						}
					}

					const prices: PriceFeedWithSymbol[] = [];
					const now = yield* Clock.currentTimeMillis;

					// First subscribe to all the symbols that we have not subscribed to yet
					for (const priceFeedId of priceFeedIds) {
						const key = priceFeedSubscriptionKey(priceFeedId, route.channel);
						if (!MutableHashMap.has(lastRequestToPriceFeed, key)) {
							yield* newPriceFeedRequests.offer({
								channel: route.channel,
								priceFeedId,
							});
						}

						MutableHashMap.set(lastRequestToPriceFeed, key, now);
					}

					// Now since the subscriptions are in-flight, we can fetch the prices concurrently.
					const results = yield* Effect.forEach(
						priceFeedIds,
						(priceFeedId) =>
							Effect.either(
								priceCache.getOrWaitPrice(
									priceFeedSubscriptionKey(priceFeedId, route.channel),
								),
							),
						{ concurrency: "unbounded" },
					);

					for (let i = 0; i < priceFeedIds.length; i++) {
						const priceFeedId = priceFeedIds[i];
						const price = results[i];

						if (Either.isLeft(price)) {
							prices.push({
								priceFeedId,
								symbol: priceFeedIdsRaw.at(i),
								[HAS_PRICE_KEY]: false,
							});
						} else {
							prices.push({
								...price.right,
								symbol: priceFeedIdsRaw.at(i),
								[HAS_PRICE_KEY]: true,
							});
						}
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
