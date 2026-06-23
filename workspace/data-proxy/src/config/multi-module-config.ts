import * as v from "valibot";
import { RouteSchema } from "./route-config";

// Module types a multi fetch can target. These are the modules backed by a
// ModuleService handler (upstream is excluded: it is handled inline by the
// proxy controller, not through a module handler).
export const MULTI_FETCH_TYPES = [
	"pyth-lazer",
	"chainlink-streams",
	"dxfeed",
	"hydromancer",
	"lo-tech",
	"pm-insights",
	"binance",
	"lighter",
] as const;

// A single sub-request inside a multi route. `fetchFromModule` and `body` are
// templates filled from the inbound request path params via replaceParams; the
// resolved value is forwarded to the target module's own handler.
export const MultiFetchSchema = v.strictObject({
	name: v.string(),
	moduleName: v.string(),
	type: v.picklist(MULTI_FETCH_TYPES),
	fetchFromModule: v.optional(v.string()),
	body: v.optional(v.string()),
	allowedQueryParams: v.optional(v.array(v.string())),
});

export type MultiFetch = v.InferOutput<typeof MultiFetchSchema>;

export const MultiModuleRouteSchema = v.strictObject({
	...RouteSchema.entries,
	type: v.literal("multi"),
	// Unused by multi routes (which dispatch via `fetches`), but kept so the
	// route union exposes a uniform `moduleName`, matching the other routes.
	moduleName: v.optional(v.string(), "default"),
	fetches: v.pipe(
		v.array(MultiFetchSchema),
		v.minLength(1, "A multi route needs at least one fetch"),
	),
});

export type MultiModuleRoute = v.InferOutput<typeof MultiModuleRouteSchema>;
