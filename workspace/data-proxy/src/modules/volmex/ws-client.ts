import { Duration, Effect, Redacted, Runtime, Schedule } from "effect";
import * as v from "valibot";
import WebSocket from "ws";
import type { VolmexModuleConfig } from "../../config/volmex-module-config";
import { type VolmexDataPrice, VolmexDataPriceSchema } from "./schema";

const ENGINE_IO_VERSION = "4";
const FETCH_INDICES_EVENT = "fetch-indices-messages-private";
const INDICES_STREAM_EVENT = "indices-messages-stream-private";

export const buildVolmexWebSocketUrl = (
	baseUrl: string,
	jwt: Redacted.Redacted<string>,
): string => {
	const normalizedBase = baseUrl.replace(/\/$/, ""); // Remove trailing slash
	return `${normalizedBase}/socket.io/?EIO=${ENGINE_IO_VERSION}&transport=websocket&jwtToken=${encodeURIComponent(Redacted.value(jwt))}`;
};

// Parse the socket.io event of the form:
// 42["indices-messages-stream-private",{...payload...}]
const parseSocketIoEvent = (
	text: string,
): { event: string; payload: unknown } | null => {
	if (!text.startsWith("42")) {
		return null;
	}

	try {
		const parsed: unknown = JSON.parse(text.slice(2));
		if (!Array.isArray(parsed) || parsed.length < 1) {
			return null;
		}

		const [event, payload] = parsed;
		if (typeof event !== "string") {
			return null;
		}

		return { event, payload };
	} catch {
		return null;
	}
};

export type VolmexWebSocketServiceDeps = {
	config: Pick<
		VolmexModuleConfig,
		"baseUrl" | "volmexApiKey" | "reconnectDelayMs"
	>;
	runtime: Runtime.Runtime<never>;
	onPrice: (price: VolmexDataPrice) => Effect.Effect<void>;
};

export const makeVolmexWebSocketService = (
	deps: VolmexWebSocketServiceDeps,
): Effect.Effect<void> =>
	Effect.gen(function* () {
		const { config, runtime, onPrice } = deps;

		const runWebSocketSession = (): Promise<void> =>
			new Promise((resolve) => {
				const url = buildVolmexWebSocketUrl(
					config.baseUrl,
					config.volmexApiKey,
				);
				let namespaceConnected = false;

				let socket: WebSocket;
				try {
					socket = new WebSocket(url);
				} catch (error) {
					Runtime.runSync(
						runtime,
						Effect.logError("Volmex WebSocket constructor failed", { error }),
					);
					resolve();
					return;
				}

				const subscribeToIndices = (): void => {
					socket.send(`42["${FETCH_INDICES_EVENT}",{}]`);
				};

				socket.on("open", () => {
					Runtime.runSync(
						runtime,
						Effect.logInfo("Volmex WebSocket connected", { url }),
					);
				});

				socket.on("message", (raw) => {
					const text = typeof raw === "string" ? raw : raw.toString();

					// Engine.IO open
					if (text.startsWith("0")) {
						// Join default namespace
						socket.send("40");
						return;
					}

					// Engine.IO ping
					if (text === "2") {
						// Engine.IO pong
						socket.send("3");
						return;
					}

					if (text.startsWith("40") && !namespaceConnected) {
						namespaceConnected = true;
						subscribeToIndices();
						return;
					}

					const event = parseSocketIoEvent(text);
					if (event === null) {
						return;
					}

					if (event.event !== INDICES_STREAM_EVENT) {
						Runtime.runSync(
							runtime,
							Effect.logDebug("Ignoring Volmex socket event", {
								event: event.event,
							}),
						);
						return;
					}

					Runtime.runSync(
						runtime,
						Effect.gen(function* () {
							const result = v.safeParse(VolmexDataPriceSchema, event.payload);
							if (!result.success) {
								yield* Effect.logWarning("Unexpected Volmex indices message", {
									issues: v.flatten(result.issues),
									payload: event.payload,
								});
								return;
							}

							yield* onPrice(result.output).pipe(
								Effect.catchAll((err) =>
									Effect.logError("Failed to handle Volmex price update", {
										err,
									}),
								),
							);
						}),
					);
				});

				socket.on("close", () => {
					Runtime.runSync(
						runtime,
						Effect.logWarning(
							"Volmex websocket closed; reconnecting after delay",
						),
					);
					resolve();
				});

				socket.on("error", (error) => {
					Runtime.runSync(
						runtime,
						Effect.logError("Volmex websocket error", { error }),
					);
				});
			});

		const reconnectSchedule = Schedule.spaced(
			Duration.millis(config.reconnectDelayMs ?? 1000),
		);

		const runSession = Effect.tryPromise({
			try: () => runWebSocketSession(),
			catch: (error) =>
				new Error("Failed to run Volmex connection session", { cause: error }),
		}).pipe(
			Effect.catchAll((error) =>
				Effect.logError("Volmex connection session failed", { error }),
			),
		);

		yield* Effect.forkDaemon(Effect.repeat(runSession, reconnectSchedule));
	});
