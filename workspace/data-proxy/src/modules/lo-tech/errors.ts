import { Data } from "effect";

export class FailedToHandleLoTechRequestError extends Data.TaggedError(
	"FailedToHandleLoTechRequestError",
)<{
	error: string | unknown;
}> {
	message = `Failed to handle LO:TECH request: ${this.error}`;
	status = 400;
}

export class FailedToGetPriceError extends Data.TaggedError(
	"FailedToGetPriceError",
)<{
	error: string | unknown;
}> {
	message = `Failed to get price: ${this.error}`;
	status = 500;
}
