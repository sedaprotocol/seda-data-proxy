import { Duration, Effect, Match, Runtime, Schedule } from "effect";
import * as v from "valibot";
import WebSocket from "ws";
import type { LoTechModuleConfig } from "../../config/lo-tech-module-config";
import { forkInboundControl } from "../shared/inbound-control";
import {
	type LoTechAck,
	LoTechAckSchema,
	LoTechDataMessageSchema,
	type LoTechErrorMessage,
	LoTechErrorMessageSchema,
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
	config: Pick<
		LoTechModuleConfig,
		"baseUrl" | "loTechApiKey" | "reconnectDelayMs"
	>;
	exchange: string;
	runtime: Runtime.Runtime<never>;
	/* Runs immediately after the socket is OPEN */
	onConnected?: (api: LoTechWebSocketServiceApi) => Effect.Effect<void>;
	handleDataMessage: (data: LoTechParsedData) => void;
	handleAckMessage: (data: LoTechAck) => Effect.Effect<void>;
	handleErrorMessage: (data: LoTechErrorMessage) => Effect.Effect<void>;
};

export type LoTechInboundControl =
	| { kind: "ack"; msg: LoTechAck }
	| { kind: "error"; msg: LoTechErrorMessage }
	| { kind: "pong" }
	| { kind: "unexpected"; parsed: unknown }
	| { kind: "invalid-json"; error: unknown; text: string }
	| { kind: "bad-format"; parsed: unknown }
	| { kind: "schema"; label: string; issues: unknown; raw: unknown };

export type ParsedInbound =
	| { kind: "data"; data: LoTechParsedData }
	| LoTechInboundControl;

const parseWithSchema = <T>(
	schema: v.GenericSchema<unknown, T>,
	label: string,
	raw: unknown,
	onOk: (value: T) => ParsedInbound,
): ParsedInbound => {
	const result = v.safeParse(schema, raw);
	if (!result.success) {
		return {
			kind: "schema",
			label,
			issues: v.flatten(result.issues),
			raw,
		};
	}
	return onOk(result.output);
};

export const parseInboundFrame = (raw: string): ParsedInbound => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return {
			kind: "invalid-json",
			error,
			text: raw.slice(0, 500),
		};
	}

	if (typeof parsed !== "object" || parsed === null) {
		return { kind: "bad-format", parsed };
	}

	if ("data" in parsed) {
		return parseWithSchema(LoTechDataMessageSchema, "data", parsed, (msg) => ({
			kind: "data",
			data: msg.data,
		}));
	}
	if ("ack" in parsed) {
		return parseWithSchema(LoTechAckSchema, "ack", parsed, (msg) => ({
			kind: "ack",
			msg,
		}));
	}
	if ("error" in parsed) {
		return parseWithSchema(
			LoTechErrorMessageSchema,
			"error",
			parsed,
			(msg) => ({
				kind: "error",
				msg,
			}),
		);
	}
	if ("pong" in parsed) {
		return { kind: "pong" };
	}
	return { kind: "unexpected", parsed };
};

export const makeLoTechWebSocketService = (
	deps: LoTechWebSocketServiceDeps,
): Effect.Effect<LoTechWebSocketServiceApi> =>
	Effect.gen(function* () {
		const {
			config,
			exchange,
			runtime,
			onConnected,
			handleDataMessage,
			handleAckMessage,
			handleErrorMessage,
		} = deps;

		let activeSocket: WebSocket | null = null;
		const pendingOutbound: string[] = [];

		const inboundControl = yield* forkInboundControl(
			(event: LoTechInboundControl) =>
				Match.value(event).pipe(
					Match.discriminatorsExhaustive("kind")({
						ack: ({ msg }) =>
							handleAckMessage(msg).pipe(
								Effect.catchAll((err) =>
									Effect.logError("Failed to handle ack message from LO:TECH", {
										err,
									}),
								),
							),
						error: ({ msg }) =>
							handleErrorMessage(msg).pipe(
								Effect.catchAll((err) =>
									Effect.logError(
										"Failed to handle error message from LO:TECH",
										{ err },
									),
								),
							),
						pong: () => Effect.logInfo("Received pong from LO:TECH"),
						unexpected: ({ parsed }) =>
							Effect.logWarning("Unexpected LO:TECH message received", parsed),
						"invalid-json": ({ error, text }) =>
							Effect.logWarning("LO:TECH invalid JSON message", {
								error,
								text,
							}),
						"bad-format": ({ parsed }) =>
							Effect.logError("Unexpected LO:TECH message format", parsed),
						schema: ({ label, issues, raw }) =>
							Effect.logError(`Unexpected LO:TECH ${label} message (schema)`, {
								issues,
								raw,
							}),
					}),
				),
		);

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

		const handleInboundMessage = (raw: string): void => {
			const parsed = parseInboundFrame(raw);
			if (parsed.kind === "data") {
				handleDataMessage(parsed.data);
				return;
			}
			inboundControl.offer(parsed);
		};

		const runWebSocketSession = (): Promise<void> =>
			new Promise((resolve) => {
				const url = `${config.baseUrl}/${exchange}`;
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
					handleInboundMessage(text);
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
