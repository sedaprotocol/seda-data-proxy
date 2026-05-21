import { tryParseSync } from "@seda-protocol/utils";
import { Duration, Effect, Option } from "effect";
import * as v from "valibot";
import { RouteSchema } from "./route-config";

export const HydromancerModuleConfigSchema = v.strictObject({
	name: v.string(),
	type: v.literal("hydromancer"),
	wsUrl: v.string(),
	restBaseUrl: v.string(),
	hydromancerApiKeyEnvKey: v.string(),
	assetCtxStaleAfter: v.pipe(
		v.optional(v.union([v.number(), v.string()]), "10 seconds"),
		v.transform((value) =>
			Option.getOrThrowWith(
				Duration.decodeUnknown(value),
				() => new Error("Invalid assetCtxStaleAfter duration"),
			),
		),
	),
	assetCtxSubscriptionCoins: v.optional(v.array(v.string()), []),
	assetCtxMaxCoinsPerRequest: v.optional(v.number(), 20),
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
	assetCtxCleanupTtl: v.pipe(
		v.optional(v.union([v.number(), v.string()]), "2 minutes"),
		v.transform((ttl) =>
			Option.getOrThrowWith(
				Duration.decodeUnknown(ttl),
				() => new Error("Invalid coin cleanup TTL"),
			),
		),
	),
	assetCtxCleanupInterval: v.pipe(
		v.optional(v.union([v.number(), v.string()]), "30 seconds"),
		v.transform((interval) =>
			Option.getOrThrowWith(
				Duration.decodeUnknown(interval),
				() => new Error("Invalid coin cleanup interval"),
			),
		),
	),
	assetCtxRestFetchTimeout: v.pipe(
		v.optional(v.union([v.number(), v.string()]), "15 seconds"),
		v.transform((value) =>
			Option.getOrThrowWith(
				Duration.decodeUnknown(value),
				() => new Error("Invalid assetCtxRestFetchTimeout duration"),
			),
		),
	),
	l2BookSubscriptionCoins: v.optional(v.array(v.string()), []),
	l2BookMaxCoinsPerRequest: v.optional(v.number(), 20),
	l2BookNSigFigs: v.optional(v.number()),
	l2BookWaitTimeout: v.pipe(
		v.optional(v.union([v.number(), v.string()]), "1 second"),
		v.transform((value) =>
			Option.getOrThrowWith(
				Duration.decodeUnknown(value),
				() => new Error("Invalid l2BookWaitTimeout duration"),
			),
		),
	),
	l2BookCleanupTtl: v.pipe(
		v.optional(v.union([v.number(), v.string()]), "2 minutes"),
		v.transform((value) =>
			Option.getOrThrowWith(
				Duration.decodeUnknown(value),
				() => new Error("Invalid l2BookCleanupTtl duration"),
			),
		),
	),
	l2BookCleanupInterval: v.pipe(
		v.optional(v.union([v.number(), v.string()]), "30 seconds"),
		v.transform((value) =>
			Option.getOrThrowWith(
				Duration.decodeUnknown(value),
				() => new Error("Invalid l2BookCleanupInterval duration"),
			),
		),
	),
});

export interface HydromancerModuleConfig
	extends v.InferOutput<typeof HydromancerModuleConfigSchema> {
	hydromancerApiKey: string;
}

export const HydromancerModuleRouteSchema = v.strictObject({
	...RouteSchema.entries,
	type: v.literal("hydromancer"),
	moduleName: v.string(),
});

export type HydromancerModuleRoute = v.InferOutput<
	typeof HydromancerModuleRouteSchema
>;

export const validateHydromancerModuleRoute = (
	_route: HydromancerModuleRoute,
) =>
	Effect.gen(function* () {
		return yield* Effect.void;
	});

export const AssetCtxSchema = v.object({
	oraclePx: v.nullable(v.string()),
	markPx: v.nullable(v.string()),
	midPx: v.nullable(v.string()),
	impactPxs: v.nullable(v.array(v.string())),
	openInterest: v.nullable(v.string()),
});

export type AssetCtx = v.InferOutput<typeof AssetCtxSchema>;

export const AssetContextRequestBodySchema = v.object({
	type: v.literal("assetContext"),
	coins: v.array(v.string()),
});

export const BookLevelSchema = v.object({
	px: v.string(),
	sz: v.string(),
	n: v.number(),
});

export type BookLevel = v.InferOutput<typeof BookLevelSchema>;

export const BookSnapshotSchema = v.object({
	coin: v.string(),
	levels: v.tuple([v.array(BookLevelSchema), v.array(BookLevelSchema)]),
	time: v.number(),
});

export type BookSnapshot = v.InferOutput<typeof BookSnapshotSchema>;

export const L2BookRequestBodySchema = v.object({
	type: v.literal("l2Book"),
	coins: v.array(v.string()),
});

// Request body the module accepts, discriminated on `type`. Any shape that
// matches neither variant is rejected with 400.
export const HydromancerRequestBodySchema = v.variant("type", [
	AssetContextRequestBodySchema,
	L2BookRequestBodySchema,
]);

export type ParsedHydromancerBody = v.InferOutput<
	typeof HydromancerRequestBodySchema
>;

export const parseHydromancerBody = (
	raw: string,
): Option.Option<ParsedHydromancerBody> => {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return Option.none();
	}
	const parsed = tryParseSync(HydromancerRequestBodySchema, json);
	return parsed.isErr ? Option.none() : Option.some(parsed.value);
};
