import {
	ExtendedSecp256k1Signature,
	Secp256k1,
	keccak256,
} from "@cosmjs/crypto";
import { Effect } from "effect";
import { FailedToDecodeSedaFastProofError } from "../errors";

export const decodeSedaFastProof = (proof: string, chainId: string) => {
	return Effect.gen(function* () {
		try {
			// The format is "{unixTimestampMs}:{signatureAsHexString}:{clientChainId}"
			const decoded = Buffer.from(proof, "base64");
			const [unixTimestampMs, signature, clientChainId] = decoded
				.toString("utf-8")
				.split(":");

			if (clientChainId !== chainId) {
				return yield* Effect.fail(
					new FailedToDecodeSedaFastProofError({
						error: `Invalid client chain id: ${clientChainId}, wanted: ${chainId}`,
					}),
				);
			}

			const unixTimestampBuffer = Buffer.alloc(8); // 64-bit = 8 bytes
			unixTimestampBuffer.writeBigUInt64BE(BigInt(unixTimestampMs));
			const chainIdBytes = Buffer.from(chainId);

			const messageHash = keccak256(
				Buffer.concat([unixTimestampBuffer, chainIdBytes]),
			);

			const extendSignatures = ExtendedSecp256k1Signature.fromFixedLength(
				Buffer.from(signature, "hex"),
			);
			const pubKey = Secp256k1.recoverPubkey(extendSignatures, messageHash);
			const compressedPubKey = Secp256k1.compressPubkey(pubKey);

			return yield* Effect.succeed({
				publicKey: Buffer.from(compressedPubKey),
				unixTimestamp: BigInt(unixTimestampMs),
				signature: Buffer.from(signature, "hex"),
			});
		} catch (error) {
			return yield* Effect.fail(
				new FailedToDecodeSedaFastProofError({ error }),
			);
		}
	});
};
