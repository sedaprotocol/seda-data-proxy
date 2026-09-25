import type { Effect, Schedule } from "effect";
import type { LighterModuleConfig } from "../../config/lighter-module-config";
import { isRecord, parseJsonRecord } from "../shared/json";
import type { PriceCache } from "../shared/price-cache";
import {
	type VenueParsedInbound,
	type VenueWS,
	createVenueWS,
} from "../shared/venue-ws";
import { createTickerModuleService } from "./ticker-module";

export const PING_FRAME = JSON.stringify({ type: "ping" });
export const PONG_FRAME = JSON.stringify({ type: "pong" });

export const LighterModuleService = (config: LighterModuleConfig) =>
	createTickerModuleService({
		venue: "lighter",
		routeType: "lighter",
		identityField: "marketId",
		config,
		parseKey: parseMarketId,
		createWS: createLighterWS,
	});

export interface LighterPriceFrame {
	s: string;
	[key: string]: unknown;
}

export const buildSubscribeFrame = (marketId: number): string =>
	JSON.stringify({ type: "subscribe", channel: `ticker/${marketId}` });

export const buildUnsubscribeFrame = (marketId: number): string =>
	JSON.stringify({ type: "unsubscribe", channel: `ticker/${marketId}` });

export const parseMarketId = (token: string): number | null => {
	const id = Number(token);
	return Number.isInteger(id) && id >= 0 ? id : null;
};

/** The inbound `channel` is `ticker:{id}` even though subscribe sends
 * `ticker/{id}`. Accept either separator. */
const parseMarketIdFromChannel = (channel: unknown): number | null => {
	if (typeof channel !== "string") return null;
	const last = channel.split(/[:/]/).pop();
	if (last === undefined) return null;
	const id = Number(last);
	return Number.isInteger(id) ? id : null;
};

export const parseInboundFrame = (
	raw: string,
): VenueParsedInbound<number, LighterPriceFrame> | null => {
	const json = parseJsonRecord(raw);
	if (!json) return null;
	if (json.type === "ping") return { kind: "ping" };

	const err = json.error;
	if (isRecord(err)) {
		return {
			kind: "error",
			code: typeof err.code === "number" ? err.code : null,
			message: typeof err.message === "string" ? err.message : null,
		};
	}

	const ticker = json.ticker;
	if (!isRecord(ticker) || typeof ticker.s !== "string") return null;
	const marketId = parseMarketIdFromChannel(json.channel);
	if (marketId === null) return null;
	return {
		kind: "tickers",
		frames: [{ key: marketId, frame: ticker as LighterPriceFrame }],
	};
};

export const createLighterWS = (
	config: LighterModuleConfig,
	cache: PriceCache<number, LighterPriceFrame>,
	reconnectSchedule?: Schedule.Schedule<unknown, unknown, never>,
): Effect.Effect<VenueWS<number>, never, never> =>
	createVenueWS({
		venue: "lighter",
		config,
		cache,
		reconnectSchedule,
		keepalive: {
			interval: config.keepaliveInterval,
			pingFrame: PING_FRAME,
			pongFrame: PONG_FRAME,
		},
		buildSubscribeFrame: (keys) => keys.map(buildSubscribeFrame),
		buildUnsubscribeFrame: (keys) => keys.map(buildUnsubscribeFrame),
		parseInboundFrame,
	});
