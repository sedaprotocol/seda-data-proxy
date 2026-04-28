import * as v from "valibot";
import type { ChainlinkStreamsModuleConfig } from "./chainlink-streams-module-config";
import { ChainlinkStreamsModuleConfigSchema } from "./chainlink-streams-module-config";
import type { HydromancerModuleConfig } from "./hydromancer-module-config";
import { HydromancerModuleConfigSchema } from "./hydromancer-module-config";
import type { PythLazerModuleConfig } from "./pyth-lazer-module-config";
import { PythLazerModuleConfigSchema } from "./pyth-lazer-module-config";

export const ModulesSchema = v.optional(
	v.array(
		v.variant("type", [
			PythLazerModuleConfigSchema,
			ChainlinkStreamsModuleConfigSchema,
			HydromancerModuleConfigSchema,
		]),
	),
	[],
);

export type Modules =
	| PythLazerModuleConfig
	| ChainlinkStreamsModuleConfig
	| HydromancerModuleConfig;
