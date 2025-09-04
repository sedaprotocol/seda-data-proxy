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
import { Maybe } from "true-myth";
import { startProxyServer } from "./proxy-server";
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

		const proxy = startProxyServer(
			{
				verificationMaxRetries: 2,
				verificationRetryDelay: 1000,
				routeGroup: "",
				sedaFast: {
					enable: true,
					maxProofAgeMs: 1000,
					allowedClients: [],
				},
				statusEndpoints: {
					root: "status",
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
					},
				],
			},
			dataProxy,
			{
				disableProof: true,
				port,
			},
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

		await proxy.stop();
	});

	it("should forward requests without params", async () => {
		const { upstreamUrl, proxyUrl, path, port } = registerHandler(
			"get",
			"/echo",
			async ({ params }) => {
				return HttpResponse.json({ receivedParams: params });
			},
		);

		const proxy = startProxyServer(
			{
				verificationMaxRetries: 2,
				verificationRetryDelay: 1000,
				routeGroup: "",
				sedaFast: {
					enable: true,
					maxProofAgeMs: 1000,
					allowedClients: [],
				},
				statusEndpoints: {
					root: "status",
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
					},
				],
			},
			dataProxy,
			{
				disableProof: true,
				port,
			},
		);

		const response = await fetch(proxyUrl);
		const result = await response.json();

		expect(result).toEqual({
			receivedParams: {},
		});

		await proxy.stop();
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

			const proxy = startProxyServer(
				{
					verificationMaxRetries: 2,
					verificationRetryDelay: 1000,
					routeGroup: "",
					sedaFast: {
						enable: true,
						maxProofAgeMs: 1000,
						allowedClients: [],
					},
					statusEndpoints: {
						root: "status",
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
						},
					],
				},
				dataProxy,
				{
					disableProof: true,
					port,
				},
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

			await proxy.stop();
		});

		it("should support rewriting the protocol and host at the route level", async () => {
			const { upstreamUrl, proxyUrl, path, port } = registerHandler(
				"get",
				"/route-public-endpoint",
				async () => {
					return HttpResponse.json({ data: "hello" });
				},
			);

			const proxy = startProxyServer(
				{
					verificationMaxRetries: 2,
					verificationRetryDelay: 1000,
					routeGroup: "",
					sedaFast: {
						enable: true,
						maxProofAgeMs: 1000,
						allowedClients: [],
					},
					statusEndpoints: {
						root: "status",
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
						},
					],
				},
				dataProxy,
				{
					disableProof: true,
					port,
				},
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

			await proxy.stop();
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

			const proxy = startProxyServer(
				{
					verificationMaxRetries: 2,
					verificationRetryDelay: 1000,
					routeGroup: "",
					sedaFast: {
						enable: true,
						maxProofAgeMs: 1000,
						allowedClients: [],
					},
					statusEndpoints: {
						root: "status",
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
						},
					],
				},
				dataProxy,
				{
					disableProof: true,
					port,
				},
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

			const proxy = startProxyServer(
				{
					verificationMaxRetries: 2,
					verificationRetryDelay: 1000,
					routeGroup: "",
					sedaFast: {
						enable: true,
						maxProofAgeMs: 1000,
						allowedClients: [],
					},
					statusEndpoints: {
						root: "status",
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
						},
					],
				},
				dataProxy,
				{
					disableProof: true,
					port,
				},
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
				version: expect.any(String),
				chainId: expect.any(String),
				rpcChainId: expect.any(String),
			});

			// Successful proxy request
			await fetch(`${proxyUrl}`);

			await expectStatus({
				status: "healthy",
				chainId: expect.any(String),
				rpcChainId: expect.any(String),
				version: expect.any(String),
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
				chainId: expect.any(String),
				rpcChainId: expect.any(String),
				version: expect.any(String),
				metrics: {
					uptime: expect.any(String),
					requests: 2,
					errors: 1,
				},
			});

			await proxy.stop();
		});

		it("should return the pubkey of the proxy for <statusRoot>/pubkey", async () => {
			const { upstreamUrl, proxyUrl, path, port } = registerHandler(
				"get",
				// Empty path to make it easier to query the status endpoint
				"",
				async () => {
					return HttpResponse.json({});
				},
			);

			const proxy = startProxyServer(
				{
					verificationMaxRetries: 2,
					verificationRetryDelay: 1000,
					routeGroup: "",
					sedaFast: {
						enable: true,
						maxProofAgeMs: 1000,
						allowedClients: [],
					},
					statusEndpoints: {
						root: "status",
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
						},
					],
				},
				dataProxy,
				{
					disableProof: true,
					port,
				},
			);

			const response = await fetch(`${proxyUrl}/status/pubkey`);
			const result = await response.json();

			expect(result).toEqual({
				pubKey:
					"031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f",
			});

			await proxy.stop();
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

			const proxy = startProxyServer(
				{
					verificationMaxRetries: 2,
					verificationRetryDelay: 1000,
					routeGroup: "",
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
					baseURL: Maybe.nothing(),
					routes: [
						{
							baseURL: Maybe.nothing(),
							method: "GET",
							path,
							upstreamUrl,
							forwardResponseHeaders: new Set([]),
							headers: {},
						},
					],
				},
				dataProxy,
				{
					disableProof: true,
					port,
				},
			);

			const unauthorizedPubkeyRes = await fetch(
				`${proxyUrl}/status/pubkey`,
			).then((r) => r.text());
			expect(unauthorizedPubkeyRes).toEqual("Unauthorized");

			const unauthorizedHealthRes = await fetch(
				`${proxyUrl}/status/health`,
			).then((r) => r.text());
			expect(unauthorizedHealthRes).toEqual("Unauthorized");

			const authorizedPubkeyRes = await fetch(`${proxyUrl}/status/pubkey`, {
				headers: {
					"X-API-Key": "secret",
				},
			}).then((r) => r.json());
			expect(authorizedPubkeyRes).toEqual({
				pubKey:
					"031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f",
			});

			const authorizedHealthRes = await fetch(`${proxyUrl}/status/health`, {
				headers: {
					"X-API-Key": "secret",
				},
			}).then((r) => r.json());
			expect(authorizedHealthRes).toEqual({
				status: "healthy",
				chainId: expect.any(String),
				rpcChainId: expect.any(String),
				version: expect.any(String),
				metrics: {
					uptime: expect.any(String),
					requests: 0,
					errors: 0,
				},
			});

			await proxy.stop();
		});
	});
});
