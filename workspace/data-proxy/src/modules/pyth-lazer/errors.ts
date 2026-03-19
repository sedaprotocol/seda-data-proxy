import { Data } from "effect";

export class FailedToHandlePythLazerRequestError extends Data.TaggedError(
	"FailedToHandlePythLazerRequestError",
)<{
	error: string | unknown;
}> {
	message = `Failed to handle Pyth Lazer request: ${this.error}`;
	status = 400;
}

export class FailedToGetSymbolPriceIdError extends Data.TaggedError(
	"FailedToGetSymbolPriceIdError",
)<{
	error: string | unknown;
}> {
	message = `Failed to get price ID by symbol: ${this.error}`;
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
