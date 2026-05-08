import type { DxFeedEventField } from "../../config/dxfeed-module-config";

export type DxFeedSymbol = string;

export type DxFeedDataPrice = {
	symbol: string;
} & Partial<Record<DxFeedEventField, unknown>>;

const readString = (
	record: Record<string, unknown>,
	key: string,
): string | undefined => {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
};

export const extractPriceDataFromEvent = (
	event: unknown,
	eventFields: readonly DxFeedEventField[],
): DxFeedDataPrice | undefined => {
	const record = event as Record<string, unknown>;

	const symbol = readString(record, "eventSymbol");
	if (symbol === undefined) {
		return undefined;
	}

	const fields = {} as Partial<Record<DxFeedEventField, unknown>>;

	for (const key of eventFields) {
		if (Object.hasOwn(record, key)) {
			fields[key] = record[key];
		}
	}

	return {
		symbol,
		...fields,
	};
};
