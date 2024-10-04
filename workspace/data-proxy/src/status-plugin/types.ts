export interface Context {
	getPublicKey(): string;

	getMetrics(): {
		uptime: string;
		requests: number;
		errors: number;
	};
}
