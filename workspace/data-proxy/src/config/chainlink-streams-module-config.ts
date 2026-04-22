import { Effect } from "effect";
import * as v from "valibot";
import { RouteSchema } from "./route-config";

// `baseUrl` is required: Chainlink exposes distinct testnet and mainnet
// endpoints, and the wrong one returns a valid-looking response with data
// from the wrong network. No default.
export const ChainlinkStreamsModuleConfigSchema = v.strictObject({
	name: v.string(),
	type: v.literal("chainlink-streams"),
	chainlinkKeyEnvKey: v.string(),
	chainlinkApiSecretEnvKey: v.string(),
	baseUrl: v.string(),
});

export interface ChainlinkStreamsModuleConfig
	extends v.InferOutput<typeof ChainlinkStreamsModuleConfigSchema> {
	chainlinkKey: string;
	chainlinkApiSecret: string;
}

export const ChainlinkStreamsModuleRouteSchema = v.strictObject({
	...RouteSchema.entries,
	type: v.literal("chainlink-streams"),
	moduleName: v.string(),
	// Appended to baseUrl; supports {:param} placeholders filled from route match.
	upstreamPath: v.string(),
});

export type ChainlinkStreamsModuleRoute = v.InferOutput<
	typeof ChainlinkStreamsModuleRouteSchema
>;

export const validateChainlinkStreamsModuleRoute = (
	route: ChainlinkStreamsModuleRoute,
) =>
	Effect.gen(function* () {
		return yield* Effect.void;
	});
