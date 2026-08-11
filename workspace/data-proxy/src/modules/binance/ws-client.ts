import {
	Deferred,
	Duration,
	Effect,
	type Fiber,
	Metric,
	MutableHashMap,
	Option,
	Runtime,
	Schedule,
} from "effect";
import type { BinanceModuleConfig } from "../../config/binance-module-config";

/** A raw Binance market-data payload. Always carries the symbol in `s`; the rest
 * of the fields depend on the configured stream type and are relayed verbatim. */
export interface BinancePriceFrame {
	s: string;
	[key: string]: unknown;
}

type OutboundMessageType = "subscribe" | "unsubscribe";

/** Metrics for the Binance WebSocket client. */
const activeSubscriptions = Metric.gauge("binance_active_subscriptions", {
	description: "Number of active Binance WebSocket stream subscriptions",
});

const messagesSent = Metric.counter("binance_messages_sent", {
	description:
		"Outbound Binance WebSocket control messages sent (subscribe/unsubscribe)",
	incremental: true,
});

const connectionAttempts = Metric.counter("binance_connection_attempts", {
	description: "Binance WebSocket connection attempts",
	incremental: true,
});

/** The subset of the shared price cache the WS daemon writes to. */
interface PriceSink {
	setPrice: (key: string, price: BinancePriceFrame) => Effect.Effect<void>;
}

export const buildStreamName = (symbol: string, streamType: string): string =>
	`${symbol.toLowerCase()}@${streamType}`;

export const buildSubscribeFrame = (
	streamNames: string[],
	id: number,
): string => JSON.stringify({ method: "SUBSCRIBE", params: streamNames, id });

export const buildUnsubscribeFrame = (
	streamNames: string[],
	id: number,
): string => JSON.stringify({ method: "UNSUBSCRIBE", params: streamNames, id });

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

export type ParsedInbound =
	| { kind: "ticker"; symbol: string; frame: BinancePriceFrame }
	| { kind: "error"; code: number | null; message: string | null };

/** Classifies an inbound message: a market-data payload, a venue error, or null
 * for other messages. */
export const parseInboundFrame = (raw: string): ParsedInbound | null => {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(json)) return null;

	const err = json.error;
	if (isRecord(err)) {
		return {
			kind: "error",
			code: typeof err.code === "number" ? err.code : null,
			message: typeof err.msg === "string" ? err.msg : null,
		};
	}

	// Combined streams wrap the payload as { stream, data }; raw streams send it bare.
	let payload: unknown = json;
	if (typeof json.stream === "string" && isRecord(json.data)) {
		payload = json.data;
	}

	if (!isRecord(payload) || typeof payload.s !== "string") {
		return null;
	}

	return {
		kind: "ticker",
		symbol: payload.s.toUpperCase(),
		frame: payload as BinancePriceFrame,
	};
};

export const defaultReconnectSchedule = (config: BinanceModuleConfig) =>
	Schedule.exponential(Duration.seconds(1)).pipe(
		Schedule.either(Schedule.spaced(config.reconnectMaxBackoff)),
		Schedule.resetAfter(config.reconnectStableThreshold),
	);

export interface BinanceWS {
	/** Forks the WS daemon. The daemon owns reconnect with backoff and resubscribes on each open. */
	start(): Effect.Effect<Fiber.RuntimeFiber<unknown, unknown>, never, never>;
	/** Adds the symbols to the desired set and sends one subscribe frame for the new ones if connected. Idempotent. */
	subscribe(symbols: string[]): Effect.Effect<void, never, never>;
	/** Removes the symbols from the desired set and sends one unsubscribe frame for the removed ones if connected. Idempotent. */
	unsubscribe(symbols: string[]): Effect.Effect<void, never, never>;
	/** True while the socket is disconnected, errored, or has a pending send failure. */
	hasError(): Effect.Effect<boolean, never, never>;
}

export interface CreateBinanceWSOptions {
	reconnectSchedule?: Schedule.Schedule<unknown, unknown, never>;
}

