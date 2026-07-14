import { Effect, type Fiber, Redacted, Runtime } from "effect";
import { type Socket, io } from "socket.io-client";
import * as v from "valibot";
import type { VolmexModuleConfig } from "../../config/volmex-module-config";
import { type VolmexDataPrice, VolmexDataPriceSchema } from "./schema";

const FETCH_INDICES_EVENT = "fetch-indices-messages-private";
const INDICES_STREAM_EVENT = "indices-messages-stream-private";

export type VolmexWebSocketServiceDeps = {
	config: Pick<
		VolmexModuleConfig,
		"baseUrl" | "volmexApiKey" | "reconnectDelayMs"
	>;
	runtime: Runtime.Runtime<never>;
	onPrice: (price: VolmexDataPrice) => Effect.Effect<void>;
};

export interface VolmexWS {
	/** Forks the Socket.IO daemon. Idempotent across repeated calls. */
	start: () => Effect.Effect<Fiber.RuntimeFiber<void, never>>;
}

export const makeVolmexWebSocketService = (
	deps: VolmexWebSocketServiceDeps,
): Effect.Effect<VolmexWS> =>
	Effect.gen(function* () {
		const { config, runtime, onPrice } = deps;
		const reconnectDelayMs = config.reconnectDelayMs ?? 1000;

		const connect = Effect.async<void>((resume) => {
			let socket: Socket;
			try {
				socket = io(config.baseUrl.replace(/\/$/, ""), {
					path: "/socket.io",
					transports: ["websocket"],
					query: {
						jwtToken: Redacted.value(config.volmexApiKey),
					},
					reconnection: true,
					reconnectionDelay: reconnectDelayMs,
				});
			} catch (error) {
				Runtime.runSync(
					runtime,
					Effect.logError("Volmex Socket.IO constructor failed", { error }),
				);
				resume(Effect.void); // No cleanup needed.
				return;
			}

			socket.on("connect", () => {
				Runtime.runSync(
					runtime,
					Effect.logInfo("Volmex Socket.IO connected", {
						url: config.baseUrl,
					}),
				);
				socket.emit(FETCH_INDICES_EVENT, {});
			});

			socket.on(INDICES_STREAM_EVENT, (payload: unknown) => {
				Runtime.runSync(
					runtime,
					Effect.gen(function* () {
						const result = v.safeParse(VolmexDataPriceSchema, payload);
						if (!result.success) {
							yield* Effect.logWarning("Unexpected Volmex indices message", {
								issues: v.flatten(result.issues),
								payload,
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

			socket.on("disconnect", (reason) => {
				Runtime.runSync(
					runtime,
					Effect.logWarning("Volmex Socket.IO disconnected; will reconnect", {
						reason,
						reconnectDelayMs,
					}),
				);
			});

			socket.on("connect_error", (error) => {
				Runtime.runSync(
					runtime,
					Effect.logError("Volmex Socket.IO connect error", { error }),
				);
			});

			// Return a cleanup Effect that will be executed if the fiber
			// running this effect is interrupted.
			return Effect.sync(() => {
				socket.removeAllListeners();
				socket.close();
			});
		});

		const cachedStart = yield* Effect.cached(Effect.forkDaemon(connect));
		const start = () => cachedStart;

		return { start } satisfies VolmexWS;
	});
