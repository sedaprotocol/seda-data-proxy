import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { Secp256k1, Secp256k1Signature, keccak256 } from "@cosmjs/crypto";
import {
	constants,
	DataProxy,
	Environment,
} from "@seda-protocol/data-proxy-sdk";
import { Effect, LogLevel, Logger } from "effect";
import { Maybe } from "true-myth";
import { JSON_PATH_HEADER_KEY } from "./constants";
import { startProxyServer } from "./proxy-server";
import { HttpClientService } from "./services/http-client";
import {
	HttpResponse,
	registerHandler,
	server,
} from "./testutils/mock-upstream";

beforeAll(() => {
	server.listen();
});

beforeEach(() => {
	server.resetHandlers();
});

afterAll(() => {
	server.close();
});

// Data proxy setup
const privateKeyBuff = Buffer.from(new Array(32).fill(1));
const keyPair = await Secp256k1.makeKeypair(privateKeyBuff);

const dataProxy = new DataProxy(Environment.Devnet, {
	privateKey: Buffer.from(keyPair.privkey),
});

describe("proxy server", () => {
	it("should forward a body without modifying it", async () => {
		const { upstreamUrl, proxyUrl, path, port } = registerHandler(
			"post",
			"/test-post-body",
			async ({ request }) => {
				const bodyText = await request.text();
				return HttpResponse.json({ receivedBody: bodyText });
			},
		);

		const proxy = await Effect.runPromise(
			startProxyServer(
				{
					verificationMaxRetries: 2,
					verificationRetryDelay: 1000,
					routeGroup: "",
					modules: [],
					sedaFast: {
						enable: true,
						maxProofAgeMs: 1000,
						allowedClients: [],
					},
					statusEndpoints: {
						root: "status",
					},
					multiEndpoint: {
						enable: false,
						path: "multi",
						maxSubRequests: 20,
						concurrency: 5,
					},
					baseURL: Maybe.nothing(),
					routes: [
						{
							baseURL: Maybe.nothing(),
							method: "POST",
							path,
							upstreamUrl,
							forwardResponseHeaders: new Set([]),
							headers: {},
							type: "upstream",
							moduleName: "upstream",
							useLegacyJsonPath: true,
						},
					],
					fastOnly: false,
				},
				dataProxy,
				{
					disableProof: true,
					port,
				},
			)
				.pipe(Effect.scoped)
				.pipe(Effect.provide(HttpClientService.Default()))
				.pipe(Logger.withMinimumLogLevel(LogLevel.None)),
		);

		const response = await fetch(proxyUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: '{"key": "value"}',
		});

		const result = await response.json();
		expect(result).toEqual({
			receivedBody: '{"key": "value"}',
		});
	});

	it("should forward requests without params", async () => {
		const { upstreamUrl, proxyUrl, path, port } = registerHandler(
			"get",
			"/echo",
			async ({ params }) => {
				return HttpResponse.json({ receivedParams: params });
			},
		);

		const proxy = await Effect.runPromise(
			startProxyServer(
				{
					verificationMaxRetries: 2,
					verificationRetryDelay: 1000,
					routeGroup: "",
					modules: [],
					sedaFast: {
						enable: true,
						maxProofAgeMs: 1000,
						allowedClients: [],
					},
					statusEndpoints: {
						root: "status",
					},
					multiEndpoint: {
						enable: false,
						path: "multi",
						maxSubRequests: 20,
						concurrency: 5,
					},
					baseURL: Maybe.nothing(),
					routes: [
						{
							baseURL: Maybe.nothing(),
							method: "GET",
							path,
							upstreamUrl,
							forwardResponseHeaders: new Set([]),
							headers: {},
							type: "upstream",
							moduleName: "upstream",
							useLegacyJsonPath: true,
						},
					],
					fastOnly: false,
				},
				dataProxy,
				{
					disableProof: true,
					port,
				},
			)
				.pipe(Effect.scoped)
				.pipe(Effect.provide(HttpClientService.Default()))
				.pipe(Logger.withMinimumLogLevel(LogLevel.None)),
		);

		const response = await fetch(proxyUrl);
		const result = await response.json();

		expect(result).toEqual({
			receivedParams: {},
		});
	});

	describe("public endpoint configuration", () => {
		it("should support rewriting the protocol and host at the root level", async () => {
			const { upstreamUrl, proxyUrl, path, port } = registerHandler(
				"get",
				"/root-public-endpoint",
				async () => {
					return HttpResponse.json({ data: "hello" });
				},
			);

			const proxy = await Effect.runPromise(
				startProxyServer(
					{
						verificationMaxRetries: 2,
						verificationRetryDelay: 1000,
						routeGroup: "",
						modules: [],
						sedaFast: {
							enable: true,
							maxProofAgeMs: 1000,
							allowedClients: [],
						},
						statusEndpoints: {
							root: "status",
						},
						multiEndpoint: {
							enable: false,
							path: "multi",
							maxSubRequests: 20,
							concurrency: 5,
						},
						baseURL: Maybe.of("https://seda-data-proxy.com"),
						routes: [
							{
								baseURL: Maybe.nothing(),
								method: "GET",
								path,
								upstreamUrl,
								forwardResponseHeaders: new Set([]),
								headers: {},
								type: "upstream",
								moduleName: "upstream",
								useLegacyJsonPath: true,
							},
						],
						fastOnly: false,
					},
					dataProxy,
					{
						disableProof: true,
						port,
					},
				)
					.pipe(Effect.scoped)
					.pipe(Effect.provide(HttpClientService.Default()))
					.pipe(Logger.withMinimumLogLevel(LogLevel.None)),
			);

			const response = await fetch(proxyUrl);
			const result = await response.json();

			const message = dataProxy.generateMessage(
				// Fake a different public URL
				`https://seda-data-proxy.com${path}`,
				"GET",
				Buffer.from(""),
				Buffer.from(JSON.stringify(result)),
			);

			const signature = Secp256k1Signature.fromFixedLength(
				Buffer.from(response.headers.get("x-seda-signature") ?? "", "hex"),
			);
			const isValid = await Secp256k1.verifySignature(
				signature,
				keccak256(message),
				Buffer.from(response.headers.get("x-seda-publickey") ?? "", "hex"),
			);

			expect(isValid, "Signature verification failed").toBe(true);
		});

		it("should support rewriting the protocol and host at the route level", async () => {
			const { upstreamUrl, proxyUrl, path, port } = registerHandler(
				"get",
				"/route-public-endpoint",
				async () => {
					return HttpResponse.json({ data: "hello" });
				},
			);

			const proxy = await Effect.runPromise(
				startProxyServer(
					{
						verificationMaxRetries: 2,
						verificationRetryDelay: 1000,
						routeGroup: "",
						modules: [],
						sedaFast: {
							enable: true,
							maxProofAgeMs: 1000,
							allowedClients: [],
						},
						statusEndpoints: {
							root: "status",
						},
						multiEndpoint: {
							enable: false,
							path: "multi",
							maxSubRequests: 20,
							concurrency: 5,
						},
						baseURL: Maybe.of("https://seda-data-proxy.com"),
						routes: [
							{
								baseURL: Maybe.of(
									"https://different-subdomain.seda-data-proxy.com",
								),
								method: "GET",
								path,
								upstreamUrl,
								forwardResponseHeaders: new Set([]),
								headers: {},
								type: "upstream",
								moduleName: "upstream",
								useLegacyJsonPath: true,
							},
						],
						fastOnly: false,
					},
					dataProxy,
					{
						disableProof: true,
						port,
					},
				)
					.pipe(Effect.scoped)
					.pipe(Effect.provide(HttpClientService.Default()))
					.pipe(Logger.withMinimumLogLevel(LogLevel.None)),
			);

			const response = await fetch(proxyUrl);
			const result = await response.json();

			const message = dataProxy.generateMessage(
				// Fake a different public URL
				`https://different-subdomain.seda-data-proxy.com${path}`,
				"GET",
				Buffer.from(""),
				Buffer.from(JSON.stringify(result)),
			);

			const signature = Secp256k1Signature.fromFixedLength(
				Buffer.from(response.headers.get("x-seda-signature") ?? "", "hex"),
			);
			const isValid = await Secp256k1.verifySignature(
				signature,
				keccak256(message),
				Buffer.from(response.headers.get("x-seda-publickey") ?? "", "hex"),
			);

			expect(isValid, "Signature verification failed").toBe(true);
		});
	});

	describe("OPTIONS methods", () => {
		it("should return the public key and version of the data proxy", async () => {
			const { upstreamUrl, proxyUrl, path, port } = registerHandler(
				"get",
				"/test",
				async () => {
					return HttpResponse.json({ data: "info" });
				},
			);

			const proxy = await Effect.runPromise(
				startProxyServer(
					{
						verificationMaxRetries: 2,
						verificationRetryDelay: 1000,
						routeGroup: "",
						modules: [],
						sedaFast: {
							enable: true,
							maxProofAgeMs: 1000,
							allowedClients: [],
						},
						statusEndpoints: {
							root: "status",
						},
						multiEndpoint: {
							enable: false,
							path: "multi",
							maxSubRequests: 20,
							concurrency: 5,
						},
						baseURL: Maybe.nothing(),
						routes: [
							{
								baseURL: Maybe.nothing(),
								method: "GET",
								path,
								upstreamUrl,
								forwardResponseHeaders: new Set([]),
								headers: {},
								jsonPath: "$.data",
								type: "upstream",
								moduleName: "upstream",
								useLegacyJsonPath: true,
							},
						],
						fastOnly: false,
					},
					dataProxy,
					{
						disableProof: true,
						port,
					},
				)
					.pipe(Effect.scoped)
					.pipe(Effect.provide(HttpClientService.Default()))
					.pipe(Logger.withMinimumLogLevel(LogLevel.None)),
			);

			const response = await fetch(proxyUrl, { method: "OPTIONS" });
			const version = response.headers.get(
				constants.SIGNATURE_VERSION_HEADER_KEY,
			);
			const publicKey = response.headers.get(constants.PUBLIC_KEY_HEADER_KEY);

			expect(version).toBe("0.1.0");
			expect(publicKey).toBe(
				"031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f",
			);
		});
	});

	describe("QueryJsonError responses", () => {
		it("does not leak QueryJsonError.data (upstream body snapshot) into the JSON error body", async () => {
			const sensitiveData = "SENSITIVE_DATA_FROM_THE_UPSTREAM";
			const upstreamBody = {
				padHead: "x".repeat(20),
				sensitiveData,
				padTail: "x".repeat(20),
			};

			const { upstreamUrl, proxyUrl, path, port } = registerHandler(
				"get",
				"/query-json-privacy",
				async () => HttpResponse.json(upstreamBody),
			);

			const proxy = await Effect.runPromise(
				startProxyServer(
					{
						verificationMaxRetries: 2,
						verificationRetryDelay: 1000,
						routeGroup: "",
						modules: [],
						sedaFast: {
							enable: true,
							maxProofAgeMs: 1000,
							allowedClients: [],
						},
						statusEndpoints: {
							root: "status",
						},
						multiEndpoint: {
							enable: false,
							path: "multi",
							maxSubRequests: 20,
							concurrency: 5,
						},
						baseURL: Maybe.nothing(),
						routes: [
							{
								baseURL: Maybe.nothing(),
								method: "GET",
								path,
								upstreamUrl,
								forwardResponseHeaders: new Set([]),
								headers: {},
								jsonPath: "$.noSuchProperty",
								type: "upstream",
								moduleName: "upstream",
								useLegacyJsonPath: true,
							},
						],
						fastOnly: false,
					},
					dataProxy,
					{
						disableProof: true,
						port,
					},
				)
					.pipe(Effect.scoped)
					.pipe(Effect.provide(HttpClientService.Default()))
					.pipe(Logger.withMinimumLogLevel(LogLevel.None)),
			);

			const response = await fetch(proxyUrl);
			expect(response.status).toBe(500);

			const raw = await response.text();
			const parsed = JSON.parse(raw) as Record<string, unknown>;

			expect(parsed).not.toHaveProperty("data");
			expect(parsed._tag).toBe("QueryJsonError");
			expect(raw).not.toContain(sensitiveData);
		});
	});

	describe("route jsonPath path params", () => {
		const assetCtxs = [{ markPx: "100" }, { markPx: "200" }, { markPx: "300" }];
		const upstreamBody = [
			{ universe: [{ name: "A" }, { name: "B" }, { name: "C" }] },
			assetCtxs,
		];

		it("substitutes path params before applying jsonPath", async () => {
			const { upstreamUrl, port } = registerHandler(
				"post",
				"/jsonpath-params-info",
				async () => HttpResponse.json(upstreamBody),
			);

			await Effect.runPromise(
				startProxyServer(
					{
						verificationMaxRetries: 2,
						verificationRetryDelay: 1000,
						routeGroup: "",
						modules: [],
						sedaFast: {
							enable: true,
							maxProofAgeMs: 1000,
							allowedClients: [],
						},
						statusEndpoints: {
							root: "status",
						},
						multiEndpoint: {
							enable: false,
							path: "multi",
							maxSubRequests: 20,
							concurrency: 5,
						},
						baseURL: Maybe.nothing(),
						routes: [
							{
								baseURL: Maybe.nothing(),
								method: "POST",
								path: "/mainnet/:index",
								upstreamUrl,
								forwardResponseHeaders: new Set([]),
								headers: {},
								jsonPath: "$.[1][{:index}]",
								type: "upstream",
								moduleName: "upstream",
								useLegacyJsonPath: true,
							},
						],
						fastOnly: false,
					},
					dataProxy,
					{
						disableProof: true,
						port,
					},
				)
					.pipe(Effect.scoped)
					.pipe(Effect.provide(HttpClientService.Default()))
					.pipe(Logger.withMinimumLogLevel(LogLevel.None)),
			);

			const response = await fetch(`http://localhost:${port}/mainnet/1`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: '{"type":"metaAndAssetCtxs","dex":"xyz"}',
			});

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual(assetCtxs[1]);
		});

		it("includes the substituted jsonPath in QueryJsonError when the index is missing", async () => {
			const { upstreamUrl, port } = registerHandler(
				"post",
				"/jsonpath-params-missing-index",
				async () => HttpResponse.json(upstreamBody),
			);

			await Effect.runPromise(
				startProxyServer(
					{
						verificationMaxRetries: 2,
						verificationRetryDelay: 1000,
						routeGroup: "",
						modules: [],
						sedaFast: {
							enable: true,
							maxProofAgeMs: 1000,
							allowedClients: [],
						},
						statusEndpoints: {
							root: "status",
						},
						multiEndpoint: {
							enable: false,
							path: "multi",
							maxSubRequests: 20,
							concurrency: 5,
						},
						baseURL: Maybe.nothing(),
						routes: [
							{
								baseURL: Maybe.nothing(),
								method: "POST",
								path: "/mainnet/:index",
								upstreamUrl,
								forwardResponseHeaders: new Set([]),
								headers: {},
								jsonPath: "$.[1][{:index}]",
								type: "upstream",
								moduleName: "upstream",
								useLegacyJsonPath: true,
							},
						],
						fastOnly: false,
					},
					dataProxy,
					{
						disableProof: true,
						port,
					},
				)
					.pipe(Effect.scoped)
					.pipe(Effect.provide(HttpClientService.Default()))
					.pipe(Logger.withMinimumLogLevel(LogLevel.None)),
			);

			const response = await fetch(`http://localhost:${port}/mainnet/99`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: '{"type":"metaAndAssetCtxs","dex":"xyz"}',
			});

			expect(response.status).toBe(500);
			const raw = await response.text();
			expect(raw).toContain(
				"Query JSON (originator: config) error: JSONPath $.[1][99] returned null",
			);
			expect(raw).not.toContain("originator: unknown");
			expect(raw).not.toContain("{:index}");
		});
	});

	it("when user-supplied JSON path is invalid, the result of operator-supplied JSON path should be returned with a 400 status", async () => {
		const picked = "PICKED_BY_OPERATOR_SUPPLIED_JSON_PATH";
		const notPicked = "NOT_PICKED_BY_OPERATOR_SUPPLIED_JSON_PATH";
		const upstreamBody = {
			picked,
			notPicked,
		};
		const validPath = "$.picked";
		const invalidPath = "$.invalidPath";

		const { upstreamUrl, proxyUrl, path, port } = registerHandler(
			"get",
			"/query-json-privacy",
			async () => HttpResponse.json(upstreamBody),
		);

		const proxy = await Effect.runPromise(
			startProxyServer(
				{
					verificationMaxRetries: 2,
					verificationRetryDelay: 1000,
					routeGroup: "",
					modules: [],
					sedaFast: {
						enable: true,
						maxProofAgeMs: 1000,
						allowedClients: [],
					},
					statusEndpoints: {
						root: "status",
					},
					multiEndpoint: {
						enable: false,
						path: "multi",
						maxSubRequests: 20,
						concurrency: 5,
					},
					baseURL: Maybe.nothing(),
					routes: [
						{
							baseURL: Maybe.nothing(),
							method: "GET",
							path,
							upstreamUrl,
							forwardResponseHeaders: new Set([]),
							headers: {},
							jsonPath: validPath,
							type: "upstream",
							moduleName: "upstream",
							useLegacyJsonPath: true,
						},
					],
					fastOnly: false,
				},
				dataProxy,
				{
					disableProof: true,
					port,
				},
			)
				.pipe(Effect.scoped)
				.pipe(Effect.provide(HttpClientService.Default()))
				.pipe(Logger.withMinimumLogLevel(LogLevel.None)),
		);

		const response = await fetch(proxyUrl, {
			headers: {
				[JSON_PATH_HEADER_KEY]: invalidPath,
			},
		});
		expect(response.status).toBe(400);

		const raw = await response.text();
		const parsed = JSON.parse(raw) as Record<string, unknown>;

		expect(parsed).not.toHaveProperty("data");
		expect(parsed._tag).toBe("QueryJsonError");
		expect(raw).toContain(
			`Query JSON (originator: header) error: JSONPath ${invalidPath} returned null`,
		);
		expect(raw).not.toContain("originator: unknown");
		expect(raw).toContain(picked);
		expect(raw).not.toContain(notPicked);
	});

	describe("status endpoints", () => {
		it("should return the status of the proxy for <statusRoot>/health", async () => {
			const { upstreamUrl, proxyUrl, path, port } = registerHandler(
				"get",
				// Empty path to make it easier to query the status endpoint
				"",
				async ({ request: { url } }) => {
					const searchparams = new URL(url).searchParams;

					if (searchparams.get("fail") === "true") {
						return HttpResponse.json({ noDataKey: "error" });
					}

					return HttpResponse.json({ data: "hello" });
				},
			);

			const proxy = await Effect.runPromise(
				startProxyServer(
					{
						verificationMaxRetries: 2,
						verificationRetryDelay: 1000,
						routeGroup: "",
						modules: [],
						sedaFast: {
							enable: true,
							maxProofAgeMs: 1000,
							allowedClients: [],
						},
						statusEndpoints: {
							root: "status",
						},
						multiEndpoint: {
							enable: false,
							path: "multi",
							maxSubRequests: 20,
							concurrency: 5,
						},
						baseURL: Maybe.nothing(),
						routes: [
							{
								baseURL: Maybe.nothing(),
								method: "GET",
								path,
								upstreamUrl,
								forwardResponseHeaders: new Set([]),
								headers: {},
								jsonPath: "$.data",
								type: "upstream",
								moduleName: "upstream",
								useLegacyJsonPath: true,
							},
						],
						fastOnly: false,
					},
					dataProxy,
					{
						disableProof: true,
						port,
					},
				)
					.pipe(Effect.scoped)
					.pipe(Effect.provide(HttpClientService.Default()))
					.pipe(Logger.withMinimumLogLevel(LogLevel.None)),
			);

			async function expectStatus(expected: unknown) {
				const response = await fetch(`${proxyUrl}/status/health`);
				const result = await response.json();

				expect(result).toEqual(expected);
			}

			await expectStatus({
				status: "healthy",
				metrics: {
					uptime: expect.any(String),
					requests: 0,
					errors: 0,
				},
			});

			// Successful proxy request
			await fetch(`${proxyUrl}`);

			await expectStatus({
				status: "healthy",
				metrics: {
					uptime: expect.any(String),
					requests: 1,
					errors: 0,
				},
			});

			// Failing proxy request
			await fetch(`${proxyUrl}?fail=true`);

			await expectStatus({
				status: "healthy",
				metrics: {
					uptime: expect.any(String),
					requests: 2,
					errors: 1,
				},
			});
		});

		it("should return the pubkey of the proxy for <statusRoot>/info", async () => {
			const { upstreamUrl, proxyUrl, path, port } = registerHandler(
				"get",
				// Empty path to make it easier to query the status endpoint
				"",
				async () => {
					return HttpResponse.json({});
				},
			);

			const proxy = await Effect.runPromise(
				startProxyServer(
					{
						verificationMaxRetries: 2,
						verificationRetryDelay: 1000,
						routeGroup: "",
						modules: [],
						sedaFast: {
							enable: true,
							maxProofAgeMs: 1000,
							allowedClients: [],
						},
						statusEndpoints: {
							root: "status",
						},
						multiEndpoint: {
							enable: false,
							path: "multi",
							maxSubRequests: 20,
							concurrency: 5,
						},
						baseURL: Maybe.nothing(),
						routes: [
							{
								baseURL: Maybe.nothing(),
								method: "GET",
								path,
								upstreamUrl,
								forwardResponseHeaders: new Set([]),
								headers: {},
								type: "upstream",
								moduleName: "upstream",
								useLegacyJsonPath: true,
							},
						],
						fastOnly: false,
					},
					dataProxy,
					{
						disableProof: true,
						port,
					},
				)
					.pipe(Effect.scoped)
					.pipe(Effect.provide(HttpClientService.Default()))
					.pipe(Logger.withMinimumLogLevel(LogLevel.None)),
			);

			const response = await fetch(`${proxyUrl}/status/info`);
			const result = await response.json();

			expect(result).toEqual({
				pubKey:
					"031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f",
				fastConfig: {
					enable: true,
					allowedClients: [],
					maxProofAgeMs: 1000,
				},
				version: expect.any(String),
				chainId: expect.any(String),
				rpcChainId: expect.any(String),
			});
		});

		it("should secure the status endpoint with an API key when configured", async () => {
			const { upstreamUrl, proxyUrl, path, port } = registerHandler(
				"get",
				// Empty path to make it easier to query the status endpoint
				"",
				async () => {
					return HttpResponse.json({});
				},
			);

			const proxy = await Effect.runPromise(
				startProxyServer(
					{
						verificationMaxRetries: 2,
						verificationRetryDelay: 1000,
						routeGroup: "",
						modules: [],
						sedaFast: {
							enable: true,
							maxProofAgeMs: 1000,
							allowedClients: [],
						},
						statusEndpoints: {
							root: "status",
							apiKey: {
								header: "X-API-Key",
								secret: "secret",
							},
						},
						multiEndpoint: {
							enable: false,
							path: "multi",
							maxSubRequests: 20,
							concurrency: 5,
						},
						baseURL: Maybe.nothing(),
						routes: [
							{
								baseURL: Maybe.nothing(),
								method: "GET",
								path,
								upstreamUrl,
								forwardResponseHeaders: new Set([]),
								headers: {},
								type: "upstream",
								moduleName: "upstream",
								useLegacyJsonPath: true,
							},
						],
						fastOnly: false,
					},
					dataProxy,
					{
						disableProof: true,
						port,
					},
				)
					.pipe(Effect.scoped)
					.pipe(Effect.provide(HttpClientService.Default()))
					.pipe(Logger.withMinimumLogLevel(LogLevel.None)),
			);

			const unauthorizedPubkeyRes = await fetch(`${proxyUrl}/status/info`).then(
				(r) => r.text(),
			);
			expect(unauthorizedPubkeyRes).toEqual("Unauthorized");

			const unauthorizedHealthRes = await fetch(
				`${proxyUrl}/status/health`,
			).then((r) => r.text());
			expect(unauthorizedHealthRes).toEqual("Unauthorized");

			const authorizedPubkeyRes = await fetch(`${proxyUrl}/status/info`, {
				headers: {
					"X-API-Key": "secret",
				},
			}).then((r) => r.json());
			expect(authorizedPubkeyRes).toEqual({
				pubKey:
					"031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f",
				fastConfig: {
					enable: true,
					allowedClients: [],
					maxProofAgeMs: 1000,
				},
				version: expect.any(String),
				chainId: expect.any(String),
				rpcChainId: expect.any(String),
			});

			const authorizedHealthRes = await fetch(`${proxyUrl}/status/health`, {
				headers: {
					"X-API-Key": "secret",
				},
			}).then((r) => r.json());
			expect(authorizedHealthRes).toEqual({
				status: "healthy",
				metrics: {
					uptime: expect.any(String),
					requests: 0,
					errors: 0,
				},
			});
		});
	});

	describe("multi endpoint", () => {
		it("fans out POST /multi to configured upstream routes by path", async () => {
			const a = registerHandler("get", "/prices/a", async () =>
				HttpResponse.json({ venue: "a", price: 1 }),
			);
			const b = registerHandler("get", "/prices/b", async () =>
				HttpResponse.json({ venue: "b", price: 2 }),
			);

			await Effect.runPromise(
				startProxyServer(
					{
						verificationMaxRetries: 2,
						verificationRetryDelay: 1000,
						routeGroup: "",
						modules: [],
						sedaFast: {
							enable: true,
							maxProofAgeMs: 1000,
							allowedClients: [],
						},
						statusEndpoints: {
							root: "status",
						},
						multiEndpoint: {
							enable: true,
							path: "multi",
							maxSubRequests: 20,
							concurrency: 5,
						},
						baseURL: Maybe.nothing(),
						routes: [
							{
								baseURL: Maybe.nothing(),
								method: "GET",
								path: "/prices/a",
								upstreamUrl: a.upstreamUrl,
								forwardResponseHeaders: new Set([]),
								headers: {},
								type: "upstream",
								moduleName: "upstream",
								useLegacyJsonPath: true,
							},
							{
								baseURL: Maybe.nothing(),
								method: "GET",
								path: "/prices/b",
								upstreamUrl: b.upstreamUrl,
								forwardResponseHeaders: new Set([]),
								headers: {},
								type: "upstream",
								moduleName: "upstream",
								useLegacyJsonPath: true,
							},
						],
						fastOnly: false,
					},
					dataProxy,
					{
						disableProof: true,
						port: a.port,
					},
				)
					.pipe(Effect.scoped)
					.pipe(Effect.provide(HttpClientService.Default()))
					.pipe(Logger.withMinimumLogLevel(LogLevel.None)),
			);

			const response = await fetch(`http://localhost:${a.port}/multi`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					a: { path: "/prices/a" },
					b: { path: "/prices/b" },
				}),
			});

			expect(response.status).toBe(200);
			expect(response.headers.get(constants.SIGNATURE_HEADER_KEY)).toBeTruthy();
			expect(await response.json()).toEqual({
				a: { venue: "a", price: 1 },
				b: { venue: "b", price: 2 },
			});
		});

		it("fans out to a trailing wildcard upstream route", async () => {
			const coffee = registerHandler("get", "/api/coffee/hot", async () =>
				HttpResponse.json({ title: "latte" }),
			);

			await Effect.runPromise(
				startProxyServer(
					{
						verificationMaxRetries: 2,
						verificationRetryDelay: 1000,
						routeGroup: "",
						modules: [],
						sedaFast: {
							enable: true,
							maxProofAgeMs: 1000,
							allowedClients: [],
						},
						statusEndpoints: {
							root: "status",
						},
						multiEndpoint: {
							enable: true,
							path: "multi",
							maxSubRequests: 20,
							concurrency: 5,
						},
						baseURL: Maybe.nothing(),
						routes: [
							{
								baseURL: Maybe.nothing(),
								method: "GET",
								path: "/api/*",
								upstreamUrl: "https://proxy-upstream.com/api/{*}",
								forwardResponseHeaders: new Set([]),
								headers: {},
								type: "upstream",
								moduleName: "upstream",
								useLegacyJsonPath: true,
							},
						],
						fastOnly: false,
					},
					dataProxy,
					{
						disableProof: true,
						port: coffee.port,
					},
				)
					.pipe(Effect.scoped)
					.pipe(Effect.provide(HttpClientService.Default()))
					.pipe(Logger.withMinimumLogLevel(LogLevel.None)),
			);

			const response = await fetch(`http://localhost:${coffee.port}/multi`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					coffee: { path: "/api/coffee/hot" },
				}),
			});

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				coffee: { title: "latte" },
			});
		});
	});
});
