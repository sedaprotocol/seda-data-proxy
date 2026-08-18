import {
	type Channel,
	type ParsedFeedPayload,
	type ParsedPayload,
	PythLazerClient,
} from "@pythnetwork/pyth-lazer-sdk";
import {
	Clock,
	Data,
	Deferred,
	Effect,
	Either,
	Layer,
	Metric,
	MetricBoundaries,
	MutableHashMap,
	Option,
	Queue,
	Runtime,
	Schedule,
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
	pythLazerErrorMessage,
	redactPythLazerSecrets,
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

interface BulkSubscription {
	subscriptionId: number;
	feedIds: Set<PriceFeedId>;
}

export const priceFeedSubscriptionKey = (
	priceFeedId: PriceFeedId,
	channel: Channel,
): PriceFeedSubscriptionKey => `${channel}:${priceFeedId}`;

const priceFeedIdFromSubscriptionKey = (
	key: PriceFeedSubscriptionKey,
): PriceFeedId => Number(key.slice(key.lastIndexOf(":") + 1));

const channelFromSubscriptionKey = (key: PriceFeedSubscriptionKey): Channel =>
	key.slice(0, key.lastIndexOf(":")) as Channel;

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
			// subscription key -> subscription id
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

			// For bulk-subscribe bookkeeping:
			// Individual subscriptions that have not yet been consolidated into a bulk subscription.
			const individualSubscriptionIds = new Set<number>();
			// Subscription keys that have delivered at least one update.
			const deliveredKeys = new Set<PriceFeedSubscriptionKey>();
			// channel -> bulk subscription
			const bulkByChannel = new Map<Channel, BulkSubscription>();
			// Bulk subscription ids waiting for their first tick
			const pendingFirstTicks = MutableHashMap.empty<
				number,
				Deferred.Deferred<void>
			>();

			const lazerClient = yield* Effect.tryPromise({
				try: () =>
					PythLazerClient.create({
						token: config.pythLazerApiKey,
						metadataServiceUrl: "https://pyth.dourolabs.app",
						webSocketPoolConfig: {
							numConnections: 3,
							urls: [
								"wss://pyth-lazer-0.dourolabs.app/v1/stream",
								"wss://pyth-lazer-1.dourolabs.app/v1/stream",
								"wss://pyth-lazer-2.dourolabs.app/v1/stream",
							],
							onWebSocketPoolError: (error) => {
								const safeMessage = redactPythLazerSecrets(
									pythLazerErrorMessage(error),
								);

								Runtime.runSync(
									runtime,
									Effect.logError(
										"Error in Pyth Lazer client web socket pool",
										{ message: safeMessage },
									),
								);

								const priceFeedId =
									extractPriceFeedIdFromErrorMessage(safeMessage);

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
														`(${Option.getOrElse(symbol, () => "Unknown/Symbol")}) ${safeMessage}`,
													)
												: Effect.void,
										),
									);
								}
							},
							onWebSocketError: (error) => {
								const safeMessage = redactPythLazerSecrets(
									pythLazerErrorMessage(error),
								);

								Runtime.runSync(
									runtime,
									Effect.logError("Error in Pyth Lazer client web socket", {
										message: safeMessage,
									}),
								);
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

					const firstTick = MutableHashMap.get(
						pendingFirstTicks,
						subscriptionId,
					);
					if (Option.isSome(firstTick)) {
						yield* Deferred.succeed(firstTick.value, undefined);
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

						deliveredKeys.add(key);
						yield* priceCache.setPrice(key, priceFeed);
					}
				});

			const sendSubscribe = (
				newSubscriptionId: number,
				channel: Channel,
				priceFeedIds: number[],
			) => {
				lazerClient.subscribe({
					type: "subscribe",
					channel,
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
					priceFeedIds,
					// Recommended by Pyth case a previously valid feed id becomes invalid (delisting, id changed, etc.)
					ignoreInvalidFeedIds: true,
				});
			};

			// Consolidates subscriptions on the same channel into a single bulk subscription.
			const consolidateSubscriptions = Effect.gen(function* () {
				const absorbableByChannel = new Map<
					Channel,
					Map<PriceFeedId, number>
				>();

				for (const [key, subId] of subscriptions) {
					if (
						!individualSubscriptionIds.has(subId) ||
						!deliveredKeys.has(key)
					) {
						continue;
					}

					const channel = channelFromSubscriptionKey(key);
					const feedId = priceFeedIdFromSubscriptionKey(key);
					let absorbable = absorbableByChannel.get(channel);
					if (absorbable === undefined) {
						absorbable = new Map();
						absorbableByChannel.set(channel, absorbable);
					}
					absorbable.set(feedId, subId);
				}

				const channels = new Set<Channel>([
					...absorbableByChannel.keys(),
					...bulkByChannel.keys(),
				]);

				for (const channel of channels) {
					const absorbable =
						absorbableByChannel.get(channel) ?? new Map<PriceFeedId, number>();
					const bulk = bulkByChannel.get(channel);
					const bulkFeedIds = bulk?.feedIds ?? new Set<PriceFeedId>();

					const carriedOver = new Set<PriceFeedId>();
					let droppedFromBulk = 0;
					for (const feedId of bulkFeedIds) {
						if (
							MutableHashMap.has(
								subscriptions,
								priceFeedSubscriptionKey(feedId, channel),
							)
						) {
							carriedOver.add(feedId);
						} else {
							droppedFromBulk++;
						}
					}

					if (absorbable.size === 0 && droppedFromBulk === 0) {
						continue;
					}

					const newFeedIds = new Set([...carriedOver, ...absorbable.keys()]);
					const oldBulkSubscriptionId = bulk?.subscriptionId;

					if (newFeedIds.size === 0) {
						if (oldBulkSubscriptionId !== undefined) {
							yield* Effect.logInfo(
								`Dropping empty bulk subscription ${oldBulkSubscriptionId} on ${channel}: ${droppedFromBulk} idle feed(s) dropped`,
							);
							lazerClient.unsubscribe(oldBulkSubscriptionId);
							MutableHashMap.remove(
								subscriptionChannels,
								oldBulkSubscriptionId,
							);
							bulkByChannel.delete(channel);
						}
						continue;
					}

					const newBulkSubscriptionId = subscriptionId++;
					yield* Effect.logInfo(
						`Consolidating subscriptions on ${channel}: ${absorbable.size} individual subscription(s) absorbed, ` +
							`${droppedFromBulk} idle feed(s) dropped, bulk subscription ${newBulkSubscriptionId} ` +
							`now carries ${newFeedIds.size} feed(s)`,
					);

					MutableHashMap.set(
						subscriptionChannels,
						newBulkSubscriptionId,
						channel,
					);

					const firstTick = yield* Deferred.make<void>();
					MutableHashMap.set(
						pendingFirstTicks,
						newBulkSubscriptionId,
						firstTick,
					);
					sendSubscribe(newBulkSubscriptionId, channel, [...newFeedIds]);

					const firstTickReceived = yield* Deferred.await(firstTick).pipe(
						Effect.timeout(config.bulkConsolidateTimeout),
						Effect.as(true),
						Effect.catchTag("TimeoutException", () => Effect.succeed(false)),
						Effect.ensuring(
							Effect.sync(() =>
								MutableHashMap.remove(pendingFirstTicks, newBulkSubscriptionId),
							),
						),
					);

					if (!firstTickReceived) {
						yield* Effect.logWarning(
							`New bulk subscription ${newBulkSubscriptionId} on ${channel} did not receive a first tick within the consolidation timeout; leaving existing subscriptions in place`,
						);
						lazerClient.unsubscribe(newBulkSubscriptionId);
						MutableHashMap.remove(subscriptionChannels, newBulkSubscriptionId);
						continue;
					}

					if (oldBulkSubscriptionId !== undefined) {
						lazerClient.unsubscribe(oldBulkSubscriptionId);
						MutableHashMap.remove(subscriptionChannels, oldBulkSubscriptionId);
					}

					const staleSubscriptionIds = new Set<number>(absorbable.values());
					for (const feedId of newFeedIds) {
						const key = priceFeedSubscriptionKey(feedId, channel);
						const current = MutableHashMap.get(subscriptions, key);
						if (Option.isNone(current)) {
							// Skip feeds that idled out while waiting for the first tick;
							// the next pass drops them from the bulk subscription.
							continue;
						}
						staleSubscriptionIds.add(current.value);
						MutableHashMap.set(subscriptions, key, newBulkSubscriptionId);
					}

					for (const subId of staleSubscriptionIds) {
						lazerClient.unsubscribe(subId);
						individualSubscriptionIds.delete(subId);
						MutableHashMap.remove(subscriptionChannels, subId);
					}

					bulkByChannel.set(channel, {
						subscriptionId: newBulkSubscriptionId,
						feedIds: newFeedIds,
					});
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
						MutableHashMap.set(lastRequestToPriceFeed, key, now);
						MutableHashMap.set(symbolToFeedId, priceFeed.name, priceFeed.id);
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
							individualSubscriptionIds.add(newSubscriptionId);

							yield* Metric.set(
								activeSubscriptions,
								MutableHashMap.size(subscriptions),
							);

							sendSubscribe(newSubscriptionId, newPriceFeed.channel, [
								newPriceFeed.priceFeedId,
							]);
						}).pipe(Effect.forever),
					);

					yield* Effect.forkDaemon(
						consolidateSubscriptions.pipe(
							Effect.catchAllCause((cause) =>
								Effect.logError(
									"Bulk subscription consolidation failed",
									cause,
								),
							),
							// Effect.schedule waits one full interval before the first pass,
							// so consolidation never races the initial config-seeded subscribes.
							Effect.schedule(Schedule.spaced(config.bulkConsolidateInterval)),
						),
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
								deliveredKeys.delete(key);

								const expiredSubscriptionId = MutableHashMap.get(
									subscriptions,
									key,
								);
								if (Option.isSome(expiredSubscriptionId)) {
									const bulk = bulkByChannel.get(
										channelFromSubscriptionKey(key),
									);
									// A feed carried by the bulk subscription must not
									// unsubscribe it: that would drop every other feed. Removing
									// it from the map stops cache writes immediately; the next
									// consolidation pass rebuilds the bulk subscription without it.
									if (
										bulk === undefined ||
										expiredSubscriptionId.value !== bulk.subscriptionId
									) {
										lazerClient.unsubscribe(expiredSubscriptionId.value);
										individualSubscriptionIds.delete(
											expiredSubscriptionId.value,
										);
										MutableHashMap.remove(
											subscriptionChannels,
											expiredSubscriptionId.value,
										);
									}
									MutableHashMap.remove(subscriptions, key);

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

					// Normalize ids or symbols to price feed ids concurrently.
					const priceFeedIds = yield* Effect.forEach(
						priceFeedIdsRaw,
						(symbolOrId) =>
							Effect.gen(function* () {
								if (!Number.isNaN(Number(symbolOrId))) {
									return Number(symbolOrId);
								}
								const cached = MutableHashMap.get(symbolToFeedId, symbolOrId);
								if (Option.isSome(cached)) {
									return cached.value;
								}
								const priceFeedId = yield* getPriceIdBySymbol(
									symbolOrId,
									lazerClient,
								);
								MutableHashMap.set(symbolToFeedId, symbolOrId, priceFeedId);
								return priceFeedId;
							}),
						{ concurrency: "unbounded" },
					);

					const prices: PriceFeedWithSymbol[] = [];
					const now = yield* Clock.currentTimeMillis;

					// First subscribe to all the symbols that we have not subscribed to yet.
					for (const priceFeedId of priceFeedIds) {
						const key = priceFeedSubscriptionKey(priceFeedId, route.channel);
						if (!MutableHashMap.has(subscriptions, key)) {
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
