import * as v from "valibot";
import {
	tickerModuleBaseFields,
	tickerModuleRouteSchema,
	validateTickerModuleRoute,
} from "./ticker-module-config";

// Binance Futures has no documented per-trade `@trade` stream (unlike Spot);
// `@aggTrade` is the supported substitute. `depth` (no suffix) is the 250ms
// cadence, matching Spot's bare `@depth` for its slowest cadence.
export const BINANCE_FUTURES_STREAM_TYPES = [
	"bookTicker",
	"aggTrade",
	"depth",
	"depth@500ms",
	"depth@100ms",
] as const;

export type BinanceFuturesStreamType =
	(typeof BINANCE_FUTURES_STREAM_TYPES)[number];

export const BinanceFuturesModuleConfigSchema = v.strictObject({
	type: v.literal("binance-futures"),
	...tickerModuleBaseFields({
		// Legacy combined-stream URL. Binance is splitting this into
		// /public (bookTicker, depth) and /market (aggTrade) endpoints;
		// the legacy URL works for both until the 2026-04-23 cutoff.
		wsUrl: "wss://fstream.binance.com/stream",
		// Binance Futures allows 10 client messages per second.
		maxMessages: 10,
		maxMessagesWindow: "1 second",
	}),
	streamType: v.optional(
		v.picklist(BINANCE_FUTURES_STREAM_TYPES),
		"bookTicker",
	),
	// Drop trades older than this when streamType is "aggTrade".
	tradesKeepSeconds: v.optional(v.number(), 10),
});

export type BinanceFuturesModuleConfig = v.InferOutput<
	typeof BinanceFuturesModuleConfigSchema
>;

export const BinanceFuturesModuleRouteSchema =
	tickerModuleRouteSchema("binance-futures");

export type BinanceFuturesModuleRoute = v.InferOutput<
	typeof BinanceFuturesModuleRouteSchema
>;

export const validateBinanceFuturesModuleRoute = validateTickerModuleRoute;
