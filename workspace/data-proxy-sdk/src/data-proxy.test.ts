import { describe, expect, it } from "bun:test";
import { Secp256k1 } from "@cosmjs/crypto";
import { Effect, Either } from "effect";
import { Environment } from "./config";
import { DataProxy } from "./data-proxy";

type SedaFastProofTestVector = {
	unixTimestampMs: bigint;
	signature: string;
	publicKey?: string;
	chainId?: string;
};

function createSedaFastProof(testVector: SedaFastProofTestVector): string {
	const payload = testVector.chainId
		? `${testVector.unixTimestampMs}:${testVector.signature}:${testVector.chainId}`
		: `${testVector.unixTimestampMs}:${testVector.signature}`;

	return Buffer.from(payload, "utf-8").toString("base64");
}

describe("DataProxy", async () => {
	const privateKeyBuff = Buffer.from(new Array(32).fill(1));
	const keyPair = await Secp256k1.makeKeypair(privateKeyBuff);

	const dataProxy = new DataProxy(Environment.Devnet, {
		privateKey: Buffer.from(keyPair.privkey),
	});

	// Data proxy without chain ID configured
	const dataProxyWithoutChainId = new DataProxy(null, {
		privateKey: Buffer.from(keyPair.privkey),
	});

	describe("signData", () => {
		it("should sign valid data", async () => {
			const signature = await Effect.runPromise(
				dataProxy.signData(
					"https://example.com",
					"get",
					Buffer.from([]),
					Buffer.from(
						JSON.stringify({
							name: "data-proxy",
						}),
					),
				),
			);

			expect(signature.publicKey).toBe(
				"031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f",
			);
			expect(signature.signature).toBe(
				"c3e4f2b4c73612ae2da70fa0377b02b107a54d3f7ab9dd74e83f7563eeaf2a5d31ee5a8fe3be64f3fc60ad22c237677091fce1d61a3ba434215e0aac13426d40",
			);
		});
	});

	describe("hashInputs", () => {
		it("should hash and concatenate the inputs", () => {
			const message = dataProxy.generateMessage(
				"https://example.com",
				"get",
				Buffer.from([]),
				Buffer.from(
					JSON.stringify({
						name: "data-proxy",
					}),
				),
			);
			expect(Buffer.from(message).toString("hex")).toBe(
				"edba3f8cfcd4165f73cd4641ced2b2ec0d3ba4338e3eec30edd58777d86b53b25a61babeb76c554783ca90a1a250e84f1b703409fdff33c217ab64dd51f05199c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a4706db57ed7cc68d9897b06df02ed002ce206633eec05690d504d61789ae87db019",
			);
		});
	});

	describe("decodeProof", () => {
		it("should decode a proof", async () => {
			const proof = Buffer.from(
				"031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f:1:c3e4f2b4c73612ae2da70fa0377b02b107a54d3f7ab9dd74e83f7563eeaf2a5d31ee5a8fe3be64f3fc60ad22c237677091fce1d61a3ba434215e0aac13426d40",
				"utf-8",
			);
			const decodedProof = await Effect.runPromise(
				Effect.either(dataProxy.decodeProof(proof.toString("base64"))),
			);

			if (Either.isLeft(decodedProof)) {
				throw decodedProof.left.error;
			}

			const { publicKey, drId, signature } = decodedProof.right;
			expect(publicKey.toString("hex")).toBe(
				"031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f",
			);
			expect(drId).toBe("1");
			expect(signature.toString("hex")).toBe(
				"c3e4f2b4c73612ae2da70fa0377b02b107a54d3f7ab9dd74e83f7563eeaf2a5d31ee5a8fe3be64f3fc60ad22c237677091fce1d61a3ba434215e0aac13426d40",
			);
		});
	});

	describe("decodeFastProof", () => {
		it("should decode a valid SEDA Fast proof with chain id", async () => {
			const testVector = {
				unixTimestampMs: 0n,
				publicKey:
					"031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f",
				signature:
					"3078599bcc106c0671fd5dbe1c6d1974c66e3efb83cd39e0dd3ab7ffe578777e3a865ef42bd9e9ac3659624ea47def412f2727a45857cca6902190b5afe2c73100",
				chainId: "seda-1-devnet",
			};

			const decodedProof = await Effect.runPromise(
				Effect.either(
					dataProxy.decodeSedaFastProof(createSedaFastProof(testVector)),
				),
			);

			if (Either.isLeft(decodedProof)) {
				expect.unreachable("Failed to decode proof");
			}

			const { publicKey, unixTimestampMs, signature } = decodedProof.right;
			expect(unixTimestampMs).toBe(testVector.unixTimestampMs);
			expect(publicKey.toString("hex")).toBe(testVector.publicKey);
			expect(signature.toString("hex")).toBe(testVector.signature);
		});

		it("should reject a SEDA Fast proof without chain id when chain id is configured", async () => {
			const testVector = {
				unixTimestampMs: 1782929240000n,
				signature:
					"dee3c4fa3bd7a3f88d32f5671cbeb8b7af3ddad6ed102f223859633fb1cf437201fbfbf4f47df7d53d842f9457299e4fbe595dc3791fb43a8331d2ca2c7e9de000",
			};

			const decodedProof = await Effect.runPromise(
				Effect.either(
					dataProxy.decodeSedaFastProof(createSedaFastProof(testVector)),
				),
			);

			if (Either.isRight(decodedProof)) {
				expect.unreachable("Should not be able to decode proof");
			}

			expect(decodedProof.left.error).toContain("Proof missing chain id");
		});

		it("should decode a valid SEDA Fast proof without chain id when chain id is not configured", async () => {
			const testVector = {
				unixTimestampMs: 1782929240000n,
				publicKey:
					"031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f",
				signature:
					"dee3c4fa3bd7a3f88d32f5671cbeb8b7af3ddad6ed102f223859633fb1cf437201fbfbf4f47df7d53d842f9457299e4fbe595dc3791fb43a8331d2ca2c7e9de000",
			};

			const decodedProof = await Effect.runPromise(
				Effect.either(
					dataProxyWithoutChainId.decodeSedaFastProof(
						createSedaFastProof(testVector),
					),
				),
			);

			if (Either.isLeft(decodedProof)) {
				expect.unreachable("Failed to decode proof");
			}

			const { publicKey, unixTimestampMs, signature } = decodedProof.right;
			expect(unixTimestampMs).toBe(testVector.unixTimestampMs);
			expect(publicKey.toString("hex")).toBe(testVector.publicKey);
			expect(signature.toString("hex")).toBe(testVector.signature);
		});

		it("should decode a valid SEDA Fast proof with chain id when chain id is not configured", async () => {
			const testVector = {
				unixTimestampMs: 0n,
				publicKey:
					"031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f",
				signature:
					"3078599bcc106c0671fd5dbe1c6d1974c66e3efb83cd39e0dd3ab7ffe578777e3a865ef42bd9e9ac3659624ea47def412f2727a45857cca6902190b5afe2c73100",
				chainId: "seda-1-devnet",
			};

			const decodedProof = await Effect.runPromise(
				Effect.either(
					dataProxyWithoutChainId.decodeSedaFastProof(
						createSedaFastProof(testVector),
					),
				),
			);

			if (Either.isLeft(decodedProof)) {
				expect.unreachable("Failed to decode proof");
			}

			const { publicKey, unixTimestampMs, signature } = decodedProof.right;
			expect(unixTimestampMs).toBe(testVector.unixTimestampMs);
			expect(publicKey.toString("hex")).toBe(testVector.publicKey);
			expect(signature.toString("hex")).toBe(testVector.signature);
		});

		it("should not recover the expected public key from the proof if it was tampered with", async () => {
			const decodedProof = await Effect.runPromise(
				Effect.either(
					dataProxy.decodeSedaFastProof(
						createSedaFastProof({
							unixTimestampMs: 1000n,
							signature:
								"3078599bcc106c0671fd5dbe1c6d1974c66e3efb83cd39e0dd3ab7ffe578777e3a865ef42bd9e9ac3659624ea47def412f2727a45857cca6902190b5afe2c73100",
							chainId: "seda-1-devnet",
						}),
					),
				),
			);

			if (Either.isLeft(decodedProof)) {
				expect.unreachable("Failed to decode proof");
			}

			const { publicKey } = decodedProof.right;
			expect(publicKey.toString("hex")).not.toBe(
				"031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f",
			);
		});

		it("should return an error if the chain id is invalid", async () => {
			const decodedProof = await Effect.runPromise(
				Effect.either(
					dataProxy.decodeSedaFastProof(
						createSedaFastProof({
							unixTimestampMs: 0n,
							signature:
								"3078599bcc106c0671fd5dbe1c6d1974c66e3efb83cd39e0dd3ab7ffe578777e3a865ef42bd9e9ac3659624ea47def412f2727a45857cca6902190b5afe2c73100",
							chainId: "seda-1-testnet",
						}),
					),
				),
			);

			if (Either.isRight(decodedProof)) {
				expect.unreachable("Should not be able to decode proof");
			}

			expect(decodedProof.left.error).toContain("Invalid client chain id");
		});
	});
});
