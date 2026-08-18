import { describe, expect, it, mock } from "bun:test";
import type { JsonOrBinaryResponse } from "@pythnetwork/pyth-lazer-sdk";
import {
	Duration,
	Effect,
	Fiber,
	LogLevel,
	Logger,
	TestClock,
	TestContext,
} from "effect";
import * as v from "valibot";
import {
	PythLazerModuleConfigSchema,
	PythLazerModuleRouteSchema,
} from "../../config/pyth-lazer-module-config";
import { HAS_PRICE_KEY } from "../../constants";
import { ModuleService } from "../module";
import { pythLazerErrorMessage, redactPythLazerSecrets } from "./errors";

const fakeHolder: { current?: ReturnType<typeof makeFakeLazerClient> } = {};

mock.module("@pythnetwork/pyth-lazer-sdk", () => ({
	PythLazerClient: {
		create: async () => {
			if (fakeHolder.current === undefined) {
				throw new Error("Fake Lazer client was not installed");
			}
			return fakeHolder.current.client;
		},
	},
}));

const {
	channelFromSubscriptionKey,
	isU32PriceFeedId,
	lagMsFromTimestampUs,
	priceFeedSubscriptionKey,
	PythLazerModuleService,
} = await import("./pyth-lazer");

const makeConfig = (
	overrides: Partial<v.InferInput<typeof PythLazerModuleConfigSchema>> = {},
) => ({
	...v.parse(PythLazerModuleConfigSchema, {
		name: "pyth",
		type: "pyth-lazer",
		priceFeedIds: [],
		pythLazerApiKeyEnvKey: "PYTH_LAZER_API_KEY",
		...overrides,
	}),
	pythLazerApiKey: "test-api-key",
});

const route200ms = v.parse(PythLazerModuleRouteSchema, {
	type: "pyth-lazer",
	moduleName: "pyth",
	path: "/price/:symbols",
	method: ["GET"],
	fetchFromModule: "{:symbols}",
});

const routeRealtime = v.parse(PythLazerModuleRouteSchema, {
	type: "pyth-lazer",
	moduleName: "pyth",
	path: "/realtime/:symbols",
	method: ["GET"],
	fetchFromModule: "{:symbols}",
	channel: "real_time",
});

const requestOn = (route: typeof route200ms, symbols: string) =>
	[route, { symbols }, new Request("http://localhost/")] as const;

interface FakeClientOptions {
	/** Push a price for every feed id as soon as it is subscribed. */
	autoDeliver?: boolean;
}

const makeFakeLazerClient = (options: FakeClientOptions = {}) => {
	const subscribeCalls: Array<{
		subscriptionId: number;
		channel: string;
		priceFeedIds: number[];
	}> = [];
	const unsubscribeCalls: number[] = [];
	let messageListener: ((event: JsonOrBinaryResponse) => void) | undefined;
	const symbols: Array<{ symbol: string; pyth_lazer_id: number }> = [
		{ symbol: "Crypto.BTC/USD", pyth_lazer_id: 1 },
	];

	const emitJson = (value: object) => {
		messageListener?.({ type: "json", value } as JsonOrBinaryResponse);
	};

	const deliverTick = (subscriptionId: number, priceFeedIds: number[]) => {
		emitJson({
			type: "streamUpdated",
			subscriptionId,
			parsed: {
				timestampUs: "0",
				priceFeeds: priceFeedIds.map((priceFeedId) => ({
					priceFeedId,
					price: `${priceFeedId * 100}`,
				})),
			},
		});
	};

	const ack = (subscriptionId: number) => {
		emitJson({ type: "subscribed", subscriptionId });
	};

	const ackWithInvalidIgnored = (subscriptionId: number) => {
		emitJson({
			type: "subscribedWithInvalidFeedIdsIgnored",
			subscriptionId,
			subscribedFeedIds: [],
			ignoredInvalidFeedIds: [],
		} as never);
	};

	const ackError = (subscriptionId: number, error = "rejected") => {
		emitJson({ type: "subscriptionError", subscriptionId, error });
	};

	const client = {
		async getSymbols(request: { query: string }) {
			return symbols.filter((entry) => entry.symbol === request.query);
		},
		subscribe(request: {
			type: string;
			subscriptionId: number;
			channel: string;
			priceFeedIds?: number[];
		}) {
			if (request.type !== "subscribe") {
				return;
			}
			const priceFeedIds = request.priceFeedIds ?? [];
			subscribeCalls.push({
				subscriptionId: request.subscriptionId,
				channel: request.channel,
				priceFeedIds,
			});
			if (options.autoDeliver) {
				deliverTick(request.subscriptionId, priceFeedIds);
			}
		},
		unsubscribe(subscriptionId: number) {
			unsubscribeCalls.push(subscriptionId);
		},
		addMessageListener(handler: (event: JsonOrBinaryResponse) => void) {
			messageListener = handler;
		},
		addAllConnectionsDownListener() {},
		addConnectionTimeoutListener() {},
	};

	return {
		client,
		subscribeCalls,
		unsubscribeCalls,
		deliverTick,
		ack,
		ackWithInvalidIgnored,
		ackError,
	};
};

