import type { Effect, Schedule } from "effect";
import type { BinanceModuleConfig } from "../../config/binance-module-config";
import { isRecord, parseJsonRecord } from "../shared/json";
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

export const BinanceModuleService = (config: BinanceModuleConfig) =>
	createTickerModuleService({
		venue: "binance",
		routeType: "binance",
		identityField: "symbol",
		config,
		parseKey: parseUppercaseSymbol,
		createWS: createBinanceWS,
		extraInitLog: { streamType: config.streamType },
	});

export interface BinancePriceFrame {
	s: string;
	[key: string]: unknown;
}

export const buildStreamName = (symbol: string, streamType: string): string =>
	`${symbol.toLowerCase()}@${streamType}`;

export const buildSubscribeFrame = (
	streamNames: string[],
	id: number,
): string => JSON.stringify({ method: "SUBSCRIBE", params: streamNames, id });

export const buildUnsubscribeFrame = (
	streamNames: string[],
	id: number,
): string => JSON.stringify({ method: "UNSUBSCRIBE", params: streamNames, id });

export const parseInboundFrame = (
	raw: string,
): VenueParsedInbound<string, BinancePriceFrame> | null => {
	const json = parseJsonRecord(raw);
	if (!json) return null;

	const err = json.error;
	if (isRecord(err)) {
		return {
			kind: "error",
			code: typeof err.code === "number" ? err.code : null,
			message: typeof err.msg === "string" ? err.msg : null,
		};
	}

	// Combined streams wrap the payload as { stream, data }; raw streams send it bare.
	let payload: unknown = json;
	if (typeof json.stream === "string" && isRecord(json.data)) {
		payload = json.data;
	}

	if (!isRecord(payload) || typeof payload.s !== "string") {
		return null;
	}

	return {
		kind: "tickers",
		frames: [
			{
				key: payload.s.toUpperCase(),
				frame: payload as BinancePriceFrame,
			},
		],
	};
};

export const createBinanceWS = (
	config: BinanceModuleConfig,
	cache: PriceCache<string, BinancePriceFrame>,
	reconnectSchedule?: Schedule.Schedule<unknown, unknown, never>,
): Effect.Effect<VenueWS, never, never> => {
	let controlId = 0;
	const nextControlId = () => ++controlId;
	const streamNamesFor = (symbols: string[]) =>
		symbols.map((symbol) => buildStreamName(symbol, config.streamType));

	return createVenueWS({
		venue: "binance",
		config,
		cache,
		reconnectSchedule,
		buildSubscribeFrame: (keys) =>
			buildSubscribeFrame(streamNamesFor(keys), nextControlId()),
		buildUnsubscribeFrame: (keys) =>
			buildUnsubscribeFrame(streamNamesFor(keys), nextControlId()),
		parseInboundFrame,
	});
};
