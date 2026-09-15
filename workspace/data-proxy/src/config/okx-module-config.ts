import * as v from "valibot";
import {
	keepaliveIntervalField,
	tickerModuleBaseFields,
	tickerModuleRouteSchema,
	validateTickerModuleRoute,
} from "./ticker-module-config";

export const OkxModuleConfigSchema = v.strictObject({
	type: v.literal("okx"),
	...tickerModuleBaseFields({
		wsUrl: "wss://ws.okx.com:8443/ws/v5/public",
		// OKX allows 480 subscribe/unsubscribe/login requests per connection per hour.
		maxMessagesPerSecond: 2,
	}),
	// OKX drops the socket if no data is pushed for 30 seconds; ping sooner.
	keepaliveInterval: keepaliveIntervalField("20 seconds"),
});

export type OkxModuleConfig = v.InferOutput<typeof OkxModuleConfigSchema>;

export const OkxModuleRouteSchema = tickerModuleRouteSchema("okx");

export type OkxModuleRoute = v.InferOutput<typeof OkxModuleRouteSchema>;

export const validateOkxModuleRoute = validateTickerModuleRoute;
