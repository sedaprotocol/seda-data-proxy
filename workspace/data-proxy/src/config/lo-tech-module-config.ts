import { Duration, Effect, Option } from "effect";
import * as v from "valibot";
import { RouteSchema } from "./route-config";

export const LO_TECH_DATA_TYPE_PRICE = "PRICE" as const;
export const LO_TECH_EXCHANGE_PATH_PARAM = "exchange" as const;
export const LO_TECH_EXCHANGE_US_EQUITIES = "us_equities" as const;
export const LO_TECH_EXCHANGE_FUTURES = "futures" as const;

export const DEFAULT_LO_TECH_SUPPORTED_EXCHANGES = [
	LO_TECH_EXCHANGE_US_EQUITIES,
	LO_TECH_EXCHANGE_FUTURES,
] as const;

export type LoTechExchange =
	(typeof DEFAULT_LO_TECH_SUPPORTED_EXCHANGES)[number];

export const LoTechDataTypeSchema = v.picklist([LO_TECH_DATA_TYPE_PRICE]);

export type LoTechDataType = v.InferOutput<typeof LoTechDataTypeSchema>;

export const LoTechModulePriceFeedSchema = v.object({
	// LO:TECH normalized symbol, e.g. BTC-USDT:SPOT (see the symbology section in the LO:TECH API docs).
	symbol: v.string(),
	// LO:TECH exchange, e.g. us_equities or futures.
	exchange: v.string(),
	// Type of data to subscribe to.
	dataType: v.optional(LoTechDataTypeSchema, LO_TECH_DATA_TYPE_PRICE),
});

export type LoTechModulePriceFeed = v.InferOutput<
	typeof LoTechModulePriceFeedSchema
>;

export type ResolvedLoTechModulePriceFeed = LoTechModulePriceFeed & {
	exchange: string;
};

export const LoTechModuleConfigSchema = v.strictObject({
	name: v.string(),
	baseUrl: v.string(),
	// List of supported exchanges.
	supportedExchanges: v.optional(v.array(v.string()), [
		...DEFAULT_LO_TECH_SUPPORTED_EXCHANGES,
	]),
	priceFeeds: v.array(LoTechModulePriceFeedSchema),
	maxFeedsPerRequest: v.optional(v.number(), 100),
	loTechApiKeyEnvKey: v.string(),
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
	reconnectDelayMs: v.optional(v.number(), 1000),
	type: v.literal("lo-tech"),
});

export interface LoTechModuleConfig
	extends Omit<v.InferOutput<typeof LoTechModuleConfigSchema>, "priceFeeds"> {
	loTechApiKey: string;
	priceFeeds: ResolvedLoTechModulePriceFeed[];
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

export const assertSupportedLoTechExchange = (
	exchange: string,
	supportedExchanges: readonly string[],
): Effect.Effect<void, string> =>
	supportedExchanges.includes(exchange)
		? Effect.void
		: Effect.fail(
				`Unsupported LO:TECH exchange "${exchange}". Supported exchanges: ${supportedExchanges.join(", ")}`,
			);

export const resolveLoTechModule = (
	module: v.InferOutput<typeof LoTechModuleConfigSchema>,
): Effect.Effect<Omit<LoTechModuleConfig, "loTechApiKey">, string> =>
	Effect.gen(function* () {
		const { supportedExchanges } = module;

		const priceFeeds: ResolvedLoTechModulePriceFeed[] = [];
		for (const feed of module.priceFeeds) {
			if (feed.exchange === undefined) {
				return yield* Effect.fail(
					`Module lo-tech requires "exchange" on each priceFeed`,
				);
			}

			yield* assertSupportedLoTechExchange(feed.exchange, supportedExchanges);

			priceFeeds.push({
				symbol: feed.symbol,
				dataType: feed.dataType,
				exchange: feed.exchange,
			});
		}

		return {
			...module,
			priceFeeds,
		};
	});