const silenceLogs = Logger.withMinimumLogLevel(LogLevel.None);

const runWithTestClock = <A, E>(effect: Effect.Effect<A, E, never>) =>
	Effect.runPromise(
		effect.pipe(Effect.provide(TestContext.TestContext), silenceLogs),
	);

const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);

describe("lagMsFromTimestampUs", () => {
	it("returns lag in ms from a microsecond timestamp", () => {
		const nowMs = 1_700_000_000_500;
		const timestampUs = (nowMs - 250) * 1000;

		expect(lagMsFromTimestampUs(nowMs, timestampUs)).toBe(250);
	});

	it("accepts string timestamps", () => {
		const nowMs = 1_700_000_000_500;
		const timestampUs = String((nowMs - 100) * 1000);

		expect(lagMsFromTimestampUs(nowMs, timestampUs)).toBe(100);
	});

	it("returns undefined for missing or invalid timestamps", () => {
		expect(lagMsFromTimestampUs(1_000, undefined)).toBeUndefined();
		expect(lagMsFromTimestampUs(1_000, "not-a-number")).toBeUndefined();
	});
});

describe("isU32PriceFeedId", () => {
	it("accepts integers from 0 through 2^32 - 1", () => {
		expect(isU32PriceFeedId(0)).toBe(true);
		expect(isU32PriceFeedId(1)).toBe(true);
		expect(isU32PriceFeedId(0xffff_ffff)).toBe(true);
	});

	it("rejects negatives, fractions, and values above 2^32 - 1", () => {
		expect(isU32PriceFeedId(-1)).toBe(false);
		expect(isU32PriceFeedId(1.5)).toBe(false);
		expect(isU32PriceFeedId(0x1_0000_0000)).toBe(false);
		expect(isU32PriceFeedId(Number.POSITIVE_INFINITY)).toBe(false);
		expect(isU32PriceFeedId(Number.NaN)).toBe(false);
	});
});

describe("priceFeedSubscriptionKey", () => {
	it("formats as channel:feedId", () => {
		expect(priceFeedSubscriptionKey(1, "fixed_rate@200ms")).toBe(
			"fixed_rate@200ms:1",
		);
	});

	it("isolates the same feed across different channels", () => {
		expect(priceFeedSubscriptionKey(1, "fixed_rate@50ms")).not.toBe(
			priceFeedSubscriptionKey(1, "fixed_rate@200ms"),
		);
	});

	it("isolates different feeds on the same channel", () => {
		expect(priceFeedSubscriptionKey(1, "real_time")).not.toBe(
			priceFeedSubscriptionKey(2, "real_time"),
		);
	});
});

describe("channelFromSubscriptionKey", () => {
	it("reads the channel from a subscription key", () => {
		expect(channelFromSubscriptionKey("fixed_rate@200ms:12")).toBe(
			"fixed_rate@200ms",
		);
	});
});

