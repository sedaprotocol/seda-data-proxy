import {
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
	MutableHashMap,
	Option,
	Queue,
	Runtime,
} from "effect";
import type { Route } from "../../config/config-parser";
import type {
	PythLazerChannel,
	PythLazerModuleConfig,
} from "../../config/pyth-lazer-module-config";
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
import { createLegacyLatestPriceHandler } from "./legacy-latest-price/latest-price";
import {
	type CachedPriceFeed,
	type FeedChannelKey,
	type PriceFeedId,
	type PriceFeedSymbol,
	makeFeedChannelKey,
} from "./types";

export class FailedToCreateLazerClientError extends Data.TaggedError(
	"FailedToCreateLazerClientError",
)<{ error: string | unknown }> {
	message = `Failed to create Pyth Lazer client: ${this.error}`;
}

interface PriceFeedWithSymbol extends ParsedFeedPayload {
	symbol?: string;
	[HAS_PRICE_KEY]: boolean;
}

export const PythLazerModuleService = (config: PythLazerModuleConfig) =>
	Layer.effect(
		ModuleService,
		Effect.gen(function* () {
			yield* Effect.logInfo("Initializing Pyth Lazer module");
			const runtime = yield* Effect.runtime();
			const priceCache = yield* createPriceCache<
				FeedChannelKey,
				CachedPriceFeed
			>();
			// The timestamp of the last request per (feed, channel)
			const lastRequestToPriceFeed = MutableHashMap.empty<
				FeedChannelKey,
				number
			>();
			const newPriceFeedRequests = yield* Queue.unbounded<{
				priceFeedId: PriceFeedId;
				channel: PythLazerChannel;
			}>();
			// (feed, channel) -> subscription id
			const subscriptions = MutableHashMap.empty<FeedChannelKey, number>();
			// subscription id -> channel, so inbound frames route back to their channel
			const subscriptionChannel = MutableHashMap.empty<
				number,
				PythLazerChannel
			>();
			const symbolsToId = MutableHashMap.empty<PriceFeedSymbol, PriceFeedId>();

			const getSymbolByPriceFeedId = (priceFeedId: PriceFeedId) => {
				for (const [symbol, id] of symbolsToId) {
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

								if (Option.isSome(priceFeedId)) {
									const symbol = getSymbolByPriceFeedId(priceFeedId.value);
									const message = `(${Option.getOrElse(symbol, () => "Unknown/Symbol")}) ${error}`;

									// Fail every channel this feed is subscribed on; the error
									// string only carries the feed id, not the channel.
									for (const [key] of subscriptions) {
										if (key.priceFeedId === priceFeedId.value) {
											Runtime.runSync(
												runtime,
												priceCache.setPriceToError(key, message),
											);
										}
									}
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

								yield* handleStreamUpdatedMessage(
									message.value.subscriptionId,
									message.value.parsed,
								);
							}
						}
					}),
				);
			});

			const handleStreamUpdatedMessage = (
				subscriptionId: number,
				message: ParsedPayload,
			) =>
				Effect.gen(function* () {
					yield* Effect.logTrace(
						"Received stream updated message from Pyth Lazer client",
						message,
					);

					const channel = MutableHashMap.get(
						subscriptionChannel,
						subscriptionId,
					);
					if (Option.isNone(channel)) {
						return yield* Effect.logWarning(
							`Received frame for unknown subscription ${subscriptionId}`,
						);
					}

					for (const priceFeed of message.priceFeeds) {
						const key = makeFeedChannelKey(
							priceFeed.priceFeedId,
							channel.value,
						);

						// A subscription carries a single feed; ignore any other feed that
						// arrives on its frame so a stale value can't land in the cache.
						if (!MutableHashMap.has(subscriptions, key)) {
							continue;
						}

						yield* priceCache.setPrice(key, {
							priceFeed,
							timestampUs: message.timestampUs,
						});
					}
				});

			const start = () =>
				Effect.gen(function* () {
					yield* Effect.logInfo("Starting Pyth Lazer module");

					const now = yield* Clock.currentTimeMillis;
					for (const priceFeed of config.priceFeedIds) {
						const key = makeFeedChannelKey(priceFeed.id, config.channel);
						yield* newPriceFeedRequests.offer({
							priceFeedId: priceFeed.id,
							channel: config.channel,
						});
						// Add a request timestamp so it is tracked in the cleanup interval
						MutableHashMap.set(lastRequestToPriceFeed, key, now);
					}

					yield* Effect.forkDaemon(
						Effect.gen(function* () {
							const { priceFeedId, channel } = yield* newPriceFeedRequests.take;
							const key = makeFeedChannelKey(priceFeedId, channel);

							if (MutableHashMap.has(subscriptions, key)) {
								yield* Effect.logDebug(
									`Price feed ${priceFeedId} is already subscribed on ${channel}`,
								);
								return;
							}

							yield* Effect.logInfo(
								`Subscribing to price feed ${priceFeedId} on ${channel}`,
							);

							const newSubscriptionId = subscriptionId++;

							MutableHashMap.set(subscriptions, key, newSubscriptionId);
							MutableHashMap.set(
								subscriptionChannel,
								newSubscriptionId,
								channel,
							);

							lazerClient.subscribe({
								type: "subscribe",
								channel,
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
								priceFeedIds: [priceFeedId],
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
								const { priceFeedId, channel } = key;
								yield* Effect.logInfo(
									`Cleaning up price feed ${priceFeedId} on ${channel}`,
								);
								yield* priceCache.deletePrice(key);

								const subscriptionId = MutableHashMap.get(subscriptions, key);
								if (Option.isSome(subscriptionId)) {
									lazerClient.unsubscribe(subscriptionId.value);
									MutableHashMap.remove(subscriptions, key);
									MutableHashMap.remove(
										subscriptionChannel,
										subscriptionId.value,
									);

									// Drop the symbol mapping only once no channel for this feed
									// remains; symbol -> id resolution is shared across channels.
									const feedStillSubscribed = Array.from(subscriptions).some(
										([remaining]) => remaining.priceFeedId === priceFeedId,
									);
									if (!feedStillSubscribed) {
										const symbol = getSymbolByPriceFeedId(priceFeedId);
										if (Option.isSome(symbol)) {
											MutableHashMap.remove(symbolsToId, symbol.value);
										}
									}

									yield* Effect.logInfo(
										`Unsubscribed from price feed ${priceFeedId} on ${channel}`,
									);
								}
							}),
					});
				}).pipe(Effect.annotateLogs("_name", "pyth-lazer"));

			// Resolve a mixed list of numeric ids and symbols to price feed ids,
			// caching symbol lookups. Shared by both request surfaces.
			const resolvePriceFeedIds = (rawTokens: string[]) =>
				Effect.gen(function* () {
					const priceFeedIds: number[] = [];

					for (const symbolOrId of rawTokens) {
						if (Number.isNaN(Number(symbolOrId))) {
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

					return priceFeedIds;
				});

			// Subscribe to feeds not requested before on this channel, then mark each
			// as freshly requested. Subscribing up front keeps the subscriptions
			// in-flight before we wait on prices.
			const ensureSubscribedAndTrack = (
				priceFeedIds: number[],
				channel: PythLazerChannel,
				now: number,
			) =>
				Effect.gen(function* () {
					for (const priceFeedId of priceFeedIds) {
						const key = makeFeedChannelKey(priceFeedId, channel);
						if (!MutableHashMap.has(lastRequestToPriceFeed, key)) {
							yield* newPriceFeedRequests.offer({ priceFeedId, channel });
						}

						MutableHashMap.set(lastRequestToPriceFeed, key, now);
					}
				});

			// Path surface (e.g. GET /price/:symbols): one array entry per requested feed,
			// each tagged with HAS_PRICE_KEY. A feed without a price keeps its slot (so callers
			// reading by index stay aligned) and is flagged false rather than failing.
			const handlePathRequest = (
				fetchFromModule: string,
				params: Record<string, string>,
			) =>
				Effect.gen(function* () {
					const priceFeedIdsRaw = replaceParams(fetchFromModule, params).split(
						",",
					);

					if (priceFeedIdsRaw.length > config.maxFeedsPerRequest) {
						return createErrorResponse(
							new FailedToHandlePythLazerRequestError({
								error: `Too many price feed IDs, max is ${config.maxFeedsPerRequest} but got ${priceFeedIdsRaw.length}`,
							}),
							400,
						);
					}

					const priceFeedIds = yield* resolvePriceFeedIds(priceFeedIdsRaw);
					const now = yield* Clock.currentTimeMillis;
					yield* ensureSubscribedAndTrack(priceFeedIds, config.channel, now);

					const results = yield* Effect.forEach(
						priceFeedIds,
						(priceFeedId) =>
							Effect.either(
								priceCache.getOrWaitPrice(
									makeFeedChannelKey(priceFeedId, config.channel),
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
								...price.right.priceFeed,
								symbol: priceFeedIdsRaw.at(i),
								[HAS_PRICE_KEY]: true,
							});
						}
					}

					return new Response(JSON.stringify(prices), { status: 200 });
				});

			const handleLegacyLatestPriceRequest = createLegacyLatestPriceHandler({
				config,
				ensureSubscribedAndTrack,
				getOrWaitPrice: (priceFeedId, channel) =>
					priceCache.getOrWaitPrice(makeFeedChannelKey(priceFeedId, channel)),
				resolvePriceFeedIds,
			});

			const handleRequest = (
				route: Route,
				params: Record<string, string>,
				request: Request,
				body?: string,
			) =>
				Effect.gen(function* () {
					if (route.type !== "pyth-lazer") {
						return yield* Effect.fail(
							new FailedToHandleRequest({
								msg: "Route is not a Pyth Lazer module",
							}),
						);
					}

					if (route.fetchFromModule !== undefined) {
						return yield* handlePathRequest(route.fetchFromModule, params);
					}

					return yield* handleLegacyLatestPriceRequest(body);
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
