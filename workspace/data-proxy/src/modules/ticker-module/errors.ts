import { Data } from "effect";

export class FailedToHandleTickerRequestError extends Data.TaggedError(
	"FailedToHandleTickerRequestError",
)<{ error: string; status: number; moduleName: string }> {
	message = `Ticker error (${this.moduleName}): ${this.error}`;
}