describe("redactPythLazerSecrets", () => {
	it("keeps the WebSocket host/path and redacts ACCESS_TOKEN", () => {
		const message =
			"WebSocket connection to 'wss://pyth-lazer-x.dourolabs.app/v1/stream?ACCESS_TOKEN=secret-token' failed: Failed to connect";

		expect(redactPythLazerSecrets(message)).toBe(
			"WebSocket connection to 'wss://pyth-lazer-x.dourolabs.app/v1/stream?ACCESS_TOKEN=<redacted>' failed: Failed to connect",
		);
	});

	it("redacts Bearer tokens and raw api key values", () => {
		const apiKey = "raw-api-key-value";
		expect(redactPythLazerSecrets(`Authorization: Bearer ${apiKey}`)).toBe(
			"Authorization: Bearer <redacted>",
		);
	});
});

describe("pythLazerErrorMessage", () => {
	it("reads message from ErrorEvent-like objects", () => {
		expect(
			pythLazerErrorMessage({
				message:
					"WebSocket connection to 'wss://example/v1/stream' failed: Failed to connect",
			}),
		).toBe(
			"WebSocket connection to 'wss://example/v1/stream' failed: Failed to connect",
		);
	});
});

describe("bulk subscriptions", () => {
	it("subscribes once per channel on start with the full desired set", async () => {
		const fake = makeFakeLazerClient();
		fakeHolder.current = fake;

		await runWithTestClock(
			Effect.gen(function* () {
				const module = yield* ModuleService;
				yield* module.start();

				expect(fake.subscribeCalls).toHaveLength(2);
				const byChannel = Object.fromEntries(
					fake.subscribeCalls.map((call) => [
						call.channel,
						sorted(call.priceFeedIds),
					]),
				);
				expect(byChannel["fixed_rate@200ms"]).toEqual([1]);
				expect(byChannel.real_time).toEqual([2, 3]);
			}).pipe(
				Effect.provide(
					PythLazerModuleService(
						makeConfig({
							priceFeedIds: [
								{ name: "BTC/USD", id: 1 },
								{ name: "ETH/USD", id: 2, channel: "real_time" },
								{ name: "SOL/USD", id: 3, channel: "real_time" },
							],
						}),
					),
				),
			),
		);
	});

	it("sends a full-set bulk when a request adds a new feed", async () => {
		const fake = makeFakeLazerClient();
		fakeHolder.current = fake;

		await runWithTestClock(
			Effect.gen(function* () {
				const module = yield* ModuleService;
				yield* module.start();
				expect(fake.subscribeCalls).toHaveLength(1);
				expect(sorted(fake.subscribeCalls[0].priceFeedIds)).toEqual([1]);

				const responseFiber = yield* Effect.fork(
					module.handleRequest(...requestOn(route200ms, "1,2")),
				);
				yield* TestClock.adjust(Duration.millis(0));
				expect(fake.subscribeCalls).toHaveLength(2);
				expect(sorted(fake.subscribeCalls[1].priceFeedIds)).toEqual([1, 2]);

				fake.deliverTick(fake.subscribeCalls[1].subscriptionId, [1, 2]);
				const response = yield* Fiber.join(responseFiber);
				const body = yield* Effect.promise(() => response.json());
				expect(body).toEqual([
					{
						priceFeedId: 1,
						price: "100",
						symbol: "1",
						[HAS_PRICE_KEY]: true,
					},
					{
						priceFeedId: 2,
						price: "200",
						symbol: "2",
						[HAS_PRICE_KEY]: true,
					},
				]);
			}).pipe(
				Effect.provide(
					PythLazerModuleService(
						makeConfig({
							priceFeedIds: [{ name: "BTC/USD", id: 1 }],
						}),
					),
				),
			),
		);
	});

	it("does not resubscribe when every requested feed is already desired", async () => {
		const fake = makeFakeLazerClient();
		fakeHolder.current = fake;

		await runWithTestClock(
			Effect.gen(function* () {
				const module = yield* ModuleService;
				yield* module.start();
				fake.deliverTick(fake.subscribeCalls[0].subscriptionId, [1]);

				yield* module.handleRequest(...requestOn(route200ms, "1"));
				expect(fake.subscribeCalls).toHaveLength(1);
			}).pipe(
				Effect.provide(
					PythLazerModuleService(
						makeConfig({
							priceFeedIds: [{ name: "BTC/USD", id: 1 }],
						}),
					),
				),
			),
		);
	});

	it("promotes a higher ack and unsubscribes older ids on the same channel only", async () => {
		const fake = makeFakeLazerClient();
		fakeHolder.current = fake;

		await runWithTestClock(
			Effect.gen(function* () {
				const module = yield* ModuleService;
				yield* module.start();

				const realtimeId = fake.subscribeCalls.find(
					(call) => call.channel === "real_time",
				)?.subscriptionId;
				const first200ms = fake.subscribeCalls.find(
					(call) => call.channel === "fixed_rate@200ms",
				)?.subscriptionId;
				expect(realtimeId).toBeDefined();
				expect(first200ms).toBeDefined();

				const responseFiber = yield* Effect.fork(
					module.handleRequest(...requestOn(route200ms, "2")),
				);
				yield* TestClock.adjust(Duration.millis(0));
				const second200ms = fake.subscribeCalls.find(
					(call) =>
						call.channel === "fixed_rate@200ms" &&
						call.subscriptionId !== first200ms,
				)?.subscriptionId;
				expect(second200ms).toBeDefined();
				expect(second200ms).not.toBe(first200ms);
				if (
					realtimeId === undefined ||
					first200ms === undefined ||
					second200ms === undefined
				) {
					throw new Error("expected subscription ids");
				}

				fake.ack(second200ms);
				expect(fake.unsubscribeCalls).toEqual([first200ms]);
				expect(fake.unsubscribeCalls).not.toContain(realtimeId);

				fake.deliverTick(second200ms, [1, 2]);
				yield* Fiber.join(responseFiber);
			}).pipe(
				Effect.provide(
					PythLazerModuleService(
						makeConfig({
							priceFeedIds: [
								{ name: "BTC/USD", id: 1 },
								{ name: "ETH/USD", id: 2, channel: "real_time" },
							],
						}),
					),
				),
			),
		);
	});

	it("ignores a late lower-id ack after a higher id is already active", async () => {
		const fake = makeFakeLazerClient();
		fakeHolder.current = fake;

		await runWithTestClock(
			Effect.gen(function* () {
				const module = yield* ModuleService;
				yield* module.start();
				const first = fake.subscribeCalls[0].subscriptionId;

				const responseFiber = yield* Effect.fork(
					module.handleRequest(...requestOn(route200ms, "2")),
				);
				yield* TestClock.adjust(Duration.millis(0));
				const second = fake.subscribeCalls[1].subscriptionId;

				fake.ack(second);
				expect(fake.unsubscribeCalls).toEqual([first]);

				fake.ack(first);
				expect(fake.unsubscribeCalls).toEqual([first]);

				fake.deliverTick(second, [1, 2]);
				yield* Fiber.join(responseFiber);
			}).pipe(
				Effect.provide(
					PythLazerModuleService(
						makeConfig({
							priceFeedIds: [{ name: "BTC/USD", id: 1 }],
						}),
					),
				),
			),
		);
	});

	it("treats subscribedWithInvalidFeedIdsIgnored as a successful ack", async () => {
		const fake = makeFakeLazerClient();
		fakeHolder.current = fake;

		await runWithTestClock(
			Effect.gen(function* () {
				const module = yield* ModuleService;
				yield* module.start();
				const first = fake.subscribeCalls[0].subscriptionId;

				const responseFiber = yield* Effect.fork(
					module.handleRequest(...requestOn(route200ms, "2")),
				);
				yield* TestClock.adjust(Duration.millis(0));
				const second = fake.subscribeCalls[1].subscriptionId;

				fake.ackWithInvalidIgnored(second);
				expect(fake.unsubscribeCalls).toEqual([first]);

				fake.deliverTick(second, [1, 2]);
				yield* Fiber.join(responseFiber);
			}).pipe(
				Effect.provide(
					PythLazerModuleService(
						makeConfig({
							priceFeedIds: [{ name: "BTC/USD", id: 1 }],
						}),
					),
				),
			),
		);
	});

	it("does not unsubscribe or switch active id on subscriptionError", async () => {
		const fake = makeFakeLazerClient();
		fakeHolder.current = fake;

		await runWithTestClock(
			Effect.gen(function* () {
				const module = yield* ModuleService;
				yield* module.start();
				const first = fake.subscribeCalls[0].subscriptionId;

				const responseFiber = yield* Effect.fork(
					module.handleRequest(...requestOn(route200ms, "2")),
				);
				yield* TestClock.adjust(Duration.millis(0));
				const second = fake.subscribeCalls[1].subscriptionId;

				fake.ackError(second);
				expect(fake.unsubscribeCalls).toEqual([]);

				fake.ack(second);
				expect(fake.unsubscribeCalls).toEqual([]);

				fake.ack(first);
				expect(fake.unsubscribeCalls).toEqual([]);

				yield* Fiber.interrupt(responseFiber);
			}).pipe(
				Effect.provide(
					PythLazerModuleService(
						makeConfig({
							priceFeedIds: [{ name: "BTC/USD", id: 1 }],
						}),
					),
				),
			),
		);
	});

	it("does not resubscribe on idle cleanup; next grow omits the idle feed", async () => {
		const fake = makeFakeLazerClient();
		fakeHolder.current = fake;

		await runWithTestClock(
			Effect.gen(function* () {
				const module = yield* ModuleService;
				yield* module.start();
				const first = fake.subscribeCalls[0].subscriptionId;
				fake.ack(first);
				fake.deliverTick(first, [1, 2]);

				yield* TestClock.adjust(Duration.seconds(30));
				yield* module.handleRequest(...requestOn(route200ms, "1"));

				yield* TestClock.adjust(Duration.seconds(120));
				expect(fake.subscribeCalls).toHaveLength(1);
				expect(fake.unsubscribeCalls).toEqual([]);

				const responseFiber = yield* Effect.fork(
					module.handleRequest(...requestOn(route200ms, "1,3")),
				);
				yield* TestClock.adjust(Duration.millis(0));
				const rebuilt = fake.subscribeCalls.at(-1);
				expect(sorted(rebuilt?.priceFeedIds ?? [])).toEqual([1, 3]);
				expect(fake.unsubscribeCalls).toEqual([]);

				fake.ack(rebuilt?.subscriptionId ?? -1);
				expect(fake.unsubscribeCalls).toEqual([first]);

				fake.deliverTick(rebuilt?.subscriptionId ?? -1, [1, 3]);
				yield* Fiber.join(responseFiber);
			}).pipe(
				Effect.provide(
					PythLazerModuleService(
						makeConfig({
							priceFeedIds: [
								{ name: "FRESH/USD", id: 1 },
								{ name: "IDLE/USD", id: 2 },
							],
							priceFeedsCleanupTtl: "2 minutes",
							priceFeedsCleanupInterval: "30 seconds",
						}),
					),
				),
			),
		);
	});

	it("does not unsubscribe when the last feed idles out", async () => {
		const fake = makeFakeLazerClient();
		fakeHolder.current = fake;

		await runWithTestClock(
			Effect.gen(function* () {
				const module = yield* ModuleService;
				yield* module.start();
				const first = fake.subscribeCalls[0].subscriptionId;
				fake.ack(first);

				yield* TestClock.adjust(Duration.seconds(90));
				expect(fake.unsubscribeCalls).toEqual([]);
				expect(fake.subscribeCalls).toHaveLength(1);
				expect(fake.subscribeCalls[0].subscriptionId).toBe(first);
			}).pipe(
				Effect.provide(
					PythLazerModuleService(
						makeConfig({
							priceFeedIds: [{ name: "BTC/USD", id: 1 }],
							priceFeedsCleanupTtl: "1 minute",
							priceFeedsCleanupInterval: "30 seconds",
						}),
					),
				),
			),
		);
	});

	it("rejects a non-u32 numeric id with 400 and does not subscribe", async () => {
		const fake = makeFakeLazerClient();
		fakeHolder.current = fake;

		await runWithTestClock(
			Effect.gen(function* () {
				const module = yield* ModuleService;
				yield* module.start();
				expect(fake.subscribeCalls).toHaveLength(1);

				for (const token of ["-1", "1.5", "4294967296"]) {
					const response = yield* module.handleRequest(
						...requestOn(route200ms, `1,${token}`),
					);
					expect(response.status).toBe(400);
					const body = yield* Effect.promise(() => response.json());
					expect(body.data_proxy_error).toContain("not a u32");
					expect(body.data_proxy_error).toContain(token);
				}

				expect(fake.subscribeCalls).toHaveLength(1);
				expect(sorted(fake.subscribeCalls[0].priceFeedIds)).toEqual([1]);
			}).pipe(
				Effect.provide(
					PythLazerModuleService(
						makeConfig({
							priceFeedIds: [{ name: "BTC/USD", id: 1 }],
						}),
					),
				),
			),
		);
	});

	it("resolves a non-numeric symbol via metadata", async () => {
		const fake = makeFakeLazerClient();
		fakeHolder.current = fake;

		await runWithTestClock(
			Effect.gen(function* () {
				const module = yield* ModuleService;
				yield* module.start();
				fake.deliverTick(fake.subscribeCalls[0].subscriptionId, [1]);

				const response = yield* module.handleRequest(
					...requestOn(route200ms, "Crypto.BTC/USD"),
				);
				const body = yield* Effect.promise(() => response.json());
				expect(body[0].priceFeedId).toBe(1);
				expect(body[0][HAS_PRICE_KEY]).toBe(true);
			}).pipe(
				Effect.provide(
					PythLazerModuleService(
						makeConfig({
							priceFeedIds: [{ name: "BTC/USD", id: 1 }],
						}),
					),
				),
			),
		);
	});

	it("keeps realtime and 200ms bulks independent", async () => {
		const fake = makeFakeLazerClient();
		fakeHolder.current = fake;

		await runWithTestClock(
			Effect.gen(function* () {
				const module = yield* ModuleService;
				yield* module.start();
				expect(fake.subscribeCalls).toHaveLength(0);

				const realtimeFiber = yield* Effect.fork(
					module.handleRequest(...requestOn(routeRealtime, "1")),
				);
				yield* TestClock.adjust(Duration.millis(0));
				expect(fake.subscribeCalls[0].channel).toBe("real_time");
				expect(fake.subscribeCalls[0].priceFeedIds).toEqual([1]);

				const msFiber = yield* Effect.fork(
					module.handleRequest(...requestOn(route200ms, "1")),
				);
				yield* TestClock.adjust(Duration.millis(0));
				expect(fake.subscribeCalls[1].channel).toBe("fixed_rate@200ms");
				expect(fake.subscribeCalls[1].priceFeedIds).toEqual([1]);

				fake.deliverTick(fake.subscribeCalls[0].subscriptionId, [1]);
				fake.deliverTick(fake.subscribeCalls[1].subscriptionId, [1]);
				yield* Fiber.join(realtimeFiber);
				yield* Fiber.join(msFiber);
			}).pipe(Effect.provide(PythLazerModuleService(makeConfig()))),
		);
	});
});

describe("handleRequest symbol resolution", () => {
	it("resolves unknown symbols concurrently", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const fake = makeFakeLazerClient({ autoDeliver: true });
		fake.client.getSymbols = async ({ query }) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 40);
			});
			inFlight--;
			const pyth_lazer_id = query === "Crypto.BTC/USD" ? 1 : 2;
			return [{ symbol: query, pyth_lazer_id }];
		};
		fakeHolder.current = fake;

		await runWithTestClock(
			Effect.gen(function* () {
				const module = yield* ModuleService;
				yield* module.start();
				const response = yield* module.handleRequest(
					...requestOn(route200ms, "Crypto.BTC/USD,Crypto.ETH/USD"),
				);
				expect(response.status).toBe(200);
				expect(maxInFlight).toBe(2);
			}).pipe(Effect.provide(PythLazerModuleService(makeConfig()))),
		);
	});
});
