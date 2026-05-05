import { EventType, type IEvent } from "@dxfeed/api";
import type { DxFeedEventTypeName } from "../../config/dxfeed-module-config";

const allowed = new Set<string>(Object.values(EventType));

export const parseDxFeedEventTypes = (
	names: readonly DxFeedEventTypeName[],
): EventType[] =>
	names.map((name) => {
		if (!allowed.has(name)) {
			throw new Error(`Invalid dxFeed EventType: ${name}`);
		}
		return name as EventType;
	});

/** Pull a numeric quote from common dxFeed event fields */
export const extractNumericPrice = (event: IEvent): number | undefined => {
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
