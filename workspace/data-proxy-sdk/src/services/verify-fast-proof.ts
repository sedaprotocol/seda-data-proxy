import { Effect } from "effect";

export const verifyFastProof = (
	proof: {
		unixTimestamp: bigint;
		signature: Buffer;
		publicKey: Buffer;
	},
	fastMaxProofAgeMs: number,
	fastAllowedClients: string[],
) => {
	return Effect.gen(function* () {
		const now = BigInt(Date.now());
		const delta = now - proof.unixTimestamp;

		if (delta > fastMaxProofAgeMs) {
			return yield* Effect.succeed({
				isValid: false,
				status: "fast_unix_timestamp_too_old" as const,
				currentUnixTimestamp: now,
			});
		}

		if (!fastAllowedClients.includes(proof.publicKey.toString("hex"))) {
			// Check if the client is allowed
			return yield* Effect.succeed({
				isValid: false,
				status: "fast_client_not_allowed" as const,
				currentUnixTimestamp: now,
			});
		}

		return yield* Effect.succeed({
			isValid: true,
			status: "eligible" as const,
			currentUnixTimestamp: now,
		});
	});
};
