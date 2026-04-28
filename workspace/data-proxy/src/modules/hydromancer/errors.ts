import { Data } from "effect";

export class FailedToHandleHydromancerRequestError extends Data.TaggedError(
	"FailedToHandleHydromancerRequestError",
)<{ error: string; status: number }> {
	message = `Hydromancer error: ${this.error}`;
}
