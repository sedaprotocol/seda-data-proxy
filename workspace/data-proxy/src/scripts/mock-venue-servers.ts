/**
 * Local HTTPS / WSS backends for the performance bench.
 *
 * Speaks enough of each venue protocol that the real data-proxy modules can
 * connect, subscribe, and receive ticks. No module injection.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type Server as HttpsServer, createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";

export const VENUES = [
	"binance",
	"lighter",
	"dxfeed",
	"pyth",
	"hydromancer",
] as const;

export type Venue = (typeof VENUES)[number];

export type VenueRates = Record<Venue, number>;

type WsClient = WebSocket;

const sendJson = (socket: WsClient, value: unknown): void => {
	if (socket.readyState === WebSocket.OPEN) {
		socket.send(JSON.stringify(value));
	}
};

const pathnameOf = (url: string | undefined): string => {
	if (!url) return "/";
	try {
		return (
			new URL(url, "https://127.0.0.1").pathname.replace(/\/+$/, "") || "/"
		);
	} catch {
		return "/";
	}
};

const createSelfSignedTls = (): { key: Buffer; cert: Buffer } => {
	const dir = mkdtempSync(join(tmpdir(), "sdp-bench-tls-"));
	const keyPath = join(dir, "key.pem");
	const certPath = join(dir, "cert.pem");
	const cnfPath = join(dir, "openssl.cnf");
	writeFileSync(
		cnfPath,
		[
			"[req]",
			"distinguished_name = req_distinguished_name",
			"x509_extensions = v3_req",
			"prompt = no",
			"[req_distinguished_name]",
			"CN = host.docker.internal",
			"[v3_req]",
			"subjectAltName = DNS:host.docker.internal,DNS:localhost,IP:127.0.0.1",
			"",
		].join("\n"),
	);
	const result = spawnSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-keyout",
			keyPath,
			"-out",
			certPath,
			"-days",
			"1",
			"-nodes",
			"-config",
			cnfPath,
		],
		{ encoding: "utf8" },
	);
	if (result.status !== 0) {
		rmSync(dir, { recursive: true, force: true });
		throw new Error(
			`Failed to generate a self-signed TLS cert with openssl: ${result.stderr || result.stdout}`,
		);
	}
	const key = readFileSync(keyPath);
	const cert = readFileSync(certPath);
	rmSync(dir, { recursive: true, force: true });
	return { key, cert };
};

export interface MockVenueServer {
	port: number;
	wssUrl: (venue: Venue) => string;
	httpsOrigin: string;
	framesSent: () => number;
	connected: (venue: Venue) => number;
	startPumps: (rates: VenueRates) => void;
	stop: () => Promise<void>;
}

export const startMockVenueServer = async (
	venues: ReadonlySet<Venue>,
): Promise<MockVenueServer> => {
	const tls = createSelfSignedTls();
	const httpsServer: HttpsServer = createServer(tls, (req, res) => {
		const path = pathnameOf(req.url);
		if (req.method === "POST" && (path === "/info" || path.endsWith("/info"))) {
			const chunks: Buffer[] = [];
			req.on("data", (chunk) => {
				chunks.push(chunk as Buffer);
			});
			req.on("end", () => {
				let coins: string[] = [];
				try {
					const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
						coins?: string | string[];
						coin?: string;
					};
					if (typeof body.coin === "string") coins = [body.coin];
					else if (typeof body.coins === "string")
						coins = body.coins.split(",");
					else if (Array.isArray(body.coins)) coins = body.coins;
				} catch {
					coins = [];
				}
				const payload: Record<string, unknown> = {};
				for (const coin of coins.map((c) => c.trim()).filter(Boolean)) {
					payload[coin] = {
						oraclePx: "100",
						markPx: "100",
						midPx: "100",
						impactPxs: ["99", "101"],
						openInterest: "1",
					};
				}
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify(payload));
			});
			return;
		}

		res.writeHead(200, { "content-type": "application/json" });
		res.end("[]");
	});

	await new Promise<void>((resolve, reject) => {
		httpsServer.once("error", reject);
		httpsServer.listen(0, "0.0.0.0", () => resolve());
	});

	const port = (httpsServer.address() as AddressInfo).port;

	const binanceClients = new Set<WsClient>();
	const lighterClients = new Set<WsClient>();
	const hydroClients = new Set<WsClient>();
	const pythClients = new Set<WsClient>();
	const dxfeedClients = new Set<WsClient>();

	const binanceStreams = new Set<string>();
	const lighterMarkets = new Set<number>();
	const hydroCoins = new Set<string>();
	const pythFeeds = new Map<number, { channel: string; feedIds: number[] }>();
	const dxfeedSymbols = new Set<string>();
	const dxfeedChannels = new Map<WsClient, number>();

	let framesSent = 0;
	const trackSend = (socket: WsClient, value: unknown) => {
		sendJson(socket, value);
		framesSent += 1;
	};

	const wss = new WebSocketServer({
		server: httpsServer,
	});

	wss.on("connection", (socket, req) => {
		const venue = pathnameOf(req.url).replace(/^\//, "") as Venue | "";

		if (venue === "binance" && venues.has("binance")) {
			binanceClients.add(socket);
			socket.on("message", (data) => {
				let json: unknown;
				try {
					json = JSON.parse(String(data));
				} catch {
					return;
				}
				if (typeof json !== "object" || json === null) return;
				const frame = json as {
					method?: string;
					params?: unknown;
					id?: number;
				};
				const params = Array.isArray(frame.params)
					? frame.params.filter((p): p is string => typeof p === "string")
					: [];
				if (frame.method === "SUBSCRIBE") {
					for (const stream of params) binanceStreams.add(stream);
					trackSend(socket, { result: null, id: frame.id ?? null });
				} else if (frame.method === "UNSUBSCRIBE") {
					for (const stream of params) binanceStreams.delete(stream);
					trackSend(socket, { result: null, id: frame.id ?? null });
				}
			});
			socket.on("close", () => binanceClients.delete(socket));
			return;
		}

		if (venue === "lighter" && venues.has("lighter")) {
			lighterClients.add(socket);
			trackSend(socket, { type: "connected", session_id: "bench" });
			socket.on("message", (data) => {
				let json: unknown;
				try {
					json = JSON.parse(String(data));
				} catch {
					return;
				}
				if (typeof json !== "object" || json === null) return;
				const frame = json as { type?: string; channel?: string };
				if (frame.type === "ping") {
					trackSend(socket, { type: "pong" });
					return;
				}
				if (frame.type === "pong") return;
				const channel = frame.channel ?? "";
				const idPart = channel.split(/[:/]/).pop();
				const marketId = Number(idPart);
				if (!Number.isInteger(marketId)) return;
				if (frame.type === "subscribe") lighterMarkets.add(marketId);
				if (frame.type === "unsubscribe") lighterMarkets.delete(marketId);
			});
			socket.on("close", () => lighterClients.delete(socket));
			return;
		}

		if (venue === "hydromancer" && venues.has("hydromancer")) {
			hydroClients.add(socket);
			socket.on("message", (data) => {
				let json: unknown;
				try {
					json = JSON.parse(String(data));
				} catch {
					return;
				}
				if (typeof json !== "object" || json === null) return;
				const frame = json as {
					method?: string;
					subscription?: { type?: string; coin?: string };
				};
				const coin = frame.subscription?.coin;
				if (typeof coin !== "string") return;
				if (frame.method === "subscribe") hydroCoins.add(coin);
				if (frame.method === "unsubscribe") hydroCoins.delete(coin);
			});
			socket.on("close", () => hydroClients.delete(socket));
			return;
		}

		if (venue === "pyth" && venues.has("pyth")) {
			pythClients.add(socket);
			socket.on("message", (data) => {
				let json: unknown;
				try {
					json = JSON.parse(String(data));
				} catch {
					return;
				}
				if (typeof json !== "object" || json === null) return;
				const frame = json as {
					type?: string;
					subscriptionId?: number;
					channel?: string;
					priceFeedIds?: unknown;
				};
				if (
					frame.type === "subscribe" &&
					typeof frame.subscriptionId === "number"
				) {
					const feedIds = Array.isArray(frame.priceFeedIds)
						? frame.priceFeedIds.filter(
								(id): id is number => typeof id === "number",
							)
						: [];
					pythFeeds.set(frame.subscriptionId, {
						channel: frame.channel ?? "fixed_rate@200ms",
						feedIds,
					});
					trackSend(socket, {
						type: "subscribed",
						subscriptionId: frame.subscriptionId,
					});
				}
				if (
					frame.type === "unsubscribe" &&
					typeof frame.subscriptionId === "number"
				) {
					pythFeeds.delete(frame.subscriptionId);
				}
			});
			socket.on("close", () => pythClients.delete(socket));
			return;
		}

		if (venue === "dxfeed" && venues.has("dxfeed")) {
			dxfeedClients.add(socket);
			socket.on("message", (data) => {
				let json: unknown;
				try {
					json = JSON.parse(String(data));
				} catch {
					return;
				}
				if (typeof json !== "object" || json === null) return;
				const frame = json as {
					type?: string;
					channel?: number;
					service?: string;
					add?: Array<{ symbol?: string; type?: string }>;
					remove?: Array<{ symbol?: string }>;
					reset?: boolean;
					acceptDataFormat?: string;
					acceptAggregationPeriod?: number;
				};

				if (frame.type === "SETUP") {
					trackSend(socket, {
						type: "SETUP",
						channel: 0,
						keepaliveTimeout: 60,
						acceptKeepaliveTimeout: 60,
						version: "0.1-js/1.0.0",
					});
					trackSend(socket, {
						type: "AUTH_STATE",
						channel: 0,
						state: "AUTHORIZED",
					});
					return;
				}
				if (frame.type === "AUTH") {
					trackSend(socket, {
						type: "AUTH_STATE",
						channel: 0,
						state: "AUTHORIZED",
					});
					return;
				}
				if (frame.type === "KEEPALIVE") {
					trackSend(socket, { type: "KEEPALIVE", channel: frame.channel ?? 0 });
					return;
				}
				if (
					frame.type === "CHANNEL_REQUEST" &&
					typeof frame.channel === "number"
				) {
					dxfeedChannels.set(socket, frame.channel);
					trackSend(socket, {
						type: "CHANNEL_OPENED",
						channel: frame.channel,
						service: frame.service ?? "FEED",
					});
					return;
				}
				if (frame.type === "FEED_SETUP" && typeof frame.channel === "number") {
					trackSend(socket, {
						type: "FEED_CONFIG",
						channel: frame.channel,
						aggregationPeriod: frame.acceptAggregationPeriod ?? 0,
						dataFormat: frame.acceptDataFormat ?? "FULL",
						eventFields: {
							Quote: [
								"eventType",
								"eventSymbol",
								"bidPrice",
								"askPrice",
								"bidSize",
								"askSize",
							],
						},
					});
					return;
				}
				if (frame.type === "FEED_SUBSCRIPTION") {
					if (frame.reset) dxfeedSymbols.clear();
					for (const item of frame.add ?? []) {
						if (typeof item.symbol === "string") dxfeedSymbols.add(item.symbol);
					}
					for (const item of frame.remove ?? []) {
						if (typeof item.symbol === "string")
							dxfeedSymbols.delete(item.symbol);
					}
				}
			});
			socket.on("close", () => {
				dxfeedClients.delete(socket);
				dxfeedChannels.delete(socket);
			});
			return;
		}

		socket.close();
	});

	const timers: ReturnType<typeof setInterval>[] = [];
	let seq = 0;

	const broadcast = (clients: Set<WsClient>, payload: unknown) => {
		for (const client of clients) trackSend(client, payload);
	};

	const startPumps = (rates: VenueRates) => {
		const every = (hz: number, fn: () => void) => {
			if (hz <= 0) return;
			const periodMs = Math.max(1, Math.round(1000 / hz));
			timers.push(setInterval(fn, periodMs));
			fn();
		};

		every(rates.binance, () => {
			if (binanceClients.size === 0 || binanceStreams.size === 0) return;
			const n = ++seq;
			for (const stream of binanceStreams) {
				const symbol = stream.split("@")[0]?.toUpperCase() ?? "UNKNOWN";
				const px = (50_000 + (n % 100)).toFixed(2);
				broadcast(binanceClients, {
					stream,
					data: {
						u: n,
						s: symbol,
						b: px,
						B: "1.2",
						a: (Number(px) + 0.02).toFixed(2),
						A: "0.8",
					},
				});
			}
		});

		every(rates.lighter, () => {
			if (lighterClients.size === 0 || lighterMarkets.size === 0) return;
			const n = ++seq;
			for (const marketId of lighterMarkets) {
				const px = (60_000 + (n % 50)).toFixed(1);
				broadcast(lighterClients, {
					channel: `ticker:${marketId}`,
					type: "update/ticker",
					timestamp: Date.now(),
					ticker: {
						s: `MKT${marketId}`,
						a: { price: px, size: "0.05" },
						b: { price: (Number(px) - 0.1).toFixed(1), size: "0.28" },
					},
				});
			}
		});

		every(rates.hydromancer, () => {
			if (hydroClients.size === 0 || hydroCoins.size === 0) return;
			const n = ++seq;
			for (const coin of hydroCoins) {
				const px = (1_000 + (n % 20)).toFixed(1);
				broadcast(hydroClients, {
					channel: "activeAssetCtx",
					seq: n,
					data: {
						coin,
						ctx: {
							oraclePx: px,
							markPx: px,
							midPx: px,
							impactPxs: [px, px],
							openInterest: "1000.5",
						},
					},
				});
			}
		});

		every(rates.pyth, () => {
			if (pythClients.size === 0 || pythFeeds.size === 0) return;
			const timestampUs = String(Date.now() * 1000);
			for (const [subscriptionId, sub] of pythFeeds) {
				broadcast(pythClients, {
					type: "streamUpdated",
					subscriptionId,
					parsed: {
						timestampUs,
						priceFeeds: sub.feedIds.map((priceFeedId) => ({
							priceFeedId,
							price: String(65_000_000_000 + priceFeedId),
							bestBidPrice: String(64_999_000_000),
							bestAskPrice: String(65_001_000_000),
							publisherCount: 19,
							exponent: -8,
							confidence: 1,
							marketSession: "regular",
						})),
					},
				});
			}
		});

		every(rates.dxfeed, () => {
			if (dxfeedClients.size === 0 || dxfeedSymbols.size === 0) return;
			const n = ++seq;
			const events = [...dxfeedSymbols].map((symbol) => ({
				eventType: "Quote",
				eventSymbol: symbol,
				bidPrice: 100 + (n % 10),
				askPrice: 100.1 + (n % 10),
				bidSize: 1.5,
				askSize: 2.5,
			}));
			for (const client of dxfeedClients) {
				trackSend(client, {
					type: "FEED_DATA",
					channel: dxfeedChannels.get(client) ?? 1,
					data: events,
				});
			}
		});
	};

	return {
		port,
		httpsOrigin: `https://127.0.0.1:${port}`,
		wssUrl: (venue) => `wss://127.0.0.1:${port}/${venue}`,
		framesSent: () => framesSent,
		connected: (venue) => {
			switch (venue) {
				case "binance":
					return binanceClients.size;
				case "lighter":
					return lighterClients.size;
				case "hydromancer":
					return hydroClients.size;
				case "pyth":
					return pythClients.size;
				case "dxfeed":
					return dxfeedClients.size;
			}
		},
		startPumps,
		stop: async () => {
			for (const timer of timers) clearInterval(timer);
			for (const client of wss.clients) client.terminate();
			wss.close();
			httpsServer.closeAllConnections?.();
			if (!httpsServer.listening) return;
			await Promise.race([
				new Promise<void>((resolve) => {
					httpsServer.close(() => resolve());
				}),
				new Promise<void>((resolve) => setTimeout(resolve, 500)),
			]);
		},
	};
};
