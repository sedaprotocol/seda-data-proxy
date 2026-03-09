import { Command } from "@commander-js/extra-typings";
import { fromBech32 } from "@cosmjs/encoding";
import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { Environment } from "@seda-protocol/data-proxy-sdk";
import { defaultConfig } from "@seda-protocol/data-proxy-sdk/src/config";
import { trySync } from "@seda-protocol/utils";
import { Effect, Either, LogLevel, Logger } from "effect";
import { ecdsaSign, publicKeyCreate } from "secp256k1";
import { Maybe } from "true-myth";
import { DEFAULT_ENVIRONMENT, PRIVATE_KEY_ENV_KEY } from "../constants";
import { sedaToAseda } from "./utils/big";
import { createHash } from "./utils/create-hash";
import { loadNetworkFromKeyFile, loadPrivateKey } from "./utils/private-key";

export const registerCmd = new Command("register")
	.description("Register the Data Proxy node on the SEDA chain")
	.argument(
		"<admin-address>",
		"SEDA chain address to register as admin and payout address for completed requests. This should be the address with which you will be signing the transaction. Payout can also be set separately using the --payout-address flag.",
	)
	.argument("<fee>", "Fee amount per request in SEDA")
	.option(
		"-pkf, --private-key-file <string>",
		"Path where to create the private key json",
	)
	.option("-n, --network <network>", "The SEDA network to chose")
	.option(
		"--payout-address <address>",
		"SEDA chain address to payout for completing requests. If not provided, the admin address will be used as payout address.",
	)
	.option(
		"--memo <string>",
		"A custom note to attach to this Data Proxy registration",
	)
	.action(async (adminAddress, fee, options) => {
		const program = Effect.gen(function* () {
			let networkEnv: Environment;
			if (options.network) {
				// Validate network option
				const validNetworks = Object.values(Environment);
				if (!validNetworks.includes(options.network as Environment)) {
					const networkList = validNetworks.join(", ");
					yield* Effect.logError(
						`Invalid network '${options.network}'. Valid options: ${networkList}`,
					);
					process.exit(1);
				}
				networkEnv = options.network as Environment;
			} else {
				// Load network from private key file (defaults to Testnet if not provided)
				const networkResult = yield* Effect.either(
					loadNetworkFromKeyFile(options.privateKeyFile),
				);
				if (Either.isLeft(networkResult)) {
					yield* Effect.logError(
						`Failed to load network from private key file: ${networkResult.left}`,
					);
					process.exit(1);
				}
				networkEnv = networkResult.right;
			}
			const network = defaultConfig[networkEnv];

			const privateKey = yield* Effect.either(
				loadPrivateKey(options.privateKeyFile),
			);

			if (Either.isLeft(privateKey)) {
				yield* Effect.logError(privateKey.left);
				yield* Effect.logError(
					`Please make sure either the environment variable ${PRIVATE_KEY_ENV_KEY} is set or you pass in the -pkf argument`,
				);
				process.exit(1);
			}

			const payoutAddress = Maybe.of(options.payoutAddress).unwrapOr(
				adminAddress,
			);

			if (!isValidSedaAddress(adminAddress)) {
				yield* Effect.logError(
					`Admin address ${adminAddress} is not a valid SEDA address`,
				);
				process.exit(1);
			}

			if (!isValidSedaAddress(payoutAddress)) {
				yield* Effect.logError(
					`Payout address ${payoutAddress} is not a valid SEDA address`,
				);
				process.exit(1);
			}

			const aSedaAmount = trySync(() => sedaToAseda(fee)).map(
				(amount) => `${amount}aseda`,
			);

			if (aSedaAmount.isErr) {
				yield* Effect.logError(`${fee} is not a valid number`);
				process.exit(1);
			}

			const memo = Maybe.of(options.memo).unwrapOr("");

			const hash = createHash(
				aSedaAmount.value,
				adminAddress,
				payoutAddress,
				memo,
				network.chainId,
			);

			const signatureRaw = ecdsaSign(hash, privateKey.right);
			const signature = Buffer.from(signatureRaw.signature);
			const publicKey = Buffer.from(publicKeyCreate(privateKey.right, true));

			const url = new URL("/data-proxy/register", network.explorerUrl);
			url.searchParams.append("fee", aSedaAmount.value);
			url.searchParams.append("adminAddress", adminAddress);
			url.searchParams.append("payoutAddress", payoutAddress);
			url.searchParams.append("publicKey", publicKey.toString("hex"));
			url.searchParams.append("signature", signature.toString("hex"));
			url.searchParams.append("recoveryId", signatureRaw.recid.toString());
			url.searchParams.append("memo", memo);

			yield* Effect.logInfo(
				`Fee amount: \t\t${fee} SEDA (${aSedaAmount.value})`,
			);
			yield* Effect.logInfo(`Admin address: \t\t${adminAddress}`);
			yield* Effect.logInfo(`Payout address: \t${payoutAddress}`);
			yield* Effect.logInfo(`Signed hash: \t\t${hash.toString("hex")}`);
			yield* Effect.logInfo(`Public key: \t\t${publicKey.toString("hex")}`);
			yield* Effect.logInfo(`Signature: \t\t${signature.toString("hex")}`);
			yield* Effect.logInfo(`Signature recovery id: \t${signatureRaw.recid}`);
			yield* Effect.logInfo("");
			yield* Effect.logInfo(`Submit your transaction on: \n${url.toString()}`);
		}).pipe(
			Effect.provide(NodeFileSystem.layer),
			Logger.withMinimumLogLevel(LogLevel.Debug),
		);

		return NodeRuntime.runMain(program);
	});

function isValidSedaAddress(address: string): boolean {
	try {
		const { prefix } = fromBech32(address);
		return prefix === "seda";
	} catch (error) {
		return false;
	}
}
