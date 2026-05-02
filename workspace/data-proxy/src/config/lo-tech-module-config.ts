import { Duration, Effect, Option } from "effect";
import * as v from "valibot";
import { RouteSchema } from "./route-config";

export const LoTechDataTypeSchema = v.picklist([
	"PRICE",
	// "TOP_OF_BOOK",
	// "ORDERBOOK",
	// "TRADE",
	// "OHLCV",
	// "FUNDING",
	// "REFERENCE_PRICE",
	// "OPEN_INTEREST",
	// "INSTRUMENT_STATIC",
]);

export type LoTechDataType = v.InferOutput<typeof LoTechDataTypeSchema>;

export const LoTechModulePriceFeedSchema = v.object({
	// LO:TECH normalized symbol, e.g. BTC-USDT:SPOT (see the symbology section in the LO:TECH API docs).
	symbol: v.string(),
	// Type of data to subscribe to.
	dataType: v.optional(LoTechDataTypeSchema, "PRICE"),
});

export type LoTechModulePriceFeed = v.InferOutput<
	typeof LoTechModulePriceFeedSchema
>;

export const LoTechModuleConfigSchema = v.strictObject({
	name: v.string(),
	exchange: v.string(),
	priceFeeds: v.array(LoTechModulePriceFeedSchema),
	maxFeedsPerRequest: v.optional(v.number(), 100),
	loTechApiKeyEnvKey: v.string(),
	priceFeedsCleanupTtl: v.pipe(
		v.optional(v.union([v.number(), v.string()]), "2 minutes"),
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
	reconnectDelayMs: v.optional(v.number(), 1000),
	type: v.literal("lo-tech"),
});

export interface LoTechModuleConfig
	extends v.InferOutput<typeof LoTechModuleConfigSchema> {
	loTechApiKey: string;
}

export const LoTechModuleRouteSchema = v.strictObject({
	...RouteSchema.entries,
	moduleName: v.string(),
	fetchFromModule: v.string(),
	type: v.literal("lo-tech"),
});

export type LoTechModuleRoute = v.InferOutput<typeof LoTechModuleRouteSchema>;

export const validateLoTechModuleRoute = (_route: LoTechModuleRoute) =>
	Effect.gen(function* () {
		return yield* Effect.void;
	});
