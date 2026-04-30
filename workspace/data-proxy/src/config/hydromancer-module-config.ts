import { Duration, Effect, Option } from "effect";
import * as v from "valibot";
import { RouteSchema } from "./route-config";

export const HydromancerModuleConfigSchema = v.strictObject({
	name: v.string(),
	type: v.literal("hydromancer"),
	wsUrl: v.string(),
	restBaseUrl: v.string(),
	hydromancerApiKeyEnvKey: v.string(),
	staleAfter: v.pipe(
		v.optional(v.union([v.number(), v.string()]), "10 seconds"),
		v.transform((value) =>
			Option.getOrThrowWith(
				Duration.decodeUnknown(value),
				() => new Error("Invalid staleAfter duration"),
			),
		),
	),
	subscriptionCoins: v.optional(v.array(v.string()), []),
	maxCoinsPerRequest: v.optional(v.number(), 20),
	reconnectMaxBackoff: v.pipe(
		v.optional(v.union([v.number(), v.string()]), "30 seconds"),
		v.transform((value) =>
			Option.getOrThrowWith(
				Duration.decodeUnknown(value),
				() => new Error("Invalid reconnectMaxBackoff duration"),
			),
		),
	),
	coinsCleanupTtl: v.pipe(
		v.optional(v.union([v.number(), v.string()]), "2 minutes"),
		v.transform((ttl) =>
			Option.getOrThrowWith(
				Duration.decodeUnknown(ttl),
				() => new Error("Invalid coin cleanup TTL"),
			),
		),
	),
	coinsCleanupInterval: v.pipe(
		v.optional(v.union([v.number(), v.string()]), "30 seconds"),
		v.transform((interval) =>
			Option.getOrThrowWith(
				Duration.decodeUnknown(interval),
				() => new Error("Invalid coin cleanup interval"),
			),
		),
	),
});

export interface HydromancerModuleConfig
	extends v.InferOutput<typeof HydromancerModuleConfigSchema> {
	hydromancerApiKey: string;
}

export const HydromancerModuleRouteSchema = v.strictObject({
	...RouteSchema.entries,
	type: v.literal("hydromancer"),
	moduleName: v.string(),
	fetchFromModule: v.string(),
});

export type HydromancerModuleRoute = v.InferOutput<
	typeof HydromancerModuleRouteSchema
>;

export const validateHydromancerModuleRoute = (route: HydromancerModuleRoute) =>
	Effect.gen(function* () {
		return yield* Effect.void;
	});

export const AssetCtxSchema = v.object({
	oraclePx: v.nullable(v.string()),
	markPx: v.nullable(v.string()),
	midPx: v.nullable(v.string()),
	impactPxs: v.nullable(v.array(v.string())),
	openInterest: v.nullable(v.string()),
});

export type AssetCtx = v.InferOutput<typeof AssetCtxSchema>;
