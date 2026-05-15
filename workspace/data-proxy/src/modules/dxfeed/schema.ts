import {
	type DxFeedEventType,
	dxfeedEventTypes,
} from "../../config/dxfeed-module-config";

export type DxFeedFullEventData = Record<string, unknown> & {
	symbol: string;
	type: DxFeedEventType;
};

export const extractFullEventDataFromEvent = (
	event: unknown,
): DxFeedFullEventData | undefined => {
	if (
		typeof event !== "object" ||
		event === null ||
		!("eventSymbol" in event) ||
		!("eventType" in event)
	) {
		return undefined;
	}

	const symbol = event.eventSymbol;
	if (typeof symbol !== "string") {
		return undefined;
	}

	const type = event.eventType;
	if (!isDxFeedEventType(type)) {
		return undefined;
	}

	return { ...event, symbol, type };
};

const isDxFeedEventType = (type: unknown): type is DxFeedEventType =>
	dxfeedEventTypes.includes(type as DxFeedEventType);
