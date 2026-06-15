import { describe, expect, it } from "bun:test";
import type {
	JsonOrBinaryResponse,
	SymbolResponse,
} from "@pythnetwork/pyth-lazer-sdk";
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
import { type LazerClient, makePythLazerModule } from "./pyth-lazer";

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

interface FakeClientOptions {
	/** symbol -> price feed id served by getSymbols */
	symbolTable?: Record<string, number>;
	/** real-time delay per getSymbols call */
	symbolLookupDelayMs?: number;
	/** push a price for every feed id as soon as it is subscribed */
	autoDeliver?: boolean;
}

const makeFakeLazerClient = (options: FakeClientOptions = {}) => {
	const subscribeCalls: Array<{
		subscriptionId: number;
		priceFeedIds: number[];
	}> = [];
	const unsubscribeCalls: number[] = [];
	const symbolLookups: string[] = [];
	let inFlightLookups = 0;
	let maxInFlightLookups = 0;
	let messageListener: ((event: JsonOrBinaryResponse) => void) | undefined;

	const deliverPrice = (priceFeedIds: number[]) => {
		messageListener?.({
			type: "json",
			value: {
				type: "streamUpdated",
				subscriptionId: 0,
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

	const client: LazerClient = {
		subscribe(request) {
			if (request.type !== "subscribe") {
				return;
			}
			const priceFeedIds = request.priceFeedIds ?? [];
			subscribeCalls.push({
				subscriptionId: request.subscriptionId,
				priceFeedIds,
			});
			if (options.autoDeliver) {
				deliverPrice(priceFeedIds);
			}
		},
		unsubscribe(subscriptionId) {
			unsubscribeCalls.push(subscriptionId);
		},
		addMessageListener(handler) {
			messageListener = handler;
		},
		addAllConnectionsDownListener() {},
		async getSymbols(params) {
			const query = params?.query ?? "";
			symbolLookups.push(query);
			inFlightLookups++;
			maxInFlightLookups = Math.max(maxInFlightLookups, inFlightLookups);
			await new Promise((resolve) =>
				setTimeout(resolve, options.symbolLookupDelayMs ?? 0),
			);
			inFlightLookups--;
			const id = options.symbolTable?.[query];
			if (id === undefined) {
				return [];
			}
			return [{ symbol: query, pyth_lazer_id: id } as SymbolResponse];
		},
	};

	return {
		client,
		deliverPrice,
		subscribeCalls,
		unsubscribeCalls,
		symbolLookups,
		maxInFlightLookups: () => maxInFlightLookups,
	};
};

const silenceLogs = Logger.withMinimumLogLevel(LogLevel.None);

const runLive = <A, E>(effect: Effect.Effect<A, E, never>) =>
	Effect.runPromise(effect.pipe(silenceLogs));

const runWithTestClock = <A, E>(effect: Effect.Effect<A, E, never>) =>
	Effect.runPromise(
		effect.pipe(Effect.provide(TestContext.TestContext), silenceLogs),
	);

const requestSymbols = (symbols: string) =>
	[route, { symbols }, new Request("http://localhost/")] as const;

describe("makePythLazerModule", () => {
	it("resolves unknown symbols concurrently instead of one metadata round trip at a time", async () => {
		const fake = makeFakeLazerClient({
			symbolTable: { A: 1, B: 2, C: 3, D: 4, E: 5 },
			symbolLookupDelayMs: 30,
			autoDeliver: true,
		});

		await runLive(
			Effect.gen(function* () {
				const module = yield* makePythLazerModule(makeConfig(), () =>
					Effect.succeed(fake.client),
				);
				yield* module.start();

				const startedAt = performance.now();
				const response = yield* module.handleRequest(
					...requestSymbols("A,B,C,D,E"),
				);
				const elapsedMs = performance.now() - startedAt;

				expect(response.status).toBe(200);
				const body = (yield* Effect.promise(() => response.json())) as Array<{
					priceFeedId: number;
				}>;
				expect(body.map((p) => p.priceFeedId)).toEqual([1, 2, 3, 4, 5]);

				expect(fake.symbolLookups).toHaveLength(5);
				expect(fake.maxInFlightLookups()).toBe(5);
				// Five sequential 30ms lookups would take >=150ms
				expect(elapsedMs).toBeLessThan(100);
			}),
		);
	});

	it("serves symbols listed in the module config without hitting the metadata service", async () => {
		const fake = makeFakeLazerClient({ autoDeliver: true });

		await runLive(
			Effect.gen(function* () {
				const module = yield* makePythLazerModule(
					makeConfig({ priceFeedIds: [{ name: "BTC/USD", id: 1 }] }),
					() => Effect.succeed(fake.client),
				);
				yield* module.start();

				const response = yield* module.handleRequest(
					...requestSymbols("BTC/USD"),
				);

				expect(response.status).toBe(200);
				const body = (yield* Effect.promise(() => response.json())) as Array<{
					priceFeedId: number;
					symbol: string;
				}>;
				expect(body).toHaveLength(1);
				expect(body[0].priceFeedId).toBe(1);
				expect(body[0].symbol).toBe("BTC/USD");
				expect(fake.symbolLookups).toHaveLength(0);
			}),
		);
	});

	it("caches a resolved symbol so repeat requests skip the metadata service", async () => {
		const fake = makeFakeLazerClient({
			symbolTable: { "NVDA/USD": 9 },
			autoDeliver: true,
		});

		await runLive(
			Effect.gen(function* () {
				const module = yield* makePythLazerModule(makeConfig(), () =>
					Effect.succeed(fake.client),
				);
				yield* module.start();

				yield* module.handleRequest(...requestSymbols("NVDA/USD"));
				yield* module.handleRequest(...requestSymbols("NVDA/USD"));

				expect(fake.symbolLookups).toHaveLength(1);
			}),
		);
	});

	it("subscribes a feed once across repeated requests", async () => {
		const fake = makeFakeLazerClient({ autoDeliver: true });

		await runLive(
			Effect.gen(function* () {
				const module = yield* makePythLazerModule(makeConfig(), () =>
					Effect.succeed(fake.client),
				);
				yield* module.start();

				yield* module.handleRequest(...requestSymbols("1"));
				yield* module.handleRequest(...requestSymbols("1"));

				expect(fake.subscribeCalls).toHaveLength(1);
				expect(fake.subscribeCalls[0].priceFeedIds).toEqual([1]);
			}),
		);
	});

	it("re-subscribes a feed after the idle cleanup dropped it", async () => {
		const fake = makeFakeLazerClient({ autoDeliver: true });

		await runWithTestClock(
			Effect.gen(function* () {
				const module = yield* makePythLazerModule(
					makeConfig({
						priceFeedsCleanupTtl: "20 seconds",
						priceFeedsCleanupInterval: "10 seconds",
					}),
					() => Effect.succeed(fake.client),
				);
				yield* module.start();

				const first = yield* module.handleRequest(...requestSymbols("7"));
				expect(first.status).toBe(200);
				expect(fake.subscribeCalls).toHaveLength(1);

				// Cross the TTL (but stay below the first 60s compaction pass)
				// so the cleanup unsubscribes the idle feed
				yield* TestClock.adjust(Duration.seconds(31));
				expect(fake.unsubscribeCalls).toContain(
					fake.subscribeCalls[0].subscriptionId,
				);

				const second = yield* module.handleRequest(...requestSymbols("7"));
				expect(second.status).toBe(200);
				expect(fake.subscribeCalls).toHaveLength(2);
				expect(fake.subscribeCalls[1].priceFeedIds).toEqual([7]);
			}),
		);
	});

	describe("bulk subscription compaction", () => {
		it("absorbs delivered side subscriptions into one bulk subscription", async () => {
			const fake = makeFakeLazerClient({ autoDeliver: true });

			await runWithTestClock(
				Effect.gen(function* () {
					const module = yield* makePythLazerModule(
						makeConfig({
							priceFeedIds: [
								{ name: "BTC/USD", id: 1 },
								{ name: "ETH/USD", id: 2 },
							],
						}),
						() => Effect.succeed(fake.client),
					);
					yield* module.start();
					yield* TestClock.adjust(Duration.millis(0));

					expect(fake.subscribeCalls).toHaveLength(2);
					const sideIds = fake.subscribeCalls.map((c) => c.subscriptionId);

					// One compaction interval plus the make-before-break overlap
					yield* TestClock.adjust(Duration.seconds(62));

					expect(fake.subscribeCalls).toHaveLength(3);
					const bulk = fake.subscribeCalls[2];
					expect([...bulk.priceFeedIds].sort()).toEqual([1, 2]);
					expect(fake.unsubscribeCalls.sort()).toEqual(sideIds.sort());
				}),
			);
		});

		it("never absorbs a feed that has not delivered an update", async () => {
			const fake = makeFakeLazerClient({ autoDeliver: false });

			await runWithTestClock(
				Effect.gen(function* () {
					const module = yield* makePythLazerModule(
						makeConfig({
							priceFeedIds: [
								{ name: "GOOD/USD", id: 1 },
								{ name: "BAD/USD", id: 2 },
							],
						}),
						() => Effect.succeed(fake.client),
					);
					yield* module.start();
					yield* TestClock.adjust(Duration.millis(0));
					expect(fake.subscribeCalls).toHaveLength(2);

					// Only feed 1 ever delivers
					fake.deliverPrice([1]);

					yield* TestClock.adjust(Duration.seconds(62));

					expect(fake.subscribeCalls).toHaveLength(3);
					expect(fake.subscribeCalls[2].priceFeedIds).toEqual([1]);

					const badSideId = fake.subscribeCalls.find((c) =>
						c.priceFeedIds.includes(2),
					)?.subscriptionId;
					expect(badSideId).toBeDefined();
					expect(fake.unsubscribeCalls).not.toContain(badSideId);
				}),
			);
		});

		it("drops an idle feed from the bulk subscription without tearing the bulk down", async () => {
			const fake = makeFakeLazerClient({ autoDeliver: true });

			await runWithTestClock(
				Effect.gen(function* () {
					const module = yield* makePythLazerModule(
						makeConfig({
							priceFeedIds: [
								{ name: "FRESH/USD", id: 1 },
								{ name: "IDLE/USD", id: 2 },
							],
							priceFeedsCleanupTtl: "2 minutes",
							priceFeedsCleanupInterval: "30 seconds",
						}),
						() => Effect.succeed(fake.client),
					);
					yield* module.start();
					yield* TestClock.adjust(Duration.millis(0));

					// First compaction folds both feeds into the bulk subscription
					yield* TestClock.adjust(Duration.seconds(62));
					expect(fake.subscribeCalls).toHaveLength(3);
					const firstBulkId = fake.subscribeCalls[2].subscriptionId;

					// Keep feed 1 fresh, let feed 2 idle past the 2 minute TTL
					yield* TestClock.adjust(Duration.seconds(28));
					yield* module.handleRequest(...requestSymbols("1"));
					yield* TestClock.adjust(Duration.seconds(95));

					// The cleanup must not unsubscribe the shared bulk subscription
					// while it carries other feeds; the next compaction rebuilds it
					const rebuilt = fake.subscribeCalls.at(-1);
					expect(rebuilt).toBeDefined();
					expect(rebuilt?.priceFeedIds).toEqual([1]);
					expect(fake.unsubscribeCalls).toContain(firstBulkId);

					const unsubscribedBeforeRebuild = fake.unsubscribeCalls.slice(
						0,
						fake.unsubscribeCalls.indexOf(firstBulkId),
					);
					expect(unsubscribedBeforeRebuild).not.toContain(firstBulkId);
				}),
			);
		});
	});
});
