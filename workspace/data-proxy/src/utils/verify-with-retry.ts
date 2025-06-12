import type { DataProxy } from "@seda-protocol/data-proxy-sdk";
import type { Maybe } from "true-myth";
import type { Logger } from "winston";

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
 * @param logger - The logger to use.
 * @param dataProxy - The data proxy to use.
 * @param proof - The proof to verify.
 * @param eligibleHeight - The eligible height to verify against if provided.
 * @param maxAttempts - The maximum number of attempts to make. Default is 2.
 * @param retryDelay - Function to calculate the delay between attempts. Default is a flat 1 second.
 * @returns The verification result.
 */
export async function verifyWithRetry(
	logger: Logger,
	dataProxy: DataProxy,
	proof: string,
	eligibleHeight: Maybe<number>,
	maxAttempts = 2,
	retryDelay: RetryDelay = () => 1000,
) {
	// Start at 0 so at the start of the loop we have attempt = 1
	let attempt = 0;
	let verificationResult: Awaited<ReturnType<typeof dataProxy.verify>>;

	do {
		attempt++;
		// Only sleep on retries
		if (attempt > 1) {
			await sleep(retryDelay(attempt));
		}

		logger.silly(
			`Verifying proof with retry (attempt ${attempt}/${maxAttempts})`,
		);

		verificationResult = await dataProxy.verify(proof);
		// Something went wrong querying the eligibility, we should retry
		if (verificationResult.isErr) {
			logger.silly(`Error while verifying proof: ${verificationResult.error}`);
			continue;
		}

		const verification = verificationResult.value;

		// Verification passed, no need to retry
		if (verification.isValid) {
			break;
		}

		// If the proof is invalid there is no point in retrying
		if (verification.status === "invalid_signature") {
			break;
		}

		if (eligibleHeight.isNothing) {
			logger.silly("No eligibility height provided, skipping retry");
			break;
		}

		if (verification.currentHeight >= eligibleHeight.value) {
			logger.silly(
				`Proof was eligible at height ${eligibleHeight.value} and current height is ${verification.currentHeight}, skipping retry`,
			);
			break;
		}

		logger.warn(
			`Received proof for height ${eligibleHeight.value} but current height is ${verification.currentHeight}, the RPC might be out of sync`,
		);

		if (
			eligibleHeight.value - verification.currentHeight >
			MAX_HEIGHT_DIFFERENCE
		) {
			logger.warn(
				`The difference between the eligible height and the current height is greater than ${MAX_HEIGHT_DIFFERENCE}, skipping retry`,
			);
			break;
		}
	} while (attempt < maxAttempts);

	logger.silly(
		`Using verification result after ${attempt}/${maxAttempts} attempts`,
	);

	return verificationResult;
}

async function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
