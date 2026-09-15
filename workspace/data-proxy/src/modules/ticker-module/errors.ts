import { Data } from "effect";

export class FailedToHandleTickerRequestError extends Data.TaggedError(
	"FailedToHandleTickerRequestError",
)<{ error: string; status: number }> {
	message = `Ticker error: ${this.error}`;
}
