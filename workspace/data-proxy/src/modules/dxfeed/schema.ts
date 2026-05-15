export type DxFeedFullEventData = Record<string, unknown> & {
	symbol: string;
};

export const extractFullEventDataFromEvent = (
	event: unknown,
): DxFeedFullEventData | undefined => {
	const record = event as Record<string, unknown>;
	const symbol = readString(record, "eventSymbol");
	if (symbol === undefined) {
		return undefined;
	}
	return { ...record, symbol };
};

const readString = (
	record: Record<string, unknown>,
	key: string,
): string | undefined => {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
};
