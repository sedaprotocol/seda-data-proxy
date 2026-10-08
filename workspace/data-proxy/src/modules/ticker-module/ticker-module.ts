import { Clock, type Duration, Effect, Layer, MutableHashMap } from "effect";
import type { Route } from "../../config/config-parser";
import { HAS_PRICE_KEY } from "../../constants";
import { createErrorResponse } from "../../controllers/create-error-response";
import { forkIdleCleanup } from "../../utils/idle-cleanup";
import { replaceParams } from "../../utils/replace-params";
import { FailedToHandleRequest, ModuleService } from "../module";
import {
	type PriceCache,
	type PriceCacheApply,
	createPriceCache,
} from "../shared/price-cache";
import type { VenueWS } from "../shared/venue-ws";
import { FailedToHandleTickerRequestError } from "./errors";

export interface TickerModuleServiceConfig {
	name: string;
	wsUrl: string;
	subscriptionSymbols: readonly string[];
	maxSymbolsPerRequest: number;
	symbolsCleanupTtl: Duration.Duration;
	symbolsCleanupInterval: Duration.Duration;
}

export const parseUppercaseSymbol = (token: string): string =>
	token.toUpperCase();

export type TickerModuleCacheApply<TFrame> = (
	prev: TFrame | undefined,
	next: TFrame,
	now: number,
) => TFrame;

export type TickerModuleCachePostReadUpdate<TFrame> = (
	cacheHit: TFrame,
	now: number,
) => TFrame;

export interface CreateTickerModuleServiceParams<
	TKey,
	TFrame,
	TConfig extends TickerModuleServiceConfig,
> {
	venue: string;
	routeType: Route["type"];
	identityField: string;
	config: TConfig;
	parseKey: (token: string) => TKey | null;
	createWS: (
		config: TConfig,
		cache: PriceCache<TKey, TFrame>,
	) => Effect.Effect<VenueWS<TKey>, never, never>;
	/**
	 * Custom cache apply, used when replacing the cached frame with the incoming one is not enough.
	 * `now` is the Effect clock in milliseconds, read on each write.
	 */
	cacheApply?: TickerModuleCacheApply<TFrame>;
	/**
	 * In case of a cache hit, the request handler calls this function to produce the value to
	 * return as a result and update the cache with.
	 */
	cachePostReadUpdate?: TickerModuleCachePostReadUpdate<TFrame>;
	extraInitLog?: Record<string, unknown>;
}

const titleCase = (venue: string) =>
	`${venue.charAt(0).toUpperCase()}${venue.slice(1)}`;

/**
 * HTTP + cache + idle-cleanup loop shared by public ticker modules.
 * Venue protocol stays in each createWS; parseKey turns request tokens into
 * cache/subscribe keys.
 */
export const createTickerModuleService = <
	TKey,
	TFrame,
	TConfig extends TickerModuleServiceConfig,
