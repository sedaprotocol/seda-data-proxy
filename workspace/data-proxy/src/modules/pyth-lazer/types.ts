import type { ParsedFeedPayload } from "@pythnetwork/pyth-lazer-sdk";

export type PriceFeedId = number;
export type PriceFeedSymbol = string;

export interface CachedPriceFeed {
	priceFeed: ParsedFeedPayload;
	timestampUs: string;
}

export type PythLazerHandlerError = {
	_tag: string;
	message: string;
	status: number;
};
