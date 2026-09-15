import {
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
import { forkInboundControl } from "./inbound-control";
import type { PriceCache } from "./price-cache";
import { recordTickHandle } from "./tick-metrics";

type OutboundMessageType = "subscribe" | "unsubscribe";

type OutboundMessage = {
	frame: string;
	type: OutboundMessageType;
};

export interface ReconnectBackoffConfig {
	reconnectMaxBackoff: Duration.Duration;
	reconnectStableThreshold: Duration.Duration;
}

export const defaultReconnectSchedule = (config: ReconnectBackoffConfig) =>
	Schedule.exponential(Duration.seconds(1)).pipe(
		Schedule.either(Schedule.spaced(config.reconnectMaxBackoff)),
		Schedule.resetAfter(config.reconnectStableThreshold),
	);

export interface VenueWS {
	/** Forks the WS daemon. The daemon owns reconnect with backoff and resubscribes on each open. */
	start(): Effect.Effect<Fiber.RuntimeFiber<unknown, unknown>, never, never>;
	/** Adds the keys to the desired set and enqueues one subscribe frame for the new ones. Idempotent. */
	subscribe(keys: string[]): Effect.Effect<void, never, never>;
	/** Removes the keys from the desired set and enqueues one unsubscribe frame for the removed ones. Idempotent. */
	unsubscribe(keys: string[]): Effect.Effect<void, never, never>;
	/** True while the socket is disconnected, errored, or has a pending send failure. */
	hasError(): Effect.Effect<boolean, never, never>;
}

export type VenueParsedInbound<TFrame> =
	| { kind: "pong" }
	| { kind: "error"; code: string | number | null; message: string | null }
	| { kind: "tickers"; frames: Array<{ key: string; frame: TFrame }> };

export interface VenueWSConfig extends ReconnectBackoffConfig {
	name: string;
	wsUrl: string;
	maxMessagesPerSecond: number;
}

export interface CreateVenueWSParams<TFrame> {
	venue: string;
	config: VenueWSConfig;
	cache: PriceCache<string, TFrame>;
	reconnectSchedule?: Schedule.Schedule<unknown, unknown, never>;
	keepalive?: {
		interval: VenueWSConfig["reconnectMaxBackoff"];
		frame: string;
	};
	buildSubscribeFrame: (keys: string[]) => string;
	buildUnsubscribeFrame: (keys: string[]) => string;
	parseInboundFrame: (raw: string) => VenueParsedInbound<TFrame> | null;
}

export const createVenueWS = <TFrame>(
	params: CreateVenueWSParams<TFrame>,
): Effect.Effect<VenueWS, never, never> =>
	Effect.gen(function* () {
		const {
			venue,
			config,
			cache,
			keepalive,
			buildSubscribeFrame,
			buildUnsubscribeFrame,
			parseInboundFrame,
		} = params;
		const { name, wsUrl, maxMessagesPerSecond } = config;
		const reconnectSchedule =
			params.reconnectSchedule ?? defaultReconnectSchedule(config);

		const inboundControl = yield* forkInboundControl(
			(event: Extract<VenueParsedInbound<TFrame>, { kind: "error" }>) =>
				Effect.logWarning(`${venue} WS error frame`, {
					code: event.code,
					message: event.message,
				}),
		);

		const runtime = yield* Effect.runtime<never>();
		const desiredKeys = MutableHashMap.empty<string, true>();
		let currentWS: WebSocket | null = null;
		let unhealthy = false;
		const outbound = yield* Queue.unbounded<OutboundMessage>();
		const activeSubscriptions = Metric.gauge(`${venue}_active_subscriptions`, {
			description: `Number of active ${venue} WebSocket stream subscriptions`,
		});
		const messagesSent = Metric.counter(`${venue}_messages_sent`, {
			description: `Outbound ${venue} WebSocket control messages sent`,
			incremental: true,
		});
		const connectionAttempts = Metric.counter(`${venue}_connection_attempts`, {
			description: `${venue} WebSocket connection attempts`,
			incremental: true,
		});

		const withModuleName = <Type, In, Out>(
			metric: Metric.Metric<Type, In, Out>,
		) => Metric.tagged(metric, "module", name);

		const setActiveSubscriptions = () =>
			Metric.set(
				withModuleName(activeSubscriptions),
				MutableHashMap.size(desiredKeys),
			);

		const incrementMessagesSent = (type: string) =>
			Metric.increment(
				Metric.tagged(withModuleName(messagesSent), "type", type),
			);

		const incrementConnectionAttempts = () =>
			Metric.increment(withModuleName(connectionAttempts));

		const isDesired = (key: string): boolean =>
			Option.isSome(MutableHashMap.get(desiredKeys, key.toUpperCase()));

		const enqueue = (frame: string, type: OutboundMessageType) =>
			Queue.offer(outbound, { frame, type }).pipe(Effect.asVoid);

		const clearOutbound = () => Queue.takeAll(outbound).pipe(Effect.asVoid);

		const closeOnSendFailure = (ws: WebSocket, err: unknown, action: string) =>
			Effect.gen(function* () {
				unhealthy = true;
				yield* Effect.logWarning(`${venue} WS ${action} failed`, {
					error: String(err),
				});
				try {
					ws.close();
				} catch {
					// best-effort; the close listener will trigger the reconnect loop.
				}
			});

		const sendOutbound = ({ frame, type }: OutboundMessage) =>
			Effect.gen(function* () {
				const ws = currentWS;
				if (ws === null || ws.readyState !== WebSocket.OPEN) {
					// Drop; handleOpen re-enqueues current desiredKeys on reconnect.
					return;
				}
				try {
					ws.send(frame);
					yield* incrementMessagesSent(type);
					// Hold the concurrency slot for the rate-limit window so at most
					// maxMessagesPerSecond frames leave per second.
					yield* Effect.sleep(Duration.seconds(1));
				} catch (err) {
					yield* closeOnSendFailure(ws, err, "send");
				}
			});

		const sendLoop = Stream.fromQueue(outbound).pipe(
			Stream.mapEffect(sendOutbound, {
				concurrency: maxMessagesPerSecond,
			}),
			Stream.runDrain,
		);

		const subscribe = (keys: string[]) =>
			Effect.gen(function* () {
				const fresh: string[] = [];
				for (const raw of keys) {
					const key = raw.toUpperCase();
					if (Option.isSome(MutableHashMap.get(desiredKeys, key))) continue;
					MutableHashMap.set(desiredKeys, key, true);
					fresh.push(key);
				}
				if (fresh.length === 0) return;
				yield* setActiveSubscriptions();
				yield* enqueue(buildSubscribeFrame(fresh), "subscribe");
			});

		const unsubscribe = (keys: string[]) =>
			Effect.gen(function* () {
				const removed: string[] = [];
				for (const raw of keys) {
					const key = raw.toUpperCase();
					if (Option.isNone(MutableHashMap.get(desiredKeys, key))) continue;
					MutableHashMap.remove(desiredKeys, key);
					removed.push(key);
				}
				if (removed.length === 0) return;
				yield* setActiveSubscriptions();
				yield* enqueue(buildUnsubscribeFrame(removed), "unsubscribe");
			});

		const hasError = () => Effect.sync(() => unhealthy);

		const handleOpen = (ws: WebSocket) =>
			Effect.gen(function* () {
				yield* Effect.logInfo(`${venue} WS open`, { name });
				unhealthy = false;
				currentWS = ws;
				const keys: string[] = [];
				for (const [key] of desiredKeys) keys.push(key);
				if (keys.length > 0) {
					yield* enqueue(buildSubscribeFrame(keys), "subscribe");
				}
			});

		const handleDisconnect = (closed: Deferred.Deferred<void, void>) =>
			Effect.gen(function* () {
				unhealthy = true;
				currentWS = null;
				// Drop queued frames so a reconnect isn't preceded by a stale backlog.
				yield* clearOutbound();
				yield* Deferred.fail(closed, undefined);
			});

		const onMessage = (raw: string) => {
			const started = performance.now();
			const parsed = parseInboundFrame(raw);
			if (!parsed) return;
			if (parsed.kind === "pong") return;
			if (parsed.kind === "error") {
				inboundControl.offer(parsed);
				return;
			}

			let applied = 0;
			for (const { key, frame } of parsed.frames) {
				if (!isDesired(key)) continue;
				cache.setPriceSync(key, frame);
				applied += 1;
			}
			recordTickHandle(venue, name, performance.now() - started, applied);
		};

		const connectOnce = Effect.gen(function* () {
			const deferred = yield* Deferred.make<void, void>();

			yield* Effect.logInfo(`${venue} WS connecting`, { name });
			yield* incrementConnectionAttempts();

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
				onMessage(event.data);
			});
			ws.addEventListener("error", () => {
				unhealthy = true;
				Runtime.runSync(
					runtime,
					Effect.logWarning(`${venue} WS error event`, { name }),
				);
			});
			ws.addEventListener("close", (event) => {
				Runtime.runSync(
					runtime,
					Effect.gen(function* () {
						yield* Effect.logWarning(`${venue} WS disconnected`, {
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
			Effect.tapError(() =>
				Effect.sync(() => {
					unhealthy = true;
				}),
			),
			Effect.retry(reconnectSchedule),
		);

		const sendPing = () =>
			Effect.gen(function* () {
				if (keepalive === undefined) return;
				const ws = currentWS;
				if (ws === null || ws.readyState !== WebSocket.OPEN) return;
				try {
					ws.send(keepalive.frame);
					yield* incrementMessagesSent("ping");
				} catch (err) {
					yield* closeOnSendFailure(ws, err, "ping");
				}
			});

		const cachedStart = yield* Effect.cached(
			Effect.gen(function* () {
				yield* Effect.forkDaemon(sendLoop);
				if (keepalive !== undefined) {
					yield* Effect.forkDaemon(
						sendPing().pipe(
							Effect.schedule(Schedule.spaced(keepalive.interval)),
						),
					);
				}
				return yield* Effect.forkDaemon(loop);
			}),
		);
		const start = () => cachedStart;

		return { start, subscribe, unsubscribe, hasError } satisfies VenueWS;
	});
