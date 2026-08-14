import { describe, expect, it, mock } from "bun:test";
import type { JsonOrBinaryResponse } from "@pythnetwork/pyth-lazer-sdk";
import {
	Duration,
	Effect,
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

const route = v.parse(PythLazerModuleRouteSchema, {
	type: "pyth-lazer",
	moduleName: "pyth",
	path: "/price/:symbols",
	method: ["GET"],
	fetchFromModule: "{:symbols}",
});

const requestSymbols = (symbols: string) =>
	[route, { symbols }, new Request("http://localhost/")] as const;

interface FakeClientOptions {
	/** Push a price for every feed id as soon as it is subscribed. `"individuals"`
	 * only auto-delivers one-feed subscriptions so bulk first-tick waits stay open. */
	autoDeliver?: boolean | "individuals";
}

const makeFakeLazerClient = (options: FakeClientOptions = {}) => {
	const subscribeCalls: Array<{
		subscriptionId: number;
		priceFeedIds: number[];
	}> = [];
	const unsubscribeCalls: number[] = [];
	let messageListener: ((event: JsonOrBinaryResponse) => void) | undefined;

	const deliverTick = (subscriptionId: number, priceFeedIds: number[]) => {
		messageListener?.({
			type: "json",
			value: {
				type: "streamUpdated",
				subscriptionId,
				parsed: {
					timestampUs: "0",
					priceFeeds: priceFeedIds.map((priceFeedId) => ({
						priceFeedId,
						price: `${priceFeedId * 100}`,
					})),
				},
			},
		});
	};

	const shouldAutoDeliver = (priceFeedIds: number[]) => {
		if (options.autoDeliver === true) {
			return true;
		}
		if (options.autoDeliver === "individuals") {
			return priceFeedIds.length === 1;
		}
		return false;
	};

	const client = {
		subscribe(request: {
			type: string;
			subscriptionId: number;
			priceFeedIds?: number[];
		}) {
			if (request.type !== "subscribe") {
				return;
			}
			const priceFeedIds = request.priceFeedIds ?? [];
			subscribeCalls.push({
				subscriptionId: request.subscriptionId,
				priceFeedIds,
			});
			if (shouldAutoDeliver(priceFeedIds)) {
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
		async getSymbols() {
			return [];
		},
	};

	return {
		client,
		deliverTick,
		subscribeCalls,
		unsubscribeCalls,
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

describe("bulk subscription consolidation", () => {
	it("absorbs delivered individual subscriptions into one bulk subscription", async () => {
		const fake = makeFakeLazerClient({ autoDeliver: true });
		fakeHolder.current = fake;

		await runWithTestClock(
			Effect.gen(function* () {
				const module = yield* ModuleService;
				yield* module.start();
				yield* TestClock.adjust(Duration.millis(0));

				expect(fake.subscribeCalls).toHaveLength(2);
				const individualIds = fake.subscribeCalls.map((c) => c.subscriptionId);

				yield* TestClock.adjust(Duration.seconds(60));

				expect(fake.subscribeCalls).toHaveLength(3);
				const bulk = fake.subscribeCalls[2];
				expect(sorted(bulk.priceFeedIds)).toEqual([1, 2]);
				expect(sorted(fake.unsubscribeCalls)).toEqual(sorted(individualIds));
			}).pipe(
				Effect.provide(
					PythLazerModuleService(
						makeConfig({
							priceFeedIds: [
								{ name: "BTC/USD", id: 1 },
								{ name: "ETH/USD", id: 2 },
							],
						}),
					),
				),
			),
		);
	});

	it("never absorbs a feed that has not delivered an update", async () => {
		const fake = makeFakeLazerClient({ autoDeliver: false });
		fakeHolder.current = fake;

		await runWithTestClock(
			Effect.gen(function* () {
				const module = yield* ModuleService;
				yield* module.start();
				yield* TestClock.adjust(Duration.millis(0));
				expect(fake.subscribeCalls).toHaveLength(2);

				const good = fake.subscribeCalls.find((c) =>
					c.priceFeedIds.includes(1),
				);
				expect(good).toBeDefined();
				// Only deliver tick for feed 1.
				fake.deliverTick(good?.subscriptionId ?? -1, [1]);

				yield* TestClock.adjust(Duration.seconds(60));
				expect(fake.subscribeCalls).toHaveLength(3);
				expect(fake.subscribeCalls[2].priceFeedIds).toEqual([1]);

				fake.deliverTick(
					fake.subscribeCalls[2].subscriptionId,
					fake.subscribeCalls[2].priceFeedIds,
				);
				yield* TestClock.adjust(Duration.millis(0));

				const badIndividualId = fake.subscribeCalls.find((c) =>
					c.priceFeedIds.includes(2),
				)?.subscriptionId;
				expect(badIndividualId).toBeDefined();
				expect(fake.unsubscribeCalls).not.toContain(badIndividualId);
			}).pipe(
				Effect.provide(
					PythLazerModuleService(
						makeConfig({
							priceFeedIds: [
								{ name: "GOOD/USD", id: 1 },
								{ name: "BAD/USD", id: 2 },
							],
						}),
					),
				),
			),
		);
	});

	it("unsubscribes an individual subscription re-created while waiting for the bulk first tick", async () => {
		const fake = makeFakeLazerClient({ autoDeliver: "individuals" });
		fakeHolder.current = fake;

		await runWithTestClock(
			Effect.gen(function* () {
				const module = yield* ModuleService;
				yield* module.start();
				yield* TestClock.adjust(Duration.millis(0));
				expect(fake.subscribeCalls).toHaveLength(2);

				// Keep feed 1 fresh so only feed 2 churns while waiting for the first tick
				yield* TestClock.adjust(Duration.seconds(55));
				yield* module.handleRequest(...requestSymbols("1"));

				// Consolidation fires at 60s and parks until the bulk subscription ticks
				yield* TestClock.adjust(Duration.seconds(5));
				expect(fake.subscribeCalls).toHaveLength(3);
				expect(sorted(fake.subscribeCalls[2].priceFeedIds)).toEqual([1, 2]);
				const bulkId = fake.subscribeCalls[2].subscriptionId;

				// Feed 2 idles out (cleanup unsubscribes its individual sub), then a
				// new request re-subscribes it fresh while the bulk first-tick wait is open
				yield* TestClock.adjust(Duration.seconds(6));
				yield* module.handleRequest(...requestSymbols("2"));
				yield* TestClock.adjust(Duration.millis(0));
				expect(fake.subscribeCalls).toHaveLength(4);
				const reCreatedId = fake.subscribeCalls[3].subscriptionId;
				expect(fake.subscribeCalls[3].priceFeedIds).toEqual([2]);

				// First tick: the bulk now supersedes the re-created individual sub
				fake.deliverTick(bulkId, [1, 2]);
				yield* TestClock.adjust(Duration.millis(0));
				expect(fake.unsubscribeCalls).toContain(reCreatedId);
			}).pipe(
				Effect.provide(
					PythLazerModuleService(
						makeConfig({
							priceFeedIds: [
								{ name: "FRESH/USD", id: 1 },
								{ name: "CHURN/USD", id: 2 },
							],
							bulkConsolidateInterval: "60 seconds",
							bulkConsolidateTimeout: "20 seconds",
							priceFeedsCleanupTtl: "62 seconds",
							priceFeedsCleanupInterval: "5 seconds",
						}),
					),
				),
			),
		);
	});

	it("drops an idle feed from the bulk subscription without tearing the bulk down", async () => {
		const fake = makeFakeLazerClient({ autoDeliver: true });
		fakeHolder.current = fake;

		await runWithTestClock(
			Effect.gen(function* () {
				const module = yield* ModuleService;
				yield* module.start();
				yield* TestClock.adjust(Duration.millis(0));

				yield* TestClock.adjust(Duration.seconds(60));
				expect(fake.subscribeCalls).toHaveLength(3);
				const firstBulkId = fake.subscribeCalls[2].subscriptionId;

				// Keep feed 1 fresh, let feed 2 idle past the 2 minute TTL
				yield* TestClock.adjust(Duration.seconds(30));
				yield* module.handleRequest(...requestSymbols("1"));
				yield* TestClock.adjust(Duration.seconds(95));

				const rebuilt = fake.subscribeCalls.at(-1);
				expect(rebuilt).toBeDefined();
				expect(rebuilt?.priceFeedIds).toEqual([1]);
				expect(fake.unsubscribeCalls).toContain(firstBulkId);

				const unsubscribedBeforeRebuild = fake.unsubscribeCalls.slice(
					0,
					fake.unsubscribeCalls.indexOf(firstBulkId),
				);
				expect(unsubscribedBeforeRebuild).not.toContain(firstBulkId);
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
});
