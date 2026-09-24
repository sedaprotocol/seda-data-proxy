import { Duration, Effect, Option } from "effect";
import * as v from "valibot";
import { RouteSchema } from "./route-config";

const durationField = (defaultValue: string, invalidMessage: string) =>
	v.pipe(
		v.optional(v.union([v.number(), v.string()]), defaultValue),
		v.transform((value) =>
			Option.getOrThrowWith(
				Duration.decodeUnknown(value),
				() => new Error(invalidMessage),
			),
		),
	);

/** Shared fields for public ticker modules. */
export const tickerModuleBaseFields = (defaults: {
	wsUrl: string;
	maxMessages: number;
	maxMessagesWindow: string;
}) => ({
	name: v.string(),
	wsUrl: v.optional(v.string(), defaults.wsUrl),
	subscriptionSymbols: v.optional(v.array(v.string()), []),
	maxSymbolsPerRequest: v.optional(v.number(), 100),
	maxMessages: v.optional(
		v.pipe(v.number(), v.minValue(1, "maxMessages must be at least 1")),
		defaults.maxMessages,
	),
	maxMessagesWindow: durationField(
		defaults.maxMessagesWindow,
		"Invalid maxMessagesWindow duration",
	),
	reconnectMaxBackoff: durationField(
		"30 seconds",
		"Invalid reconnectMaxBackoff duration",
	),
	reconnectStableThreshold: durationField(
		"30 seconds",
		"Invalid reconnectStableThreshold duration",
	),
	symbolsCleanupTtl: durationField("1 hour", "Invalid symbols cleanup TTL"),
	symbolsCleanupInterval: durationField(
		"30 seconds",
		"Invalid symbols cleanup interval",
	),
});

export const keepaliveIntervalField = (defaultValue: string) =>
	durationField(defaultValue, "Invalid keepaliveInterval duration");

export const tickerModuleRouteSchema = <T extends string>(type: T) =>
	v.strictObject({
		...RouteSchema.entries,
		moduleName: v.string(),
		fetchFromModule: v.string(),
		type: v.literal(type),
	});

export const validateTickerModuleRoute = (_route: unknown) => Effect.void;
