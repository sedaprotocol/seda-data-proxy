import { Duration, Effect, Option } from "effect";
import * as v from "valibot";
import { RouteSchema } from "./route-config";

export const dxfeedEventTypes = [
	// Events on orders:
	"Quote",
	"Order",
	"SpreadOrder",
	// Events on transactions:
	"Trade",
	"TradeETH",
	"TimeAndSale",
	"Summary",
	// Information about the security instrument:
	"Profile",
] as const;
export type DxFeedEventType = (typeof dxfeedEventTypes)[number];

const DxFeedSubscriptionSchema = v.union([
	v.strictObject({
		symbol: v.string(),
		type: v.picklist(dxfeedEventTypes),
	}),
]);

export const DxFeedModuleConfigSchema = v.strictObject({
	name: v.string(),
	dxfeedAuthTokenEnvKey: v.optional(v.string()),
	webSocketUrl: v.string(),
	/**
	 * Aggregation period in seconds.
	 * If not specified, the channel will use the default value.
	 * If specified as 0, the channel will try not aggregate events.
	 */
	acceptAggregationPeriod: v.optional(v.number()),
	/**
	 * Default subscriptions to be added to the feed.
	 */
	subscriptions: v.optional(v.array(DxFeedSubscriptionSchema), []),
	maxFeedsPerRequest: v.optional(v.number(), 100),
	subscriptionsCleanupTtl: v.pipe(
		v.optional(v.union([v.number(), v.string()]), "1 hour"),
		v.transform((ttl) =>
			Option.getOrThrowWith(
				Duration.decodeUnknown(ttl),
				() => new Error("Invalid subscription cleanup TTL"),
			),
		),
	),
	subscriptionsCleanupInterval: v.pipe(
		v.optional(v.union([v.number(), v.string()]), "30 seconds"),
		v.transform((interval) =>
			Option.getOrThrowWith(
				Duration.decodeUnknown(interval),
				() => new Error("Invalid subscription cleanup interval"),
			),
		),
	),
	type: v.literal("dxfeed"),
});

// DxFeedKey is a eventType-symbol composite key used to identify subscriptions.
// Event type prefix is separated from symbol by a dash.
export type DxFeedKey = `${DxFeedEventType}-${string}`;

export function dxfeedKey(
	symbol: string,
	eventType: DxFeedEventType,
): DxFeedKey {
	return `${eventType}-${symbol}`;
}

export interface DxFeedModuleConfig
	extends v.InferOutput<typeof DxFeedModuleConfigSchema> {
	dxfeedAuthToken?: string;
}

export const DxFeedModuleRouteSchema = v.strictObject({
	...RouteSchema.entries,
	moduleName: v.string(),
	fetchFromModule: v.string(),
	eventType: v.picklist(dxfeedEventTypes),
	type: v.literal("dxfeed"),
});

export type DxFeedModuleRoute = v.InferOutput<typeof DxFeedModuleRouteSchema>;

export const validateDxFeedModuleRoute = (_route: DxFeedModuleRoute) =>
	Effect.gen(function* () {
		return yield* Effect.void;
	});
