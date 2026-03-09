import type { CosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { Effect } from "effect";
import { FailedToVerifyCoreProofError } from "../errors";

export const verifyCoreProof = (
	proof: {
		drId: string;
		signature: Buffer;
		publicKey: Buffer;
	},
	cosmwasmClient: CosmWasmClient,
	coreContractAddress: string,
) => {
	return Effect.gen(function* () {
		// Verify if eligible (right now is this one staked or not)
		const result = yield* Effect.tryPromise({
			try: () =>
				cosmwasmClient.queryContractSmart(coreContractAddress, {
					get_executor_eligibility: {
						data: proof,
					},
				}),
			catch: (error) => new FailedToVerifyCoreProofError({ error }),
		});

		return result;
	});
};
