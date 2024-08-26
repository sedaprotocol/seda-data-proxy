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
	TEST_LOCAL_PROXY_PORT,
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
		const { upstreamUrl, proxyUrl, path } = registerHandler(
			"post",
			"/test-post-body",
			async ({ request }) => {
				const bodyText = await request.text();
				return HttpResponse.json({ receivedBody: bodyText });
			},
		);

		startProxyServer(
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
				port: TEST_LOCAL_PROXY_PORT,
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
	});
});
