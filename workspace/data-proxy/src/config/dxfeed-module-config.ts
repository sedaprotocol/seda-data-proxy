import { Duration, Effect, Option } from "effect";
import * as v from "valibot";
import { RouteSchema } from "./route-config";

export const eventFields = [
	"askPrice",
	"bidPrice",
	"bidTime",
	"askTime",
] as const;

export const DxFeedModuleConfigSchema = v.strictObject({
	name: v.string(),
	webSocketUrl: v.string(),
	subscriptions: v.optional(v.array(v.string()), []),
	eventFields: v.optional(v.array(v.picklist(eventFields)), eventFields),
	maxFeedsPerRequest: v.optional(v.number(), 100),
	dxfeedAuthTokenEnvKey: v.optional(v.string()),
	subscriptionsCleanupTtl: v.pipe(
		v.optional(v.union([v.number(), v.string()]), "2 minutes"),
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

export type DxFeedModuleEventField = v.InferOutput<
	typeof DxFeedModuleConfigSchema
>["eventFields"];

export type DxFeedEventField = DxFeedModuleEventField[number];

export interface DxFeedModuleConfig
	extends v.InferOutput<typeof DxFeedModuleConfigSchema> {
	dxfeedAuthToken?: string;
}

export const DxFeedModuleRouteSchema = v.strictObject({
	...RouteSchema.entries,
	moduleName: v.string(),
	fetchFromModule: v.string(),
	type: v.literal("dxfeed"),
});

export type DxFeedModuleRoute = v.InferOutput<typeof DxFeedModuleRouteSchema>;

export const validateDxFeedModuleRoute = (_route: DxFeedModuleRoute) =>
	Effect.gen(function* () {
		return yield* Effect.void;
	});
