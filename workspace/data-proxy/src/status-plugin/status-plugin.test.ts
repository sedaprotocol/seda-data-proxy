import { afterEach, describe, expect, it } from "bun:test";
import { Secp256k1 } from "@cosmjs/crypto";
import node from "@elysiajs/node";
import { DataProxy, Environment } from "@seda-protocol/data-proxy-sdk";
import { Effect, LogLevel, Logger } from "effect";
import { Elysia } from "elysia";
import type { Config } from "../config/config-parser";
import { SocketHealthRegistry } from "../services/socket-health";
import { StatusContext } from "./status-context";
import { statusPlugin } from "./status-plugin";

const privateKeyBuff = Buffer.from(new Array(32).fill(1));
const keyPair = await Secp256k1.makeKeypair(privateKeyBuff);
const dataProxy = new DataProxy(Environment.Devnet, {
	privateKey: Buffer.from(keyPair.privkey),
});

const fastOnly = { fastOnly: true } as Config;
const withChain = { fastOnly: false } as Config;

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

const mockChain = (network: string) => {
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		if (url.endsWith("/status")) {
			return Response.json({
				result: { node_info: { network } },
			});
		}
		return originalFetch(input, init);
	}) as typeof fetch;
};

const health = async (registry: SocketHealthRegistry, config: Config) => {
	const plugin = await Effect.runPromise(
		statusPlugin(
			new StatusContext(dataProxy.publicKey.toString("hex"), undefined),
			dataProxy,
			{ root: "status" },
			config,
			registry,
		).pipe(Logger.withMinimumLogLevel(LogLevel.None)),
	);
	const app = new Elysia({ adapter: node() });
	plugin(app);
	return app.handle(new Request("http://localhost/status/health"));
};

describe("status health", () => {
	it("returns 200 when fastOnly and no socket is past the grace", async () => {
		const registry = new SocketHealthRegistry();
		registry.track({ module: "okx", venue: "okx" }, Date.now);

		const response = await health(registry, fastOnly);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.status).toBe("healthy");
		expect(body).not.toHaveProperty("sockets");
	});

	it("returns a non-200 status when a socket has been down for the grace", async () => {
		const registry = new SocketHealthRegistry();
		registry.track({ module: "binance-main", venue: "binance" }, () => 0);

		const response = await health(registry, fastOnly);
		const body = await response.json();

		expect(response.status).not.toBe(200);
		expect(response.status).toBe(500);
		expect(body.status).toBe("unhealthy");
		expect(body.sockets).toEqual([
			{
				module: "binance-main",
				venue: "binance",
				disconnectedForMs: expect.any(Number),
			},
		]);
		expect(body.sockets[0].disconnectedForMs).toBeGreaterThanOrEqual(30_000);
	});

	it("keeps the RPC check when fastOnly is off", async () => {
		mockChain(dataProxy.options.chainId);
		const healthy = await health(new SocketHealthRegistry(), withChain);
		expect(healthy.status).toBe(200);

		mockChain("wrong-chain");
		const rpcDown = await health(new SocketHealthRegistry(), withChain);
		const rpcBody = await rpcDown.json();
		expect(rpcDown.status).toBe(500);
		expect(rpcBody.status).toBe("unhealthy");
		expect(rpcBody).not.toHaveProperty("sockets");

		mockChain(dataProxy.options.chainId);
		const registry = new SocketHealthRegistry();
		registry.track({ module: "binance-main", venue: "binance" }, () => 0);
		const socketDown = await health(registry, withChain);
		const socketBody = await socketDown.json();
		expect(socketDown.status).toBe(500);
		expect(socketBody.sockets).toHaveLength(1);
	});
});
