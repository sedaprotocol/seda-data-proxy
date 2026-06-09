import { Duration, Effect, Option } from "effect";
import * as v from "valibot";
import { RouteSchema } from "./route-config";

export const LighterModuleConfigSchema = v.strictObject({
	name: v.string(),
	type: v.literal("lighter"),
	wsUrl: v.optional(v.string(), "wss://mainnet.zklighter.elliot.ai/stream"),
	// Lighter numeric market ids (e.g. 1 for BTC) to subscribe at startup.
	subscriptionMarketIds: v.optional(v.array(v.number()), []),
	maxMarketsPerRequest: v.optional(v.number(), 100),
	keepaliveInterval: v.pipe(
		v.optional(v.union([v.number(), v.string()]), "60 seconds"),
		v.transform((value) =>
			Option.getOrThrowWith(
				Duration.decodeUnknown(value),
				() => new Error("Invalid keepaliveInterval duration"),
			),
		),
	),
	reconnectMaxBackoff: v.pipe(
		v.optional(v.union([v.number(), v.string()]), "30 seconds"),
		v.transform((value) =>
			Option.getOrThrowWith(
				Duration.decodeUnknown(value),
				() => new Error("Invalid reconnectMaxBackoff duration"),
			),
		),
	),
	reconnectStableThreshold: v.pipe(
		v.optional(v.union([v.number(), v.string()]), "30 seconds"),
		v.transform((value) =>
			Option.getOrThrowWith(
				Duration.decodeUnknown(value),
				() => new Error("Invalid reconnectStableThreshold duration"),
			),
		),
	),
	marketsCleanupTtl: v.pipe(
		v.optional(v.union([v.number(), v.string()]), "1 hour"),
		v.transform((ttl) =>
			Option.getOrThrowWith(
				Duration.decodeUnknown(ttl),
				() => new Error("Invalid markets cleanup TTL"),
			),
		),
	),
	marketsCleanupInterval: v.pipe(
		v.optional(v.union([v.number(), v.string()]), "30 seconds"),
		v.transform((interval) =>
			Option.getOrThrowWith(
				Duration.decodeUnknown(interval),
				() => new Error("Invalid markets cleanup interval"),
			),
		),
	),
});

export type LighterModuleConfig = v.InferOutput<
	typeof LighterModuleConfigSchema
>;

export const LighterModuleRouteSchema = v.strictObject({
	...RouteSchema.entries,
	moduleName: v.string(),
	fetchFromModule: v.string(),
	type: v.literal("lighter"),
});

export type LighterModuleRoute = v.InferOutput<typeof LighterModuleRouteSchema>;

export const validateLighterModuleRoute = (_route: LighterModuleRoute) =>
	Effect.gen(function* () {
		return yield* Effect.void;
	});
