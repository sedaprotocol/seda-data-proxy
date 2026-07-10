import { Data } from "effect";

export class FailedToHandleVolmexRequestError extends Data.TaggedError(
	"FailedToHandleVolmexRequestError",
)<{
	error: string | unknown;
}> {
	message = `Failed to handle Volmex request: ${this.error}`;
	status = 400;
}