export const createBinanceWS = (
	config: BinanceModuleConfig,
	cache: PriceSink,
	options?: CreateBinanceWSOptions,
): Effect.Effect<BinanceWS, never, never> =>
	Effect.gen(function* () {
		const runtime = yield* Effect.runtime<never>();
		const desiredSymbols = MutableHashMap.empty<string, true>();
		let currentWS: WebSocket | null = null;
		let unhealthy = false;
		let controlId = 0;
		const schedule =
			options?.reconnectSchedule ?? defaultReconnectSchedule(config);

		const withModuleName = <Type, In, Out>(
			metric: Metric.Metric<Type, In, Out>,
		) => Metric.tagged(metric, "module", config.name);

		const setActiveSubscriptions = () =>
			Metric.set(
				withModuleName(activeSubscriptions),
				MutableHashMap.size(desiredSymbols),
			);

		const incrementMessagesSent = (type: OutboundMessageType) =>
			Metric.increment(
				Metric.tagged(withModuleName(messagesSent), "type", type),
			);

		const incrementConnectionAttempts = () =>
			Metric.increment(withModuleName(connectionAttempts));

		const nextControlId = () => ++controlId;

		const streamNamesFor = (symbols: string[]) =>
			symbols.map((symbol) => buildStreamName(symbol, config.streamType));

		const trySend = (frame: string, type: OutboundMessageType) =>
			Effect.gen(function* () {
				const ws = currentWS;
				if (ws === null || ws.readyState !== WebSocket.OPEN) return;
				try {
					ws.send(frame);
					yield* incrementMessagesSent(type);
				} catch (err) {
					unhealthy = true;
					yield* Effect.logWarning("Binance WS send failed", {
						error: String(err),
					});
					try {
						ws.close();
					} catch {
						// best-effort; the close listener will trigger the reconnect loop.
					}
				}
			});

		const subscribe = (symbols: string[]) =>
			Effect.gen(function* () {
				const fresh: string[] = [];
				for (const raw of symbols) {
					const symbol = raw.toUpperCase();
					if (Option.isSome(MutableHashMap.get(desiredSymbols, symbol)))
						continue;
					MutableHashMap.set(desiredSymbols, symbol, true);
					fresh.push(symbol);
				}
				if (fresh.length === 0) return;
				yield* setActiveSubscriptions();
				// Binance caps inbound control messages at 5/sec; one frame per batch stays under it.
				yield* trySend(
					buildSubscribeFrame(streamNamesFor(fresh), nextControlId()),
					"subscribe",
				);
			});

		const unsubscribe = (symbols: string[]) =>
			Effect.gen(function* () {
				const removed: string[] = [];
				for (const raw of symbols) {
					const symbol = raw.toUpperCase();
					if (Option.isNone(MutableHashMap.get(desiredSymbols, symbol)))
						continue;
					MutableHashMap.remove(desiredSymbols, symbol);
					removed.push(symbol);
				}
				if (removed.length === 0) return;
				yield* setActiveSubscriptions();
				yield* trySend(
					buildUnsubscribeFrame(streamNamesFor(removed), nextControlId()),
					"unsubscribe",
				);
			});

		const hasError = () => Effect.sync(() => unhealthy);

		const handleOpen = (ws: WebSocket) =>
			Effect.gen(function* () {
				yield* Effect.logInfo("Binance WS open", { name: config.name });
				unhealthy = false;
				currentWS = ws;
				const symbols: string[] = [];
				for (const [symbol] of desiredSymbols) symbols.push(symbol);
				if (symbols.length > 0) {
					yield* trySend(
						buildSubscribeFrame(streamNamesFor(symbols), nextControlId()),
						"subscribe",
					);
				}
			});

		const handleInboundMessage = (raw: string) => {
			const parsed = parseInboundFrame(raw);
			if (!parsed) return Effect.void;
			if (parsed.kind === "error") {
				return Effect.logWarning("Binance WS error frame", {
					code: parsed.code,
					message: parsed.message,
				});
			}
			if (Option.isNone(MutableHashMap.get(desiredSymbols, parsed.symbol))) {
				return Effect.void;
			}

			return Effect.gen(function* () {
				yield* cache.setPrice(parsed.symbol, parsed.frame);
			}).pipe(
				Effect.withSpan("binance.ws.handleInboundMessage", {
					attributes: { symbol: parsed.symbol },
				}),
			);
		};

		const handleDisconnect = (closed: Deferred.Deferred<void, void>) =>
			Effect.gen(function* () {
				unhealthy = true;
				currentWS = null;
				yield* Deferred.fail(closed, undefined);
			});

		const connectOnce = Effect.gen(function* () {
			const deferred = yield* Deferred.make<void, void>();

			yield* Effect.logInfo("Binance WS connecting", { name: config.name });
			yield* incrementConnectionAttempts();

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
				unhealthy = true;
				Runtime.runSync(
					runtime,
					Effect.logWarning("Binance WS error event", { name: config.name }),
				);
			});
			ws.addEventListener("close", (event) => {
				Runtime.runSync(
					runtime,
					Effect.gen(function* () {
						yield* Effect.logWarning("Binance WS disconnected", {
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
			Effect.retry(schedule),
		);

		const cachedStart = yield* Effect.cached(Effect.forkDaemon(loop));
		const start = () => cachedStart;

		return { start, subscribe, unsubscribe, hasError } satisfies BinanceWS;
	});
