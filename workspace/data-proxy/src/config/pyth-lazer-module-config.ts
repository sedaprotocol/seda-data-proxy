import { Duration, Effect, Option } from "effect";
import * as v from "valibot";
import { RouteSchema } from "./route-config";

export const PythLazerChannelSchema = v.picklist([
	"real_time",
	"fixed_rate@50ms",
	"fixed_rate@1000ms",
	"fixed_rate@200ms",
]);

export type PythLazerChannel = v.InferOutput<typeof PythLazerChannelSchema>;

export const PythLazerModuleConfigSchema = v.strictObject({
	name: v.string(),
	priceFeedIds: v.array(
		v.object({
			name: v.string(),
			id: v.number(),
		}),
	),
	channel: v.optional(PythLazerChannelSchema, "fixed_rate@200ms"),
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
	type: v.literal("pyth-lazer"),
});

export interface PythLazerModuleConfig
	extends v.InferOutput<typeof PythLazerModuleConfigSchema> {
	pythLazerApiKey: string;
}

export const PythLazerModuleRouteSchema = v.strictObject({
	...RouteSchema.entries,
	moduleName: v.string(),
	// Present: the symbols/ids come from the path (e.g. GET /price/:symbols),
	// returning a per-feed array. Absent: use the legacy-compatible
	// POST /v1/latest_price body surface.
	fetchFromModule: v.optional(v.string()),
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
