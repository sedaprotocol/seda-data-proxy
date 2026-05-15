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
import {
	type DxFeedEventType,
	type DxFeedKey,
	type DxFeedModuleConfig,
	dxfeedKey,
} from "../../config/dxfeed-module-config";
import { createErrorResponse } from "../../controllers/create-error-response";
import { replaceParams } from "../../utils/replace-params";
import { FailedToHandleRequest, ModuleService } from "../module";
import { createPriceCache } from "../shared/price-cache";
import { FailedToHandleDxFeedRequestError } from "./errors";
import {
	type DxFeedFullEventData,
	extractFullEventDataFromEvent,
} from "./schema";

export const DxFeedModuleService = (config: DxFeedModuleConfig) =>
	Layer.effect(
		ModuleService,
		Effect.gen(function* () {
			yield* Effect.logInfo("Initializing dxFeed module", {
				name: config.name,
				webSocketUrl: config.webSocketUrl,
			});

			const runtime = yield* Effect.runtime();
			const priceCache = yield* createPriceCache<
				DxFeedKey,
				DxFeedFullEventData
			>();
			const subscriptions = MutableHashMap.empty<DxFeedKey, number>();
			const unsubscribeByKey = MutableHashMap.empty<DxFeedKey, () => void>();
			const newSubscriptionRequests = yield* Queue.unbounded<{
				symbol: string;
				eventType: DxFeedEventType;
			}>();
			const lastRequestByKey = MutableHashMap.empty<DxFeedKey, number>();

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
			});

			feed.addEventListener((events) => {
				Runtime.runSync(
					runtime,
					Effect.gen(function* () {
						for (const event of events) {
							yield* Effect.logDebug("dxFeed event", event);

							const priceData = extractFullEventDataFromEvent(event);
							if (priceData === undefined) {
								yield* Effect.logError(
									"Failed to extract price data from event",
									{
										event,
									},
								);
								continue;
							}

							const eventType =
								((event as Record<string, unknown>).eventType as string) ??
								"Quote";
							const key = dxfeedKey(
								priceData.symbol,
								eventType as DxFeedEventType,
							);

							if (MutableHashMap.has(subscriptions, key)) {
								yield* priceCache.setPrice(key, priceData);
							} else {
								yield* Effect.logError("Received event for unsubscribed key", {
									key,
								});
							}
						}
					}),
				);
			});

			client.addErrorListener((error) => {
				Runtime.runSync(runtime, Effect.logError("dxFeed error", error));
			});

			const subscribeSymbol = (
				symbol: string,
				eventType: DxFeedEventType = "Quote",
			) =>
				Effect.gen(function* () {
					const key = dxfeedKey(symbol, eventType);
					if (MutableHashMap.has(unsubscribeByKey, key)) {
						return;
					}

					yield* Effect.logInfo(
						`Subscribing to dxFeed symbol ${symbol} (${eventType})`,
					);

					const subscription = {
						type: eventType,
						symbol,
					};

					feed.addSubscriptions([subscription]);

					MutableHashMap.set(unsubscribeByKey, key, () =>
						feed.removeSubscriptions(subscription),
					);
				});

			const unsubscribeByCompositeKey = (key: string) => {
				const unsub = MutableHashMap.get(unsubscribeByKey, key);

				if (Option.isSome(unsub)) {
					unsub.value();
					MutableHashMap.remove(unsubscribeByKey, key);
					MutableHashMap.remove(subscriptions, key);
				}
			};

			for (const sub of config.subscriptions) {
				const symbol = sub.symbol;
				const eventType = sub.type;

				const key = dxfeedKey(symbol, eventType);
				const newSubscriptionId = subscriptionId++;
				MutableHashMap.set(subscriptions, key, newSubscriptionId);
				yield* subscribeSymbol(symbol, eventType);
			}

			const start = () =>
				Effect.gen(function* () {
					yield* Effect.logInfo("Starting dxFeed module");

					// Subscribe to new symbols as they are requested
					yield* Effect.forkDaemon(
						Effect.gen(function* () {
							const { symbol, eventType } = yield* newSubscriptionRequests.take;
							const key = dxfeedKey(symbol, eventType);

							yield* Effect.logInfo(
								`Subscribing to dxFeed symbol ${symbol} (${eventType})`,
							);

							const newSubscriptionId = subscriptionId++;
							MutableHashMap.set(subscriptions, key, newSubscriptionId);

							const now = yield* Clock.currentTimeMillis;
							MutableHashMap.set(lastRequestByKey, key, now);

							yield* subscribeSymbol(symbol, eventType);
						}).pipe(Effect.forever),
					);

					// Clean up subscriptions that haven't been requested in a while
					yield* Effect.forkDaemon(
						Effect.gen(function* () {
							const now = yield* Clock.currentTimeMillis;
							yield* Effect.logDebug(
								`Cleaning up dxFeed subscriptions (running ${priceCache.size()})`,
							);

							for (const [key, lastRequestTimestamp] of lastRequestByKey) {
								const cleanupInterval = Duration.toMillis(
									config.subscriptionsCleanupTtl,
								);
								const timeSinceLastRequest = now - lastRequestTimestamp;

								yield* Effect.logDebug(
									`Time since last request for dxFeed ${key}: ${Duration.format(Duration.decode(timeSinceLastRequest))}`,
								);

								if (timeSinceLastRequest > cleanupInterval) {
									yield* Effect.logInfo(
										`Cleaning up dxFeed subscription ${key}`,
									);
									MutableHashMap.remove(lastRequestByKey, key);
									yield* priceCache.deletePrice(key);

									const id = MutableHashMap.get(subscriptions, key);
									if (Option.isSome(id)) {
										unsubscribeByCompositeKey(key);
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

					const eventType: DxFeedEventType =
						route.type === "dxfeed" ? (route.eventType ?? "Quote") : "Quote";

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

					const prices: DxFeedFullEventData[] = [];
					const now = yield* Clock.currentTimeMillis;

					for (const symbol of symbols) {
						const key = dxfeedKey(symbol, eventType);
						const lastRequestTimestamp = MutableHashMap.get(
							lastRequestByKey,
							key,
						);
						if (Option.isNone(lastRequestTimestamp)) {
							yield* newSubscriptionRequests.offer({ symbol, eventType });
						}
						MutableHashMap.set(lastRequestByKey, key, now);

						const price = yield* priceCache.getOrWaitPrice(key).pipe(
							Effect.catchTag("FailedToGetPriceError", (error) =>
								Effect.gen(function* () {
									yield* priceCache.deletePrice(key);
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
