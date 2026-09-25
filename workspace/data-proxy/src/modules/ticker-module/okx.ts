import type { Effect, Schedule } from "effect";
import type { OkxModuleConfig } from "../../config/okx-module-config";
import { isRecord, mapDataItems, parseJsonRecord } from "../shared/json";
import type { PriceCache } from "../shared/price-cache";
import { createVenueWS } from "../shared/venue-ws";
import type { VenueParsedInbound, VenueWS } from "../shared/venue-ws";
import {
	createTickerModuleService,
	parseUppercaseSymbol,
} from "./ticker-module";

export const TICKERS_CHANNEL = "tickers";
export const PING_FRAME = "ping";
export const PONG_FRAME = "pong";

export const OkxModuleService = (config: OkxModuleConfig) =>
	createTickerModuleService({
		venue: "okx",
		routeType: "okx",
		identityField: "instId",
		config,
		parseKey: parseUppercaseSymbol,
		createWS: createOkxWS,
	});

export interface OkxPriceFrame {
	instId: string;
	[key: string]: unknown;
}

export const buildSubscribeFrame = (instIds: string[], id: string): string =>
	JSON.stringify({
		id,
		op: "subscribe",
		args: instIds.map((instId) => ({
			channel: TICKERS_CHANNEL,
			instId: instId,
		})),
	});

export const buildUnsubscribeFrame = (instIds: string[], id: string): string =>
	JSON.stringify({
		id,
		op: "unsubscribe",
		args: instIds.map((instId) => ({
			channel: TICKERS_CHANNEL,
			instId: instId,
		})),
	});

export const parseInboundFrame = (
	raw: string,
): VenueParsedInbound<string, OkxPriceFrame> | null => {
	if (raw === PONG_FRAME) return { kind: "pong" };

	const json = parseJsonRecord(raw);
	if (!json) return null;

	if (json.event === "error" || json.event === "notice") {
		return {
			kind: "error",
			code: typeof json.code === "string" ? json.code : null,
			message: typeof json.msg === "string" ? json.msg : null,
		};
	}

	const arg = json.arg;
	if (
		!isRecord(arg) ||
		arg.channel !== TICKERS_CHANNEL ||
		!Array.isArray(json.data)
	) {
		return null;
	}

	const frames = mapDataItems(json.data, (item) => {
		if (typeof item.instId !== "string") return null;
		return {
			key: item.instId.toUpperCase(),
			frame: item as OkxPriceFrame,
		};
	});
	if (frames.length === 0) return null;

	return { kind: "tickers", frames };
};

export const createOkxWS = (
	config: OkxModuleConfig,
	cache: PriceCache<string, OkxPriceFrame>,
	reconnectSchedule?: Schedule.Schedule<unknown, unknown, never>,
): Effect.Effect<VenueWS, never, never> => {
	let controlId = 0;
	const nextControlId = () => String(++controlId);

	return createVenueWS({
		venue: "okx",
		config,
		cache,
		reconnectSchedule,
		keepalive: {
			interval: config.keepaliveInterval,
			pingFrame: PING_FRAME,
		},
		buildSubscribeFrame: (keys) => buildSubscribeFrame(keys, nextControlId()),
		buildUnsubscribeFrame: (keys) =>
			buildUnsubscribeFrame(keys, nextControlId()),
		parseInboundFrame,
	});
};
