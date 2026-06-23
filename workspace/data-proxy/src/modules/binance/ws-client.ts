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
import type { BinanceModuleConfig } from "../../config/binance-module-config";

/** A raw Binance market-data payload. Always carries the symbol in `s`; the rest
 * of the fields depend on the configured stream type and are relayed verbatim. */
export interface BinancePriceFrame {
	s: string;
	[key: string]: unknown;
}

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

/** Extracts {symbol, frame} from an inbound message, or null if it is not a
 * market-data payload (control acks like {result, id} and malformed frames). */
export const parseInboundFrame = (
	raw: string,
): { symbol: string; frame: BinancePriceFrame } | null => {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return null;
	}

	// Combined streams wrap the payload as { stream, data }; raw streams send it bare.
	let payload: unknown = json;
	if (
		isRecord(json) &&
		typeof json.stream === "string" &&
		isRecord(json.data)
	) {
		payload = json.data;
	}

	if (!isRecord(payload) || typeof payload.s !== "string") {
		return null;
	}

	return {
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
		let socketError: string | undefined;
		let controlId = 0;
		const schedule =
			options?.reconnectSchedule ?? defaultReconnectSchedule(config);

		const nextControlId = () => ++controlId;

		const streamNamesFor = (symbols: string[]) =>
			symbols.map((symbol) => buildStreamName(symbol, config.streamType));

		const trySend = (frame: string) =>
			Effect.gen(function* () {
				const ws = currentWS;
				if (ws === null || ws.readyState !== WebSocket.OPEN) return;
				try {
					ws.send(frame);
				} catch (err) {
					socketError = `ws send failed: ${String(err)}`;
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
				// Binance caps inbound control messages at 5/sec; one frame per batch stays under it.
				yield* trySend(
					buildSubscribeFrame(streamNamesFor(fresh), nextControlId()),
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
				yield* trySend(
					buildUnsubscribeFrame(streamNamesFor(removed), nextControlId()),
				);
			});

		const hasError = () => Effect.sync(() => socketError !== undefined);

		const handleOpen = (ws: WebSocket) =>
			Effect.gen(function* () {
				yield* Effect.logInfo("Binance WS open", { name: config.name });
				socketError = undefined;
				currentWS = ws;
				const symbols: string[] = [];
				for (const [symbol] of desiredSymbols) symbols.push(symbol);
				if (symbols.length > 0) {
					yield* trySend(
						buildSubscribeFrame(streamNamesFor(symbols), nextControlId()),
					);
				}
			});

		const handleInboundMessage = (raw: string) =>
			Effect.gen(function* () {
				const parsed = parseInboundFrame(raw);
				if (!parsed) return;
				if (Option.isNone(MutableHashMap.get(desiredSymbols, parsed.symbol))) {
					return;
				}
				yield* cache.setPrice(parsed.symbol, parsed.frame);
			});

		const handleDisconnect = (
			reason: "close" | "error",
			closed: Deferred.Deferred<void, "close" | "error">,
		) =>
			Effect.gen(function* () {
				yield* Effect.logWarning("Binance WS disconnected", { reason });
				socketError = `ws ${reason}`;
				currentWS = null;
				yield* Deferred.fail(closed, reason);
			});

		const connectOnce = Effect.gen(function* () {
			const closed = yield* Deferred.make<void, "close" | "error">();

			yield* Effect.logInfo("Binance WS connecting", { name: config.name });

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
				Effect.sync(() => {
					socketError = `ws connect failed: ${String(error)}`;
				}),
			),
			Effect.retry(schedule),
		);

		const cachedStart = yield* Effect.cached(Effect.forkDaemon(loop));
		const start = () => cachedStart;

		return { start, subscribe, unsubscribe, hasError } satisfies BinanceWS;
	});
