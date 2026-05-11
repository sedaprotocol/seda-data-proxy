import "./cometd-bootstrap";
import {
	DXLinkFeed,
	DXLinkWebSocketClient,
	FeedContract,
	FeedDataFormat,
} from "@dxfeed/dxlink-api";
import {
	Clock,
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
import type { DxFeedModuleConfig } from "../../config/dxfeed-module-config";
import { createErrorResponse } from "../../controllers/create-error-response";
import { replaceParams } from "../../utils/replace-params";
import { FailedToHandleRequest, ModuleService } from "../module";
import { createPriceCache } from "../shared/price-cache";
import { FailedToHandleDxFeedRequestError } from "./errors";
import { type DxFeedDataPrice, extractPriceDataFromEvent } from "./schema";

export const DxFeedModuleService = (config: DxFeedModuleConfig) =>
	Layer.effect(
		ModuleService,
		Effect.gen(function* () {
			yield* Effect.logInfo("Initializing dxFeed module", {
				name: config.name,
				webSocketUrl: config.webSocketUrl,
			});

			const runtime = yield* Effect.runtime();
			const priceCache = yield* createPriceCache<string, DxFeedDataPrice>();
			const subscriptions = MutableHashMap.empty<string, number>();
			const unsubscribeBySymbol = MutableHashMap.empty<string, () => void>();
			const newSubscriptionRequests = yield* Queue.unbounded<string>();
			const lastRequestToSubscription = MutableHashMap.empty<string, number>();

			let subscriptionId = 0;

			const client = new DXLinkWebSocketClient();

			if (config.dxfeedAuthToken !== undefined) {
				client.setAuthToken(config.dxfeedAuthToken);
			}

			client.connect(config.webSocketUrl);

			const feed = new DXLinkFeed(client, FeedContract.AUTO);

			feed.configure({
				acceptAggregationPeriod: 10,
				acceptDataFormat: FeedDataFormat.FULL,
				acceptEventFields: {
					// We always want the eventSymbol
					Quote: ["eventSymbol", ...config.eventFields],
				},
			});

			feed.addEventListener((events) => {
				Runtime.runSync(
					runtime,
					Effect.gen(function* () {
						for (const event of events) {
							yield* Effect.logDebug("dxFeed event", event);

							const priceData = extractPriceDataFromEvent(
								event,
								config.eventFields,
							);
							if (priceData === undefined) {
								yield* Effect.logError(
									"Failed to extract price data from event",
									{
										event,
									},
								);
								continue;
							}

							if (MutableHashMap.has(subscriptions, priceData.symbol)) {
								yield* priceCache.setPrice(priceData.symbol, priceData);
							} else {
								yield* Effect.logError(
									"Received event for unsubscribed symbol",
									{
										symbol: priceData.symbol,
									},
								);
							}
						}
					}),
				);
			});

			client.addErrorListener((error) => {
				Runtime.runSync(runtime, Effect.logError("dxFeed error", error));
			});

			const subscribeSymbol = (symbol: string) =>
				Effect.gen(function* () {
					if (MutableHashMap.has(unsubscribeBySymbol, symbol)) {
						return;
					}

					yield* Effect.logInfo(`Subscribing to dxFeed symbol ${symbol}`);

					const subscription = {
						type: "Quote",
						symbol,
					};

					feed.addSubscriptions([subscription]);

					MutableHashMap.set(unsubscribeBySymbol, symbol, () =>
						feed.removeSubscriptions(subscription),
					);
				});

			const unsubscribeSymbol = (symbol: string) => {
				const unsub = MutableHashMap.get(unsubscribeBySymbol, symbol);

				if (Option.isSome(unsub)) {
					unsub.value();
					MutableHashMap.remove(unsubscribeBySymbol, symbol);
					MutableHashMap.remove(subscriptions, symbol);
				}
			};

			for (const symbol of config.subscriptions) {
				const newSubscriptionId = subscriptionId++;
				MutableHashMap.set(subscriptions, symbol, newSubscriptionId);
				yield* subscribeSymbol(symbol);
			}

			const start = () =>
				Effect.gen(function* () {
					yield* Effect.logInfo("Starting dxFeed module");

					// Subscribe to new symbols as they are requested
					yield* Effect.forkDaemon(
						Effect.gen(function* () {
							const newSymbol = yield* newSubscriptionRequests.take;

							yield* Effect.logInfo(
								`Subscribing to dxFeed symbol ${newSymbol}`,
							);

							const newSubscriptionId = subscriptionId++;
							MutableHashMap.set(subscriptions, newSymbol, newSubscriptionId);

							const now = yield* Clock.currentTimeMillis;
							MutableHashMap.set(lastRequestToSubscription, newSymbol, now);

							yield* subscribeSymbol(newSymbol);
						}).pipe(Effect.forever),
					);

					// Clean up subscriptions that haven't been requested in a while
					yield* Effect.forkDaemon(
						Effect.gen(function* () {
							const now = yield* Clock.currentTimeMillis;
							yield* Effect.logDebug(
								`Cleaning up dxFeed subscriptions (running ${priceCache.size()})`,
							);

							for (const [
								symbol,
								lastRequestTimestamp,
							] of lastRequestToSubscription) {
								const cleanupInterval = Duration.toMillis(
									config.subscriptionsCleanupTtl,
								);
								const timeSinceLastRequest = now - lastRequestTimestamp;

								yield* Effect.logDebug(
									`Time since last request for dxFeed ${symbol}: ${Duration.format(Duration.decode(timeSinceLastRequest))}`,
								);

								if (timeSinceLastRequest > cleanupInterval) {
									yield* Effect.logInfo(
										`Cleaning up dxFeed subscription ${symbol}`,
									);
									MutableHashMap.remove(lastRequestToSubscription, symbol);
									yield* priceCache.deletePrice(symbol);

									const id = MutableHashMap.get(subscriptions, symbol);
									if (Option.isSome(id)) {
										unsubscribeSymbol(symbol);
									}
								}
							}
						}).pipe(
							Effect.schedule(
								Schedule.spaced(config.subscriptionsCleanupInterval),
							),
						),
					);
				}).pipe(Effect.annotateLogs("_name", "dxfeed"));

			const handleRequest = (
				route: Route,
				params: Record<string, string>,
				request: Request,
			) =>
				Effect.gen(function* () {
					if (route.type !== "dxfeed") {
						return yield* Effect.fail(
							new FailedToHandleRequest({
								msg: "Route is not a dxFeed module",
							}),
						);
					}

					yield* Effect.logDebug("Handling dxFeed request", { route, params });

					const symbols = replaceParams(route.fetchFromModule, params)
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean);

					if (symbols.length > config.maxFeedsPerRequest) {
						return yield* Effect.succeed(
							createErrorResponse(
								new FailedToHandleDxFeedRequestError({
									error: `Too many symbols requested, max is ${config.maxFeedsPerRequest} but got ${symbols.length}`,
								}),
								400,
							),
						);
					}

					const prices: DxFeedDataPrice[] = [];
					const now = yield* Clock.currentTimeMillis;

					for (const symbol of symbols) {
						const lastRequestTimestamp = MutableHashMap.get(
							lastRequestToSubscription,
							symbol,
						);
						if (Option.isNone(lastRequestTimestamp)) {
							yield* newSubscriptionRequests.offer(symbol);
						}
						MutableHashMap.set(lastRequestToSubscription, symbol, now);

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
					Effect.withSpan("handleDxFeedRequest"),
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
