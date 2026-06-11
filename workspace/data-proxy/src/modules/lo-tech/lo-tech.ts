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
	LO_TECH_EXCHANGE_PATH_PARAM,
	type LoTechModuleConfig,
	assertSupportedLoTechExchange,
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
	LoTechErrorMessage,
	LoTechParsedData,
	LoTechResponse,
} from "./schema";
import { LoTechSubscriptionFailureCode } from "./schema";
import { makeLoTechWebSocketService } from "./ws-client";

export type PriceFeedKey = `${string}:${string}`;

type PriceFeedSubscription = {
	symbol: string;
	exchange: string;
};

export const priceFeedKey = (exchange: string, symbol: string): PriceFeedKey =>
	`${exchange}:${symbol}`;

export const parsePriceFeedKey = (key: PriceFeedKey): PriceFeedSubscription => {
	const separatorIndex = key.indexOf(":");
	return {
		exchange: key.slice(0, separatorIndex),
		symbol: key.slice(separatorIndex + 1),
	};
};

// Resolve the exchange for the given request from the required path parameter.
export const resolveLoTechExchange = (
	exchange: string | undefined,
	moduleConfig: Pick<LoTechModuleConfig, "supportedExchanges">,
): Effect.Effect<string, FailedToHandleLoTechRequestError> =>
	Effect.gen(function* () {
		if (exchange === undefined || exchange === "") {
			return yield* Effect.fail(
				new FailedToHandleLoTechRequestError({
					error: `Missing required "${LO_TECH_EXCHANGE_PATH_PARAM}" path parameter`,
				}),
			);
		}

		yield* assertSupportedLoTechExchange(
			exchange,
			moduleConfig.supportedExchanges,
		).pipe(
			Effect.mapError(
				(error) =>
					new FailedToHandleLoTechRequestError({
						error,
					}),
			),
		);
		return exchange;
	});

