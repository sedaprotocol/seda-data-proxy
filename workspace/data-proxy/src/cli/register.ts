import { Command } from "@commander-js/extra-typings";
import { Keccak256 } from "@cosmjs/crypto";
import { fromBech32 } from "@cosmjs/encoding";
import { Environment } from "@seda-protocol/data-proxy-sdk";
import { defaultConfig } from "@seda-protocol/data-proxy-sdk/src/config";
import { trySync } from "@seda-protocol/utils";
import { ecdsaSign, publicKeyCreate } from "secp256k1";
import { Maybe } from "true-myth";
import { DEFAULT_ENVIRONMENT, PRIVATE_KEY_ENV_KEY } from "../constants";
import { sedaToAseda } from "./utils/big";
import { loadPrivateKey } from "./utils/private-key";

export const registerCommand = new Command("register")
	.description("Register the Data Proxy node on the SEDA chain")
	.argument(
		"<payout-address>",
		"SEDA chain address to payout for completing requests",
	)
	.argument("<fee>", "Fee amount per request in SEDA")
	.option(
		"-pkf, --private-key-file <string>",
		"Path where to create the private key json",
	)
	.option(
		"-n, --network <network>",
		"The SEDA network to chose",
		DEFAULT_ENVIRONMENT,
	)
	.option(
		"--memo <string>",
		"A custom note to attach to this Data Proxy registration",
	)
	.action(async (payoutAddress, fee, options) => {
		const network = Maybe.of(defaultConfig[options.network as Environment]);

		if (network.isNothing) {
			console.error(
				`Given network ${options.network} does not exist, please select ${Environment.Devnet}, ${Environment.Testnet} or ${Environment.Mainnet}`,
			);
			process.exit(1);
		}

		const privateKey = await loadPrivateKey(options.privateKeyFile);

		if (privateKey.isErr) {
			console.error(privateKey.error);
			console.error(
				`Please make sure either the environment variable ${PRIVATE_KEY_ENV_KEY} is set or you pass in the -pkf argument`,
			);
			process.exit(1);
		}

		if (!isValidSedaAddress(payoutAddress)) {
			console.error(`${payoutAddress} is not a valid SEDA address`);
			process.exit(1);
		}

		const aSedaAmount = trySync(() => sedaToAseda(fee)).map(
			(amount) => `${amount}aseda`,
		);

		if (aSedaAmount.isErr) {
			console.error(`${fee} is not a valid number`);
			process.exit(1);
		}

		const memo = Maybe.of(options.memo).unwrapOr("");
		const hasher = new Keccak256(Buffer.from(aSedaAmount.value));

		hasher.update(Buffer.from(payoutAddress));
		hasher.update(Buffer.from(memo));
		hasher.update(Buffer.from(network.value.chainId));
		const hash = Buffer.from(hasher.digest());

		const signatureRaw = ecdsaSign(hash, privateKey.value);
		const signature = Buffer.from(signatureRaw.signature);
		const publicKey = Buffer.from(publicKeyCreate(privateKey.value, true));

		const url = new URL("/data-proxy/register", network.value.explorerUrl);
		url.searchParams.append("fee", aSedaAmount.value);
		url.searchParams.append("payoutAddress", payoutAddress);
		url.searchParams.append("publicKey", publicKey.toString("hex"));
		url.searchParams.append("signature", signature.toString("hex"));
		url.searchParams.append("recoveryId", signatureRaw.recid.toString());
		url.searchParams.append("memo", memo);

		console.info(`Fee amount: \t\t${fee} SEDA (${aSedaAmount.value})`);
		console.info(`Payout address: \t${payoutAddress}`);
		console.info(`Signed hash: \t\t${hash.toString("hex")}`);
		console.info(`Public key: \t\t${publicKey.toString("hex")}`);
		console.info(`Signature: \t\t${signature.toString("hex")}`);
		console.info(`Signature recovery id: \t${signatureRaw.recid}`);
		console.info("");
		console.info(`Submit your transaction on: \n${url.toString()}`);
	});

function isValidSedaAddress(address: string): boolean {
	try {
		const { prefix } = fromBech32(address);
		return prefix === "seda";
	} catch (error) {
		return false;
	}
}
