import { Data } from "effect";

export class FailedToHandleDxFeedRequestError extends Data.TaggedError(
	"FailedToHandleDxFeedRequestError",
)<{
	error: string | unknown;
}> {
	message = `Failed to handle dxFeed request: ${this.error}`;
	status = 400;
}

// We can't distinguish between a price not found and a price error, so we use a 404 status code to reduce the noise in the logs
export class FailedToGetPriceError extends Data.TaggedError(
	"FailedToGetPriceError",
)<{
	error: string | unknown;
}> {
	message = `Failed to get price: ${this.error}`;
	status = 404;
}
