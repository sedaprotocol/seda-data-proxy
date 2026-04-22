import { Data } from "effect";

export class FailedToHandleChainlinkStreamsRequestError extends Data.TaggedError(
	"FailedToHandleChainlinkStreamsRequestError",
)<{ error: string; status: number }> {
	message = `Chainlink Streams error: ${this.error}`;
}
