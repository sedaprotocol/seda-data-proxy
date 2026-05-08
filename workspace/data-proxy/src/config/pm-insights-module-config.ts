import { Effect } from "effect";
import * as v from "valibot";
import { RouteSchema } from "./route-config";

export const PmInsightsModuleConfigSchema = v.strictObject({
	name: v.string(),
	type: v.literal("pm-insights"),
	baseUrl: v.optional(v.string(), "https://api.pminsights.com/"),
	/** Environment variable name whose value is the PM Insights account email (sent as `username` to /login). */
	emailEnvKey: v.string(),
	/** Environment variable name whose value is the PM Insights account password. */
	passwordEnvKey: v.string(),
	/** How often to call POST /login again to refresh the bearer token. Default 50 minutes. */
	tokenRefreshIntervalMinutes: v.optional(
		v.pipe(v.number(), v.minValue(1)),
		50,
	),
});

export interface PmInsightsModuleConfig
	extends v.InferOutput<typeof PmInsightsModuleConfigSchema> {
	email: string;
	password: string;
}

export const PmInsightsModuleRouteSchema = v.strictObject({
	...RouteSchema.entries,
	type: v.literal("pm-insights"),
	moduleName: v.string(),
	upstreamPath: v.string(),
});

export type PmInsightsModuleRoute = v.InferOutput<
	typeof PmInsightsModuleRouteSchema
>;

export const validatePmInsightsModuleRoute = (_route: PmInsightsModuleRoute) =>
	Effect.gen(function* () {
		return yield* Effect.void;
	});
