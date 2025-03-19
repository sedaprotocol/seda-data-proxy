import { Secp256k1 } from "@cosmjs/crypto";
import { ecdsaSign } from "secp256k1";
import { createHash } from "../cli/utils/create-hash";

// Test vectors are generated for a specific chain id.
const CHAIN_ID = "seda-1-testvectors";

const privateKeyBuff = Buffer.from(new Array(32).fill(1));
const keyPair = await Secp256k1.makeKeypair(privateKeyBuff);

const testCases = [
	{
		name: "Happy path",
		fee: "10000000000000000000aseda",
		adminAddress: "seda1uea9km4nup9q7qu96ak683kc67x9jf7ste45z5",
		payoutAddress: "seda1wyzxdtpl0c99c92n397r3drlhj09qfjvf6teyh",
		memo: "",
	},
	{
		name: "Happy path with memo",
		fee: "9000000000000000000aseda",
		adminAddress: "seda1uea9km4nup9q7qu96ak683kc67x9jf7ste45z5",
		payoutAddress: "seda1wyzxdtpl0c99c92n397r3drlhj09qfjvf6teyh",
		memo: "This is a sweet proxy",
	},
	{
		name: "Registering an already existing data proxy should fail",
		fee: "10000000000000000000aseda",
		adminAddress: "seda1uea9km4nup9q7qu96ak683kc67x9jf7ste45z5",
		payoutAddress: "seda1uea9km4nup9q7qu96ak683kc67x9jf7ste45z5",
		memo: "",
	},
];

for (const testCase of testCases) {
	const hash = createHash(
		testCase.fee,
		testCase.adminAddress,
		testCase.payoutAddress,
		testCase.memo,
		CHAIN_ID,
	);
	const signatureRaw = ecdsaSign(hash, keyPair.privkey);
	const signature = Buffer.from(signatureRaw.signature);
	const publicKey = Buffer.from(keyPair.pubkey);

	console.log(`name: "${testCase.name}",`);
	console.log("msg: &types.MsgRegisterDataProxy{");
	console.log(`    AdminAddress: "${testCase.adminAddress}",`);
	console.log(`    PayoutAddress: "${testCase.payoutAddress}",`);
	console.log(
		`    Fee: s.NewFeeFromString("${testCase.fee.replace("aseda", "")}"),`,
	);
	console.log(`    Memo: "${testCase.memo}",`);
	console.log(`    PubKey: "${publicKey.toString("hex")}",`);
	console.log(`    Signature: "${signature.toString("hex")}",`);
	console.log("},");
	console.log("");
}
