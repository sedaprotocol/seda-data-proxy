import {
	Deferred,
	Duration,
	Effect,
	type Fiber,
	Runtime,
	Schedule,
} from "effect";
import WebSocket from "ws";
import type { LoTechModuleConfig } from "../../config/lo-tech-module-config";
import type { LoTechData, LoTechDataMessage } from "./schema";

// LO:TECH expects periodic ping frames to keep the connection alive.
const LO_TECH_PING_INTERVAL_MS = 30_000;

function subscribePricePayload(symbol: string, priceFeedId: number): string {
	return JSON.stringify({
		op: "SUBSCRIBE",
		topics: [{ symbol, type: "PRICE" }],
		id: priceFeedId,
	});
}

function unsubscribePricePayload(symbol: string): string {
	return JSON.stringify({
		op: "UNSUBSCRIBE",
		topics: [{ symbol, type: "PRICE" }],
	});
}

export interface LoTechWS {
	/** Forks the WS daemon. The daemon owns reconnect with backoff and flushes pending sends on each open. */
	start(): Effect.Effect<Fiber.RuntimeFiber<unknown, unknown>, never, never>;
	subscribePrice(
		symbol: string,
		priceFeedId: number,
	): Effect.Effect<void, never, never>;
	unsubscribePrice(symbol: string): Effect.Effect<void, never, never>;
	/** True while the socket is disconnected, errored, or has a pending send failure. */
	hasError(): Effect.Effect<boolean, never, never>;
}

export interface CreateLoTechWSDeps {
	config: LoTechModuleConfig;
	handleDataMessage: (data: LoTechData) => Effect.Effect<void>;
}

export interface CreateLoTechWSOptions {
	reconnectSchedule?: Schedule.Schedule<unknown, unknown, never>;
}

export const defaultReconnectSchedule = (config: LoTechModuleConfig) =>
	Schedule.spaced(Duration.millis(config.reconnectDelayMs ?? 1000));

