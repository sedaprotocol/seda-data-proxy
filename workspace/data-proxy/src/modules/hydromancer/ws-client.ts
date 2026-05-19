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
import type { AssetCache } from "./asset-cache";

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
	/** Adds the coin to the activeAssetCtx desired set and sends a subscribe frame if connected. Idempotent. */
	subscribeAssetCtx(coin: string): Effect.Effect<void, never, never>;
	/** Removes the coin from the activeAssetCtx desired set and sends an unsubscribe frame if connected. Idempotent. */
	unsubscribeAssetCtx(coin: string): Effect.Effect<void, never, never>;
	/** Adds the coin to the l2Book desired set and sends a subscribe frame if connected. Idempotent. */
	subscribeBook(coin: string): Effect.Effect<void, never, never>;
	/** Removes the coin from the l2Book desired set and sends an unsubscribe frame if connected. Idempotent. */
	unsubscribeBook(coin: string): Effect.Effect<void, never, never>;
	/** True while the socket is disconnected, errored, or has a pending send failure. */
	hasError(): Effect.Effect<boolean, never, never>;
}

export interface CreateHydromancerWSOptions {
	reconnectSchedule?: Schedule.Schedule<unknown, unknown, never>;
}

export const createHydromancerWS = (
	config: HydromancerModuleConfig,
	assetCache: AssetCache,
	bookCache: BookCacheWriter,
	options?: CreateHydromancerWSOptions,
): Effect.Effect<HydromancerWS, never, never> =>
	Effect.gen(function* () {
		const runtime = yield* Effect.runtime<never>();
		const desiredAssetCtx = MutableHashMap.empty<string, true>();
		const desiredBook = MutableHashMap.empty<string, true>();
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

		const subscribeAssetCtx = (coin: string) =>
			Effect.gen(function* () {
				if (Option.isSome(MutableHashMap.get(desiredAssetCtx, coin))) return;
				MutableHashMap.set(desiredAssetCtx, coin, true);
				yield* trySend(buildSubscribeFrame("activeAssetCtx", coin));
			});

		const unsubscribeAssetCtx = (coin: string) =>
			Effect.gen(function* () {
				if (Option.isNone(MutableHashMap.get(desiredAssetCtx, coin))) return;
				MutableHashMap.remove(desiredAssetCtx, coin);
				yield* trySend(buildUnsubscribeFrame("activeAssetCtx", coin));
			});

		const subscribeBook = (coin: string) =>
			Effect.gen(function* () {
				if (Option.isSome(MutableHashMap.get(desiredBook, coin))) return;
				MutableHashMap.set(desiredBook, coin, true);
				yield* trySend(
					buildSubscribeFrame("l2Book", coin, config.l2BookNSigFigs),
				);
			});

		const unsubscribeBook = (coin: string) =>
			Effect.gen(function* () {
				if (Option.isNone(MutableHashMap.get(desiredBook, coin))) return;
				MutableHashMap.remove(desiredBook, coin);
				yield* trySend(buildUnsubscribeFrame("l2Book", coin));
			});

		const hasError = () => Effect.sync(() => socketError !== undefined);

		const handleOpen = (ws: WebSocket) =>
			Effect.gen(function* () {
				yield* Effect.logInfo("Hydromancer WS open", { name: config.name });
				socketError = undefined;
				currentWS = ws;
				for (const [coin] of desiredAssetCtx) {
					yield* trySend(buildSubscribeFrame("activeAssetCtx", coin));
				}
				for (const [coin] of desiredBook) {
					yield* trySend(
						buildSubscribeFrame("l2Book", coin, config.l2BookNSigFigs),
					);
				}
			});

		const handleInboundMessage = (raw: string) =>
			Effect.gen(function* () {
				const frame = parseInboundFrame(raw);
				if (!frame) return;
				if (frame.kind === "activeAssetCtx") {
					if (Option.isNone(MutableHashMap.get(desiredAssetCtx, frame.coin))) {
						return;
					}
					const now = yield* Clock.currentTimeMillis;
					yield* assetCache.set(frame.coin, frame.ctx, now);
					return;
				}
				if (Option.isNone(MutableHashMap.get(desiredBook, frame.snapshot.coin))) {
					return;
				}
				yield* bookCache.setPrice(frame.snapshot.coin, frame.snapshot);
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

		return {
			start,
			subscribeAssetCtx,
			unsubscribeAssetCtx,
			subscribeBook,
			unsubscribeBook,
			hasError,
		} satisfies HydromancerWS;
	});
