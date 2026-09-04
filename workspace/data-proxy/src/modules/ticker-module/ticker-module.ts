import { Clock, type Duration, Effect, Layer, MutableHashMap } from "effect";
import type { Route } from "../../config/config-parser";
import { HAS_PRICE_KEY } from "../../constants";
import { createErrorResponse } from "../../controllers/create-error-response";
import { forkIdleCleanup } from "../../utils/idle-cleanup";
import { replaceParams } from "../../utils/replace-params";
import { FailedToHandleRequest, ModuleService } from "../module";
import { type PriceCache, createPriceCache } from "../shared/price-cache";
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

export interface CreateTickerModuleServiceParams<
	TFrame,
	TConfig extends TickerModuleServiceConfig,
> {
	venue: string;
	routeType: Route["type"];
	identityField: string;
	config: TConfig;
	createWS: (
		config: TConfig,
		cache: PriceCache<string, TFrame>,
	) => Effect.Effect<VenueWS, never, never>;
	extraInitLog?: Record<string, unknown>;
}

const titleCase = (venue: string) =>
	`${venue.charAt(0).toUpperCase()}${venue.slice(1)}`;

/**
 * HTTP + cache + idle-cleanup loop shared by string-keyed public ticker
 * modules. Venue protocol stays in each createWS.
 */
export const createTickerModuleService = <
	TFrame,
	TConfig extends TickerModuleServiceConfig,
>(
	params: CreateTickerModuleServiceParams<TFrame, TConfig>,
) =>
	Layer.effect(
		ModuleService,
		Effect.gen(function* () {
			const {
				venue,
				routeType,
				identityField,
				config,
				createWS,
				extraInitLog,
			} = params;

			yield* Effect.logInfo(`Initializing ${venue} module`, {
				name: config.name,
				wsUrl: config.wsUrl,
				...extraInitLog,
			});

			const cache = yield* createPriceCache<string, TFrame>();
			const ws = yield* createWS(config, cache);
			const lastRequestToSymbol = MutableHashMap.empty<string, number>();

			const start = () =>
				Effect.gen(function* () {
					yield* Effect.logInfo(`Starting ${venue} module`, {
						name: config.name,
					});

					yield* ws.start();

					if (config.subscriptionSymbols.length > 0) {
						const now = yield* Clock.currentTimeMillis;
						const seeded = config.subscriptionSymbols.map((symbol) =>
							symbol.toUpperCase(),
						);
						for (const symbol of seeded) {
							MutableHashMap.set(lastRequestToSymbol, symbol, now);
						}
						yield* ws.subscribe(seeded);
					}

					yield* forkIdleCleanup({
						lastRequest: lastRequestToSymbol,
						ttl: config.symbolsCleanupTtl,
						interval: config.symbolsCleanupInterval,
						onExpire: (symbol) =>
							Effect.gen(function* () {
								yield* Effect.logInfo("Cleaning up idle symbol", { symbol });
								yield* cache.deletePrice(symbol);
								yield* ws.unsubscribe([symbol]);
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

					const requestedSymbols = replaceParams(
						route.fetchFromModule,
						routeParams,
					)
						.split(",")
						.map((symbol) => symbol.trim())
						.filter((symbol) => symbol.length > 0);

					if (requestedSymbols.length > config.maxSymbolsPerRequest) {
						return yield* Effect.fail(
							new FailedToHandleTickerRequestError({
								error: `Too many symbols, max is ${config.maxSymbolsPerRequest} but got ${requestedSymbols.length}`,
								status: 400,
								moduleName: config.name,
							}),
						);
					}

					const now = yield* Clock.currentTimeMillis;
					const socketHealthy = !(yield* ws.hasError());
					const newSymbols: string[] = [];
					for (const requested of requestedSymbols) {
						const symbol = requested.toUpperCase();
						if (!MutableHashMap.has(lastRequestToSymbol, symbol)) {
							newSymbols.push(symbol);
						}
						MutableHashMap.set(lastRequestToSymbol, symbol, now);
					}

					if (newSymbols.length > 0) {
						yield* ws.subscribe(newSymbols);
					}

					const results = yield* Effect.forEach(
						requestedSymbols,
						(requested) => cache.getOrWaitPrice(requested.toUpperCase()),
						{ concurrency: "unbounded" },
					);

					const prices: Array<Record<string, unknown>> = [];
					for (let i = 0; i < requestedSymbols.length; i++) {
						const requested = requestedSymbols[i];
						const result = results[i];

						if (result === null || !socketHealthy) {
							prices.push({
								[identityField]: requested,
								[HAS_PRICE_KEY]: false,
							});
						} else {
							prices.push({
								...result,
								[identityField]: requested,
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
