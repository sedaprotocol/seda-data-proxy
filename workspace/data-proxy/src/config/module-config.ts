import * as v from "valibot";
import type { ChainlinkStreamsModuleConfig } from "./chainlink-streams-module-config";
import { ChainlinkStreamsModuleConfigSchema } from "./chainlink-streams-module-config";
import type { DxFeedModuleConfig } from "./dxfeed-module-config";
import { DxFeedModuleConfigSchema } from "./dxfeed-module-config";
import type { HydromancerModuleConfig } from "./hydromancer-module-config";
import { HydromancerModuleConfigSchema } from "./hydromancer-module-config";
import type { LoTechModuleConfig } from "./lo-tech-module-config";
import { LoTechModuleConfigSchema } from "./lo-tech-module-config";
import type { PythLazerModuleConfig } from "./pyth-lazer-module-config";
import { PythLazerModuleConfigSchema } from "./pyth-lazer-module-config";

export const ModulesSchema = v.optional(
	v.array(
		v.variant("type", [
			PythLazerModuleConfigSchema,
			ChainlinkStreamsModuleConfigSchema,
			DxFeedModuleConfigSchema,
			HydromancerModuleConfigSchema,
			LoTechModuleConfigSchema,
		]),
	),
	[],
);

export type Modules =
	| PythLazerModuleConfig
	| ChainlinkStreamsModuleConfig
	| DxFeedModuleConfig
	| HydromancerModuleConfig
	| LoTechModuleConfig;
