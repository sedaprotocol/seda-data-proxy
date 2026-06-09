import { Data } from "effect";

export class FailedToHandleLighterRequestError extends Data.TaggedError(
	"FailedToHandleLighterRequestError",
)<{ error: string; status: number }> {
	message = `Lighter error: ${this.error}`;
}
