import { Effect, Layer } from "effect";
import type { Route } from "../../config/config-parser";
import type { HydromancerModuleConfig } from "../../config/hydromancer-module-config";
import { createErrorResponse } from "../../controllers/create-error-response";
import { replaceParams } from "../../utils/replace-params";
import { FailedToHandleRequest, ModuleService } from "../module";
import { FailedToHandleHydromancerRequestError } from "./errors";
import {
	fetchAssetContextsFromRest,
	pickResolvedContexts,
} from "./rest-fallback";

export const HydromancerModuleService = (config: HydromancerModuleConfig) =>
	Layer.effect(
		ModuleService,
		Effect.gen(function* () {
			yield* Effect.logInfo("Initializing Hydromancer module", {
				name: config.name,
				wsUrl: config.wsUrl,
				restBaseUrl: config.restBaseUrl,
			});

			const start = () =>
				Effect.gen(function* () {
					yield* Effect.logInfo("Hydromancer module started", {
						name: config.name,
					});
				}).pipe(Effect.annotateLogs("_name", "hydromancer"));

			const handleRequest = (
				route: Route,
				params: Record<string, string>,
				_request: Request,
			) =>
				Effect.gen(function* () {
					if (route.type !== "hydromancer") {
						return yield* Effect.fail(
							new FailedToHandleRequest({
								msg: "Route is not a Hydromancer module",
							}),
						);
					}

					const coins = replaceParams(route.fetchFromModule, params).split(",");

					if (coins.length > config.maxCoinsPerRequest) {
						return yield* Effect.fail(
							new FailedToHandleHydromancerRequestError({
								error: `Too many coins, max is ${config.maxCoinsPerRequest} but got ${coins.length}`,
								status: 400,
							}),
						);
					}

					const batch = yield* fetchAssetContextsFromRest(config, coins);
					const resolved = pickResolvedContexts(coins, batch);

					return new Response(JSON.stringify(resolved), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}).pipe(
					Effect.withSpan("handleHydromancerRequest"),
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
