import { Data } from "effect";

export class FailedToHandleVolmexRequestError extends Data.TaggedError(
	"FailedToHandleVolmexRequestError",
)<{
	error: string | unknown;
	status: number;
}> {
	message = `Failed to handle Volmex request: ${this.error}`;
}
