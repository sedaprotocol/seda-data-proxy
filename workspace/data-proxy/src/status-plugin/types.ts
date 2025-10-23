import type { Config } from "../config-parser";

export interface Context {
	getPublicKey(): string;

	getMetrics(): {
		uptime: string;
		requests: number;
		errors: number;
	};

	getFastConfig(): Config["sedaFast"];
}
