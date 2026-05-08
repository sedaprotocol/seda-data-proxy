import { Data } from "effect";

export class FailedToHandleLoTechRequestError extends Data.TaggedError(
	"FailedToHandleLoTechRequestError",
)<{
	error: string | unknown;
}> {
	message = `Failed to handle LO:TECH request: ${this.error}`;
	status = 400;
}
