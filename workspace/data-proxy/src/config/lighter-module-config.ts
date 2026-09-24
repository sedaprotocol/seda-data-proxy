import * as v from "valibot";
import {
	keepaliveIntervalField,
	tickerModuleBaseFields,
	tickerModuleRouteSchema,
	validateTickerModuleRoute,
} from "./ticker-module-config";

export const LighterModuleConfigSchema = v.strictObject({
	type: v.literal("lighter"),
	...tickerModuleBaseFields({
		// ?readonly=true avoids geo-restriction on the public stream.
		wsUrl: "wss://mainnet.zklighter.elliot.ai/stream?readonly=true",
		// Lighter allows 200 client WS messages per minute.
		maxMessages: 180,
		maxMessagesWindow: "1 minute",
	}),
	// Lighter closes a connection with no client frames for 2 minutes;
	// ping on a shorter cadence.
	keepaliveInterval: keepaliveIntervalField("60 seconds"),
});

export type LighterModuleConfig = v.InferOutput<
	typeof LighterModuleConfigSchema
>;

export const LighterModuleRouteSchema = tickerModuleRouteSchema("lighter");

export type LighterModuleRoute = v.InferOutput<typeof LighterModuleRouteSchema>;

export const validateLighterModuleRoute = validateTickerModuleRoute;
