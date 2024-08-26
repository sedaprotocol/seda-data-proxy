import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { randomBytes } from "node:crypto";
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
const privateKeyBuff = randomBytes(32);
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
});
