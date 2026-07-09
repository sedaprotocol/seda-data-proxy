import {
	type JsonOrBinaryResponse,
	type Request as LazerSubscriptionRequest,
	type ParsedFeedPayload,
	type ParsedPayload,
	PythLazerClient,
	type SymbolResponse,
	type SymbolsQueryParams,
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
} from "./errors";
import { getPriceIdBySymbol } from "./get-symbol-price-id";

// Newly requested feeds get an immediate individual subscription, and a
// periodic compaction pass unifies every individual subscription that proved
// it delivers into one bulk subscription (make-before-break: subscribe the new
// set, overlap briefly, then drop the old bulk and the absorbed individual
// subscriptions). Idle feeds fall out of the bulk set at the same time. The
// upstream then sends one frame per channel tick carrying all feeds instead of
// one frame per feed, which keeps the standing WebSocket load (and the price
// staleness caused by thousands of per-feed frames) flat as feeds grow.
// Cadence is configured per module via bulkCompactInterval and bulkOverlap.

export class FailedToCreateLazerClientError extends Data.TaggedError(
	"FailedToCreateLazerClientError",
)<{ error: string | unknown }> {
	message = `Failed to create Pyth Lazer client: ${this.error}`;
}

type PriceFeedId = number;
type PriceFeedSymbol = string;
type SubscriptionId = number;

interface PriceFeedWithSymbol extends ParsedFeedPayload {
	symbol?: string;
	[HAS_PRICE_KEY]: boolean;
}

/** The subset of PythLazerClient the module talks to. */
export interface LazerClient {
	subscribe(request: LazerSubscriptionRequest): void;
	unsubscribe(subscriptionId: number): void;
	addMessageListener(handler: (event: JsonOrBinaryResponse) => void): void;
	addAllConnectionsDownListener(handler: () => void): void;
	getSymbols(params?: SymbolsQueryParams): Promise<SymbolResponse[]>;
}

/** Error callbacks the module wires into the client's WebSocket pool. */
export interface LazerClientHooks {
	onPoolError: (error: unknown) => void;
	onSocketError: (error: unknown) => void;
}

export const PythLazerModuleService = (config: PythLazerModuleConfig) =>
	Layer.effect(
		ModuleService,
		makePythLazerModule(config, (hooks) =>
			Effect.tryPromise({
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
							onWebSocketPoolError: hooks.onPoolError,
							onWebSocketError: hooks.onSocketError,
						},
					}),
				catch: (error) => new FailedToCreateLazerClientError({ error }),
			}),
		),
	);

