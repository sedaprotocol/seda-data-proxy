import * as v from "valibot";
import {
	keepaliveIntervalField,
	tickerModuleBaseFields,
	tickerModuleRouteSchema,
	validateTickerModuleRoute,
} from "./ticker-module-config";

export const BybitModuleConfigSchema = v.strictObject({
	type: v.literal("bybit"),
	...tickerModuleBaseFields({
		wsUrl: "wss://stream.bybit.com/v5/public/spot",
		maxMessages: 10,
		maxMessagesWindow: "1 second",
	}),
	maxSymbolsPerRequest: v.optional(v.number(), 100),
	// Bybit drops the socket if no ping is sent for ~20 seconds.
	keepaliveInterval: keepaliveIntervalField("15 seconds"),
});

export type BybitModuleConfig = v.InferOutput<typeof BybitModuleConfigSchema>;

export const BybitModuleRouteSchema = tickerModuleRouteSchema("bybit");

export type BybitModuleRoute = v.InferOutput<typeof BybitModuleRouteSchema>;

export const validateBybitModuleRoute = validateTickerModuleRoute;
