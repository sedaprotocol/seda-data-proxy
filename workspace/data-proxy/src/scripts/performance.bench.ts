/**
 * Application-level performance bench.
 *
 * Starts mock WSS venue backends on the host, runs the production Docker image
 * (bundled Node) against them, then drives the multi-endpoint HTTP API.
 *
 *   bun run bench:performance
 *   bun run bench:performance -- --quick
 *   bun run bench:performance -- --binance-hz 1000 --duration 10
 *   bun run bench:performance -- --venues binance,lighter
 *   bun run bench:performance -- --skip-build
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
	DEFAULT_MULTI_ENDPOINT_PATH,
	DEFAULT_MULTI_MAX_SUB_REQUESTS,
} from "../config/multi-endpoint-config";
import {
	DEFAULT_PROXY_ROUTE_GROUP,
	HAS_PRICE_KEY,
	PRIVATE_KEY_ENV_KEY,
} from "../constants";
import {
	type MockVenueServer,
	VENUES,
	type Venue,
	type VenueRates,
	startMockVenueServer,
} from "./mock-venue-servers";

const DOCKER_IMAGE = "seda-data-proxy:performance-bench";
const DOCKER_CONTAINER = "sdp-performance-bench";
const DOCKERFILE = ".build/docker/Dockerfile";
const PROXY_CONTAINER_PORT = 5384;
const MOCK_HOST_FROM_CONTAINER = "host.docker.internal";

const repoRoot = join(import.meta.dir, "../../../../");

const argMap = (() => {
	const out = new Map<string, string | boolean>();
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (!token.startsWith("--")) continue;
		const key = token.slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) {
			out.set(key, true);
			continue;
		}
		out.set(key, next);
		i++;
	}
	return out;
})();

const numArg = (key: string, fallback: number): number => {
	const raw = argMap.get(key);
	if (typeof raw !== "string") return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`--${key} must be a non-negative number, got ${raw}`);
	}
	return value;
};

const quick = argMap.has("quick");
const skipBuild = argMap.has("skip-build");
const verbose = argMap.has("verbose");
const imageName =
	typeof argMap.get("image") === "string"
		? (argMap.get("image") as string)
		: DOCKER_IMAGE;

const selectedVenues: Set<Venue> = (() => {
	const raw = argMap.get("venues");
	if (typeof raw !== "string" || raw.length === 0) return new Set(VENUES);
	const picked = raw.split(",").map((v) => v.trim()) as Venue[];
	for (const venue of picked) {
		if (!VENUES.includes(venue)) {
			throw new Error(`Unknown venue "${venue}". Valid: ${VENUES.join(", ")}`);
		}
	}
	return new Set(picked);
})();

const workload = {
	binanceSymbols: numArg("binance-symbols", 40),
	binanceHz: numArg("binance-hz", 25),
	lighterMarkets: numArg("lighter-markets", 20),
	lighterHz: numArg("lighter-hz", 10),
	dxfeedSymbols: numArg("dxfeed-symbols", 30),
	dxfeedHz: numArg("dxfeed-hz", 30),
	pythFeeds: numArg("pyth-feeds", 50),
	pythHz: numArg("pyth-hz", 5),
	hydroCoins: numArg("hydro-coins", 30),
	hydroHz: numArg("hydro-hz", 1),
	httpRps: numArg("http-rps", 30),
	warmupSeconds: numArg("warmup", quick ? 1 : 2),
	durationSeconds: numArg("duration", quick ? 2 : 5),
};

const symbols = (prefix: string, count: number): string[] =>
	Array.from({ length: count }, (_, i) => `${prefix}${i}`);

const binanceSymbols = symbols("B", workload.binanceSymbols).map(
	(s) => `${s}USDT`,
);
const lighterMarketIds = Array.from(
	{ length: workload.lighterMarkets },
	(_, i) => i + 1,
);
const dxfeedSymbols = symbols("DX", workload.dxfeedSymbols);
const pythFeedIds = Array.from({ length: workload.pythFeeds }, (_, i) => i + 1);
const hydroCoins = symbols("H", workload.hydroCoins);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const getFreePort = (): Promise<number> =>
	new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("Failed to allocate a TCP port"));
				return;
			}
			const port = address.port;
			server.close((err) => (err ? reject(err) : resolve(port)));
		});
	});

const percentile = (sorted: number[], p: number): number => {
	if (sorted.length === 0) return 0;
	const index = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
	);
	return sorted[index];
};

const formatInt = (n: number): string => Math.round(n).toLocaleString("en-US");

const pad = (value: string, width: number) => value.padEnd(width);

const printTable = (headers: string[], rows: string[][], widths: number[]) => {
	console.log(headers.map((h, i) => pad(h, widths[i])).join("  "));
	console.log(widths.map((w) => "-".repeat(w)).join("  "));
	for (const row of rows) {
		console.log(row.map((cell, i) => pad(cell, widths[i])).join("  "));
	}
};

const docker = (
	args: string[],
	options: { inherit?: boolean; input?: string } = {},
): { status: number; stdout: string; stderr: string } => {
	const result = spawnSync("docker", args, {
		encoding: "utf8",
		cwd: repoRoot,
		input: options.input,
		stdio: options.inherit ? "inherit" : "pipe",
	});
	if (result.error) {
		throw new Error(
			`Failed to run docker ${args[0] ?? ""}: ${result.error.message}`,
		);
	}
	return {
		status: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
};

const requireDocker = () => {
	const result = docker(["version"]);
	if (result.status !== 0) {
		throw new Error(
			`Docker is required for this bench.\n${result.stderr || result.stdout}`,
		);
	}
	if (!existsSync(join(repoRoot, DOCKERFILE))) {
		throw new Error(`Dockerfile not found at ${join(repoRoot, DOCKERFILE)}`);
	}
};

const imageExists = (name: string): boolean =>
	docker(["image", "inspect", name]).status === 0;

const buildImage = (name: string) => {
	console.log(`Building ${name} from ${DOCKERFILE} (production Node bundle)`);
	console.log("");
	const result = docker(["build", "-f", DOCKERFILE, "-t", name, "."], {
		inherit: true,
	});
	if (result.status !== 0) {
		throw new Error("Docker image build failed");
	}
	console.log("");
};

const removeContainer = (name: string) => {
	docker(["rm", "-f", name]);
};

const containerLogs = (name: string, tail = 80): string => {
	const result = docker(["logs", "--tail", String(tail), name]);
	return `${result.stdout}${result.stderr}`;
};

const parseDockerPercent = (raw: string): number | null => {
	const value = Number.parseFloat(raw.replace("%", "").trim());
	return Number.isFinite(value) ? value : null;
};

const startContainerStatsSampler = (name: string) => {
	const cpu: number[] = [];
	const mem: number[] = [];
	let stopped = false;
	let child: ReturnType<typeof spawn> | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const poll = () => {
		if (stopped) return;
		let output = "";
		child = spawn(
			"docker",
			["stats", "--no-stream", "--format", "{{.CPUPerc}}\t{{.MemPerc}}", name],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
		});
		child.on("close", () => {
			child = null;
			const [cpuRaw, memRaw] = output.trim().split("\t");
			const cpuValue = cpuRaw ? parseDockerPercent(cpuRaw) : null;
			const memValue = memRaw ? parseDockerPercent(memRaw) : null;
			if (cpuValue !== null) cpu.push(cpuValue);
			if (memValue !== null) mem.push(memValue);
			if (!stopped) timer = setTimeout(poll, 1000);
		});
	};
	poll();

	return {
		cpu,
		mem,
		stop: () => {
			stopped = true;
			if (timer) clearTimeout(timer);
			child?.kill("SIGTERM");
		},
	};
};

const mean = (values: number[]): number =>
	values.length === 0
		? 0
		: values.reduce((sum, value) => sum + value, 0) / values.length;

const buildConfigJson = (mock: MockVenueServer): unknown => {
	const origin = `https://${MOCK_HOST_FROM_CONTAINER}:${mock.port}`;
	const wssUrl = (venue: Venue) =>
		`wss://${MOCK_HOST_FROM_CONTAINER}:${mock.port}/${venue}`;

	const modules: Record<string, unknown>[] = [];
	const routes: Record<string, unknown>[] = [];

	if (selectedVenues.has("binance")) {
		modules.push({
			name: "bin",
			type: "binance",
			wsUrl: wssUrl("binance"),
			streamType: "bookTicker",
			subscriptionSymbols: binanceSymbols,
			maxSymbolsPerRequest: 200,
		});
		routes.push({
			type: "binance",
			moduleName: "bin",
			path: "/binance/:symbols",
			method: ["GET"],
			fetchFromModule: "{:symbols}",
		});
	}

	if (selectedVenues.has("lighter")) {
		modules.push({
			name: "lig",
			type: "lighter",
			wsUrl: wssUrl("lighter"),
			subscriptionSymbols: lighterMarketIds.map(String),
			maxSymbolsPerRequest: 200,
		});
		routes.push({
			type: "lighter",
			moduleName: "lig",
			path: "/lighter/:markets",
			method: ["GET"],
			fetchFromModule: "{:markets}",
		});
	}

	if (selectedVenues.has("dxfeed")) {
		modules.push({
			name: "dx",
			type: "dxfeed",
			webSocketUrl: wssUrl("dxfeed"),
			acceptAggregationPeriod: 0,
			subscriptions: dxfeedSymbols.map((symbol) => ({
				symbol,
				type: "Quote",
			})),
			maxFeedsPerRequest: 200,
		});
		routes.push({
			type: "dxfeed",
			moduleName: "dx",
			path: "/dxfeed/:symbols",
			method: ["GET"],
			fetchFromModule: "{:symbols}",
			eventType: "Quote",
		});
	}

	if (selectedVenues.has("pyth")) {
		modules.push({
			name: "pyth",
			type: "pyth-lazer",
			pythLazerApiKeyEnvKey: "PYTH_LAZER_API_KEY",
			streamUrls: [wssUrl("pyth")],
			metadataServiceUrl: origin,
			numConnections: 1,
			priceFeedIds: pythFeedIds.map((id) => ({
				name: `FEED-${id}`,
				id,
				channel: "fixed_rate@200ms",
			})),
			maxFeedsPerRequest: 200,
		});
		routes.push({
			type: "pyth-lazer",
			moduleName: "pyth",
			path: "/pyth/:ids",
			method: ["GET"],
			fetchFromModule: "{:ids}",
			channel: "fixed_rate@200ms",
		});
	}

	if (selectedVenues.has("hydromancer")) {
		modules.push({
			name: "hydro",
			type: "hydromancer",
			wsUrl: wssUrl("hydromancer"),
			restBaseUrl: origin,
			hydromancerApiKeyEnvKey: "HYDROMANCER_API_KEY",
			subscriptionCoins: hydroCoins,
			maxCoinsPerRequest: 200,
		});
		routes.push({
			type: "hydromancer",
			moduleName: "hydro",
			path: "/hydromancer/asset-context",
			method: ["POST"],
		});
	}

	return {
		routeGroup: DEFAULT_PROXY_ROUTE_GROUP,
		modules,
		routes,
		multiEndpoint: {
			enable: true,
			path: DEFAULT_MULTI_ENDPOINT_PATH,
			maxSubRequests: DEFAULT_MULTI_MAX_SUB_REQUESTS,
		},
	};
};

const buildMultiBody = (): Record<string, unknown> => {
	const body: Record<string, unknown> = {};
	if (selectedVenues.has("binance")) {
		body.binance = { path: `/binance/${binanceSymbols.join(",")}` };
	}
	if (selectedVenues.has("lighter")) {
		body.lighter = { path: `/lighter/${lighterMarketIds.join(",")}` };
	}
	if (selectedVenues.has("dxfeed")) {
		body.dxfeed = { path: `/dxfeed/${dxfeedSymbols.join(",")}` };
	}
	if (selectedVenues.has("pyth")) {
		body.pyth = { path: `/pyth/${pythFeedIds.join(",")}` };
	}
	if (selectedVenues.has("hydromancer")) {
		body.hydro = {
			path: "/hydromancer/asset-context",
			method: "POST",
			body: { type: "assetContext", coins: hydroCoins },
		};
	}
	return body;
};

const ratesFor = (): VenueRates => ({
	binance: selectedVenues.has("binance") ? workload.binanceHz : 0,
	lighter: selectedVenues.has("lighter") ? workload.lighterHz : 0,
	dxfeed: selectedVenues.has("dxfeed") ? workload.dxfeedHz : 0,
	pyth: selectedVenues.has("pyth") ? workload.pythHz : 0,
	hydromancer: selectedVenues.has("hydromancer") ? workload.hydroHz : 0,
});

type RequestSample = {
	ms: number;
	ok: boolean;
	status: number;
	bytes: number;
	missingPrice: boolean;
};

const fireMulti = async (
	url: string,
	bodyText: string,
): Promise<RequestSample> => {
	const started = performance.now();
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: bodyText,
		});
		const text = await response.text();
		return {
			ms: performance.now() - started,
			ok: response.ok,
			status: response.status,
			bytes: text.length,
			missingPrice: text.includes(`"${HAS_PRICE_KEY}":false`),
		};
	} catch {
		return {
			ms: performance.now() - started,
			ok: false,
			status: 0,
			bytes: 0,
			missingPrice: false,
		};
	}
};

const waitForHttp = async (url: string, timeoutMs: number): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	let lastError = "timeout";
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url);
			if (response.ok || response.status < 500) return;
			lastError = `HTTP ${response.status}`;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await sleep(200);
	}
	throw new Error(`Proxy did not become ready at ${url}: ${lastError}`);
};

const waitForClients = async (
	mock: MockVenueServer,
	timeoutMs: number,
): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const pending = [...selectedVenues].filter(
			(venue) => mock.connected(venue) === 0,
		);
		if (pending.length === 0) return;
		await sleep(50);
	}
	const missing = [...selectedVenues].filter(
		(venue) => mock.connected(venue) === 0,
	);
	if (missing.length > 0) {
		console.warn(
			`Timed out waiting for proxy WS clients: ${missing.join(", ")}`,
		);
	}
};

const startProxyContainer = (options: {
	image: string;
	configPath: string;
	hostPort: number;
	privateKeyHex: string;
}): string => {
	removeContainer(DOCKER_CONTAINER);
	const args = [
		"run",
		"-d",
		"--name",
		DOCKER_CONTAINER,
		"--add-host",
		`${MOCK_HOST_FROM_CONTAINER}:host-gateway`,
		"-p",
		`127.0.0.1:${options.hostPort}:${PROXY_CONTAINER_PORT}`,
		"-v",
		`${options.configPath}:/app/config.json:ro`,
		"-e",
		`${PRIVATE_KEY_ENV_KEY}=${options.privateKeyHex}`,
		"-e",
		"PYTH_LAZER_API_KEY=bench-token",
		"-e",
		"HYDROMANCER_API_KEY=bench-token",
		"-e",
		"NODE_TLS_REJECT_UNAUTHORIZED=0",
		"-e",
		"LOG_LEVEL=Warning",
		options.image,
		"run",
		"--disable-proof",
		"--skip-registration-check",
		"-n",
		"devnet",
		"-c",
		"/app/config.json",
		"-p",
		String(PROXY_CONTAINER_PORT),
	];
	const result = docker(args);
	if (result.status !== 0) {
		throw new Error(
			`Failed to start proxy container:\n${result.stderr || result.stdout}`,
		);
	}
	const id = result.stdout.trim();
	if (verbose) {
		spawn("docker", ["logs", "-f", DOCKER_CONTAINER], {
			stdio: "inherit",
		});
	}
	return id;
};

const main = async () => {
	console.log(
		"Performance bench against the production Docker proxy + mock WSS venues",
	);
	console.log("");
	console.log(`Venues:  ${[...selectedVenues].join(", ")}`);
	if (selectedVenues.has("binance")) {
		console.log(
			`  Binance       ${workload.binanceSymbols} symbols @ ${workload.binanceHz} Hz`,
		);
	}
	if (selectedVenues.has("lighter")) {
		console.log(
			`  Lighter       ${workload.lighterMarkets} markets @ ${workload.lighterHz} Hz`,
		);
	}
	if (selectedVenues.has("dxfeed")) {
		console.log(
			`  DxFeed        ${workload.dxfeedSymbols} symbols @ ${workload.dxfeedHz} Hz`,
		);
	}
	if (selectedVenues.has("pyth")) {
		console.log(
			`  Pyth          ${workload.pythFeeds} feeds @ ${workload.pythHz} Hz envelopes`,
		);
	}
	if (selectedVenues.has("hydromancer")) {
		console.log(
			`  Hydromancer   ${workload.hydroCoins} coins @ ${workload.hydroHz} Hz`,
		);
	}
	console.log(
		`HTTP:    ${workload.httpRps} multi-endpoint req/s for ${workload.durationSeconds}s (${workload.warmupSeconds}s warmup)`,
	);
	console.log(`Image:   ${imageName}`);
	if (quick) console.log("mode:    --quick");
	console.log("");

	requireDocker();
	if (!skipBuild || !imageExists(imageName)) {
		buildImage(imageName);
	} else {
		console.log(`Reusing existing image ${imageName} (--skip-build)`);
		console.log("");
	}

	const workDir = mkdtempSync(join(tmpdir(), "sdp-performance-bench-"));
	const configPath = join(workDir, "config.json");
	const mock = await startMockVenueServer(selectedVenues);
	const proxyPort = await getFreePort();
	writeFileSync(
		configPath,
		`${JSON.stringify(buildConfigJson(mock), null, 2)}\n`,
	);

	const privateKeyHex = randomBytes(32).toString("hex");
	let succeeded = false;
	let statsSampler: ReturnType<typeof startContainerStatsSampler> | null = null;
	const multiUrl = `http://127.0.0.1:${proxyPort}/proxy/multi`;
	const bodyText = JSON.stringify(buildMultiBody());

	try {
		startProxyContainer({
			image: imageName,
			configPath,
			hostPort: proxyPort,
			privateKeyHex,
		});

		try {
			await waitForHttp(`http://127.0.0.1:${proxyPort}/status`, 30_000);
		} catch (error) {
			console.error(containerLogs(DOCKER_CONTAINER));
			throw error;
		}

		statsSampler = startContainerStatsSampler(DOCKER_CONTAINER);
		await waitForClients(mock, 15_000);
		mock.startPumps(ratesFor());

		const warmupDeadline = Date.now() + workload.warmupSeconds * 1000;
		let warmed = false;
		while (Date.now() < warmupDeadline) {
			const sample = await fireMulti(multiUrl, bodyText);
			if (sample.ok && !sample.missingPrice) {
				warmed = true;
				break;
			}
			await sleep(100);
		}
		if (!warmed) {
			const probe = await fireMulti(multiUrl, bodyText);
			console.warn(
				`Warmup ended without a fully priced response (status ${probe.status}, missingPrice=${probe.missingPrice})`,
			);
			if (!probe.ok) {
				console.error(containerLogs(DOCKER_CONTAINER));
			}
		}

		const samples: RequestSample[] = [];
		const intervalMs = 1000 / Math.max(workload.httpRps, 1);
		const loadStarted = performance.now();
		const loadDurationMs = workload.durationSeconds * 1000;

		let next = loadStarted;
		const inflight: Promise<void>[] = [];
		while (performance.now() - loadStarted < loadDurationMs) {
			const now = performance.now();
			if (now < next) await sleep(next - now);
			next += intervalMs;
			inflight.push(
				fireMulti(multiUrl, bodyText).then((sample) => {
					samples.push(sample);
				}),
			);
		}
		await Promise.all(inflight);
		const cpuSamples = statsSampler?.cpu ?? [];
		const memSamples = statsSampler?.mem ?? [];

		const elapsedMs = performance.now() - loadStarted;
		const ok = samples.filter((s) => s.ok);
		const latencies = [...ok.map((s) => s.ms)].sort((a, b) => a - b);
		const errors = samples.length - ok.length;
		const missing = samples.filter((s) => s.missingPrice).length;
		const bytes = ok.length > 0 ? ok[0].bytes : 0;
		const cpuSorted = [...cpuSamples].sort((a, b) => a - b);
		const memSorted = [...memSamples].sort((a, b) => a - b);

		console.log("Results");
		console.log("");
		printTable(
			["metric", "value"],
			[
				["HTTP requests", formatInt(samples.length)],
				["success", formatInt(ok.length)],
				["errors", formatInt(errors)],
				[`missing ${HAS_PRICE_KEY}`, formatInt(missing)],
				["achieved RPS", (samples.length / (elapsedMs / 1000)).toFixed(1)],
				["response bytes", formatInt(bytes)],
				["latency p50 (ms)", percentile(latencies, 50).toFixed(2)],
				["latency p95 (ms)", percentile(latencies, 95).toFixed(2)],
				["latency p99 (ms)", percentile(latencies, 99).toFixed(2)],
				["latency max (ms)", (latencies.at(-1) ?? 0).toFixed(2)],
				[
					"container CPU avg",
					cpuSorted.length === 0 ? "n/a" : `${mean(cpuSorted).toFixed(1)}%`,
				],
				[
					"container CPU max",
					cpuSorted.length === 0
						? "n/a"
						: `${(cpuSorted.at(-1) ?? 0).toFixed(1)}%`,
				],
				[
					"container mem avg",
					memSorted.length === 0 ? "n/a" : `${mean(memSorted).toFixed(1)}%`,
				],
				["mock frames sent", formatInt(mock.framesSent())],
				[
					"mock clients",
					[...selectedVenues]
						.map((venue) => `${venue}=${mock.connected(venue)}`)
						.join(" "),
				],
			],
			[28, 48],
		);
		console.log("");
		console.log(
			"Proxy runs as the production Node bundle in Docker. CPU% is docker stats (share of host CPUs). Compare HTTP latency and error rate across code changes; raise --binance-hz etc to stress ingest.",
		);
		succeeded = true;
	} finally {
		statsSampler?.stop();
		removeContainer(DOCKER_CONTAINER);
		await Promise.race([mock.stop(), sleep(500)]);
		rmSync(workDir, { recursive: true, force: true });
	}
	process.exit(succeeded ? 0 : 1);
};

if (import.meta.main) {
	await main();
}
