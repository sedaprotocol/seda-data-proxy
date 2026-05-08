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
import {
	FailedToConnectDxFeedError,
	FailedToHandleDxFeedRequestError,
} from "./errors";
import { extractNumericPrice } from "./parse-event-types";
import { createPriceCache } from "./price-cache";
import type { DxFeedDataPrice } from "./schema";

// const DXFEED_CONNECTION_TIMEOUT = Duration.seconds(10);

// const waitForDxFeedConnected = (
// 	feed: Feed,
// 	webSocketUrl: string,
// 	timeout: Duration.Duration,
// ) =>
// 	Effect.gen(function* () {
// 		const timeoutMs = Duration.toMillis(timeout);
// 		const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
// 		while (!feed.subscriptions.state.connected) {
// 			const now = yield* Clock.currentTimeMillis;
// 			if (now >= deadline) {
// 				const err = new FailedToConnectDxFeedError({
// 					webSocketUrl,
// 					timeoutMs,
// 				});
// 				yield* Effect.logError(err.message);
// 				return yield* Effect.fail(err);
// 			}
// 			yield* Effect.sleep(Duration.millis(100));
// 		}
// 		yield* Effect.logInfo("dxFeed connected");
// 	});

export const DxFeedModuleService = (config: DxFeedModuleConfig) =>
	Layer.effect(
		ModuleService,
		Effect.gen(function* () {
			yield* Effect.logInfo("Initializing dxFeed module", {
				name: config.name,
				webSocketUrl: config.webSocketUrl,
			});

			const runtime = yield* Effect.runtime();
			const priceCache = yield* createPriceCache();
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
				// TODO config?
				acceptAggregationPeriod: 10,
				// TODO config?
				acceptDataFormat: FeedDataFormat.FULL,
				acceptEventFields: {
					Quote: config.eventFields,
				},
			});

			feed.addEventListener((events) => {
				for (const event of events) {
					// Fuck you DxFeed
					Runtime.runSync(runtime, Effect.logInfo("dxFeed event", event));
				}
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

			// yield* waitForDxFeedConnected(
			// 	feed,
			// 	config.webSocketUrl,
			// 	DXFEED_CONNECTION_TIMEOUT,
			// ).pipe(Effect.orDie);

			const handleIncomingEvent = (subscribedSymbol: string, event: any) =>
				Effect.gen(function* () {
					yield* Effect.logDebug("dxFeed event", {
						subscribedSymbol,
						event,
					});

					if (
						event.eventSymbol !== subscribedSymbol &&
						!event.eventSymbol.startsWith(`${subscribedSymbol}#`)
					) {
						return;
					}

					const price = extractNumericPrice(event);
					if (price === undefined) {
						return;
					}

					const payload: DxFeedDataPrice = {
						symbol: subscribedSymbol,
						price,
						eventType: event.eventType,
						eventSymbol: event.eventSymbol,
					};
					yield* priceCache.setPrice(subscribedSymbol, payload);
				});

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
									// const configured = eventTypesByConfiguredSymbol.has(symbol);
									// if (configured) {
									// 	continue;
									// }

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

					yield* Effect.logInfo("Handling dxFeed request", { route, params });

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
