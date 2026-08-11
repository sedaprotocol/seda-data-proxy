import {
	Clock,
	Deferred,
	Duration,
	Effect,
	type Fiber,
	Metric,
	MutableHashMap,
	Option,
	Queue,
	Runtime,
	Schedule,
	Stream,
} from "effect";
import type { LighterModuleConfig } from "../../config/lighter-module-config";

/** A Lighter `ticker` payload. Always carries the symbol in `s`; the best
 * bid/ask sit in `b`/`a` and are relayed verbatim. */
export interface LighterPriceFrame {
	s: string;
	[key: string]: unknown;
}

type OutboundMessageType = "subscribe" | "unsubscribe" | "ping" | "pong";

type OutboundMessage = {
	frame: string;
	type: OutboundMessageType;
};

/** Metrics for the Lighter WebSocket client. */
const activeSubscriptions = Metric.gauge("lighter_active_subscriptions", {
	description: "Number of active Lighter WebSocket market subscriptions",
});

const messagesSent = Metric.counter("lighter_messages_sent", {
	description:
		"Outbound Lighter WebSocket messages sent (subscribe/unsubscribe/ping/pong)",
	incremental: true,
});

const connectionAttempts = Metric.counter("lighter_connection_attempts", {
	description: "Lighter WebSocket connection attempts",
	incremental: true,
});

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
	/** Forks the WS daemon (reconnect with backoff, resubscribe on open), the
	 * paced outbound sender, and the keepalive daemon. */
	start(): Effect.Effect<Fiber.RuntimeFiber<unknown, unknown>, never, never>;
	/** Adds the market ids to the desired set and enqueues a subscribe frame for
	 * each new one. Idempotent. Frames are paced by the outbound sender. */
	subscribe(marketIds: number[]): Effect.Effect<void, never, never>;
	/** Removes the market ids from the desired set and enqueues an unsubscribe
	 * frame for each removed one. Idempotent. Frames are paced by the outbound sender. */
	unsubscribe(marketIds: number[]): Effect.Effect<void, never, never>;
	/** True while there is no open connection, so cached prices may be stale. */
	hasError(): Effect.Effect<boolean, never, never>;
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
		// Outbound queue to enfore maxMessagesPerMinute rate limit.
		const outbound = yield* Queue.unbounded<OutboundMessage>();

		const withModuleName = <Type, In, Out>(
			metric: Metric.Metric<Type, In, Out>,
		) => Metric.tagged(metric, "module", config.name);

		const setActiveSubscriptions = () =>
			Metric.set(
				withModuleName(activeSubscriptions),
				MutableHashMap.size(desiredMarkets),
			);

		const enqueue = (frame: string, type: OutboundMessageType) =>
			Queue.offer(outbound, { frame, type }).pipe(Effect.asVoid);

		const clearOutbound = () => Queue.takeAll(outbound).pipe(Effect.asVoid);

		const sendOutbound = ({ frame, type }: OutboundMessage) =>
			Effect.gen(function* () {
				const ws = currentWS;
				if (ws === null || ws.readyState !== WebSocket.OPEN) {
					// Drop; handleOpen re-enqueues current desiredMarkets on reconnect.
					return;
				}

				try {
					ws.send(frame);
					yield* Metric.increment(
						Metric.tagged(withModuleName(messagesSent), "type", type),
					);
					yield* Effect.sleep(Duration.decode(Duration.minutes(1)));
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

		const sendLoop = Stream.fromQueue(outbound).pipe(
			Stream.mapEffect(sendOutbound, {
				concurrency: config.maxMessagesPerMinute,
			}),
			Stream.runDrain,
		);

		const subscribe = (marketIds: number[]) =>
			Effect.gen(function* () {
				let added = false;
				for (const marketId of marketIds) {
					if (Option.isSome(MutableHashMap.get(desiredMarkets, marketId)))
						continue;
					MutableHashMap.set(desiredMarkets, marketId, true);
					added = true;
					yield* enqueue(buildSubscribeFrame(marketId), "subscribe");
				}
				if (added) {
					yield* setActiveSubscriptions();
				}
			});

		const unsubscribe = (marketIds: number[]) =>
			Effect.gen(function* () {
				let removed = false;
				for (const marketId of marketIds) {
					if (Option.isNone(MutableHashMap.get(desiredMarkets, marketId)))
						continue;
					MutableHashMap.remove(desiredMarkets, marketId);
					removed = true;
					yield* enqueue(buildUnsubscribeFrame(marketId), "unsubscribe");
				}
				if (removed) {
					yield* setActiveSubscriptions();
				}
			});

		const handleOpen = (ws: WebSocket) =>
			Effect.gen(function* () {
				yield* Effect.logInfo("Lighter WS open", { name: config.name });
				currentWS = ws;
				for (const [marketId] of desiredMarkets) {
					yield* enqueue(buildSubscribeFrame(marketId), "subscribe");
				}
			});

		const handleInboundMessage = (raw: string) =>
			Effect.gen(function* () {
				const parsed = parseInboundFrame(raw);
				if (!parsed) return;
				if (parsed.kind === "ping") {
					yield* enqueue(PONG_FRAME, "pong");
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

		const handleDisconnect = (closed: Deferred.Deferred<void, void>) =>
			Effect.gen(function* () {
				currentWS = null;
				// Drop queued frames so a reconnect isn't preceded by a stale backlog.
				yield* clearOutbound();
				yield* Deferred.fail(closed, undefined);
			});

		const connectOnce = Effect.gen(function* () {
			const deferred = yield* Deferred.make<void, void>();

			yield* Effect.logInfo("Lighter WS connecting", { name: config.name });
			yield* Metric.increment(withModuleName(connectionAttempts));

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
			ws.addEventListener("error", () => {
				Runtime.runSync(
					runtime,
					Effect.logWarning("Lighter WS error event", { name: config.name }),
				);
			});
			ws.addEventListener("close", (event) => {
				Runtime.runSync(
					runtime,
					Effect.gen(function* () {
						yield* Effect.logWarning("Lighter WS disconnected", {
							code: event.code,
							closeReason: event.reason,
							wasClean: event.wasClean,
						});
						yield* handleDisconnect(deferred);
					}),
				);
			});

			yield* Deferred.await(deferred);
		}).pipe(Effect.scoped);

		const loop = connectOnce.pipe(
			Effect.tapError(() => Effect.logWarning("Lighter WS connect failed")),
			Effect.retry(schedule),
		);

		const keepaliveLoop = enqueue(PING_FRAME, "ping").pipe(
			Effect.schedule(Schedule.spaced(config.keepaliveInterval)),
		);

		const cachedStart = yield* Effect.cached(
			Effect.gen(function* () {
				yield* Effect.forkDaemon(sendLoop);
				yield* Effect.forkDaemon(keepaliveLoop);
				return yield* Effect.forkDaemon(loop);
			}),
		);
		const start = () => cachedStart;

		// The socket is healthy only while a connection is open; currentWS is
		// nulled on every disconnect and reset on open.
		const hasError = () => Effect.sync(() => currentWS === null);

		return { start, subscribe, unsubscribe, hasError } satisfies LighterWS;
	});
