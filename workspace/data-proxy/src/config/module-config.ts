import * as v from "valibot";
import type { ChainlinkStreamsModuleConfig } from "./chainlink-streams-module-config";
import { ChainlinkStreamsModuleConfigSchema } from "./chainlink-streams-module-config";
import type { LoTechModuleConfig } from "./lo-tech-module-config";
import { LoTechModuleConfigSchema } from "./lo-tech-module-config";
import type { PythLazerModuleConfig } from "./pyth-lazer-module-config";
import { PythLazerModuleConfigSchema } from "./pyth-lazer-module-config";

export const ModulesSchema = v.optional(
	v.array(
		v.variant("type", [
			PythLazerModuleConfigSchema,
			ChainlinkStreamsModuleConfigSchema,
			LoTechModuleConfigSchema,
		]),
	),
	[],
);

export type Modules =
	| PythLazerModuleConfig
	| ChainlinkStreamsModuleConfig
	| LoTechModuleConfig;
