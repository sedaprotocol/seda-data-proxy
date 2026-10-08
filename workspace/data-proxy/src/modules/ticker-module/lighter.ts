import { type Effect, Match, type Schedule } from "effect";
import type {
	LighterModuleConfig,
	LighterStreamType,
} from "../../config/lighter-module-config";
import { isRecord, parseJsonRecord } from "../shared/json";
import type { PriceCache } from "../shared/price-cache";
import {
	type ParsedTickerFrames,
	type VenueParsedInbound,
	type VenueWS,
	createVenueWS,
} from "../shared/venue-ws";
import {
	type CreateTickerModuleServiceParams,
	createTickerModuleService,
} from "./ticker-module";

export const PING_FRAME = JSON.stringify({ type: "ping" });
export const PONG_FRAME = JSON.stringify({ type: "pong" });

export interface LighterPriceFrame {
	[key: string]: unknown;
}

const tradeTimestamp = (trade: unknown): number | null => {
	if (!isRecord(trade)) return null;
	const timestamp = trade.timestamp;
	return typeof timestamp === "number" && Number.isFinite(timestamp)
		? timestamp
		: null;
};

/** Filters out trades whose timestamp (ms) is outside the window. */
const retainLighterTradesWithinWindow = (
	trades: readonly unknown[],
	keepMillis: number,
	now: number,
): readonly unknown[] => {
	const cutoff = now - keepMillis;
	const kept = trades.filter((trade) => {
		const timestamp = tradeTimestamp(trade);
		return timestamp !== null && timestamp >= cutoff;
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

const windowTrades = (
	previous: readonly unknown[] | undefined,
	incoming: readonly unknown[],
	keepMillis: number,
	now: number,
): readonly unknown[] =>
	retainLighterTradesWithinWindow(
		combineTrades(previous, incoming),
		keepMillis,
		now,
	);

/** Concatenates a trade batch onto the cached window. */
const applyLighterTradeFrame = (
	prev: LighterPriceFrame | undefined,
	next: LighterPriceFrame,
	keepMillis: number,
	now: number,
): LighterPriceFrame => {
	const trades = windowTrades(
		asTradeList(prev?.trades),
		asTradeList(next.trades) ?? [],
		keepMillis,
		now,
	);
	const liquidationTrades = windowTrades(
		asTradeList(prev?.liquidation_trades),
		asTradeList(next.liquidation_trades) ?? [],
		keepMillis,
		now,
	);

	if (
		prev !== undefined &&
		trades === prev.trades &&
		liquidationTrades === prev.liquidation_trades
	) {
		return prev;
	}
	if (
		prev === undefined &&
		trades === next.trades &&
		liquidationTrades === next.liquidation_trades
	) {
		return next;
	}
	return { trades, liquidation_trades: liquidationTrades };
};

export const LighterModuleService = (config: LighterModuleConfig) => {
	const params: CreateTickerModuleServiceParams<
		number,
		LighterPriceFrame,
		LighterModuleConfig
	> = {
		venue: "lighter",
		routeType: "lighter",
		identityField: "marketId",
		config,
		parseKey: parseMarketId,
		createWS: createLighterWS,
		extraInitLog: { streamType: config.streamType },
	};

	if (config.streamType === "trade") {
		const keepMillis = config.tradesKeepSeconds * 1000;
		params.cacheApply = (prev, next, now) =>
			applyLighterTradeFrame(prev, next, keepMillis, now);
		params.cachePostReadUpdate = (cacheHit, now) =>
			applyLighterTradeFrame(
				cacheHit,
				{ trades: [], liquidation_trades: [] },
				keepMillis,
				now,
			);
	}
	return createTickerModuleService(params);
};

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

const readTradeFrame = (
	json: Record<string, unknown>,
	marketId: number,
): ParsedTickerFrames<number, LighterPriceFrame> | null => {
	if (!Array.isArray(json.trades)) return null;
	const frame: LighterPriceFrame = { trades: json.trades };
	if (Array.isArray(json.liquidation_trades)) {
		frame.liquidation_trades = json.liquidation_trades;
	}
	return [{ key: marketId, frame }];
};

const readTickerFrame = (
	json: Record<string, unknown>,
	marketId: number,
): ParsedTickerFrames<number, LighterPriceFrame> | null => {
	const payload = json.ticker;
	if (!isRecord(payload)) return null;
	return [{ key: marketId, frame: payload }];
};

const isNonce = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value);

const isLevel = (value: unknown): value is Record<string, unknown> =>
	isRecord(value) &&
	typeof value.price === "string" &&
	typeof value.size === "string";

const readLevels = (value: unknown): Array<Record<string, unknown>> | null => {
	if (!Array.isArray(value)) return null;
	const levels: Array<Record<string, unknown>> = [];
	for (const item of value) {
		if (!isLevel(item)) return null;
		levels.push(item);
	}
	return levels;
};

const isZeroSize = (size: unknown): boolean =>
	typeof size === "string" && Number(size) === 0;

const copyLevel = (
	level: Record<string, unknown>,
): Record<string, unknown> => ({
	...level,
});

/** Updates a side in place. Size `"0"` removes the price. New prices append. */
const mergeLevels = (
	existing: Array<Record<string, unknown>>,
	incoming: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> => {
	const levels = existing.map(copyLevel);
	for (const next of incoming) {
		const index = levels.findIndex((level) => level.price === next.price);
		if (isZeroSize(next.size)) {
			if (index !== -1) levels.splice(index, 1);
			continue;
		}
		if (index === -1) levels.push(copyLevel(next));
		else levels[index] = copyLevel(next);
	}
	return levels.filter((level) => !isZeroSize(level.size));
};

const bookFields = (
	frame: LighterPriceFrame,
	asks: Array<Record<string, unknown>>,
	bids: Array<Record<string, unknown>>,
): LighterPriceFrame => {
	const book: LighterPriceFrame = {};
	for (const [key, value] of Object.entries(frame)) {
		if (key === "asks" || key === "bids") continue;
		book[key] = value;
	}
	book.asks = asks;
	book.bids = bids;
	return book;
};

/**
 * `subscribed/order_book` replaces the book.
 * `update/order_book` merges when `begin_nonce` equals the previous `nonce`, otherwise asks for a fresh snapshot.
 */
const readOrderBookFrame = (
	json: Record<string, unknown>,
	cache: PriceCache<number, LighterPriceFrame>,
	marketId: number,
): ParsedTickerFrames<number, LighterPriceFrame> | null => {
	const kind =
		json.type === "subscribed/order_book"
			? "snapshot"
			: json.type === "update/order_book"
				? "update"
				: null;
	if (kind === null) return null;

	const payload = json.order_book;
	if (!isRecord(payload)) return null;
	const frame = { ...payload };
	const asks = readLevels(frame.asks);
	const bids = readLevels(frame.bids);
	const nonceOk = isNonce(frame.nonce);
	const prev = cache.getCached(marketId);
	if (asks === null || bids === null || !nonceOk) {
		return [
			{
				key: marketId,
				frame,
				action:
					kind === "update" && prev !== undefined ? "resubscribe" : "ignore",
			},
		];
	}

	// Snapshot: Write the frame as is.
	if (kind === "snapshot") {
		return [
			{
				key: marketId,
				action: "write",
				frame: bookFields(
					frame,
					asks.filter((level) => !isZeroSize(level.size)).map(copyLevel),
					bids.filter((level) => !isZeroSize(level.size)).map(copyLevel),
				),
			},
		];
	}

	// Update: Merge with the previous frame.
	if (prev === undefined) return [{ key: marketId, frame, action: "ignore" }];
	if (!isNonce(frame.begin_nonce) || frame.begin_nonce !== prev.nonce) {
		return [{ key: marketId, frame, action: "resubscribe" }];
	}
	const prevAsks = readLevels(prev.asks);
	const prevBids = readLevels(prev.bids);
	if (prevAsks === null || prevBids === null) {
		return [{ key: marketId, frame, action: "resubscribe" }];
	}
	return [
		{
			key: marketId,
			action: "write",
			frame: bookFields(
				frame,
				mergeLevels(prevAsks, asks),
				mergeLevels(prevBids, bids),
			),
		},
	];
};

export const parseInboundFrame = (
	raw: string,
	streamType: LighterStreamType,
	cache: PriceCache<number, LighterPriceFrame>,
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

	const frames = Match.value(streamType).pipe(
		Match.when("trade", () => readTradeFrame(json, marketId)),
		Match.when("ticker", () => readTickerFrame(json, marketId)),
		Match.when("order_book", () => readOrderBookFrame(json, cache, marketId)),
		Match.exhaustive,
	);
	if (frames === null) return null;

	return { kind: "tickers", frames };
};

export const createLighterWS = (
	config: LighterModuleConfig,
	cache: PriceCache<number, LighterPriceFrame>,
	reconnectSchedule?: Schedule.Schedule<unknown, unknown, never>,
): Effect.Effect<VenueWS<number>, never, never> => {
	return createVenueWS({
		venue: "lighter",
		config,
		cache,
		reconnectSchedule,
		keepalive: {
			interval: config.keepaliveInterval,
			pingFrame: PING_FRAME,
			pongFrame: PONG_FRAME,
		},
		buildSubscribeFrame: (keys: number[]) =>
			keys.map((marketId) => buildSubscribeFrame(marketId, config.streamType)),
		buildUnsubscribeFrame: (keys: number[]) =>
			keys.map((marketId) =>
				buildUnsubscribeFrame(marketId, config.streamType),
			),
		parseInboundFrame: (raw: string) =>
			parseInboundFrame(raw, config.streamType, cache),
	});
};
