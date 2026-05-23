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
	type BookSnapshot,
	BookSnapshotSchema,
	type HydromancerModuleConfig,
} from "../../config/hydromancer-module-config";
import type { FreshnessCache } from "../shared/freshness-cache";

export type HydromancerChannel = "activeAssetCtx" | "l2Book";

export interface BookCacheWriter {
	setPrice: (coin: string, snapshot: BookSnapshot) => Effect.Effect<void>;
}

const InboundAssetCtxFrameSchema = v.object({
	channel: v.literal("activeAssetCtx"),
	data: v.object({
		coin: v.string(),
		ctx: AssetCtxSchema,
	}),
});

const InboundBookFrameSchema = v.object({
	channel: v.literal("l2Book"),
	data: BookSnapshotSchema,
});

const InboundFrameSchema = v.variant("channel", [
	InboundAssetCtxFrameSchema,
	InboundBookFrameSchema,
]);

export type ParsedInboundFrame =
	| { kind: "activeAssetCtx"; coin: string; ctx: AssetCtx }
	| { kind: "l2Book"; snapshot: BookSnapshot };

export const buildSubscribeFrame = (
	channel: HydromancerChannel,
	coin: string,
	nSigFigs?: number,
): string =>
	JSON.stringify({
		method: "subscribe",
		subscription:
			nSigFigs === undefined
				? { type: channel, coin }
				: { type: channel, coin, nSigFigs },
	});

export const buildUnsubscribeFrame = (
	channel: HydromancerChannel,
	coin: string,
): string =>
	JSON.stringify({
		method: "unsubscribe",
		subscription: { type: channel, coin },
	});

export const parseInboundFrame = (raw: string): ParsedInboundFrame | null => {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return null;
	}
	const parsed = tryParseSync(InboundFrameSchema, json);
	if (parsed.isErr) return null;
	if (parsed.value.channel === "activeAssetCtx") {
		return {
			kind: "activeAssetCtx",
			coin: parsed.value.data.coin,
			ctx: parsed.value.data.ctx,
		};
	}
	return { kind: "l2Book", snapshot: parsed.value.data };
};

export const defaultReconnectSchedule = (config: HydromancerModuleConfig) =>
	Schedule.exponential(Duration.seconds(1)).pipe(
		Schedule.either(Schedule.spaced(config.reconnectMaxBackoff)),
		Schedule.resetAfter(config.reconnectStableThreshold),
	);

export interface HydromancerWS {
	/** Forks the WS daemon. The daemon owns reconnect with backoff and resubscribes on each open. */
	start(): Effect.Effect<Fiber.RuntimeFiber<unknown, unknown>, never, never>;
	/** Adds the coin to the channel's desired set and sends a subscribe frame if connected. Idempotent. */
	subscribe(
		channel: HydromancerChannel,
		coin: string,
	): Effect.Effect<void, never, never>;
	/** Removes the coin from the channel's desired set and sends an unsubscribe frame if connected. Idempotent. */
	unsubscribe(
		channel: HydromancerChannel,
		coin: string,
	): Effect.Effect<void, never, never>;
	/** True while the socket is disconnected, errored, or has a pending send failure. */
	hasError(): Effect.Effect<boolean, never, never>;
}

export interface CreateHydromancerWSOptions {
	reconnectSchedule?: Schedule.Schedule<unknown, unknown, never>;
}

/** Per-channel subscription state. One WS connection multiplexes every channel. */
interface ChannelState {
	desired: MutableHashMap.MutableHashMap<string, true>;
	subscribeFrame: (coin: string) => string;
}

