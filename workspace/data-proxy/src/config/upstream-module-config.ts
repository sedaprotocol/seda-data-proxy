import * as v from "valibot";
import { RouteSchema } from "./route-config";

export const UpstreamModuleRouteSchema = v.strictObject({
	...RouteSchema.entries,
	upstreamUrl: v.string(),
	moduleName: v.optional(v.string(), "default"),
	type: v.optional(v.literal("upstream"), "upstream"),
});

export type UpstreamModuleRoute = v.InferOutput<
	typeof UpstreamModuleRouteSchema
>;
