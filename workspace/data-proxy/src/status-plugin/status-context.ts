import { formatISODuration, intervalToDuration } from "date-fns";
import type { Context } from "./types";

export class StatusContext implements Context {
	readonly startedAt = new Date();
	private requests = 0;
	private errors = 0;

	constructor(private publicKey: string) {
		this.publicKey = publicKey;
	}

	incrementRequests() {
		this.requests++;
	}

	incrementErrors() {
		this.errors++;
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
