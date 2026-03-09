import type {
	DataProxy,
	FailedToVerifyCoreProofError,
} from "@seda-protocol/data-proxy-sdk";
import { Effect, Either, Option } from "effect";

type RetryDelay = (attempt: number) => number;

const MAX_HEIGHT_DIFFERENCE = 2;

/**
 * Verifies a proof with retry. Will attempt the verification up to maxAttempts times, and
 * will always try at least once.
 *
 * Will not retry if the proof is invalid.
 * Will not retry if the eligible height is not provided.
 * Will not retry if the difference between the eligible height and the current height is greater than 2.
 *
 * @param dataProxy - The data proxy to use.
 * @param proof - The proof to verify.
 * @param eligibleHeight - The eligible height to verify against if provided.
 * @param maxAttempts - The maximum number of attempts to make. Default is 2.
 * @param retryDelay - Function to calculate the delay between attempts. Default is a flat 1 second.
 * @returns The verification result.
 */
export const verifyWithRetry = (
	dataProxy: DataProxy,
	proof: string,
	eligibleHeight: Option.Option<bigint>,
	maxAttempts = 2,
	retryDelay: RetryDelay = () => 1000,
) =>
	Effect.gen(function* () {
		// Start at 0 so at the start of the loop we have attempt = 1
		let attempt = 0;
		let verificationResult: Either.Either<
			{ isValid: boolean; status: string; currentHeight: bigint },
			FailedToVerifyCoreProofError
		>;

		do {
			attempt++;
			// Only sleep on retries
			if (attempt > 1) {
				yield* Effect.sleep(retryDelay(attempt));
			}

			yield* Effect.logTrace(
				`Verifying proof with retry (attempt ${attempt}/${maxAttempts})`,
			);

			verificationResult = yield* Effect.either(dataProxy.verify(proof));

			// Something went wrong querying the eligibility, we should retry
			if (Either.isLeft(verificationResult)) {
				yield* Effect.logTrace(
					`Error while verifying proof: ${verificationResult.left}`,
				);
				continue;
			}

			const verification = verificationResult.right;

			// Verification passed, no need to retry
			if (verification.isValid) {
				break;
			}

			// If the proof is invalid there is no point in retrying
			if (verification.status === "invalid_signature") {
				break;
			}

			if (Option.isNone(eligibleHeight)) {
				yield* Effect.logTrace(
					"No eligibility height provided, skipping retry",
				);
				break;
			}

			if (verification.currentHeight >= eligibleHeight.value) {
				yield* Effect.logTrace(
					`Proof was eligible at height ${eligibleHeight.value} and current height is ${verification.currentHeight}, skipping retry`,
				);
				break;
			}

			yield* Effect.logWarning(
				`Received proof for height ${eligibleHeight.value} but current height is ${verification.currentHeight}, the RPC might be out of sync`,
			);

			if (
				eligibleHeight.value - verification.currentHeight >
				MAX_HEIGHT_DIFFERENCE
			) {
				yield* Effect.logWarning(
					`The difference between the eligible height and the current height is greater than ${MAX_HEIGHT_DIFFERENCE}, skipping retry`,
				);
				break;
			}
		} while (attempt < maxAttempts);

		yield* Effect.logTrace(
			`Using verification result after ${attempt}/${maxAttempts} attempts`,
		);

		if (Either.isLeft(verificationResult)) {
			return yield* Effect.fail(verificationResult.left);
		}

		return verificationResult.right;
	}).pipe(Effect.withSpan("verifyWithRetry"));