>(
	params: CreateTickerModuleServiceParams<TKey, TFrame, TConfig>,
) =>
	Layer.effect(
		ModuleService,
		Effect.gen(function* () {
			const {
				venue,
				routeType,
				identityField,
				config,
				parseKey,
				createWS,
				cacheApply,
				cachePostReadUpdate,
				extraInitLog,
			} = params;

			yield* Effect.logInfo(`Initializing ${venue} module`, {
				name: config.name,
				wsUrl: config.wsUrl,
				...extraInitLog,
			});

			let apply: PriceCacheApply<TFrame> | undefined;
			if (cacheApply !== undefined) {
				const clock = yield* Clock.clockWith((clock) => Effect.succeed(clock));
				apply = (prev, next) =>
					cacheApply(prev, next, clock.unsafeCurrentTimeMillis());
			}
			const cache = yield* createPriceCache<TKey, TFrame>({ apply });
			const ws = yield* createWS(config, cache);
			const lastRequestToKey = MutableHashMap.empty<TKey, number>();

			const start = () =>
				Effect.gen(function* () {
					yield* Effect.logInfo(`Starting ${venue} module`, {
						name: config.name,
					});

					yield* ws.start();

					if (config.subscriptionSymbols.length > 0) {
						const now = yield* Clock.currentTimeMillis;
						const seeded: TKey[] = [];
						for (const token of config.subscriptionSymbols) {
							const key = parseKey(token);
							if (key === null) continue;
							if (!MutableHashMap.has(lastRequestToKey, key)) {
								seeded.push(key);
							}
							MutableHashMap.set(lastRequestToKey, key, now);
						}
						if (seeded.length > 0) {
							yield* ws.subscribe(seeded);
						}
					}

					yield* forkIdleCleanup({
						lastRequest: lastRequestToKey,
						ttl: config.symbolsCleanupTtl,
						interval: config.symbolsCleanupInterval,
						onExpire: (key) =>
							Effect.gen(function* () {
								yield* Effect.logInfo("Cleaning up idle key", { key });
								yield* cache.deletePrice(key);
								yield* ws.unsubscribe([key]);
							}),
					});
				}).pipe(Effect.annotateLogs("_name", venue));

			const handleRequest = (
				route: Route,
				routeParams: Record<string, string>,
				_request: Request,
			) =>
				Effect.gen(function* () {
					if (
						route.type !== routeType ||
						!("fetchFromModule" in route) ||
						typeof route.fetchFromModule !== "string"
					) {
						return yield* Effect.fail(
							new FailedToHandleRequest({
								msg: `Route is not a ${titleCase(venue)} module`,
							}),
						);
					}

					const requestedTokens = replaceParams(
						route.fetchFromModule,
						routeParams,
					)
						.split(",")
						.map((token) => token.trim())
						.filter((token) => token.length > 0);

					if (requestedTokens.length > config.maxSymbolsPerRequest) {
						return yield* Effect.fail(
							new FailedToHandleTickerRequestError({
								error: `Too many symbols, max is ${config.maxSymbolsPerRequest} but got ${requestedTokens.length}`,
								status: 400,
								moduleName: config.name,
							}),
						);
					}

					const requested = requestedTokens.map((token) => ({
						token,
						key: parseKey(token),
					}));

					const now = yield* Clock.currentTimeMillis;
					const socketHealthy = !(yield* ws.hasError());
					const newKeys: TKey[] = [];
					for (const { key } of requested) {
						if (key === null) continue;
						if (!MutableHashMap.has(lastRequestToKey, key)) {
							newKeys.push(key);
						}
						MutableHashMap.set(lastRequestToKey, key, now);
					}

					if (newKeys.length > 0) {
						yield* ws.subscribe(newKeys);
					}

					const results = yield* Effect.forEach(
						requested,
						({ key }) => {
							if (key === null) return Effect.succeed(null);
							if (cachePostReadUpdate === undefined || !socketHealthy) {
								return cache.getOrWaitPrice(key);
							}
							return Effect.gen(function* () {
								const cached = yield* cache.getOrWaitPrice(key);
								if (cached === null) return null;
								const servedAt = yield* Clock.currentTimeMillis;
								const kept = cachePostReadUpdate(cached, servedAt);
								if (kept !== cached) cache.replaceCached(key, kept);
								return kept;
							});
						},
						{ concurrency: "unbounded" },
					);

					const prices: Array<Record<string, unknown>> = [];
					for (let i = 0; i < requested.length; i++) {
						const { token } = requested[i];
						const result = results[i];

						if (result === null || !socketHealthy) {
							prices.push({
								[identityField]: token,
								[HAS_PRICE_KEY]: false,
							});
						} else {
							prices.push({
								...result,
								[identityField]: token,
								[HAS_PRICE_KEY]: true,
							});
						}
					}

					return new Response(JSON.stringify(prices), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}).pipe(
					Effect.withSpan(`handle${titleCase(venue)}Request`),
					Effect.catchAll((error) =>
						Effect.succeed(createErrorResponse(error, error.status)),
					),
				);

			return {
				start,
				handleRequest,
			};
		}),
	);
