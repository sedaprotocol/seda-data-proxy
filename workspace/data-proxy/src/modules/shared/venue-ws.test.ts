import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Duration, Effect, Fiber, LogLevel, Logger, Schedule } from "effect";
import {
	FakeWebSocket,
	installFakeWebSocket,
} from "./fake-websocket.test-helpers";
import { createPriceCache } from "./price-cache";
import { createVenueWS } from "./venue-ws";

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const parseControl = (raw: string) =>
	JSON.parse(raw) as { op: string; keys: string[] };

let restoreWebSocket: (() => void) | undefined;

beforeEach(() => {
	restoreWebSocket = installFakeWebSocket();
});

afterEach(() => {
	restoreWebSocket?.();
});

const startClient = (options?: {
	keepaliveInterval?: Duration.Duration;
	maxMessages?: number;
	maxMessagesWindow?: Duration.Duration;
	reconnectSchedule?: Schedule.Schedule<unknown, unknown, never>;
	preSubscribed?: string[];
}) =>
	Effect.gen(function* () {
		const cache = yield* createPriceCache<string, Record<string, unknown>>();
		const ws = yield* createVenueWS({
			venue: "venue",
			config: {
				name: "venue-test",
				wsUrl: "wss://example.test/ws",
				maxMessages: options?.maxMessages ?? 5,
				maxMessagesWindow: options?.maxMessagesWindow ?? Duration.seconds(1),
				reconnectMaxBackoff: Duration.seconds(30),
				reconnectStableThreshold: Duration.seconds(30),
			},
			cache,
			reconnectSchedule:
				options?.reconnectSchedule ?? Schedule.spaced(Duration.minutes(10)),
			keepalive:
				options?.keepaliveInterval === undefined
					? undefined
					: {
							interval: options.keepaliveInterval,
							frame: "ping",
						},
			buildSubscribeFrame: (keys) => JSON.stringify({ op: "subscribe", keys }),
			buildUnsubscribeFrame: (keys) =>
				JSON.stringify({ op: "unsubscribe", keys }),
			parseInboundFrame: (raw) => {
				let json: unknown;
				try {
					json = JSON.parse(raw);
				} catch {
					return null;
				}
				if (typeof json !== "object" || json === null) return null;
				const record = json as Record<string, unknown>;
				if (typeof record.s !== "string") return null;
				return {
					kind: "tickers" as const,
					frames: [{ key: record.s, frame: record }],
				};
			},
		});
		if (options?.preSubscribed !== undefined) {
			yield* ws.subscribe(options.preSubscribed);
		}
		const fiber = yield* ws.start();
		return { cache, ws, fiber };
	}).pipe(Logger.withMinimumLogLevel(LogLevel.None));

