import type { Channel } from "@pythnetwork/pyth-lazer-sdk";
import { Duration, Effect, Option } from "effect";
import * as v from "valibot";
import { isU32 } from "../utils/number";
import { RouteSchema } from "./route-config";

export const PYTH_LAZER_DEFAULT_CHANNEL = "fixed_rate@200ms" as const;

const PYTH_LAZER_CHANNELS = [
	"real_time",
	"fixed_rate@50ms",
	"fixed_rate@200ms",
	"fixed_rate@1000ms",
] as const satisfies readonly Channel[];

export const PythLazerChannelSchema = v.picklist(PYTH_LAZER_CHANNELS);

const PythLazerPriceFeedIdSchema = v.pipe(
	v.number(),
	v.check(isU32, "Price feed ID must be a u32 (0 through 2^32 - 1)"),
);

const PythLazerPriceFeedEntrySchema = v.object({
	name: v.string(),
	id: PythLazerPriceFeedIdSchema,
	channel: v.optional(PythLazerChannelSchema, PYTH_LAZER_DEFAULT_CHANNEL),
});

/** Subscribed on start when `priceFeedIds` is omitted from config. */
export const PYTH_LAZER_DEFAULT_PRICE_FEED_IDS = [
	{
		name: "BTC/USD",
		id: 1,
		channel: PYTH_LAZER_DEFAULT_CHANNEL,
	},
];

export const PythLazerModuleConfigSchema = v.strictObject({
	name: v.string(),
	priceFeedIds: v.optional(
		v.pipe(
			v.array(PythLazerPriceFeedEntrySchema),
			v.minLength(1, "priceFeedIds must contain at least one feed"),
		),
		PYTH_LAZER_DEFAULT_PRICE_FEED_IDS,
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
	type: v.literal("pyth-lazer"),
});

export interface PythLazerModuleConfig
	extends v.InferOutput<typeof PythLazerModuleConfigSchema> {
	pythLazerApiKey: string;
}

export const PythLazerModuleRouteSchema = v.strictObject({
	...RouteSchema.entries,
	moduleName: v.string(),
	// Present: path template. Omitted: POST body is expected instead.
	fetchFromModule: v.optional(v.string()),
	channel: v.optional(PythLazerChannelSchema, PYTH_LAZER_DEFAULT_CHANNEL),
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
