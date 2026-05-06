import { Data } from "effect";

export class FailedToHandleDxFeedRequestError extends Data.TaggedError(
	"FailedToHandleDxFeedRequestError",
)<{
	error: string | unknown;
}> {
	message = `Failed to handle dxFeed request: ${this.error}`;
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

export class FailedToConnectDxFeedError extends Data.TaggedError(
	"FailedToConnectDxFeedError",
)<{
	webSocketUrl: string;
	timeoutMs: number;
}> {
	message = `dxFeed did not reach connected state within ${this.timeoutMs}ms (url: ${this.webSocketUrl})`;
}