export const createHydromancerWS = (
	config: HydromancerModuleConfig,
	assetCache: FreshnessCache<string, AssetCtx>,
	bookCache: BookCacheWriter,
	options?: CreateHydromancerWSOptions,
): Effect.Effect<HydromancerWS, never, never> =>
	Effect.gen(function* () {
		const runtime = yield* Effect.runtime<never>();
		const channels: Record<HydromancerChannel, ChannelState> = {
			activeAssetCtx: {
				desired: MutableHashMap.empty<string, true>(),
				subscribeFrame: (coin) => buildSubscribeFrame("activeAssetCtx", coin),
			},
			l2Book: {
				desired: MutableHashMap.empty<string, true>(),
				subscribeFrame: (coin) =>
					buildSubscribeFrame("l2Book", coin, config.l2BookNSigFigs),
			},
		};
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

		const subscribe = (channel: HydromancerChannel, coin: string) =>
			Effect.gen(function* () {
				const { desired, subscribeFrame } = channels[channel];
				if (Option.isSome(MutableHashMap.get(desired, coin))) return;
				MutableHashMap.set(desired, coin, true);
				yield* trySend(subscribeFrame(coin));
			});

		const unsubscribe = (channel: HydromancerChannel, coin: string) =>
			Effect.gen(function* () {
				const { desired } = channels[channel];
				if (Option.isNone(MutableHashMap.get(desired, coin))) return;
				MutableHashMap.remove(desired, coin);
				yield* trySend(buildUnsubscribeFrame(channel, coin));
			});

		const hasError = () => Effect.sync(() => socketError !== undefined);

		const handleOpen = (ws: WebSocket) =>
			Effect.gen(function* () {
				yield* Effect.logInfo("Hydromancer WS open", { name: config.name });
				socketError = undefined;
				currentWS = ws;
				for (const channel of Object.values(channels)) {
					for (const [coin] of channel.desired) {
						yield* trySend(channel.subscribeFrame(coin));
					}
				}
			});

		const handleInboundMessage = (raw: string) =>
			Effect.gen(function* () {
				const frame = parseInboundFrame(raw);
				if (!frame) return;
				if (frame.kind === "activeAssetCtx") {
					if (
						Option.isNone(
							MutableHashMap.get(channels.activeAssetCtx.desired, frame.coin),
						)
					) {
						return;
					}
					const now = yield* Clock.currentTimeMillis;
					assetCache.set(frame.coin, frame.ctx, now);
					return;
				}
				if (
					Option.isNone(
						MutableHashMap.get(channels.l2Book.desired, frame.snapshot.coin),
					)
				) {
					return;
				}
				yield* bookCache.setPrice(frame.snapshot.coin, frame.snapshot);
			});

		const handleDisconnect = (
			reason: "close" | "error",
			closed: Deferred.Deferred<void, "close" | "error">,
		) =>
			Effect.gen(function* () {
				if (yield* Deferred.isDone(closed)) return;
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

			// Acquire pairs the socket with its four listeners so the release can
			// detach them; otherwise each reconnect strands four closures on the
			// dead socket until GC reaches it.
			yield* Effect.acquireRelease(
				Effect.sync(() => {
					const socket = new WebSocket(wsUrl);
					const onOpen = () => Runtime.runSync(runtime, handleOpen(socket));
					const onMessage = (event: MessageEvent) => {
						if (typeof event.data !== "string") return;
						Runtime.runSync(runtime, handleInboundMessage(event.data));
					};
					const onClose = () =>
						Runtime.runSync(runtime, handleDisconnect("close", closed));
					const onError = () =>
						Runtime.runSync(runtime, handleDisconnect("error", closed));
					socket.addEventListener("open", onOpen);
					socket.addEventListener("message", onMessage);
					socket.addEventListener("close", onClose);
					socket.addEventListener("error", onError);
					return { socket, onOpen, onMessage, onClose, onError };
				}),
				({ socket, onOpen, onMessage, onClose, onError }) =>
					Effect.sync(() => {
						socket.removeEventListener("open", onOpen);
						socket.removeEventListener("message", onMessage);
						socket.removeEventListener("close", onClose);
						socket.removeEventListener("error", onError);
						if (socket.readyState !== WebSocket.CLOSED) {
							socket.close();
						}
					}),
			);

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

		return {
			start,
			subscribe,
			unsubscribe,
			hasError,
		} satisfies HydromancerWS;
	});
