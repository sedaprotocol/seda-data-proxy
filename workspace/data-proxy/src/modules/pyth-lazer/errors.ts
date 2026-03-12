import { Data } from "effect";

export class FailedToHandlePythLazerRequestError extends Data.TaggedError(
	"FailedToHandlePythLazerRequestError",
)<{ error: string | unknown }> {
	message = `Failed to handle Pyth Lazer request: ${this.error}`;
	status = 400;
}
