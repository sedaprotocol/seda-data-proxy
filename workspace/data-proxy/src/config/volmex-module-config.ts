import { Duration, Effect, Option, type Redacted } from "effect";
import * as v from "valibot";
import { RouteSchema } from "./route-config";

export const VolmexModuleConfigSchema = v.strictObject({
	name: v.string(),
	wsBaseUrl: v.optional(v.string(), "wss://ws-8jh89.volmex.finance"),
	restBaseUrl: v.optional(
		v.string(),
		"https://private-multiregion-8jh89.volmex.finance",
	),
	maxSymbolsPerRequest: v.optional(v.number(), 100),
	volmexApiKeyEnvKey: v.string(),
	reconnectDelayMs: v.optional(v.number(), 1000),
	restFetchTimeout: v.pipe(
		v.optional(v.union([v.number(), v.string()]), "15 seconds"),
		v.transform((value) =>
			Option.getOrThrowWith(
				Duration.decodeUnknown(value),
				() => new Error("Invalid restFetchTimeout duration"),
			),
		),
	),
	type: v.literal("volmex"),
});

export interface VolmexModuleConfig
	extends v.InferOutput<typeof VolmexModuleConfigSchema> {
	volmexApiKey: Redacted.Redacted<string>;
}

const VolmexWsModuleRouteSchema = v.strictObject({
	...RouteSchema.entries,
	moduleName: v.string(),
	type: v.literal("volmex"),
	source: v.literal("ws"),
	fetchFromModule: v.string(),
});

const VolmexRestModuleRouteSchema = v.strictObject({
	...RouteSchema.entries,
	moduleName: v.string(),
	type: v.literal("volmex"),
	source: v.literal("rest"),
	upstreamPath: v.string(),
});

// REST first so `source: "rest"` does not fall through to the WS schema.
export const VolmexModuleRouteSchema = v.variant("source", [
	VolmexRestModuleRouteSchema,
	VolmexWsModuleRouteSchema,
]);

export type VolmexModuleRoute = v.InferOutput<typeof VolmexModuleRouteSchema>;

export const validateVolmexModuleRoute = (_route: VolmexModuleRoute) =>
	Effect.gen(function* () {
		return yield* Effect.void;
	});
