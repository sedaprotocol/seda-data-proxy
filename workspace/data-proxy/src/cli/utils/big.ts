import Big, { type BigSource } from "big.js";

export default Big;

Big.PE = 100000;

export const SEDA_EXPONENT = 18;

export function toDecimal(amount: BigSource, decimals: number): Big {
	const exponent = new Big(10).pow(decimals);
	return new Big(amount).div(exponent);
}

export function fromDecimal(amount: BigSource, decimals: number): Big {
	const exponent = new Big(10).pow(decimals);
	return new Big(amount).mul(exponent);
}

export function sedaToAseda(amount: BigSource): Big {
	const aseda = fromDecimal(amount, SEDA_EXPONENT);
	if (aseda.lt(1)) {
		throw new Error(`${amount} is smaller than 1 aseda`);
	}

	return aseda;
}

export function asedaToSeda(amount: BigSource): Big {
	return toDecimal(amount, SEDA_EXPONENT);
}
