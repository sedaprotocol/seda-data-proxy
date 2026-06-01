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
import { createLegacyLatestPriceHandler } from "./legacy-latest-price/latest-price";
import type { CachedPriceFeed, PriceFeedId, PriceFeedSymbol } from "./types";

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
				PriceFeedId,
				CachedPriceFeed
			>();
			// The timestamp of the last request to the price feed
			const lastRequestToPriceFeed = MutableHashMap.empty<
				PriceFeedId,
				number
			>();
			const newPriceFeedRequests = yield* Queue.unbounded<PriceFeedId>();
			// price feed id -> subscription id
			const subscriptions = MutableHashMap.empty<PriceFeedId, number>();
			const symbolsToId = MutableHashMap.empty<PriceFeedSymbol, PriceFeedId>();

			const getSymbolByPriceFeedId = (priceFeedId: PriceFeedId) => {
				for (const [symbol, id] of MutableHashMap.fromIterable(symbolsToId)) {
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

									Runtime.runSync(
										runtime,
										priceCache.setPriceToError(
											priceFeedId.value,
											`(${Option.getOrElse(symbol, () => "Unknown/Symbol")}) ${error}`,
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
						"Received stream updated message from Pyth Lazer client",
						message,
					);

					for (const priceFeed of message.priceFeeds) {
						// To make sure that we don't set the price for a price feed that we are not subscribed to
						// otherwise requests may get an outdated price
						if (!MutableHashMap.has(subscriptions, priceFeed.priceFeedId)) {
							continue;
						}

						yield* priceCache.setPrice(priceFeed.priceFeedId, {
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
						yield* newPriceFeedRequests.offer(priceFeed.id);
						// Add a request timestamp so it is tracked in the cleanup interval
						MutableHashMap.set(lastRequestToPriceFeed, priceFeed.id, now);
					}

					yield* Effect.forkDaemon(
						Effect.gen(function* () {
							const newPriceFeedId = yield* newPriceFeedRequests.take;

							if (MutableHashMap.has(subscriptions, newPriceFeedId)) {
								yield* Effect.logDebug(
									`Price feed ${newPriceFeedId} is already subscribed`,
								);
								return;
							}

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
								// Recommended by Pyth case a previously valid feed id becomes invalid (delisting, id changed, etc.)
								ignoreInvalidFeedIds: true,
							});
						}).pipe(Effect.forever),
					);

					yield* forkIdleCleanup({
						lastRequest: lastRequestToPriceFeed,
						ttl: config.priceFeedsCleanupTtl,
						interval: config.priceFeedsCleanupInterval,
						onExpire: (priceFeedId) =>
							Effect.gen(function* () {
								yield* Effect.logInfo(`Cleaning up price feed ${priceFeedId}`);
								yield* priceCache.deletePrice(priceFeedId);

								const subscriptionId = MutableHashMap.get(
									subscriptions,
									priceFeedId,
								);
								if (Option.isSome(subscriptionId)) {
									lazerClient.unsubscribe(subscriptionId.value);
									MutableHashMap.remove(subscriptions, priceFeedId);

									const symbol = getSymbolByPriceFeedId(priceFeedId);
									if (Option.isSome(symbol)) {
										MutableHashMap.remove(symbolsToId, symbol.value);
									}

									yield* Effect.logInfo(
										`Unsubscribed from price feed ${priceFeedId}`,
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

			// Subscribe to feeds not requested before, then mark each as freshly requested.
			// Subscribing up front keeps the subscriptions in-flight before we wait on prices.
			const ensureSubscribedAndTrack = (priceFeedIds: number[], now: number) =>
				Effect.gen(function* () {
					for (const priceFeedId of priceFeedIds) {
						if (!MutableHashMap.has(lastRequestToPriceFeed, priceFeedId)) {
							yield* newPriceFeedRequests.offer(priceFeedId);
						}

						MutableHashMap.set(lastRequestToPriceFeed, priceFeedId, now);
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
					yield* ensureSubscribedAndTrack(priceFeedIds, now);

					const results = yield* Effect.forEach(
						priceFeedIds,
						(priceFeedId) =>
							Effect.either(priceCache.getOrWaitPrice(priceFeedId)),
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
				getOrWaitPrice: priceCache.getOrWaitPrice,
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
