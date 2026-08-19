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

export const priceFeedSubscriptionKey = (
	priceFeedId: PriceFeedId,
	channel: Channel,
): PriceFeedSubscriptionKey => `${channel}:${priceFeedId}`;

const priceFeedIdFromSubscriptionKey = (
	key: PriceFeedSubscriptionKey,
): PriceFeedId => Number(key.slice(key.lastIndexOf(":") + 1));

export const channelFromSubscriptionKey = (
	key: PriceFeedSubscriptionKey,
): Channel => key.slice(0, key.lastIndexOf(":")) as Channel;

const PYTH_LAZER_SUBSCRIBE_PROPERTIES = [
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
] as const;

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

const desiredFeeds = Metric.gauge("pyth_lazer_desired_feeds", {
	description: "Number of desired price feeds per channel",
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
			// Desired feeds per channel. Grows on startup and requests, shrinks
			// only in idle cleanup. Matches the latest subscribe sent on that
			// channel, not necessarily the acked active subscription yet.
			const subscriptions = new Map<Channel, Set<PriceFeedId>>();
			// subscription id -> channel, used to route incoming updates to the correct cache
			const subscriptionChannels = MutableHashMap.empty<number, Channel>();
			// Highest successfully acked subscription id per channel
			const activeSubscriptionByChannel = new Map<Channel, number>();
			// Subscription ids sent for a channel that are still awaiting ack or
			// are the current active subscription.
			const outstandingIdsByChannel = new Map<Channel, Set<number>>();
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

			const hasDesiredFeed = (
				channel: Channel,
				priceFeedId: PriceFeedId,
			): boolean => subscriptions.get(channel)?.has(priceFeedId) ?? false;

			const setDesiredFeeds = (channel: Channel, count: number) => {
				Runtime.runSync(
					runtime,
					Metric.set(Metric.tagged(desiredFeeds, "channel", channel), count),
				);
			};

			const addDesiredFeed = (
				channel: Channel,
				priceFeedId: PriceFeedId,
			): boolean => {
				let feeds = subscriptions.get(channel);
				if (feeds === undefined) {
					feeds = new Set<PriceFeedId>();
					subscriptions.set(channel, feeds);
				}
				if (feeds.has(priceFeedId)) {
					return false;
				}
				feeds.add(priceFeedId);
				setDesiredFeeds(channel, feeds.size);
				return true;
			};

			const removeDesiredFeed = (
				channel: Channel,
				priceFeedId: PriceFeedId,
			) => {
				const feeds = subscriptions.get(channel);
				if (feeds === undefined || !feeds.has(priceFeedId)) {
					return;
				}
				feeds.delete(priceFeedId);
				if (feeds.size === 0) {
					subscriptions.delete(channel);
					setDesiredFeeds(channel, 0);
					return;
				}
				setDesiredFeeds(channel, feeds.size);
			};

			const outstandingFor = (channel: Channel): Set<number> => {
				const existing = outstandingIdsByChannel.get(channel);
				if (existing !== undefined) {
					return existing;
				}
				const created = new Set<number>();
				outstandingIdsByChannel.set(channel, created);
				return created;
			};

			let nextSubscriptionId = 0;

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
										Effect.forEach(subscriptions, ([channel]) =>
											hasDesiredFeed(channel, priceFeedId.value)
												? priceCache.setPriceToError(
														priceFeedSubscriptionKey(
															priceFeedId.value,
															channel,
														),
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

			const unsubscribeSubscription = (subscriptionId: number) => {
				Runtime.runSync(
					runtime,
					Effect.logInfo("Unsubscribing subscription", {
						subscriptionId,
					}),
				);

				lazerClient.unsubscribe(subscriptionId);
				MutableHashMap.remove(subscriptionChannels, subscriptionId);
			};

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

			const sendSubscriptionForChannel = (channel: Channel) => {
				const priceFeedIds = subscriptions.get(channel);
				const outstanding = outstandingFor(channel);

				if (priceFeedIds === undefined || priceFeedIds.size === 0) {
					for (const subscriptionId of outstanding) {
						unsubscribeSubscription(subscriptionId);
					}
					outstanding.clear();
					activeSubscriptionByChannel.delete(channel);
					return;
				}

				const newSubscriptionId = nextSubscriptionId++;
				outstanding.add(newSubscriptionId);
				MutableHashMap.set(subscriptionChannels, newSubscriptionId, channel);

				Runtime.runSync(
					runtime,
					Effect.logInfo("Sending subscription request", {
						subscriptionId: newSubscriptionId,
						channel,
					}),
				);

				lazerClient.subscribe({
					type: "subscribe",
					channel,
					formats: [],
					properties: [...PYTH_LAZER_SUBSCRIBE_PROPERTIES],
					subscriptionId: newSubscriptionId,
					priceFeedIds: [...priceFeedIds],
					// Recommended by Pyth case a previously valid feed id becomes invalid (delisting, id changed, etc.)
					ignoreInvalidFeedIds: true,
				});
			};

			const handleSuccessfulSubscriptionAck = (subscriptionId: number) => {
				const channel = MutableHashMap.get(
					subscriptionChannels,
					subscriptionId,
				);
				if (Option.isNone(channel)) {
					return;
				}

				const active = activeSubscriptionByChannel.get(channel.value);
				const outstanding = outstandingFor(channel.value);

				// Unsubscribe if its ID is lower than the currently active subscription's.
				if (active !== undefined && subscriptionId < active) {
					unsubscribeSubscription(subscriptionId);
					outstanding.delete(subscriptionId);
					return;
				}

				// Promote to active and unsubscribe any lower outstanding IDs on
				// this channel as a precaution for acks that never arrive.
				for (const outstandingId of [...outstanding]) {
					if (outstandingId < subscriptionId) {
						const wasPresent = outstanding.delete(outstandingId);
						if (wasPresent) {
							unsubscribeSubscription(outstandingId);
						}
					}
				}

				Runtime.runSync(
					runtime,
					Effect.logInfo("Promoting subscription to active", {
						currentActiveId: activeSubscriptionByChannel.get(channel.value),
						newActiveId: subscriptionId,
					}),
				);
				activeSubscriptionByChannel.set(channel.value, subscriptionId);
			};

			lazerClient.addMessageListener((message) => {
				Runtime.runSync(
					runtime,
					Effect.gen(function* () {
						yield* Effect.logTrace(
							"Received message from Pyth Lazer client",
							message,
						);

						if (message.type !== "json") {
							return;
						}

						const value = message.value;
						if (value.type === "streamUpdated") {
							if (!value.parsed) {
								return yield* Effect.logWarning("No parsed message found", {
									message,
								});
							}

							yield* handleStreamUpdatedMessage(
								value.subscriptionId,
								value.parsed,
							);
							return;
						}

						if (
							value.type === "subscribed" ||
							value.type === "subscribedWithInvalidFeedIdsIgnored"
						) {
							yield* Effect.logInfo("Pyth Lazer successfully subscribed", {
								message: value,
							});
							handleSuccessfulSubscriptionAck(value.subscriptionId);
							return;
						}

						if (value.type === "subscriptionError") {
							const channel = MutableHashMap.get(
								subscriptionChannels,
								value.subscriptionId,
							);
							MutableHashMap.remove(subscriptionChannels, value.subscriptionId);
							if (Option.isSome(channel)) {
								outstandingFor(channel.value).delete(value.subscriptionId);
							}
							yield* Effect.logWarning(
								"Pyth Lazer subscription error; leaving the active subscription in place",
								{
									subscriptionId: value.subscriptionId,
									error: value.error,
								},
							);
							return;
						}

						if (value.type === "error") {
							yield* Effect.logWarning("Pyth Lazer error", {
								error: value.error,
							});
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
						if (!hasDesiredFeed(channel.value, priceFeed.priceFeedId)) {
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
						const key = priceFeedSubscriptionKey(
							priceFeed.id,
							priceFeed.channel,
						);
						addDesiredFeed(priceFeed.channel, priceFeed.id);
						MutableHashMap.set(lastRequestToPriceFeed, key, now);
					}

					for (const [channel, feeds] of subscriptions) {
						if (feeds.size === 0) {
							continue;
						}
						yield* Effect.logInfo(
							`Subscribing to ${feeds.size} price feed(s) on ${channel}`,
						);
						sendSubscriptionForChannel(channel);
					}

					yield* forkIdleCleanup({
						lastRequest: lastRequestToPriceFeed,
						ttl: config.priceFeedsCleanupTtl,
						interval: config.priceFeedsCleanupInterval,
						onExpire: (key) =>
							Effect.gen(function* () {
								const priceFeedId = priceFeedIdFromSubscriptionKey(key);
								const channel = channelFromSubscriptionKey(key);

								// Note we wait until the next request that grows the desired set
								// to re-subscribe without this price feed.
								removeDesiredFeed(channel, priceFeedId);

								let hasOtherRate = false;
								for (const otherChannel of subscriptions.keys()) {
									if (hasDesiredFeed(otherChannel, priceFeedId)) {
										hasOtherRate = true;
										break;
									}
								}
								if (!hasOtherRate) {
									const symbol = getSymbolByPriceFeedId(priceFeedId);
									if (Option.isSome(symbol)) {
										MutableHashMap.remove(symbolToFeedId, symbol.value);
									}
								}

								yield* Effect.logInfo(`Cleaning up price feed ${key}`);
								yield* priceCache.deletePrice(key);
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

					const now = yield* Clock.currentTimeMillis;

					let desiredSetGrew = false;
					for (const priceFeedId of priceFeedIds) {
						const key = priceFeedSubscriptionKey(priceFeedId, route.channel);
						if (addDesiredFeed(route.channel, priceFeedId)) {
							desiredSetGrew = true;
						}

						MutableHashMap.set(lastRequestToPriceFeed, key, now);
					}

					if (desiredSetGrew) {
						sendSubscriptionForChannel(route.channel);
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

					const prices: PriceFeedWithSymbol[] = [];
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
