import type { Effect, Schedule } from "effect";
import type { OkxModuleConfig } from "../../config/okx-module-config";
import type { PriceCache } from "../shared/price-cache";
import { createVenueWS } from "../shared/venue-ws";
import type { VenueWS } from "../shared/venue-ws";
import { createTickerModuleService } from "./ticker-module";

export const TICKERS_CHANNEL = "tickers";
export const PING_FRAME = "ping";
export const PONG_FRAME = "pong";

export const OkxModuleService = (config: OkxModuleConfig) =>
	createTickerModuleService({
		venue: "okx",
		routeType: "okx",
		identityField: "instId",
		config,
		createWS: createOkxWS,
	});

/** A raw OKX tickers-channel payload. Always carries `instId`; the rest of the
 * fields are relayed verbatim. */
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

export type ParsedInbound =
	| { kind: "pong" }
	| { kind: "tickers"; frames: Array<{ instId: string; frame: OkxPriceFrame }> }
	| { kind: "error"; code: string | null; message: string | null };

export const parseInboundFrame = (raw: string): ParsedInbound | null => {
	if (raw === PONG_FRAME) return { kind: "pong" };

	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(json)) return null;

	if (json.event === "error" || json.event === "notice") {
		return {
			kind: "error",
			code: typeof json.code === "string" ? json.code : null,
			message: typeof json.msg === "string" ? json.msg : null,
		};
	}

	const arg = json.arg;
	const data = json.data;
	if (
		!isRecord(arg) ||
		arg.channel !== TICKERS_CHANNEL ||
		!Array.isArray(data)
	) {
		return null;
	}

	const frames: Array<{ instId: string; frame: OkxPriceFrame }> = [];
	for (const item of data) {
		if (!isRecord(item) || typeof item.instId !== "string") continue;
		frames.push({
			instId: item.instId.toUpperCase(),
			frame: item as OkxPriceFrame,
		});
	}
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
			frame: PING_FRAME,
		},
		buildSubscribeFrame: (keys) => buildSubscribeFrame(keys, nextControlId()),
		buildUnsubscribeFrame: (keys) =>
			buildUnsubscribeFrame(keys, nextControlId()),
		parseInboundFrame: (raw) => {
			const parsed = parseInboundFrame(raw);
			if (!parsed) return null;
			if (parsed.kind === "pong" || parsed.kind === "error") return parsed;
			return {
				kind: "tickers",
				frames: parsed.frames.map(({ instId, frame }) => ({
					key: instId,
					frame,
				})),
			};
		},
	});
};
