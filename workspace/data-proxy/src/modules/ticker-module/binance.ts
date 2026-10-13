import { type Effect, Match, type Schedule } from "effect";
import type {
	BinanceModuleConfig,
	BinanceStreamType,
} from "../../config/binance-module-config";
import { isRecord, parseJsonRecord } from "../shared/json";
import type { PriceCache } from "../shared/price-cache";
import {
	type ParsedTickerFrames,
	type VenueParsedInbound,
	type VenueWS,
	createVenueWS,
} from "../shared/venue-ws";
import { type DepthSync, createDepthSync } from "./binance-depth";
import {
	type CreateTickerModuleServiceParams,
	createTickerModuleService,
	parseUppercaseSymbol,
} from "./ticker-module";

export const BinanceModuleService = (config: BinanceModuleConfig) => {
	const params: CreateTickerModuleServiceParams<
		string,
		BinancePriceFrame,
		BinanceModuleConfig
	> = {
		venue: "binance",
		routeType: "binance",
		identityField: "symbol",
		config,
		parseKey: parseUppercaseSymbol,
		createWS: createBinanceWS,
		extraInitLog: { streamType: config.streamType },
	};

	if (config.streamType === "trade") {
		const keepMillis = config.tradesKeepSeconds * 1000;
		params.cacheApply = (prev, next, now) =>
			applyBinanceTradeFrame(prev, next, keepMillis, now);
		params.cachePostReadUpdate = (cacheHit, now) =>
			applyBinanceTradeFrame(
				cacheHit,
				{ s: cacheHit.s, trades: [] },
				keepMillis,
				now,
			);
	}

	return createTickerModuleService(params);
};

export interface BinancePriceFrame {
	s: string;
	[key: string]: unknown;
}

export const buildStreamName = (
	symbol: string,
	streamType: BinanceStreamType,
): string => `${symbol.toLowerCase()}@${streamType}`;

export const buildSubscribeFrame = (
	streamNames: string[],
	id: number,
): string => JSON.stringify({ method: "SUBSCRIBE", params: streamNames, id });

export const buildUnsubscribeFrame = (
	streamNames: string[],
	id: number,
): string => JSON.stringify({ method: "UNSUBSCRIBE", params: streamNames, id });

const tradeTime = (trade: unknown): number | null => {
	if (!isRecord(trade)) return null;
	const time = trade.T;
	return typeof time === "number" && Number.isFinite(time) ? time : null;
};

/** Drops trades whose `T` (ms) is outside the window */
const retainTradesWithinWindow = (
	trades: readonly unknown[],
	keepMillis: number,
	now: number,
): readonly unknown[] => {
	const cutoff = now - keepMillis;
	const kept = trades.filter((trade) => {
		const time = tradeTime(trade);
		return time !== null && time >= cutoff;
	});
	return kept.length === trades.length ? trades : kept;
};

const asTradeList = (value: unknown): readonly unknown[] | undefined =>
	Array.isArray(value) ? value : undefined;

const combineTrades = (
	previous: readonly unknown[] | undefined,
	incoming: readonly unknown[],
): readonly unknown[] => {
	if (previous === undefined) return incoming;
	if (incoming.length === 0) return previous;
	return previous.concat(incoming);
};

/** Concatenates a trade batch onto the cached window. */
const applyBinanceTradeFrame = (
	prev: BinancePriceFrame | undefined,
	next: BinancePriceFrame,
	keepMillis: number,
	now: number,
): BinancePriceFrame => {
	const trades = retainTradesWithinWindow(
		combineTrades(asTradeList(prev?.trades), asTradeList(next.trades) ?? []),
		keepMillis,
		now,
	);
	if (prev !== undefined && trades === prev.trades) return prev;
	if (prev === undefined && trades === next.trades) return next;
	const symbol = next.s.length > 0 ? next.s : prev?.s;
	return { s: symbol ?? "", trades };
};

const readErrorFrame = (
	json: Record<string, unknown>,
): {
	kind: "error";
	code: string | number | null;
	message: string | null;
} | null => {
	const err = json.error;
	if (!isRecord(err)) return null;
	return {
		kind: "error",
		code: typeof err.code === "number" ? err.code : null,
		message: typeof err.msg === "string" ? err.msg : null,
	};
};

const unwrapPayload = (
	json: Record<string, unknown>,
): Record<string, unknown> =>
	typeof json.stream === "string" && isRecord(json.data) ? json.data : json;

const readSymbolFrame = (
	payload: Record<string, unknown>,
	symbol: string,
): ParsedTickerFrames<string, BinancePriceFrame> => [
	{
		key: symbol.toUpperCase(),
		frame: payload as BinancePriceFrame,
	},
];

const readTradeFrame = (
	payload: Record<string, unknown>,
	symbol: string,
): ParsedTickerFrames<string, BinancePriceFrame> => [
	{
		key: symbol.toUpperCase(),
		frame: { s: symbol, trades: [payload] },
	},
];

const readDepthFrame = (
	payload: Record<string, unknown>,
	symbol: string,
	depth: DepthSync | undefined,
): ParsedTickerFrames<string, BinancePriceFrame> | null => {
	if (depth === undefined) return null;
	return depth.ingest(payload, symbol);
};

export const parseInboundFrame = (
	raw: string,
	streamType: BinanceStreamType,
	depth?: DepthSync,
): VenueParsedInbound<string, BinancePriceFrame> | null => {
	const json = parseJsonRecord(raw);
	if (!json) return null;

	const errorFrame = readErrorFrame(json);
	if (errorFrame) return errorFrame;

	const payload = unwrapPayload(json);
	if (typeof payload.s !== "string" || payload.s.length === 0) return null;

	const symbol = payload.s;
	const frames = Match.value(streamType).pipe(
		Match.when("bookTicker", () => readSymbolFrame(payload, symbol)),
		Match.when("trade", () => readTradeFrame(payload, symbol)),
		Match.when("depth@100ms", () => readDepthFrame(payload, symbol, depth)),
		Match.when("depth@1000ms", () => readDepthFrame(payload, symbol, depth)),
		Match.exhaustive,
	);
	if (frames === null) return null;

	return { kind: "tickers", frames };
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

	const depth =
		config.streamType.split("@")[0] === "depth"
			? createDepthSync(cache)
			: undefined;

	return createVenueWS({
		venue: "binance",
		config,
		cache,
		reconnectSchedule,
		seed: depth,
		buildSubscribeFrame: (keys) =>
			buildSubscribeFrame(streamNamesFor(keys), nextControlId()),
		buildUnsubscribeFrame: (keys) =>
			buildUnsubscribeFrame(streamNamesFor(keys), nextControlId()),
		parseInboundFrame: (raw) =>
			parseInboundFrame(raw, config.streamType, depth),
	});
};
