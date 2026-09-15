import type { Effect, Schedule } from "effect";
import type { BinanceModuleConfig } from "../../config/binance-module-config";
import type { PriceCache } from "../shared/price-cache";
import { type VenueWS, createVenueWS } from "../shared/venue-ws";

/** A raw Binance market-data payload. Always carries the symbol in `s`; the rest
 * of the fields depend on the configured stream type and are relayed verbatim. */
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

export type ParsedInbound =
	| { kind: "ticker"; symbol: string; frame: BinancePriceFrame }
	| { kind: "error"; code: number | null; message: string | null };

/** Classifies an inbound message: a market-data payload, a venue error, or null
 * for other messages. */
export const parseInboundFrame = (raw: string): ParsedInbound | null => {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(json)) return null;

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
		kind: "ticker",
		symbol: payload.s.toUpperCase(),
		frame: payload as BinancePriceFrame,
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
		parseInboundFrame: (raw) => {
			const parsed = parseInboundFrame(raw);
			if (!parsed) return null;
			if (parsed.kind === "error") return parsed;
			return {
				kind: "tickers",
				frames: [{ key: parsed.symbol, frame: parsed.frame }],
			};
		},
	});
};
