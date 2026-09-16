import * as v from "valibot";
import {
	tickerModuleBaseFields,
	tickerModuleRouteSchema,
	validateTickerModuleRoute,
} from "./ticker-module-config";

export const BINANCE_STREAM_TYPES = [
	"bookTicker",
	"aggTrade",
	"trade",
	"ticker",
	"miniTicker",
] as const;

export type BinanceStreamType = (typeof BINANCE_STREAM_TYPES)[number];

export const BinanceModuleConfigSchema = v.strictObject({
	type: v.literal("binance"),
	...tickerModuleBaseFields({
		wsUrl: "wss://stream.binance.com:9443/stream",
		// Binance allows 5 client messages per second.
		maxMessages: 5,
		maxMessagesWindow: "1 second",
	}),
	streamType: v.optional(v.picklist(BINANCE_STREAM_TYPES), "bookTicker"),
});

export type BinanceModuleConfig = v.InferOutput<
	typeof BinanceModuleConfigSchema
>;

export const BinanceModuleRouteSchema = tickerModuleRouteSchema("binance");

export type BinanceModuleRoute = v.InferOutput<typeof BinanceModuleRouteSchema>;

export const validateBinanceModuleRoute = validateTickerModuleRoute;
