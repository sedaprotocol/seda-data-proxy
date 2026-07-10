import { Effect, type Redacted } from "effect";
import * as v from "valibot";
import { RouteSchema } from "./route-config";

export const VolmexModuleConfigSchema = v.strictObject({
	name: v.string(),
	baseUrl: v.optional(v.string(), "wss://ws-8jh89.volmex.finance"),
	maxSymbolsPerRequest: v.optional(v.number(), 100),
	volmexApiKeyEnvKey: v.string(),
	reconnectDelayMs: v.optional(v.number(), 1000),
	type: v.literal("volmex"),
});

export interface VolmexModuleConfig
	extends v.InferOutput<typeof VolmexModuleConfigSchema> {
	volmexApiKey: Redacted.Redacted<string>;
}

export const VolmexModuleRouteSchema = v.strictObject({
	...RouteSchema.entries,
	moduleName: v.string(),
	fetchFromModule: v.string(),
	type: v.literal("volmex"),
});

export type VolmexModuleRoute = v.InferOutput<typeof VolmexModuleRouteSchema>;

export const validateVolmexModuleRoute = (_route: VolmexModuleRoute) =>
	Effect.gen(function* () {
		return yield* Effect.void;
	});
