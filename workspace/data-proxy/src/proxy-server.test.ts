import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { Secp256k1 } from "@cosmjs/crypto";
import { DataProxy, Environment } from "@seda-protocol/data-proxy-sdk";
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
				routeGroup: "",
				statusEndpoints: {
					root: "status",
				},
				routes: [
					{
						method: "POST",
						path,
						upstreamUrl,
						forwardRepsonseHeaders: new Set([]),
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
				routeGroup: "",
				statusEndpoints: {
					root: "status",
				},
				routes: [
					{
						method: "GET",
						path,
						upstreamUrl,
						forwardRepsonseHeaders: new Set([]),
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
					routeGroup: "",
					statusEndpoints: {
						root: "status",
					},
					routes: [
						{
							method: "GET",
							path,
							upstreamUrl,
							forwardRepsonseHeaders: new Set([]),
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
					routeGroup: "",
					statusEndpoints: {
						root: "status",
					},
					routes: [
						{
							method: "GET",
							path,
							upstreamUrl,
							forwardRepsonseHeaders: new Set([]),
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
					routeGroup: "",
					statusEndpoints: {
						root: "status",
						apiKey: {
							header: "X-API-Key",
							secret: "secret",
						},
					},
					routes: [
						{
							method: "GET",
							path,
							upstreamUrl,
							forwardRepsonseHeaders: new Set([]),
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
