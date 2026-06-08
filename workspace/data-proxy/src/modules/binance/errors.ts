import { Data } from "effect";

export class FailedToHandleBinanceRequestError extends Data.TaggedError(
	"FailedToHandleBinanceRequestError",
)<{ error: string; status: number }> {
	message = `Binance error: ${this.error}`;
}
