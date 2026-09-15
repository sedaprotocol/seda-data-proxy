import type { Effect, Schedule } from "effect";
import type { BybitModuleConfig } from "../../config/bybit-module-config";
import type { PriceCache } from "../shared/price-cache";
import { type VenueWS, createVenueWS } from "../shared/venue-ws";
import { createTickerModuleService } from "./ticker-module";

export const TICKERS_TOPIC_PREFIX = "tickers.";
export const PING_FRAME = JSON.stringify({ op: "ping" });

export const BybitModuleService = (config: BybitModuleConfig) =>
	createTickerModuleService({
		venue: "bybit",
		routeType: "bybit",
		identityField: "symbol",
		config,
		createWS: createBybitWS,
	});

/** A raw Bybit tickers payload. Always carries `symbol`; the rest of the
 * fields are relayed verbatim. */
export interface BybitPriceFrame {
	symbol: string;
	[key: string]: unknown;
}

export const buildSubscribeFrame = (symbols: string[]): string =>
	JSON.stringify({
		op: "subscribe",
		args: symbols.map((symbol) => `${TICKERS_TOPIC_PREFIX}${symbol}`),
	});

export const buildUnsubscribeFrame = (symbols: string[]): string =>
	JSON.stringify({
		op: "unsubscribe",
		args: symbols.map((symbol) => `${TICKERS_TOPIC_PREFIX}${symbol}`),
	});

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

export type ParsedInbound =
	| { kind: "pong" }
	| {
			kind: "tickers";
			frames: Array<{ symbol: string; frame: BybitPriceFrame }>;
	  }
	| { kind: "error"; code: string | null; message: string | null };

const codeFromJson = (json: Record<string, unknown>): string | null => {
	if (typeof json.ret_code === "string") return json.ret_code;
	if (typeof json.ret_code === "number") return String(json.ret_code);
	return null;
};

/** Classifies an inbound message: a tickers payload, a venue error, a
 * keepalive pong, or null for other control frames. */
export const parseInboundFrame = (raw: string): ParsedInbound | null => {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(json)) return null;

	if (json.op === "pong" || json.ret_msg === "pong") {
		return { kind: "pong" };
	}

	if (json.success === false) {
		return {
			kind: "error",
			code: codeFromJson(json),
			message: typeof json.ret_msg === "string" ? json.ret_msg : null,
		};
	}

	const topic = json.topic;
	if (typeof topic !== "string" || !topic.startsWith(TICKERS_TOPIC_PREFIX)) {
		return null;
	}

	const topicSymbol = topic.slice(TICKERS_TOPIC_PREFIX.length).toUpperCase();
	const items = Array.isArray(json.data)
		? json.data
		: isRecord(json.data)
			? [json.data]
			: [];

	const frames: Array<{ symbol: string; frame: BybitPriceFrame }> = [];
	for (const item of items) {
		if (!isRecord(item)) continue;
		const symbol =
			typeof item.symbol === "string" ? item.symbol.toUpperCase() : topicSymbol;
		if (!symbol) continue;
		frames.push({
			symbol,
			frame: { ...item, symbol } as BybitPriceFrame,
		});
	}
	if (frames.length === 0) return null;

	return { kind: "tickers", frames };
};

export const createBybitWS = (
	config: BybitModuleConfig,
	cache: PriceCache<string, BybitPriceFrame>,
	reconnectSchedule?: Schedule.Schedule<unknown, unknown, never>,
): Effect.Effect<VenueWS, never, never> =>
	createVenueWS({
		venue: "bybit",
		config,
		cache,
		reconnectSchedule,
		keepalive: {
			interval: config.keepaliveInterval,
			frame: PING_FRAME,
		},
		buildSubscribeFrame,
		buildUnsubscribeFrame,
		parseInboundFrame: (raw) => {
			const parsed = parseInboundFrame(raw);
			if (!parsed) return null;
			if (parsed.kind === "pong" || parsed.kind === "error") return parsed;
			return {
				kind: "tickers",
				frames: parsed.frames.map(({ symbol, frame }) => ({
					key: symbol,
					frame,
				})),
			};
		},
	});
