import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Duration, Effect, Fiber, LogLevel, Logger, Schedule } from "effect";
import {
	FakeWebSocket,
	installFakeWebSocket,
} from "./fake-websocket.test-helpers";
import { createPriceCache } from "./price-cache";
import { createVenueWS } from "./venue-ws";

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

let restoreWebSocket: (() => void) | undefined;

beforeEach(() => {
	restoreWebSocket = installFakeWebSocket();
});

afterEach(() => {
	restoreWebSocket?.();
});

const startClient = (options?: {
	keepaliveInterval?: Duration.Duration;
	maxMessagesPerSecond?: number;
	reconnectSchedule?: Schedule.Schedule<unknown, unknown, never>;
	preSubscribed?: string[];
}) =>
	Effect.gen(function* () {
		const cache = yield* createPriceCache<string, string>();
		const ws = yield* createVenueWS({
			venue: "venue",
			config: {
				name: "venue-test",
				wsUrl: "wss://example.test/ws",
				maxMessagesPerSecond: options?.maxMessagesPerSecond ?? 5,
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
			parseInboundFrame: () => null,
		});
		if (options?.preSubscribed !== undefined) {
			yield* ws.subscribe(options.preSubscribed);
		}
		const fiber = yield* ws.start();
		return { ws, fiber };
	}).pipe(Logger.withMinimumLogLevel(LogLevel.None));

describe("createVenueWS", () => {
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
		expect(JSON.parse(ws1.sent[0])).toEqual({
			op: "subscribe",
			keys: ["BTC", "ETH"],
		});

		ws1.triggerClose();
		await new Promise<void>((r) => setTimeout(r, 40));

		const ws2 = FakeWebSocket.instances[1];
		ws2.triggerOpen();
		await flush();
		expect(JSON.parse(ws2.sent[0])).toEqual({
			op: "subscribe",
			keys: ["BTC", "ETH"],
		});

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
