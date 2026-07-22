import { Data, Option } from "effect";

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

export function extractPriceFeedIdFromErrorMessage(
	error: string,
): Option.Option<number> {
	// API key has insufficient access for the following reasons: Feeds are not stable: 2701 (coming_soon)
	const match = error.match(/Feeds are not stable: (\d+)/);

	if (match) {
		return Option.some(Number.parseInt(match[1]));
	}

	return Option.none();
}

/** Extracts a loggable message from WS Error / ErrorEvent-like values. */
export const pythLazerErrorMessage = (error: unknown): string => {
	if (
		typeof error === "object" &&
		error !== null &&
		"message" in error &&
		typeof error.message === "string"
	) {
		return error.message;
	}
	return String(error);
};

/**
 * Keeps the WebSocket URL for debugging but strips credentials from the text.
 * Pyth Lazer puts the API key in `?ACCESS_TOKEN=` (browser) or Bearer headers.
 */
export const redactPythLazerSecrets = (text: string): string => {
	const output = text
		.replaceAll(/([?&]ACCESS_TOKEN=)[^&\s'"]+/gi, "$1<redacted>")
		.replaceAll(/(Bearer\s+)\S+/gi, "$1<redacted>");
	return output;
};