export const createLoTechWS = (
	deps: CreateLoTechWSDeps,
	options?: CreateLoTechWSOptions,
): Effect.Effect<LoTechWS, never, never> =>
	Effect.gen(function* () {
		const { config, handleDataMessage } = deps;
		const runtime = yield* Effect.runtime<never>();
		const schedule =
			options?.reconnectSchedule ?? defaultReconnectSchedule(config);

		const pendingOutbound: string[] = [];
		let currentWS: WebSocket | null = null;
		let socketError: string | undefined;
		let pingTimer: ReturnType<typeof setInterval> | undefined;

		const trySend = (message: string) =>
			Effect.gen(function* () {
				const ws = currentWS;
				if (ws === null || ws.readyState !== WebSocket.OPEN) return;
				yield* Effect.logDebug("Sending message to LO:TECH", { message });
				try {
					ws.send(message);
				} catch (err) {
					socketError = `ws send failed: ${String(err)}`;
					yield* Effect.logWarning("LO:TECH WS send failed", {
						error: String(err),
					});
					try {
						ws.close();
					} catch {
						// best-effort; close listener completes the session for reconnect.
					}
				}
			});

		const enqueueOrSend = (text: string) =>
			Effect.gen(function* () {
				const ws = currentWS;
				if (ws !== null && ws.readyState === WebSocket.OPEN) {
					yield* trySend(text);
				} else {
					pendingOutbound.push(text);
				}
			});

		const subscribePrice = (symbol: string, priceFeedId: number) =>
			enqueueOrSend(subscribePricePayload(symbol, priceFeedId));

		const unsubscribePrice = (symbol: string) =>
			enqueueOrSend(unsubscribePricePayload(symbol));

		const hasError = () => Effect.sync(() => socketError !== undefined);

		const handleOpen = (ws: WebSocket) =>
			Effect.gen(function* () {
				yield* Effect.logInfo("LO:TECH WS open", {
					exchange: config.exchange,
				});
				socketError = undefined;
				currentWS = ws;

				while (pendingOutbound.length > 0) {
					const text = pendingOutbound.shift();
					if (text === undefined) break;
					yield* Effect.logDebug(
						"Flushing pending outbound message to LO:TECH",
						{ text },
					);
					yield* trySend(text);
				}

				if (pingTimer !== undefined) {
					clearInterval(pingTimer);
					pingTimer = undefined;
				}
				pingTimer = setInterval(() => {
					try {
						ws.ping();
					} catch (err) {
						Runtime.runSync(
							runtime,
							Effect.logWarning("LO:TECH WS ping failed", {
								error: String(err),
							}),
						);
					}
				}, LO_TECH_PING_INTERVAL_MS);
			});

		const handleInboundMessage = (raw: string) =>
			Effect.gen(function* () {
				try {
					const parsed: unknown = JSON.parse(raw);

					if (typeof parsed !== "object" || parsed === null) {
						yield* Effect.logError("Unexpected LO:TECH message format", parsed);
						return;
					}

					if ("data" in parsed) {
						yield* handleDataMessage((parsed as LoTechDataMessage).data).pipe(
							Effect.catchAll((err) =>
								Effect.logError("Failed to handle data message from LO:TECH", {
									err,
								}),
							),
						);
					} else if ("ack" in parsed) {
						yield* Effect.logWarning("Received ack from LO:TECH");
					} else if ("pong" in parsed) {
						yield* Effect.logInfo("Received pong from LO:TECH");
					} else if ("error" in parsed) {
						yield* Effect.logError("LO:TECH error message received", parsed);
					} else {
						yield* Effect.logWarning(
							"Unexpected LO:TECH message received",
							parsed,
						);
					}
				} catch (error) {
					yield* Effect.logWarning("LO:TECH invalid JSON message", {
						error,
						text: raw.slice(0, 500),
					});
				}
			});

		const handleDisconnect = (
			reason: "close" | "error",
			closed: Deferred.Deferred<void, "close" | "error">,
		) =>
			Effect.gen(function* () {
				yield* Effect.logWarning(
					"LO:TECH websocket disconnected; reconnecting",
					{ reason },
				);
				socketError = `ws ${reason}`;
				currentWS = null;
				if (pingTimer !== undefined) {
					clearInterval(pingTimer);
					pingTimer = undefined;
				}
				yield* Deferred.fail(closed, reason);
			});

		const connectOnce = Effect.gen(function* () {
			const url = `${config.baseUrl}/${config.exchange}`;
			const closed = yield* Deferred.make<void, "close" | "error">();
			let sessionEnded = false;

			const endSession = (reason: "close" | "error") =>
				Effect.gen(function* () {
					if (sessionEnded) return;
					sessionEnded = true;
					yield* handleDisconnect(reason, closed);
				});

			yield* Effect.logInfo("LO:TECH WS connecting", {
				exchange: config.exchange,
			});

			const ws = yield* Effect.acquireRelease(
				Effect.sync(
					() =>
						new WebSocket(url, {
							headers: { "X-API-KEY": config.loTechApiKey },
						}),
				),
				(socket) =>
					Effect.sync(() => {
						if (socket.readyState !== WebSocket.CLOSED) {
							socket.close();
						}
					}),
			);

			ws.on("open", () => {
				Runtime.runSync(runtime, handleOpen(ws));
			});
			ws.on("message", (raw) => {
				const text = typeof raw === "string" ? raw : raw.toString();
				Runtime.runSync(runtime, handleInboundMessage(text));
			});
			ws.on("close", () => {
				Runtime.runSync(runtime, endSession("close"));
			});
			ws.on("error", (error) => {
				Runtime.runSync(
					runtime,
					Effect.logError("LO:TECH websocket error", { error }),
				);
				Runtime.runSync(runtime, endSession("error"));
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

		const start = () => Effect.forkDaemon(loop);

		return {
			start,
			subscribePrice,
			unsubscribePrice,
			hasError,
		} satisfies LoTechWS;
	});
