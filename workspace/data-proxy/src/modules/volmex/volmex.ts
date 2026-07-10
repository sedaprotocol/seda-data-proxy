import { Effect, Either, Layer } from "effect";
import type { Route } from "../../config/config-parser";
import type { VolmexModuleConfig } from "../../config/volmex-module-config";
import { HAS_PRICE_KEY } from "../../constants";
import { createErrorResponse } from "../../controllers/create-error-response";
import { replaceParams } from "../../utils/replace-params";
import { FailedToHandleRequest, ModuleService } from "../module";
import { createPriceCache } from "../shared/price-cache";
import { FailedToHandleVolmexRequestError } from "./errors";
import type { VolmexDataPrice, VolmexResponse } from "./schema";
import { makeVolmexWebSocketService } from "./ws-client";

export const VolmexModuleService = (config: VolmexModuleConfig) =>
	Layer.effect(
		ModuleService,
		Effect.gen(function* () {
			yield* Effect.logInfo("Initializing Volmex module");

			const runtime = yield* Effect.runtime();
			const priceCache = yield* createPriceCache<string, VolmexDataPrice>();

			const updatePrice = (data: VolmexDataPrice) =>
				Effect.gen(function* () {
					yield* Effect.logDebug("Received message from Volmex client", data);
					yield* priceCache.setPrice(data.symbol, data);
				});

			yield* makeVolmexWebSocketService({
				config,
				runtime,
				onPrice: updatePrice,
			});

			const start = () =>
				Effect.gen(function* () {
					yield* Effect.logInfo("Starting Volmex module");
				}).pipe(Effect.annotateLogs("_name", "volmex"));

			const handleRequest = (
				route: Route,
				params: Record<string, string>,
				_request: Request,
			) =>
				Effect.gen(function* () {
					if (route.type !== "volmex") {
						return yield* Effect.fail(
							new FailedToHandleRequest({
								msg: "Route is not a Volmex module",
							}),
						);
					}

					yield* Effect.logDebug("Handling Volmex request", { route, params });

					const symbols = replaceParams(route.fetchFromModule, params)
						.split(",")
						.map((symbol) => symbol.trim())
						.filter((symbol) => symbol.length > 0);

					if (symbols.length > config.maxSymbolsPerRequest) {
						return yield* Effect.succeed(
							createErrorResponse(
								new FailedToHandleVolmexRequestError({
									error: `Too many symbols requested, max is ${config.maxSymbolsPerRequest} but got ${symbols.length}`,
								}),
								400,
							),
						);
					}

					const prices = yield* Effect.forEach(
						symbols,
						(symbol) => Effect.either(priceCache.getOrWaitPrice(symbol)),
						{ concurrency: "unbounded" },
					);

					const responses: VolmexResponse[] = [];
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
					Effect.withSpan("handleVolmexRequest"),
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
