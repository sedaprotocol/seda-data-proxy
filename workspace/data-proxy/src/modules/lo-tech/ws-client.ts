import { Duration, Effect, Runtime } from "effect";
import WebSocket from "ws";
import type { LoTechModuleConfig } from "../../config/lo-tech-module-config";
import type { LoTechData, LoTechDataMessage } from "./schema";

// LO:TECH expects a ping every ~60 seconds to keep the connection alive.
const LO_TECH_PING_INTERVAL_MS = 30_000;

export type LoTechWebSocketServiceApi = {
	readonly sendIfOpen: (text: string) => Effect.Effect<void>;
};

export type LoTechWebSocketServiceDeps = {
	config: LoTechModuleConfig;
	runtime: Runtime.Runtime<never>;
	onOpen: (socket: WebSocket) => void;
	handleDataMessage: (data: LoTechData) => Effect.Effect<void>;
};

export const makeLoTechWebSocketService = (
	deps: LoTechWebSocketServiceDeps,
): Effect.Effect<LoTechWebSocketServiceApi> =>
	Effect.gen(function* () {
		const { config, runtime, onOpen, handleDataMessage } = deps;

		let activeSocket: WebSocket | null = null;

		const sendIfOpen = (text: string) =>
			Effect.gen(function* () {
				const sock = activeSocket;
				if (sock !== null && sock.readyState === WebSocket.OPEN) {
					yield* Effect.logDebug("Sending message to LO:TECH", { text });
					sock.send(text);
				}
			});

		const runWebSocketSession = (): Promise<void> =>
			new Promise((resolve) => {
				const url = `wss://data.lo.tech/ws/v1/${config.exchange}`;
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
					onOpen(socket);

					if (pingTimer !== undefined) {
						clearInterval(pingTimer);
					}
					pingTimer = setInterval(() => {
						Runtime.runSync(
							runtime,
							sendIfOpen(JSON.stringify({ op: "PING" })),
						);
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
									yield* handleDataMessage(
										(parsed as LoTechDataMessage).data,
									).pipe(
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
									yield* Effect.logWarning("Received ack from LO:TECH");
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

		yield* Effect.forkDaemon(
			Effect.gen(function* () {
				while (true) {
					yield* Effect.tryPromise({
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
					yield* Effect.sleep(Duration.millis(config.reconnectDelayMs ?? 1000));
				}
			}),
		);

		return { sendIfOpen };
	});
