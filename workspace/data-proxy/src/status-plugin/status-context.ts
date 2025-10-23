import { formatISODuration, intervalToDuration } from "date-fns";
import type { Config } from "../config-parser";
import type { Context } from "./types";

export class StatusContext implements Context {
	readonly startedAt = new Date();
	private requests = 0;
	private errors = 0;

	constructor(
		private publicKey: string,
		private fastConfig: Config["sedaFast"],
	) {
		this.publicKey = publicKey;
	}

	incrementRequests() {
		this.requests++;
	}

	incrementErrors() {
		this.errors++;
	}

	getFastConfig() {
		return this.fastConfig ?? { enable: false, allowedClients: [] };
	}

	getPublicKey() {
		return this.publicKey;
	}

	getMetrics() {
		return {
			uptime: formatISODuration(
				intervalToDuration({ start: this.startedAt, end: Date.now() }),
			),
			requests: this.requests,
			errors: this.errors,
		};
	}
}
