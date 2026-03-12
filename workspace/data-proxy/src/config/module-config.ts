import * as v from "valibot";
import type { PythLazerModuleConfig } from "./pyth-lazer-module-config";
import { PythLazerModuleConfigSchema } from "./pyth-lazer-module-config";

export const ModulesSchema = v.optional(
	v.array(PythLazerModuleConfigSchema),
	[],
);

export type Modules = PythLazerModuleConfig;
