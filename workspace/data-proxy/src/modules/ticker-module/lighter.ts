import type { Effect, Schedule } from "effect";
import type { LighterModuleConfig } from "../../config/lighter-module-config";
import type { PriceCache } from "../shared/price-cache";
import { type VenueWS, createVenueWS } from "../shared/venue-ws";
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

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

export type ParsedInbound =
	| { kind: "ping" }
	| { kind: "ticker"; marketId: number | null; frame: LighterPriceFrame }
	| { kind: "error"; code: number | null; message: string | null };

export const parseInboundFrame = (raw: string): ParsedInbound | null => {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(json)) return null;
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
	if (isRecord(ticker) && typeof ticker.s === "string") {
		return {
			kind: "ticker",
			marketId: parseMarketIdFromChannel(json.channel),
			frame: ticker as LighterPriceFrame,
		};
	}
	return null;
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
		parseInboundFrame: (raw) => {
			const parsed = parseInboundFrame(raw);
			if (!parsed) return null;
			if (parsed.kind === "ping" || parsed.kind === "error") return parsed;
			if (parsed.marketId === null) return null;
			return {
				kind: "tickers",
				frames: [{ key: parsed.marketId, frame: parsed.frame }],
			};
		},
	});
