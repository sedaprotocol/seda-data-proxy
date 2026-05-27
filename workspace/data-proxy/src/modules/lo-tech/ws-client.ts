import { Duration, Effect, Runtime, Schedule } from "effect";
import * as v from "valibot";
import WebSocket from "ws";
import type { LoTechModuleConfig } from "../../config/lo-tech-module-config";
import {
	type LoTechAck,
	LoTechAckSchema,
	LoTechDataMessageSchema,
	type LoTechParsedData,
} from "./schema";

// LO:TECH expects a ping every ~60 seconds to keep the connection alive.
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

export type LoTechWebSocketServiceApi = {
	readonly subscribePrice: (
		symbol: string,
		priceFeedId: number,
	) => Effect.Effect<void>;
	readonly unsubscribePrice: (symbol: string) => Effect.Effect<void>;
};

export type LoTechWebSocketServiceDeps = {
	config: LoTechModuleConfig;
	runtime: Runtime.Runtime<never>;
	/* Runs immediately after the socket is OPEN */
	onConnected?: (api: LoTechWebSocketServiceApi) => Effect.Effect<void>;
	handleDataMessage: (data: LoTechParsedData) => Effect.Effect<void>;
	handleAckMessage: (data: LoTechAck) => Effect.Effect<void>;
};

export const makeLoTechWebSocketService = (
	deps: LoTechWebSocketServiceDeps,
): Effect.Effect<LoTechWebSocketServiceApi> =>
	Effect.gen(function* () {
		const {
			config,
			runtime,
			onConnected,
			handleDataMessage,
			handleAckMessage,
		} = deps;

		let activeSocket: WebSocket | null = null;
		const pendingOutbound: string[] = [];

		function send(text: string): Effect.Effect<void> {
			return Effect.gen(function* () {
				const sock = activeSocket;
				if (sock !== null && sock.readyState === WebSocket.OPEN) {
					yield* Effect.logDebug("Sending message to LO:TECH", { text });
					sock.send(text);
				} else {
					pendingOutbound.push(text);
				}
			});
		}

		const subscribePrice = (symbol: string, priceFeedId: number) =>
			send(subscribePricePayload(symbol, priceFeedId));

		const unsubscribePrice = (symbol: string) =>
			send(unsubscribePricePayload(symbol));

		const api: LoTechWebSocketServiceApi = {
			subscribePrice,
			unsubscribePrice,
		};

		const flushPendingOutbound = (): void => {
			const sock = activeSocket;
			if (sock === null || sock.readyState !== WebSocket.OPEN) {
				return;
			}
			while (pendingOutbound.length > 0) {
				const text = pendingOutbound.shift();
				if (text === undefined) {
					break;
				}
				Runtime.runSync(
					runtime,
					Effect.gen(function* () {
						yield* Effect.logDebug(
							"Flushing pending outbound message to LO:TECH",
							{ text },
						);
						sock.send(text);
					}),
				);
			}
		};

		const runWebSocketSession = (): Promise<void> =>
			new Promise((resolve) => {
				const url = `${config.baseUrl}/${config.exchange}`;
				let pingTimer: ReturnType<typeof setInterval> | undefined;

				let socket: WebSocket;
				try {
					socket = new WebSocket(url, {
						headers: { "X-API-KEY": config.loTechApiKey },
					});
				} catch (error) {
					Runtime.runSync(
						runtime,
						Effect.logError("LO:TECH WebSocket constructor failed", {
							error,
						}),
					);
					resolve();
					return;
				}

				activeSocket = socket;

				socket.on("open", () => {
					if (onConnected !== undefined) {
						Runtime.runSync(
							runtime,
							onConnected(api).pipe(
								Effect.catchAll((err) =>
									Effect.logError("LO:TECH onConnected failed", { err }),
								),
							),
						);
					}

					flushPendingOutbound();

					if (pingTimer !== undefined) {
						clearInterval(pingTimer);
					}
					pingTimer = setInterval(() => {
						socket.ping();
					}, LO_TECH_PING_INTERVAL_MS);
				});

				socket.on("message", (raw) => {
					const text = typeof raw === "string" ? raw : raw.toString();

					try {
						const parsed: unknown = JSON.parse(text);

						Runtime.runSync(
							runtime,
							Effect.gen(function* () {
								if (typeof parsed !== "object" || parsed === null) {
									yield* Effect.logError(
										"Unexpected LO:TECH message format",
										parsed,
									);
									return;
								}

								if ("data" in parsed) {
									const msgResult = v.safeParse(
										LoTechDataMessageSchema,
										parsed,
									);
									if (!msgResult.success) {
										yield* Effect.logError(
											"Unexpected LO:TECH data message (schema)",
											{
												issues: v.flatten(msgResult.issues),
												raw: parsed,
											},
										);
										return;
									}

									yield* handleDataMessage(msgResult.output.data).pipe(
										Effect.catchAll((err) =>
											Effect.logError(
												"Failed to handle data message from LO:TECH",
												{
													err,
												},
											),
										),
									);
								} else if ("ack" in parsed) {
									const ackResult = v.safeParse(LoTechAckSchema, parsed);
									if (!ackResult.success) {
										yield* Effect.logError(
											"Unexpected LO:TECH ack message (schema)",
											{
												issues: v.flatten(ackResult.issues),
												raw: parsed,
											},
										);
										return;
									}
									yield* handleAckMessage(ackResult.output).pipe(
										Effect.catchAll((err) =>
											Effect.logError(
												"Failed to handle ack message from LO:TECH",
												{
													err,
												},
											),
										),
									);
								} else if ("pong" in parsed) {
									yield* Effect.logInfo("Received pong from LO:TECH");
								} else if ("error" in parsed) {
									yield* Effect.logError(
										"LO:TECH error message received",
										parsed,
									);
								} else {
									yield* Effect.logWarning(
										"Unexpected LO:TECH message received",
										parsed,
									);
								}
							}),
						);
					} catch (error) {
						Runtime.runSync(
							runtime,
							Effect.logWarning("LO:TECH invalid JSON message", {
								error,
								text: text.slice(0, 500),
							}),
						);
					}
				});

				socket.on("close", () => {
					Runtime.runSync(
						runtime,
						Effect.logWarning(
							"LO:TECH websocket closed; reconnecting after delay",
						),
					);

					if (pingTimer !== undefined) {
						clearInterval(pingTimer);
						pingTimer = undefined;
					}
					if (activeSocket === socket) {
						activeSocket = null;
					}
					resolve();
				});

				socket.on("error", (error) => {
					Runtime.runSync(
						runtime,
						Effect.logError("LO:TECH websocket error", { error }),
					);
				});
			});

		const reconnectSchedule = Schedule.spaced(
			Duration.millis(config.reconnectDelayMs ?? 1000),
		);

		const runSession = Effect.tryPromise({
			try: () => runWebSocketSession(),
			catch: (error) =>
				new Error("Failed to run LO:TECH connection session", {
					cause: error,
				}),
		}).pipe(
			Effect.catchAll((error) =>
				Effect.logError("LO:TECH connection session failed", {
					error,
				}),
			),
		);

		yield* Effect.forkDaemon(Effect.repeat(runSession, reconnectSchedule));

		return api;
	});