export const makePythLazerModule = (
	config: PythLazerModuleConfig,
	acquireClient: (
		hooks: LazerClientHooks,
	) => Effect.Effect<LazerClient, FailedToCreateLazerClientError>,
) =>
	Effect.gen(function* () {
		yield* Effect.logInfo("Initializing Pyth Lazer module");
		const runtime = yield* Effect.runtime();
		const priceCache = yield* createPriceCache<
			PriceFeedId,
			ParsedFeedPayload
		>();
		// The timestamp of the last request to the price feed
		const lastRequestToPriceFeed = MutableHashMap.empty<PriceFeedId, number>();
		const newPriceFeedRequests = yield* Queue.unbounded<PriceFeedId>();
		// price feed id -> subscription id
		const subscriptions = MutableHashMap.empty<PriceFeedId, SubscriptionId>();
		const symbolsToId = MutableHashMap.empty<PriceFeedSymbol, PriceFeedId>();

		const getSymbolByPriceFeedId = (priceFeedId: PriceFeedId) => {
			for (const [symbol, id] of symbolsToId) {
				if (id === priceFeedId) {
					return Option.some(symbol);
				}
			}

			return Option.none();
		};

		let subscriptionId: SubscriptionId = 0;

		// Bulk-subscribe bookkeeping: which subscription ids are individual
		// subscriptions, which feeds the current bulk subscription carries, and
		// which feeds have delivered at least one update. Feeds that never
		// deliver (e.g. entitlement failures) are never absorbed into the bulk
		// subscription, so one bad feed cannot poison it.
		const individualSubscriptionIds = new Set<SubscriptionId>();
		let bulkSubscriptionId: SubscriptionId | undefined;
		let bulkFeedIds = new Set<PriceFeedId>();
		const deliveredFeedIds = new Set<PriceFeedId>();

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

					deliveredFeedIds.add(priceFeed.priceFeedId);
					yield* priceCache.setPrice(priceFeed.priceFeedId, priceFeed);
				}
			});

		const lazerClient = yield* acquireClient({
			onPoolError: (error) => {
				Runtime.runSync(
					runtime,
					Effect.logError("Error in Pyth Lazer client web socket pool"),
				);

				const priceFeedId = extractPriceFeedIdFromErrorMessage(`${error}`);

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
			onSocketError: (error) => {
				Runtime.runSync(
					runtime,
					Effect.logError("Error in Pyth Lazer client web socket", {
						error,
					}),
				);

				console.error(error);
			},
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

		const sendSubscribe = (
			newSubscriptionId: SubscriptionId,
			priceFeedIds: PriceFeedId[],
		) => {
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
				priceFeedIds,
				// Recommended by Pyth case a previously valid feed id becomes invalid (delisting, id changed, etc.)
				ignoreInvalidFeedIds: true,
			});
		};

		// Unifies individual subscriptions that have proven they deliver into a
		// single bulk subscription, and drops feeds that idled out of the bulk
		// set. Make-before-break: the replacement subscription overlaps the old
		// ones before they are unsubscribed, so duplicate frames during the
		// overlap are the only cost (cache writes are latest-wins). Individual
		// subscriptions created during the overlap are absorbed on the next pass.
		const compactSubscriptions = Effect.gen(function* () {
			const absorbable = new Map<PriceFeedId, SubscriptionId>();
			for (const [feedId, subId] of subscriptions) {
				if (
					individualSubscriptionIds.has(subId) &&
					deliveredFeedIds.has(feedId)
				) {
					absorbable.set(feedId, subId);
				}
			}

			const carriedOver = new Set<PriceFeedId>();
			let droppedFromBulk = 0;
			for (const feedId of bulkFeedIds) {
				if (MutableHashMap.has(subscriptions, feedId)) {
					carriedOver.add(feedId);
				} else {
					droppedFromBulk++;
				}
			}

			if (absorbable.size === 0 && droppedFromBulk === 0) {
				return;
			}

			const newFeedIds = new Set([...carriedOver, ...absorbable.keys()]);
			const oldBulkSubscriptionId = bulkSubscriptionId;

			if (newFeedIds.size === 0) {
				if (oldBulkSubscriptionId !== undefined) {
					lazerClient.unsubscribe(oldBulkSubscriptionId);
					bulkSubscriptionId = undefined;
					bulkFeedIds = new Set();
				}
				return;
			}

			const newBulkSubscriptionId = subscriptionId++;
			yield* Effect.logInfo(
				`Compacting subscriptions: ${absorbable.size} individual subscription(s) absorbed, ` +
					`${droppedFromBulk} idle feed(s) dropped, bulk subscription ${newBulkSubscriptionId} ` +
					`now carries ${newFeedIds.size} feed(s)`,
			);

			sendSubscribe(newBulkSubscriptionId, [...newFeedIds]);
			yield* Effect.sleep(config.bulkOverlap);

			if (oldBulkSubscriptionId !== undefined) {
				lazerClient.unsubscribe(oldBulkSubscriptionId);
			}
			for (const subId of absorbable.values()) {
				lazerClient.unsubscribe(subId);
				individualSubscriptionIds.delete(subId);
			}
			for (const feedId of newFeedIds) {
				// Skip feeds that idled out during the overlap; the next pass
				// drops them from the bulk subscription.
				const current = MutableHashMap.get(subscriptions, feedId);
				if (Option.isNone(current)) {
					continue;
				}
				// A feed re-subscribed during the overlap holds a fresh individual
				// subscription that the bulk now supersedes; drop it so it is not
				// orphaned (no feed would map to it, so no later pass could).
				if (
					current.value !== newBulkSubscriptionId &&
					individualSubscriptionIds.has(current.value)
				) {
					lazerClient.unsubscribe(current.value);
					individualSubscriptionIds.delete(current.value);
				}
				MutableHashMap.set(subscriptions, feedId, newBulkSubscriptionId);
			}

			bulkSubscriptionId = newBulkSubscriptionId;
			bulkFeedIds = newFeedIds;
		});

		const start = () =>
			Effect.gen(function* () {
				yield* Effect.logInfo("Starting Pyth Lazer module");

				const now = yield* Clock.currentTimeMillis;
				for (const priceFeed of config.priceFeedIds) {
					yield* newPriceFeedRequests.offer(priceFeed.id);
					// Add a request timestamp so it is tracked in the cleanup interval
					MutableHashMap.set(lastRequestToPriceFeed, priceFeed.id, now);
					// Seed the symbol lookup so requests by symbol skip the metadata service
					MutableHashMap.set(symbolsToId, priceFeed.name, priceFeed.id);
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

						individualSubscriptionIds.add(newSubscriptionId);

						sendSubscribe(newSubscriptionId, [newPriceFeedId]);
					}).pipe(Effect.forever),
				);

				yield* Effect.forkDaemon(
					compactSubscriptions.pipe(
						Effect.catchAllCause((cause) =>
							Effect.logError("Bulk subscription compaction failed", cause),
						),
						// Effect.schedule waits one full interval before the first pass,
						// so compaction never races the initial config-seeded subscribes.
						Effect.schedule(Schedule.spaced(config.bulkCompactInterval)),
					),
				);

				yield* forkIdleCleanup({
					lastRequest: lastRequestToPriceFeed,
					ttl: config.priceFeedsCleanupTtl,
					interval: config.priceFeedsCleanupInterval,
					onExpire: (priceFeedId) =>
						Effect.gen(function* () {
							yield* Effect.logInfo(`Cleaning up price feed ${priceFeedId}`);
							yield* priceCache.deletePrice(priceFeedId);
							deliveredFeedIds.delete(priceFeedId);

							const subscriptionId = MutableHashMap.get(
								subscriptions,
								priceFeedId,
							);
							if (Option.isSome(subscriptionId)) {
								// A feed carried by the bulk subscription must not
								// unsubscribe it: that would drop every other feed. Removing
								// it from the map stops cache writes immediately; the next
								// compaction pass rebuilds the bulk subscription without it.
								if (subscriptionId.value !== bulkSubscriptionId) {
									lazerClient.unsubscribe(subscriptionId.value);
									individualSubscriptionIds.delete(subscriptionId.value);
								}
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

				// Normalize the ids or symbols to price feed ids. Unknown symbols hit
				// the metadata service, so they are resolved concurrently instead of
				// serializing one round trip per symbol.
				const priceFeedIds = yield* Effect.forEach(
					priceFeedIdsRaw,
					(symbolOrId) =>
						Effect.gen(function* () {
							if (!Number.isNaN(Number(symbolOrId))) {
								return Number(symbolOrId);
							}

							// Let's check if the symbol exists otherwise
							const cachedSymbolToPriceFeedId = MutableHashMap.get(
								symbolsToId,
								symbolOrId,
							);

							if (Option.isSome(cachedSymbolToPriceFeedId)) {
								return cachedSymbolToPriceFeedId.value;
							}

							const priceFeedId = yield* getPriceIdBySymbol(
								symbolOrId,
								lazerClient,
							);

							MutableHashMap.set(symbolsToId, symbolOrId, priceFeedId);
							return priceFeedId;
						}),
					{ concurrency: "unbounded" },
				);

				const prices: PriceFeedWithSymbol[] = [];
				const now = yield* Clock.currentTimeMillis;

				// First subscribe to all the symbols that we have not subscribed to yet.
				// The subscriptions map is the source of truth: a lastRequest entry can
				// outlive its subscription when a request races the idle cleanup, and
				// the subscribe daemon dedupes any double offer.
				for (const priceFeedId of priceFeedIds) {
					if (!MutableHashMap.has(subscriptions, priceFeedId)) {
						yield* newPriceFeedRequests.offer(priceFeedId);
					}

					MutableHashMap.set(lastRequestToPriceFeed, priceFeedId, now);
				}

				// Now since the subscriptions are in-flight, we can fetch the prices concurrently.
				const results = yield* Effect.forEach(
					priceFeedIds,
					(priceFeedId) =>
						Effect.either(priceCache.getOrWaitPrice(priceFeedId)),
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
	});
