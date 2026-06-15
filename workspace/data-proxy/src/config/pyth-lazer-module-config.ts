import { Duration, Effect, Option } from "effect";
import * as v from "valibot";
import { RouteSchema } from "./route-config";

export const PythLazerModuleConfigSchema = v.strictObject({
	name: v.string(),
	priceFeedIds: v.array(
		v.object({
			name: v.string(),
			id: v.number(),
		}),
	),
	channel: v.optional(
		v.picklist([
			"real_time",
			"fixed_rate@50ms",
			"fixed_rate@1000ms",
			"fixed_rate@200ms",
		]),
		"fixed_rate@200ms",
	),
	maxFeedsPerRequest: v.optional(v.number(), 100),
	pythLazerApiKeyEnvKey: v.string(),
	priceFeedsCleanupTtl: v.pipe(
		v.optional(v.union([v.number(), v.string()]), "1 hour"),
		v.transform((ttl) =>
			Option.getOrThrowWith(
				Duration.decodeUnknown(ttl),
				() => new Error("Invalid price feed cleanup TTL"),
			),
		),
	),
	priceFeedsCleanupInterval: v.pipe(
		v.optional(v.union([v.number(), v.string()]), "30 seconds"),
		v.transform((interval) =>
			Option.getOrThrowWith(
				Duration.decodeUnknown(interval),
				() => new Error("Invalid price feed cleanup interval"),
			),
		),
	),
	// How often the compaction pass folds individual subscriptions into one
	// bulk subscription.
	bulkCompactInterval: v.pipe(
		v.optional(v.union([v.number(), v.string()]), "60 seconds"),
		v.transform((interval) =>
			Option.getOrThrowWith(
				Duration.decodeUnknown(interval),
				() => new Error("Invalid bulk compaction interval"),
			),
		),
	),
	// Make-before-break overlap: how long the new bulk subscription runs
	// alongside the subscriptions it replaces before they are dropped.
	bulkOverlap: v.pipe(
		v.optional(v.union([v.number(), v.string()]), "1 second"),
		v.transform((overlap) =>
			Option.getOrThrowWith(
				Duration.decodeUnknown(overlap),
				() => new Error("Invalid bulk overlap"),
			),
		),
	),
	type: v.literal("pyth-lazer"),
});

export interface PythLazerModuleConfig
	extends v.InferOutput<typeof PythLazerModuleConfigSchema> {
	pythLazerApiKey: string;
}

export const PythLazerModuleRouteSchema = v.strictObject({
	...RouteSchema.entries,
	moduleName: v.string(),
	fetchFromModule: v.string(),
	type: v.literal("pyth-lazer"),
});

export type PythLazerModuleRoute = v.InferOutput<
	typeof PythLazerModuleRouteSchema
>;

export const validatePythLazerModuleRoute = (route: PythLazerModuleRoute) =>
	Effect.gen(function* () {
		// all is ok for now
		return yield* Effect.void;
	});
