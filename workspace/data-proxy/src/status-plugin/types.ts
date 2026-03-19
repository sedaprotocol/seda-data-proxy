import type { Config } from "../config/config-parser";

export interface Context {
	getPublicKey(): string;

	getMetrics(): {
		uptime: string;
		requests: number;
		errors: number;
	};

	getFastConfig(): Config["sedaFast"];
}
