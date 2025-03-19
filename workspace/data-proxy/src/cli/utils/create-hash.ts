import { Keccak256 } from "@cosmjs/crypto";

export function createHash(
	fee: string,
	adminAddress: string,
	payoutAddress: string,
	memo: string,
	chainId: string,
) {
	const hasher = new Keccak256(Buffer.from(fee));
	hasher.update(Buffer.from(adminAddress));
	hasher.update(Buffer.from(payoutAddress));
	hasher.update(Buffer.from(memo));
	hasher.update(Buffer.from(chainId));
	const hash = Buffer.from(hasher.digest());

	return hash;
}
