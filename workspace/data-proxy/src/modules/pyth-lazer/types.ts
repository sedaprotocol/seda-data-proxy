import type { ParsedFeedPayload } from "@pythnetwork/pyth-lazer-sdk";
import { Data } from "effect";
import type { PythLazerChannel } from "../../config/pyth-lazer-module-config";

export type PriceFeedId = number;
export type PriceFeedSymbol = string;

export interface CachedPriceFeed {
	priceFeed: ParsedFeedPayload;
	timestampUs: string;
}

// Cache and subscription identity. The same feed on two channels (real_time vs
// fixed_rate@200ms) is two distinct entries, so a request is served the channel
// it asked for instead of whichever one happened to be subscribed first.
export type FeedChannelKey = {
	readonly priceFeedId: PriceFeedId;
	readonly channel: PythLazerChannel;
};

// Data.struct gives the key structural Hash/Equal, so it works directly as a
// MutableHashMap key while staying a plain readonly object for field access.
export const makeFeedChannelKey = (
	priceFeedId: PriceFeedId,
	channel: PythLazerChannel,
): FeedChannelKey => Data.struct({ priceFeedId, channel });

export type PythLazerHandlerError = {
	_tag: string;
	message: string;
	status: number;
};
