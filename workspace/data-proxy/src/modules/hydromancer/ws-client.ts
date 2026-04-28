import { tryParseSync } from "@seda-protocol/utils";
import { Clock, Deferred, Duration, Effect, Runtime, Schedule } from "effect";
import * as v from "valibot";
import {
	type AssetCtx,
	AssetCtxSchema,
	type HydromancerModuleConfig,
} from "../../config/hydromancer-module-config";
import type { createAssetCache } from "./asset-cache";

type AssetCache = Effect.Effect.Success<ReturnType<typeof createAssetCache>>;

const InboundFrameSchema = v.object({
	channel: v.string(),
	data: v.optional(
		v.object({
			coin: v.string(),
			ctx: AssetCtxSchema,
		}),
	),
});

export interface InboundActiveAssetCtx {
	coin: string;
	ctx: AssetCtx;
}

export const buildSubscribeFrame = (coin: string): string =>
	JSON.stringify({
		method: "subscribe",
		subscription: { type: "activeAssetCtx", coin },
	});

export const buildUnsubscribeFrame = (coin: string): string =>
	JSON.stringify({
		method: "unsubscribe",
		subscription: { type: "activeAssetCtx", coin },
	});

export const parseInboundFrame = (
	raw: string,
): InboundActiveAssetCtx | null => {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return null;
	}
	const parsed = tryParseSync(InboundFrameSchema, json);
	if (parsed.isErr) return null;
	if (parsed.value.channel !== "activeAssetCtx" || !parsed.value.data) {
		return null;
	}
	return parsed.value.data;
};

const defaultReconnectSchedule = (config: HydromancerModuleConfig) =>
	Schedule.exponential(Duration.seconds(1)).pipe(
		Schedule.either(Schedule.spaced(config.reconnectMaxBackoff)),
	);

export const startWebSocketDaemon = (
	config: HydromancerModuleConfig,
	cache: AssetCache,
	options?: {
		reconnectSchedule?: Schedule.Schedule<unknown, unknown, never>;
	},
) =>
	Effect.gen(function* () {
		const runtime = yield* Effect.runtime<never>();
		const schedule =
			options?.reconnectSchedule ?? defaultReconnectSchedule(config);

		const connectOnce = Effect.gen(function* () {
			const wsUrl = `${config.wsUrl}?token=${encodeURIComponent(
				config.hydromancerApiKey,
			)}`;
			const closed = yield* Deferred.make<void>();

			yield* Effect.logInfo("Hydromancer WS connecting", {
				name: config.name,
			});

			const ws = yield* Effect.acquireRelease(
				Effect.sync(() => new WebSocket(wsUrl)),
				(socket) =>
					Effect.sync(() => {
						if (socket.readyState !== WebSocket.CLOSED) {
							socket.close();
						}
					}),
			);

			ws.addEventListener("open", () => {
				Runtime.runSync(runtime, handleOpen(ws, config, cache));
			});
			ws.addEventListener("message", (event) => {
				const data =
					typeof event.data === "string"
						? event.data
						: String((event.data as { toString: () => string }).toString());
				Runtime.runSync(runtime, handleInboundMessage(data, cache));
			});
			ws.addEventListener("close", () => {
				Runtime.runSync(runtime, handleDisconnect("close", cache, closed));
			});
			ws.addEventListener("error", () => {
				Runtime.runSync(runtime, handleDisconnect("error", cache, closed));
			});

			yield* Deferred.await(closed);
		}).pipe(Effect.scoped);

		const loop = connectOnce.pipe(
			Effect.tapError((error) =>
				cache.markSocketError(`ws connect failed: ${String(error)}`),
			),
			Effect.retry(schedule),
		);

		return yield* Effect.forkDaemon(loop);
	});

const handleOpen = (
	ws: WebSocket,
	config: HydromancerModuleConfig,
	cache: AssetCache,
) =>
	Effect.gen(function* () {
		yield* Effect.logInfo("Hydromancer WS open", { name: config.name });
		yield* cache.clearSocketError();
		for (const coin of config.subscriptionCoins) {
			ws.send(buildSubscribeFrame(coin));
		}
	});

const handleInboundMessage = (raw: string, cache: AssetCache) =>
	Effect.gen(function* () {
		const frame = parseInboundFrame(raw);
		if (!frame) return;
		const now = yield* Clock.currentTimeMillis;
		yield* cache.set(frame.coin, frame.ctx, now);
	});

const handleDisconnect = (
	reason: "close" | "error",
	cache: AssetCache,
	closed: Deferred.Deferred<void>,
) =>
	Effect.gen(function* () {
		yield* Effect.logWarning("Hydromancer WS disconnected", { reason });
		yield* cache.markSocketError(reason);
		yield* Deferred.succeed(closed, undefined);
	});
