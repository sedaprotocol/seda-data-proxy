import "./cometd-bootstrap";
import { Feed, type IEvent } from "@dxfeed/api";
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
import type {
	DxFeedEventTypeName,
	DxFeedModuleConfig,
} from "../../config/dxfeed-module-config";
import { createErrorResponse } from "../../controllers/create-error-response";
import { replaceParams } from "../../utils/replace-params";
import { FailedToHandleRequest, ModuleService } from "../module";
import {
	FailedToConnectDxFeedError,
	FailedToHandleDxFeedRequestError,
} from "./errors";
import {
	extractNumericPrice,
	parseDxFeedEventTypes,
} from "./parse-event-types";
import { createPriceCache } from "./price-cache";
import type { DxFeedDataPrice } from "./schema";

const DXFEED_CONNECTION_TIMEOUT = Duration.seconds(10);

const waitForDxFeedConnected = (
	feed: Feed,
	webSocketUrl: string,
	timeout: Duration.Duration,
) =>
	Effect.gen(function* () {
		const timeoutMs = Duration.toMillis(timeout);
		const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
		while (!feed.subscriptions.state.connected) {
			const now = yield* Clock.currentTimeMillis;
			if (now >= deadline) {
				const err = new FailedToConnectDxFeedError({
					webSocketUrl,
					timeoutMs,
				});
				yield* Effect.logError(err.message);
				return yield* Effect.fail(err);
			}
			yield* Effect.sleep(Duration.millis(100));
		}
		yield* Effect.logInfo("dxFeed connected");
	});

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

			const defaultEventTypeNames = config.defaultEventTypes;

			const eventTypesByConfiguredSymbol = new Map(
				config.subscriptions.map((sub) => [
					sub.symbol,
					sub.eventTypes ?? defaultEventTypeNames,
				]),
			);

			const resolveEventTypeNamesForSymbol = (
				symbol: string,
			): readonly DxFeedEventTypeName[] => {
				const fromConfig = eventTypesByConfiguredSymbol.get(symbol);
				return fromConfig ?? defaultEventTypeNames;
			};

			const feed = new Feed();

			if (config.dxfeedAuthToken !== undefined) {
				feed.setAuthToken(config.dxfeedAuthToken);
			}

			yield* Effect.sync(() => {
				feed.connect(config.webSocketUrl);
			}).pipe(Effect.orDie);

			yield* waitForDxFeedConnected(
				feed,
				config.webSocketUrl,
				DXFEED_CONNECTION_TIMEOUT,
			).pipe(Effect.orDie);

			const handleIncomingEvent = (subscribedSymbol: string, event: IEvent) =>
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

			const subscribeMarketData = (symbol: string) =>
				Effect.gen(function* () {
					if (MutableHashMap.has(unsubscribeBySymbol, symbol)) {
						return;
					}

					const eventTypeNames = resolveEventTypeNamesForSymbol(symbol);
					const eventTypes = parseDxFeedEventTypes(eventTypeNames);

					yield* Effect.logInfo(`Subscribing to dxFeed symbol ${symbol}`, {
						eventTypes: eventTypeNames,
					});

					const unsub = feed.subscribe<IEvent>(
						eventTypes,
						[symbol],
						(event) => {
							Runtime.runFork(
								runtime,
								handleIncomingEvent(symbol, event).pipe(
									Effect.catchAll((error) =>
										Effect.logError(`dxFeed handler error: ${String(error)}`),
									),
								),
							);
						},
					);

					MutableHashMap.set(unsubscribeBySymbol, symbol, unsub);
				});

			const unsubscribeSymbol = (symbol: string) =>
				Effect.sync(() => {
					const unsub = MutableHashMap.get(unsubscribeBySymbol, symbol);
					if (Option.isSome(unsub)) {
						unsub.value();
						MutableHashMap.remove(unsubscribeBySymbol, symbol);
						MutableHashMap.remove(subscriptions, symbol);
					}
				});

			for (const sub of config.subscriptions) {
				const newSubscriptionId = subscriptionId++;
				MutableHashMap.set(subscriptions, sub.symbol, newSubscriptionId);
				yield* subscribeMarketData(sub.symbol);
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

							yield* subscribeMarketData(newSymbol);
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
									const configured = eventTypesByConfiguredSymbol.has(symbol);
									if (configured) {
										continue;
									}

									yield* Effect.logInfo(
										`Cleaning up dxFeed subscription ${symbol}`,
									);
									MutableHashMap.remove(lastRequestToSubscription, symbol);
									yield* priceCache.deletePrice(symbol);

									const id = MutableHashMap.get(subscriptions, symbol);
									if (Option.isSome(id)) {
										yield* unsubscribeSymbol(symbol);
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
