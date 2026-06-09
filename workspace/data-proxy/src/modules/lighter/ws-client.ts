import {
	Deferred,
	Duration,
	Effect,
	type Fiber,
	MutableHashMap,
	Option,
	Runtime,
	Schedule,
} from "effect";
import type { LighterModuleConfig } from "../../config/lighter-module-config";

/** A Lighter `ticker` payload. Always carries the symbol in `s`; the best
 * bid/ask sit in `b`/`a` and are relayed verbatim. */
export interface LighterPriceFrame {
	s: string;
	[key: string]: unknown;
}

/** The subset of the shared price cache the WS daemon writes to, keyed by market id. */
interface PriceSink {
	setPrice: (key: number, price: LighterPriceFrame) => Effect.Effect<void>;
}

const PING_FRAME = JSON.stringify({ type: "ping" });
const PONG_FRAME = JSON.stringify({ type: "pong" });

export const buildSubscribeFrame = (marketId: number): string =>
	JSON.stringify({ type: "subscribe", channel: `ticker/${marketId}` });

export const buildUnsubscribeFrame = (marketId: number): string =>
	JSON.stringify({ type: "unsubscribe", channel: `ticker/${marketId}` });

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

/** The inbound `channel` is `ticker:{id}` (colon) even though subscribe sends
 * `ticker/{id}` (slash); accept either separator. */
const parseMarketId = (channel: unknown): number | null => {
	if (typeof channel !== "string") return null;
	const last = channel.split(/[:/]/).pop();
	if (last === undefined) return null;
	const id = Number(last);
	return Number.isInteger(id) ? id : null;
};

export type ParsedInbound =
	| { kind: "ping" }
	| { kind: "ticker"; marketId: number | null; frame: LighterPriceFrame };

/** Classifies an inbound message: a keepalive ping, a ticker payload (snapshot
 * `subscribed/ticker` or `update/ticker`, both carry `.ticker`), or null for
 * control frames like `{type:connected}`, error frames, and malformed input. */
export const parseInboundFrame = (raw: string): ParsedInbound | null => {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(json)) return null;
	if (json.type === "ping") return { kind: "ping" };

	const ticker = json.ticker;
	if (isRecord(ticker) && typeof ticker.s === "string") {
		return {
			kind: "ticker",
			marketId: parseMarketId(json.channel),
			frame: ticker as LighterPriceFrame,
		};
	}
	return null;
};

export const defaultReconnectSchedule = (config: LighterModuleConfig) =>
	Schedule.exponential(Duration.seconds(1)).pipe(
		Schedule.either(Schedule.spaced(config.reconnectMaxBackoff)),
		Schedule.resetAfter(config.reconnectStableThreshold),
	);

export interface LighterWS {
	/** Forks the WS daemon (reconnect with backoff, resubscribe on open) and the keepalive daemon. */
	start(): Effect.Effect<Fiber.RuntimeFiber<unknown, unknown>, never, never>;
	/** Adds the market ids to the desired set and sends a subscribe frame for each new one if connected. Idempotent. */
	subscribe(marketIds: number[]): Effect.Effect<void, never, never>;
	/** Removes the market ids from the desired set and sends an unsubscribe frame for each removed one if connected. Idempotent. */
	unsubscribe(marketIds: number[]): Effect.Effect<void, never, never>;
}

export interface CreateLighterWSOptions {
	reconnectSchedule?: Schedule.Schedule<unknown, unknown, never>;
}

export const createLighterWS = (
	config: LighterModuleConfig,
	cache: PriceSink,
	options?: CreateLighterWSOptions,
): Effect.Effect<LighterWS, never, never> =>
	Effect.gen(function* () {
		const runtime = yield* Effect.runtime<never>();
		const desiredMarkets = MutableHashMap.empty<number, true>();
		let currentWS: WebSocket | null = null;
		const schedule =
			options?.reconnectSchedule ?? defaultReconnectSchedule(config);

		const trySend = (frame: string) =>
			Effect.gen(function* () {
				const ws = currentWS;
				if (ws === null || ws.readyState !== WebSocket.OPEN) return;
				try {
					ws.send(frame);
				} catch (err) {
					yield* Effect.logWarning("Lighter WS send failed", {
						error: String(err),
					});
					try {
						ws.close();
					} catch {
						// best-effort; the close listener will trigger the reconnect loop.
					}
				}
			});

		const subscribe = (marketIds: number[]) =>
			Effect.gen(function* () {
				for (const marketId of marketIds) {
					if (Option.isSome(MutableHashMap.get(desiredMarkets, marketId)))
						continue;
					MutableHashMap.set(desiredMarkets, marketId, true);
					yield* trySend(buildSubscribeFrame(marketId));
				}
			});

		const unsubscribe = (marketIds: number[]) =>
			Effect.gen(function* () {
				for (const marketId of marketIds) {
					if (Option.isNone(MutableHashMap.get(desiredMarkets, marketId)))
						continue;
					MutableHashMap.remove(desiredMarkets, marketId);
					yield* trySend(buildUnsubscribeFrame(marketId));
				}
			});

		const handleOpen = (ws: WebSocket) =>
			Effect.gen(function* () {
				yield* Effect.logInfo("Lighter WS open", { name: config.name });
				currentWS = ws;
				for (const [marketId] of desiredMarkets) {
					yield* trySend(buildSubscribeFrame(marketId));
				}
			});

		const handleInboundMessage = (raw: string) =>
			Effect.gen(function* () {
				const parsed = parseInboundFrame(raw);
				if (!parsed) return;
				if (parsed.kind === "ping") {
					yield* trySend(PONG_FRAME);
					return;
				}
				// Drop frames with no parseable id, or for a market we have since
				// unsubscribed (post-unsubscribe race).
				if (
					parsed.marketId === null ||
					Option.isNone(MutableHashMap.get(desiredMarkets, parsed.marketId))
				) {
					return;
				}
				yield* cache.setPrice(parsed.marketId, parsed.frame);
			});

		const handleDisconnect = (
			reason: "close" | "error",
			closed: Deferred.Deferred<void, "close" | "error">,
		) =>
			Effect.gen(function* () {
				yield* Effect.logWarning("Lighter WS disconnected", { reason });
				currentWS = null;
				yield* Deferred.fail(closed, reason);
			});

		const connectOnce = Effect.gen(function* () {
			const closed = yield* Deferred.make<void, "close" | "error">();

			yield* Effect.logInfo("Lighter WS connecting", { name: config.name });

			const ws = yield* Effect.acquireRelease(
				Effect.sync(() => new WebSocket(config.wsUrl)),
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
				Effect.logWarning("Lighter WS connect failed", {
					error: String(error),
				}),
			),
			Effect.retry(schedule),
		);

		// Lighter closes a connection with no client frames for 2 minutes; ping on a
		// shorter cadence. trySend no-ops while disconnected, so this is harmless then.
		const keepaliveLoop = trySend(PING_FRAME).pipe(
			Effect.schedule(Schedule.spaced(config.keepaliveInterval)),
		);

		const cachedStart = yield* Effect.cached(
			Effect.gen(function* () {
				yield* Effect.forkDaemon(keepaliveLoop);
				return yield* Effect.forkDaemon(loop);
			}),
		);
		const start = () => cachedStart;

		return { start, subscribe, unsubscribe } satisfies LighterWS;
	});
