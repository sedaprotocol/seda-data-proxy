import { Data } from "effect";

export class FailedToHandlePmInsightsRequestError extends Data.TaggedError(
	"FailedToHandlePmInsightsRequestError",
)<{ error: string; status: number }> {
	message = `PM Insights error: ${this.error}`;
}