describe("createVenueWS", () => {
	it("opens the WS at the configured url and batches the subscribe on open", async () => {
		const { fiber, ws: service } = await Effect.runPromise(
			startClient({ preSubscribed: ["btc", "eth"] }),
		);
		await flush();

		expect(FakeWebSocket.instances.length).toBe(1);
		const ws = FakeWebSocket.instances[0];
		expect(ws.url).toBe("wss://example.test/ws");

		ws.triggerOpen();
		await flush();

		expect(ws.sent.length).toBe(1);
		expect(parseControl(ws.sent[0])).toEqual({
			op: "subscribe",
			keys: ["BTC", "ETH"],
		});
		expect(await Effect.runPromise(service.hasError())).toBe(false);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("writes inbound frames for desired keys into the cache", async () => {
		const { cache, fiber } = await Effect.runPromise(
			startClient({ preSubscribed: ["BTC"] }),
		);
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();

		const frame = { s: "BTC", px: "67123.44" };
		ws.triggerMessage(JSON.stringify(frame));
		await flush();

		expect(await Effect.runPromise(cache.getOrWaitPrice("BTC"))).toEqual(frame);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("drops inbound frames for keys not in the desired set", async () => {
		const { cache, fiber } = await Effect.runPromise(
			startClient({ preSubscribed: ["BTC"] }),
		);
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();

		ws.triggerMessage(JSON.stringify({ s: "ETH", px: "3500.10" }));
		await flush();

		expect(cache.size()).toBe(0);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("marks hasError after the socket closes", async () => {
		const { ws: service, fiber } = await Effect.runPromise(
			startClient({ preSubscribed: ["BTC"] }),
		);
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();
		expect(await Effect.runPromise(service.hasError())).toBe(false);

		ws.triggerClose();
		await flush();

		expect(await Effect.runPromise(service.hasError())).toBe(true);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("ignores non-json frames and payloads with no key", async () => {
		const { cache, fiber } = await Effect.runPromise(
			startClient({ preSubscribed: ["BTC"] }),
		);
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();

		ws.triggerMessage(JSON.stringify({ result: null, id: 1 }));
		ws.triggerMessage("not json");
		await flush();

		expect(cache.size()).toBe(0);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("subscribe is idempotent: a duplicate key sends no extra frame", async () => {
		const { ws: service, fiber } = await Effect.runPromise(
			startClient({ preSubscribed: ["BTC"] }),
		);
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();
		expect(ws.sent.length).toBe(1);

		await Effect.runPromise(service.subscribe(["BTC"]));
		await Effect.runPromise(service.subscribe(["BTC"]));
		await flush();

		expect(ws.sent.length).toBe(1);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("subscribe batches multiple new keys into one frame", async () => {
		const { ws: service, fiber } = await Effect.runPromise(
			startClient({ preSubscribed: [] }),
		);
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();
		expect(ws.sent.length).toBe(0);

		await Effect.runPromise(service.subscribe(["BTC", "ETH", "SOL"]));
		await flush();

		expect(ws.sent.length).toBe(1);
		expect(parseControl(ws.sent[0])).toEqual({
			op: "subscribe",
			keys: ["BTC", "ETH", "SOL"],
		});

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("unsubscribe removes the key and sends an unsubscribe frame", async () => {
		const { ws: service, fiber } = await Effect.runPromise(
			startClient({ preSubscribed: ["BTC"] }),
		);
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();
		expect(ws.sent.length).toBe(1);

		await Effect.runPromise(service.unsubscribe(["ETH"]));
		await flush();
		expect(ws.sent.length).toBe(1);

		await Effect.runPromise(service.unsubscribe(["BTC"]));
		await flush();
		expect(ws.sent.length).toBe(2);
		expect(parseControl(ws.sent[1])).toEqual({
			op: "unsubscribe",
			keys: ["BTC"],
		});

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("reconnects after a close, producing a second WebSocket instance", async () => {
		const { ws: service, fiber } = await Effect.runPromise(
			startClient({
				preSubscribed: ["BTC"],
				reconnectSchedule: Schedule.spaced(Duration.millis(10)),
			}),
		);
		await flush();

		expect(FakeWebSocket.instances.length).toBe(1);
		const ws1 = FakeWebSocket.instances[0];
		ws1.triggerOpen();
		await flush();

		ws1.triggerClose();
		await new Promise<void>((r) => setTimeout(r, 40));

		expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
		const ws2 = FakeWebSocket.instances[1];
		expect(ws2).not.toBe(ws1);

		ws2.triggerOpen();
		await flush();
		expect(await Effect.runPromise(service.hasError())).toBe(false);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("resubscribes desired keys after reconnect", async () => {
		const { fiber } = await Effect.runPromise(
			startClient({
				preSubscribed: ["btc", "eth"],
				reconnectSchedule: Schedule.spaced(Duration.millis(10)),
			}),
		);
		await flush();

		const ws1 = FakeWebSocket.instances[0];
		ws1.triggerOpen();
		await flush();
		expect(parseControl(ws1.sent[0])).toEqual({
			op: "subscribe",
			keys: ["BTC", "ETH"],
		});

		ws1.triggerClose();
		await new Promise<void>((r) => setTimeout(r, 40));

		const ws2 = FakeWebSocket.instances[1];
		ws2.triggerOpen();
		await flush();
		expect(parseControl(ws2.sent[0])).toEqual({
			op: "subscribe",
			keys: ["BTC", "ETH"],
		});

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("recovers from a send error by closing the socket and reconnecting", async () => {
		FakeWebSocket.sendImpl = (instance, data) => {
			if (FakeWebSocket.instances.indexOf(instance) === 0) {
				throw new Error("send-blew-up");
			}
			instance.sent.push(data);
		};

		const { ws: service, fiber } = await Effect.runPromise(
			startClient({
				preSubscribed: ["BTC"],
				reconnectSchedule: Schedule.spaced(Duration.millis(10)),
			}),
		);
		await flush();

		const ws1 = FakeWebSocket.instances[0];
		ws1.triggerOpen();
		await flush();

		await new Promise<void>((r) => setTimeout(r, 40));
		expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
		const ws2 = FakeWebSocket.instances[1];
		ws2.triggerOpen();
		await flush();

		expect(parseControl(ws2.sent[0])).toEqual({
			op: "subscribe",
			keys: ["BTC"],
		});
		expect(await Effect.runPromise(service.hasError())).toBe(false);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("paces outbound frames to stay under maxMessages per maxMessagesWindow", async () => {
		const { ws: service, fiber } = await Effect.runPromise(
			startClient({
				preSubscribed: [],
				maxMessages: 2,
				maxMessagesWindow: Duration.millis(80),
			}),
		);
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();

		await Effect.runPromise(service.subscribe(["BTC"]));
		await Effect.runPromise(service.subscribe(["ETH"]));
		await Effect.runPromise(service.subscribe(["SOL"]));
		await Effect.runPromise(service.subscribe(["DOGE"]));
		await Effect.runPromise(service.subscribe(["XRP"]));
		await flush();

		expect(ws.sent.length).toBe(2);
		await new Promise<void>((r) => setTimeout(r, 40));
		expect(ws.sent.length).toBe(2);

		await new Promise<void>((r) => setTimeout(r, 80));
		expect(ws.sent.length).toBe(4);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("sends keepalive out of band when configured", async () => {
		const { fiber } = await Effect.runPromise(
			startClient({ keepaliveInterval: Duration.millis(30) }),
		);
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();

		await new Promise<void>((r) => setTimeout(r, 80));
		expect(ws.sent.some((raw) => raw === "ping")).toBe(true);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("does not send keepalive when it is omitted", async () => {
		const { fiber } = await Effect.runPromise(startClient());
		await flush();
		const ws = FakeWebSocket.instances[0];
		ws.triggerOpen();
		await flush();

		await new Promise<void>((r) => setTimeout(r, 40));
		expect(ws.sent.some((raw) => raw === "ping")).toBe(false);

		await Effect.runPromise(Fiber.interrupt(fiber));
	});
});
