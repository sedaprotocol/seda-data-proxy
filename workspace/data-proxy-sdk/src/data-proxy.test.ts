import { describe, expect, it } from "bun:test";
import { Secp256k1 } from "@cosmjs/crypto";
import { Environment } from "./config";
import { DataProxy } from "./data-proxy";

describe("DataProxy", async () => {
	const privateKeyBuff = Buffer.from(new Array(32).fill(1));
	const keyPair = await Secp256k1.makeKeypair(privateKeyBuff);

	const dataProxy = new DataProxy(Environment.Devnet, {
		privateKey: Buffer.from(keyPair.privkey),
	});

	describe("signData", () => {
		it("should sign valid data", async () => {
			const signature = await dataProxy.signData(
				"https://example.com",
				"get",
				Buffer.from([]),
				Buffer.from(
					JSON.stringify({
						name: "data-proxy",
					}),
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
		it("should decode a proof", () => {
			const proof = Buffer.from(
				"031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f:1:c3e4f2b4c73612ae2da70fa0377b02b107a54d3f7ab9dd74e83f7563eeaf2a5d31ee5a8fe3be64f3fc60ad22c237677091fce1d61a3ba434215e0aac13426d40",
				"utf-8",
			);
			const decodedProof = dataProxy.decodeProof(proof.toString("base64"));

			if (decodedProof.isErr) {
				throw decodedProof.error;
			}

			const { publicKey, drId, signature } = decodedProof.value;
			expect(publicKey.toString("hex")).toBe(
				"031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f",
			);
			expect(drId).toBe("1");
			expect(signature.toString("hex")).toBe(
				"c3e4f2b4c73612ae2da70fa0377b02b107a54d3f7ab9dd74e83f7563eeaf2a5d31ee5a8fe3be64f3fc60ad22c237677091fce1d61a3ba434215e0aac13426d40",
			);
		});
	});
});