export const LoTechModuleService = (config: LoTechModuleConfig) =>
	Layer.effect(
		ModuleService,
		Effect.gen(function* () {
			yield* Effect.logInfo("Initializing LO:TECH module");

			const runtime = yield* Effect.runtime();

			// Monotonically increasing counter for price feed IDs.
			let latestPriceFeedId = 0;
			// Map from price feed IDs to cache keys. (Used to process acks)
			const priceFeedIds = MutableHashMap.empty<number, PriceFeedKey>();
			// Map from subscribed price feed keys to price feed IDs.
			const priceFeeds = MutableHashMap.empty<PriceFeedKey, number>();
			// Queue of new price feeds to subscribe to.
			const newPriceFeedQueue = yield* Queue.unbounded<PriceFeedSubscription>();
			// Timestamp of the last request to the price feed. (Used for cleanup)
			const lastRequestToPriceFeed = MutableHashMap.empty<
				PriceFeedKey,
				number
			>();
			const priceCache = yield* createPriceCache<
				PriceFeedKey,
				LoTechDataPrice
			>();
			const exchanges = new Set(
				config.priceFeeds.map((priceFeed) => priceFeed.exchange),
			);
			const wsByExchange = new Map<
				string,
				Effect.Effect.Success<ReturnType<typeof makeLoTechWebSocketService>>
			>();

			const updatePrice = (exchange: string, data: LoTechDataPrice) =>
				Effect.gen(function* () {
					yield* Effect.logDebug("Received message from LO:TECH client", data);

					const key = priceFeedKey(exchange, data.symbol);
					if (!MutableHashMap.has(priceFeeds, key)) {
						return;
					}
					yield* priceCache.setPrice(key, data);
				});

			const makeHandleDataMessage =
				(exchange: string) => (data: LoTechParsedData) =>
					Match.value(data).pipe(
						Match.discriminatorsExhaustive("type")({
							[LO_TECH_DATA_TYPE_PRICE]: (priceData) =>
								updatePrice(exchange, priceData),
						}),
					);

			const handleAckMessage = (msg: LoTechAck) =>
				Effect.gen(function* () {
					yield* Effect.logDebug("handling ack", { msg });

					const key = MutableHashMap.get(priceFeedIds, msg.ack.id);
					if (Option.isNone(key)) {
						yield* Effect.logWarning("Received ack for unknown price feed ID", {
							msg,
						});
						return;
					}

					MutableHashMap.set(priceFeeds, key.value, msg.ack.id);

					const now = yield* Clock.currentTimeMillis;
					MutableHashMap.set(lastRequestToPriceFeed, key.value, now);
				});

			const handleErrorMessage = (msg: LoTechErrorMessage) =>
				Effect.gen(function* () {
					if (msg.error.code === LoTechSubscriptionFailureCode) {
						yield* Effect.logInfo("Subscription request failed", {
							id: msg.error.id,
						});
						MutableHashMap.remove(priceFeedIds, msg.error.id);
						return;
					}

					yield* Effect.logWarning("Unexpected LO:TECH error message", { msg });
				});

			const getOrCreateWs = (exchange: string) =>
				Effect.gen(function* () {
					const existing = wsByExchange.get(exchange);
					if (existing !== undefined) {
						return existing;
					}

					yield* Effect.logInfo(
						"Creating LO:TECH websocket connection for exchange",
						{ exchange },
					);

					const ws = yield* makeLoTechWebSocketService({
						config,
						exchange,
						runtime,
						handleDataMessage: makeHandleDataMessage(exchange),
						handleAckMessage,
						handleErrorMessage,
					});

					wsByExchange.set(exchange, ws);
					exchanges.add(exchange);
					return ws;
				});

			const subscribePriceOnExchange = (
				exchange: string,
				symbol: string,
				priceFeedId: number,
			) =>
				Effect.gen(function* () {
					const ws = yield* getOrCreateWs(exchange);
					yield* ws.subscribePrice(symbol, priceFeedId);
				});

			const unsubscribePriceOnExchange = (exchange: string, symbol: string) =>
				Effect.gen(function* () {
					const ws = wsByExchange.get(exchange);
					if (ws === undefined) {
						yield* Effect.logError(
							"No LO:TECH websocket connection for exchange",
							{ exchange, symbol },
						);
						return;
					}

					yield* ws.unsubscribePrice(symbol);
				});

			for (const priceFeed of config.priceFeeds) {
				const key = priceFeedKey(priceFeed.exchange, priceFeed.symbol);
				const newSubscriptionId = latestPriceFeedId++;
				MutableHashMap.set(priceFeedIds, newSubscriptionId, key);

				yield* Effect.logInfo(
					`Subscribing to price feed ${priceFeed.symbol} on ${priceFeed.exchange}`,
				);
				yield* subscribePriceOnExchange(
					priceFeed.exchange,
					priceFeed.symbol,
					newSubscriptionId,
				);
			}

			const start = () =>
				Effect.gen(function* () {
					yield* Effect.logInfo("Starting LO:TECH module");

					// Background fiber for handling new price feed subscriptions
					yield* Effect.forkDaemon(
						Effect.gen(function* () {
							while (true) {
								const { symbol, exchange } = yield* newPriceFeedQueue.take;
								const key = priceFeedKey(exchange, symbol);

								yield* Effect.logInfo(
									`Subscribing to price feed ${symbol} on ${exchange}`,
								);

								const newSubscriptionId = latestPriceFeedId++;
								MutableHashMap.set(priceFeedIds, newSubscriptionId, key);

								yield* subscribePriceOnExchange(
									exchange,
									symbol,
									newSubscriptionId,
								);
							}
						}),
					);

					// Background fiber for cleaning up price feeds subscriptions
					yield* Effect.forkDaemon(
						Effect.gen(function* () {
							const now = yield* Clock.currentTimeMillis;
							yield* Effect.logDebug(
								`Cleaning up price feeds (currently running ${priceCache.size()} price feeds)..`,
							);

							for (const [
								key,
								lastRequestTimestamp,
							] of lastRequestToPriceFeed) {
								const cleanupInterval = Duration.toMillis(
									config.priceFeedsCleanupTtl,
								);
								const timeSinceLastRequest = now - lastRequestTimestamp;

								yield* Effect.logDebug(
									`Time since last request for price feed ${key}: ${Duration.format(Duration.decode(timeSinceLastRequest))}`,
								);

								if (timeSinceLastRequest > cleanupInterval) {
									const { exchange, symbol } = parsePriceFeedKey(key);
									yield* Effect.logInfo(
										`Cleaning up price feed ${symbol} on ${exchange}`,
									);
									MutableHashMap.remove(lastRequestToPriceFeed, key);
									yield* priceCache.deletePrice(key);

									const priceFeedId = MutableHashMap.get(priceFeeds, key);

									if (Option.isSome(priceFeedId)) {
										yield* unsubscribePriceOnExchange(exchange, symbol);
										MutableHashMap.remove(priceFeeds, key);
										MutableHashMap.remove(priceFeedIds, priceFeedId.value);
									} else {
										yield* Effect.logError(
											"Failed to find price feed ID for symbol",
											{
												symbol,
												exchange,
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

					const exchange = yield* resolveLoTechExchange(
						params.exchange,
						config,
					);
					const symbolRequests = symbols.map((symbol) => ({
						symbol,
						exchange,
					}));

					const responses: LoTechResponse[] = [];
					const now = yield* Clock.currentTimeMillis;

					// Subscribe to the symbols that we have not subscribed to yet.
					for (const { symbol, exchange } of symbolRequests) {
						const key = priceFeedKey(exchange, symbol);

						if (!MutableHashMap.has(priceFeeds, key)) {
							yield* newPriceFeedQueue.offer({ symbol, exchange });
						}

						MutableHashMap.set(lastRequestToPriceFeed, key, now);
					}

					const prices = yield* Effect.forEach(
						symbolRequests,
						({ symbol, exchange }) =>
							Effect.either(
								priceCache.getOrWaitPrice(priceFeedKey(exchange, symbol)),
							),
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
						return Effect.succeed(createErrorResponse(error, error.status));
					}),
				);

			return {
				start,
				handleRequest,
			};
		}),
	);
