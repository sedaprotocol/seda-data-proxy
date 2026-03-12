import { constants, type DataProxy } from "@seda-protocol/data-proxy-sdk";
import { Data, Effect, Match, Option } from "effect";
import type { Config } from "../../config/config-parser";
import { UnknownError } from "../../errors";
import { verifyWithRetry } from "../../utils/verify-with-retry";

type VerifyProofParams = {
	headers: Record<string, string | undefined>;
	config: Config;
	dataProxy: DataProxy;
};

export class VerifyProofError extends Data.TaggedError("VerifyProofError")<{
	error: string | unknown;
}> {
	message = `Failed to verify proof: ${this.error}`;
}

export class IneligibleProofError extends Data.TaggedError(
	"IneligibleProofError",
)<{
	error: string | unknown;
}> {
	message = `Ineligible proof: ${this.error}`;
}

const handleSedaFastProof = (
	sedaFastProofHeader: string,
	dataProxy: DataProxy,
) =>
	Effect.gen(function* () {
		const decodedProof =
			yield* dataProxy.decodeSedaFastProof(sedaFastProofHeader);

		const proofId = decodedProof.publicKey.toString("hex");
		yield* Effect.logDebug(`SEDA Fast Public Key: ${proofId}`);

		const verificationResult = yield* dataProxy.verifyFastProof(decodedProof);

		if (!verificationResult.isValid) {
			return yield* Effect.fail(
				new IneligibleProofError({
					error: `At timestamp ${verificationResult.currentUnixTimestamp}: ${verificationResult.status}`,
				}),
			);
		}

		return decodedProof;
	}).pipe(
		Effect.catchTag("FailedToDecodeSedaFastProofError", (error) =>
			Effect.fail(new VerifyProofError({ error })),
		),
	);

const handleSedaCoreProof = (
	sedaCoreProofHeader: string,
	config: Config,
	eligibleHeight: Option.Option<bigint>,
	dataProxy: DataProxy,
) =>
	Effect.gen(function* () {
		const decodedProof = yield* dataProxy.decodeProof(sedaCoreProofHeader);
		const proofId = decodedProof.drId;
		yield* Effect.logDebug(`SEDA Core Data Request Id: ${proofId}`);

		const verificationResult = yield* verifyWithRetry(
			dataProxy,
			sedaCoreProofHeader,
			eligibleHeight,
			config.verificationMaxRetries,
			() => config.verificationRetryDelay,
		);

		if (!verificationResult.isValid) {
			return yield* Effect.fail(
				new IneligibleProofError({
					error: `At height ${verificationResult.currentHeight}: ${verificationResult.status}`,
				}),
			);
		}

		return decodedProof;
	}).pipe(
		Effect.catchTag("FailedToDecodeProofError", (error) =>
			Effect.fail(new VerifyProofError({ error })),
		),
		Effect.catchTag("FailedToVerifyCoreProofError", (error) =>
			Effect.fail(new IneligibleProofError({ error })),
		),
	);

export const verifyProof = (params: VerifyProofParams) =>
	Effect.gen(function* () {
		const { headers, config, dataProxy } = params;

		yield* Effect.logDebug("Verifying proof");

		const proofHeader = Option.fromNullable(
			headers[constants.PROOF_HEADER_KEY],
		);
		const sedaFastProofHeader = Option.fromNullable(
			headers[constants.SEDA_FAST_PROOF_HEADER_KEY],
		);

		const heightFromHeader = Number(headers[constants.HEIGHT_HEADER_KEY]);
		const eligibleHeight = Option.fromNullable(
			Number.isNaN(heightFromHeader) ? undefined : BigInt(heightFromHeader),
		);

		yield* Effect.logDebug(
			`Received proof for height ${Option.getOrElse(eligibleHeight, () => "unknown")}`,
		);

		if (Option.isNone(proofHeader) && Option.isNone(sedaFastProofHeader)) {
			return yield* Effect.fail(
				new VerifyProofError({
					error: `Header "${constants.PROOF_HEADER_KEY}" or "${constants.SEDA_FAST_PROOF_HEADER_KEY}" is not provided`,
				}),
			);
		}

		if (!config.sedaFast?.enable && Option.isSome(sedaFastProofHeader)) {
			// Disallow SEDA Fast usage if it's not enabled
			return yield* Effect.fail(
				new VerifyProofError({
					error: `Header "${constants.SEDA_FAST_PROOF_HEADER_KEY}" is not allowed`,
				}),
			);
		}

		if (Option.isSome(sedaFastProofHeader)) {
			return yield* handleSedaFastProof(sedaFastProofHeader.value, dataProxy);
		}

		if (Option.isSome(proofHeader)) {
			return yield* handleSedaCoreProof(
				proofHeader.value,
				config,
				eligibleHeight,
				dataProxy,
			);
		}

		return yield* Effect.fail(
			new UnknownError({ error: "No proof header provided" }),
		);
	});
