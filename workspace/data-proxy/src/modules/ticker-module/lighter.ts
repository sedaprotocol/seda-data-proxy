import type { Effect, Schedule } from "effect";
import type {
	LighterModuleConfig,
	LighterStreamType,
} from "../../config/lighter-module-config";
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
		extraInitLog: { streamType: config.streamType },
	});

export interface LighterPriceFrame {
	[key: string]: unknown;
}

export const buildSubscribeFrame = (
	marketId: number,
	streamType: LighterStreamType,
): string =>
	JSON.stringify({ type: "subscribe", channel: `${streamType}/${marketId}` });

export const buildUnsubscribeFrame = (
	marketId: number,
	streamType: LighterStreamType,
): string =>
	JSON.stringify({
		type: "unsubscribe",
		channel: `${streamType}/${marketId}`,
	});

export const parseMarketId = (token: string): number | null => {
	const id = Number(token);
	return Number.isInteger(id) && id >= 0 ? id : null;
};

/** The inbound `channel` is `{streamType}:{id}` even though subscribe sends
 * `{streamType}/{id}`. Accept either separator. */
const parseMarketIdFromChannel = (
	channel: unknown,
	streamType: LighterStreamType,
): number | null => {
	if (typeof channel !== "string") return null;
	const [prefix, idPart, ...rest] = channel.split(/[:/]/);
	if (rest.length > 0 || prefix !== streamType || idPart === undefined) {
		return null;
	}
	const id = Number(idPart);
	return Number.isInteger(id) ? id : null;
};

const frameForStream = (
	json: Record<string, unknown>,
	streamType: LighterStreamType,
): LighterPriceFrame | null => {
	switch (streamType) {
		case "trade": {
			if (!Array.isArray(json.trades)) return null;
			const frame: LighterPriceFrame = { trades: json.trades };
			if (Array.isArray(json.liquidation_trades)) {
				frame.liquidation_trades = json.liquidation_trades;
			}
			return frame;
		}
		case "ticker":
		case "order_book": {
			const payload = json[streamType];
			if (!isRecord(payload)) return null;
			return payload;
		}
		default: {
			const _exhaustive: never = streamType;
			return _exhaustive;
		}
	}
};

export const parseInboundFrame = (
	raw: string,
	streamType: LighterStreamType,
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

	const marketId = parseMarketIdFromChannel(json.channel, streamType);
	if (marketId === null) return null;
	const frame = frameForStream(json, streamType);
	if (frame === null) return null;
	return { kind: "tickers", frames: [{ key: marketId, frame }] };
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
		buildSubscribeFrame: (keys) =>
			keys.map((marketId) => buildSubscribeFrame(marketId, config.streamType)),
		buildUnsubscribeFrame: (keys) =>
			keys.map((marketId) =>
				buildUnsubscribeFrame(marketId, config.streamType),
			),
		parseInboundFrame: (raw) => parseInboundFrame(raw, config.streamType),
	});
