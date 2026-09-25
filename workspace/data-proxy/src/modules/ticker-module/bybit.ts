import type { Effect, Schedule } from "effect";
import type { BybitModuleConfig } from "../../config/bybit-module-config";
import { mapDataItems, parseJsonRecord } from "../shared/json";
import type { PriceCache } from "../shared/price-cache";
import {
	type VenueParsedInbound,
	type VenueWS,
	createVenueWS,
} from "../shared/venue-ws";
import {
	createTickerModuleService,
	parseUppercaseSymbol,
} from "./ticker-module";

export const TICKERS_TOPIC_PREFIX = "tickers.";
export const PING_FRAME = JSON.stringify({ op: "ping" });

export const frameType = Symbol("bybit.frameType");

/** A snapshot replaces the cached ticker. A delta copies changed fields onto it. */
const applyBybitFrame = (
	prev: BybitPriceFrame | undefined,
	next: BybitPriceFrame,
): BybitPriceFrame => {
	const isDelta = (next as { [frameType]?: string })[frameType] === "delta";
	if (isDelta && prev !== undefined) {
		return { ...prev, ...next };
	}
	return { ...next };
};

export const BybitModuleService = (config: BybitModuleConfig) =>
	createTickerModuleService({
		venue: "bybit",
		routeType: "bybit",
		identityField: "symbol",
		config,
		parseKey: parseUppercaseSymbol,
		createWS: createBybitWS,
		cacheApply: applyBybitFrame,
	});

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

const codeFromJson = (json: Record<string, unknown>): string | null => {
	if (typeof json.ret_code === "string") return json.ret_code;
	if (typeof json.ret_code === "number") return String(json.ret_code);
	return null;
};

export const parseInboundFrame = (
	raw: string,
): VenueParsedInbound<string, BybitPriceFrame> | null => {
	const json = parseJsonRecord(raw);
	if (!json) return null;

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
	const frames = mapDataItems(json.data, (item) => {
		const symbol =
			typeof item.symbol === "string" ? item.symbol.toUpperCase() : topicSymbol;
		if (!symbol) return null;

		const frame = { ...item, symbol } as BybitPriceFrame;
		Object.defineProperty(frame, frameType, {
			value: json.type === "delta" ? "delta" : "snapshot",
			// Non-enumerable so object spread leaves frameType out of the cached ticker.
			enumerable: false,
		});
		return { key: symbol, frame };
	});
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
			pingFrame: PING_FRAME,
		},
		buildSubscribeFrame,
		buildUnsubscribeFrame,
		parseInboundFrame,
	});
