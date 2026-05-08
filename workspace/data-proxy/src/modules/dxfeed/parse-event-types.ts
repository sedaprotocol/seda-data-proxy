/** Pull a numeric quote from common dxFeed event fields */
export const extractNumericPrice = (event: any): number | undefined => {
	const record = event as Record<string, unknown>;
	const keys = [
		"value",
		"price",
		"dayClosePrice",
		"dayOpenPrice",
		"vwap",
		"prevDayClosePrice",
		"bidPrice",
		"askPrice",
	] as const;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value)) {
			return value;
		}
	}
	return undefined;
};
