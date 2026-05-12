import { tryParseSync } from "@seda-protocol/utils";
import {
	Clock,
	Deferred,
	Duration,
	Effect,
	type Fiber,
	MutableHashMap,
	Option,
	Runtime,
	Schedule,
} from "effect";
import * as v from "valibot";
import {
	type AssetCtx,
	AssetCtxSchema,
	type HydromancerModuleConfig,
} from "../../config/hydromancer-module-config";
import type { AssetCache } from "./asset-cache";

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

export const defaultReconnectSchedule = (config: HydromancerModuleConfig) =>
	Schedule.exponential(Duration.seconds(1)).pipe(
		Schedule.either(Schedule.spaced(config.reconnectMaxBackoff)),
		Schedule.resetAfter(config.reconnectStableThreshold),
	);

export interface HydromancerWS {
	/** Forks the WS daemon. The daemon owns reconnect with backoff and resubscribes on each open. */
	start(): Effect.Effect<Fiber.RuntimeFiber<unknown, unknown>, never, never>;
	/** Adds the coin to the desired set and sends a subscribe frame if connected. Idempotent. */
	subscribe(coin: string): Effect.Effect<void, never, never>;
	/** Removes the coin from the desired set and sends an unsubscribe frame if connected. Idempotent. */
	unsubscribe(coin: string): Effect.Effect<void, never, never>;
	/** True while the socket is disconnected, errored, or has a pending send failure. */
	hasError(): Effect.Effect<boolean, never, never>;
}

export interface CreateHydromancerWSOptions {
	reconnectSchedule?: Schedule.Schedule<unknown, unknown, never>;
}

export const createHydromancerWS = (
	config: HydromancerModuleConfig,
	cache: AssetCache,
	options?: CreateHydromancerWSOptions,
): Effect.Effect<HydromancerWS, never, never> =>
	Effect.gen(function* () {
		const runtime = yield* Effect.runtime<never>();
		const desiredCoins = MutableHashMap.empty<string, true>();
		let currentWS: WebSocket | null = null;
		let socketError: string | undefined;
		const schedule =
			options?.reconnectSchedule ?? defaultReconnectSchedule(config);

		const trySend = (frame: string) =>
			Effect.gen(function* () {
				const ws = currentWS;
				if (ws === null || ws.readyState !== WebSocket.OPEN) return;
				try {
					ws.send(frame);
				} catch (err) {
					socketError = `ws send failed: ${String(err)}`;
					yield* Effect.logWarning("Hydromancer WS send failed", {
						error: String(err),
					});
					try {
						ws.close();
					} catch {
						// best-effort; the close listener will trigger the reconnect loop.
					}
				}
			});

		const subscribe = (coin: string) =>
			Effect.gen(function* () {
				if (Option.isSome(MutableHashMap.get(desiredCoins, coin))) return;
				MutableHashMap.set(desiredCoins, coin, true);
				yield* trySend(buildSubscribeFrame(coin));
			});

		const unsubscribe = (coin: string) =>
			Effect.gen(function* () {
				if (Option.isNone(MutableHashMap.get(desiredCoins, coin))) return;
				MutableHashMap.remove(desiredCoins, coin);
				yield* trySend(buildUnsubscribeFrame(coin));
			});

		const hasError = () => Effect.sync(() => socketError !== undefined);

		const handleOpen = (ws: WebSocket) =>
			Effect.gen(function* () {
				yield* Effect.logInfo("Hydromancer WS open", { name: config.name });
				socketError = undefined;
				currentWS = ws;
				for (const [coin] of desiredCoins) {
					yield* trySend(buildSubscribeFrame(coin));
				}
			});

		const handleInboundMessage = (raw: string) =>
			Effect.gen(function* () {
				const frame = parseInboundFrame(raw);
				if (!frame) return;
				if (Option.isNone(MutableHashMap.get(desiredCoins, frame.coin))) {
					return;
				}
				const now = yield* Clock.currentTimeMillis;
				yield* cache.set(frame.coin, frame.ctx, now);
			});

		const handleDisconnect = (
			reason: "close" | "error",
			closed: Deferred.Deferred<void, "close" | "error">,
		) =>
			Effect.gen(function* () {
				yield* Effect.logWarning("Hydromancer WS disconnected", { reason });
				socketError = `ws ${reason}`;
				currentWS = null;
				yield* Deferred.fail(closed, reason);
			});

		const connectOnce = Effect.gen(function* () {
			const wsUrl = `${config.wsUrl}?token=${encodeURIComponent(
				config.hydromancerApiKey,
			)}`;
			const closed = yield* Deferred.make<void, "close" | "error">();

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
				Runtime.runSync(runtime, handleOpen(ws));
			});
			ws.addEventListener("message", (event) => {
				if (typeof event.data !== "string") return;
				Runtime.runSync(runtime, handleInboundMessage(event.data));
			});
			ws.addEventListener("close", () => {
				Runtime.runSync(runtime, handleDisconnect("close", closed));
			});
			ws.addEventListener("error", () => {
				Runtime.runSync(runtime, handleDisconnect("error", closed));
			});

			yield* Deferred.await(closed);
		}).pipe(Effect.scoped);

		const loop = connectOnce.pipe(
			Effect.tapError((error) =>
				Effect.sync(() => {
					socketError = `ws connect failed: ${String(error)}`;
				}),
			),
			Effect.retry(schedule),
		);

		const cachedStart = yield* Effect.cached(Effect.forkDaemon(loop));
		const start = () => cachedStart;

		return { start, subscribe, unsubscribe, hasError } satisfies HydromancerWS;
	});
