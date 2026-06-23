import { Duration, Effect, Option } from "effect";
import * as v from "valibot";
import { RouteSchema } from "./route-config";

export const BINANCE_STREAM_TYPES = [
	"bookTicker",
	"aggTrade",
	"trade",
	"ticker",
	"miniTicker",
] as const;

export type BinanceStreamType = (typeof BINANCE_STREAM_TYPES)[number];

export const BinanceModuleConfigSchema = v.strictObject({
	name: v.string(),
	type: v.literal("binance"),
	wsUrl: v.optional(v.string(), "wss://stream.binance.com:9443/stream"),
	streamType: v.optional(v.picklist(BINANCE_STREAM_TYPES), "bookTicker"),
	subscriptionSymbols: v.optional(v.array(v.string()), []),
	maxSymbolsPerRequest: v.optional(v.number(), 100),
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
	symbolsCleanupTtl: v.pipe(
		v.optional(v.union([v.number(), v.string()]), "1 hour"),
		v.transform((ttl) =>
			Option.getOrThrowWith(
				Duration.decodeUnknown(ttl),
				() => new Error("Invalid symbols cleanup TTL"),
			),
		),
	),
	symbolsCleanupInterval: v.pipe(
		v.optional(v.union([v.number(), v.string()]), "30 seconds"),
		v.transform((interval) =>
			Option.getOrThrowWith(
				Duration.decodeUnknown(interval),
				() => new Error("Invalid symbols cleanup interval"),
			),
		),
	),
});

export type BinanceModuleConfig = v.InferOutput<
	typeof BinanceModuleConfigSchema
>;

export const BinanceModuleRouteSchema = v.strictObject({
	...RouteSchema.entries,
	moduleName: v.string(),
	fetchFromModule: v.string(),
	type: v.literal("binance"),
});

export type BinanceModuleRoute = v.InferOutput<typeof BinanceModuleRouteSchema>;

export const validateBinanceModuleRoute = (_route: BinanceModuleRoute) =>
	Effect.gen(function* () {
		return yield* Effect.void;
	});
