import {
	ExtendedSecp256k1Signature,
	Secp256k1,
	keccak256,
} from "@cosmjs/crypto";
import { Effect } from "effect";
import { FailedToDecodeSedaFastProofError } from "../errors";

// "{unixTimestampMs}:{signatureAsHexString}" — signed over keccak256(timestamp)
// or:
// "{unixTimestampMs}:{signatureAsHexString}:{clientChainId}" — signed over keccak256(timestamp || chainId)
export const decodeSedaFastProof = (proof: string, chainId: string) => {
	return Effect.gen(function* () {
		try {
			const decoded = Buffer.from(proof, "base64");
			const parts = decoded.toString("utf-8").split(":");

			if (parts.length !== 2 && parts.length !== 3) {
				return yield* Effect.fail(
					new FailedToDecodeSedaFastProofError({
						error: `Invalid proof format: expected 2 or 3 colon-separated fields, got ${parts.length}`,
					}),
				);
			}

			const [unixTimestampMs, signature, clientChainId] = parts;

			if (clientChainId !== undefined && clientChainId !== chainId) {
				return yield* Effect.fail(
					new FailedToDecodeSedaFastProofError({
						error: `Invalid client chain id: ${clientChainId}, wanted: ${chainId}`,
					}),
				);
			}

			const timestampBuffer = Buffer.alloc(8); // 64-bit = 8 bytes
			timestampBuffer.writeBigUInt64BE(BigInt(unixTimestampMs));

			const messageHash =
				parts.length === 2
					? keccak256(timestampBuffer)
					: keccak256(Buffer.concat([timestampBuffer, Buffer.from(chainId)]));

			const extendSignatures = ExtendedSecp256k1Signature.fromFixedLength(
				Buffer.from(signature, "hex"),
			);
			const pubKey = Secp256k1.recoverPubkey(extendSignatures, messageHash);
			const compressedPubKey = Secp256k1.compressPubkey(pubKey);

			return yield* Effect.succeed({
				publicKey: Buffer.from(compressedPubKey),
				unixTimestampMs: BigInt(unixTimestampMs),
				signature: Buffer.from(signature, "hex"),
			});
		} catch (error) {
			return yield* Effect.fail(
				new FailedToDecodeSedaFastProofError({ error }),
			);
		}
	});
};
