import * as v from "valibot";
import {
	tickerModuleBaseFields,
	tickerModuleRouteSchema,
	validateTickerModuleRoute,
} from "./ticker-module-config";

export const BINANCE_STREAM_TYPES = ["bookTicker", "trade"] as const;

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
	// Drop trades older than this when streamType is "trade".
	tradesKeepSeconds: v.optional(v.number(), 10),
});

export type BinanceModuleConfig = v.InferOutput<
	typeof BinanceModuleConfigSchema
>;

export const BinanceModuleRouteSchema = tickerModuleRouteSchema("binance");

export type BinanceModuleRoute = v.InferOutput<typeof BinanceModuleRouteSchema>;

export const validateBinanceModuleRoute = validateTickerModuleRoute;
