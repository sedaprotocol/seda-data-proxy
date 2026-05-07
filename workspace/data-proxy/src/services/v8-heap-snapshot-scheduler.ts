import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import v8 from "node:v8";
import { Clock, Duration, Effect, Either, Schedule } from "effect";
import {
	V8_HEAP_SNAPSHOT_DIR,
	V8_HEAP_SNAPSHOT_ENABLED,
	V8_HEAP_SNAPSHOT_INTERVAL_MS,
} from "../constants";

type ProcessWithInternals = NodeJS.Process & {
	_getActiveHandles?: () => unknown[];
	_getActiveRequests?: () => unknown[];
};

const writeHeapSnapshot = (dir: string) =>
	Effect.try({
		try: () => {
			const filePath = join(dir, `heap-${Date.now()}.heapsnapshot`);
			return v8.writeHeapSnapshot(filePath);
		},
		catch: (cause) => cause,
	});

const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(2);
const formatDelayMs = (ns: number) => (ns / 1e6).toFixed(1);

const safeJson = (value: unknown) => {
	try {
		return JSON.stringify(value);
	} catch {
		return null;
	}
};

const tryGetOpenFdCount = () => {
	// Linux-only, but safe to attempt.
	try {
		return readdirSync("/proc/self/fd").length;
	} catch {
		return null;
	}
};

/**
 * Starts a background fiber that periodically writes a V8 heap snapshot (Chrome
 * `.heapsnapshot` format) for the running process.
 */
export const startV8HeapSnapshotDaemon = Effect.gen(function* () {
	const rawInterval = yield* V8_HEAP_SNAPSHOT_INTERVAL_MS;
	const intervalMs = Math.max(1_000, rawInterval);
	const dir = yield* V8_HEAP_SNAPSHOT_DIR;
	const heapSnapshotEnabled = yield* V8_HEAP_SNAPSHOT_ENABLED;

	yield* Effect.logInfo(
		`Process memory metrics enabled every ${intervalMs} ms`,
	);

	const elDelay = monitorEventLoopDelay({ resolution: 20 });
	elDelay.enable();
	let lastElu = performance.eventLoopUtilization?.();

	const snapshotEffect = Effect.gen(function* () {
		const memory = process.memoryUsage();
		const resource = process.resourceUsage?.();
		const openFds = tryGetOpenFdCount();

		for (const [key, value] of Object.entries(memory)) {
			yield* Effect.logInfo(`memory[${key}]: ${mb(value)} MB`);
		}

		if (openFds !== null) {
			yield* Effect.logInfo(`proc[openFds]: ${openFds}`);
		}

		const proc = process as ProcessWithInternals;
		const activeHandles =
			typeof proc._getActiveHandles === "function"
				? proc._getActiveHandles().length
				: null;
		const activeRequests =
			typeof proc._getActiveRequests === "function"
				? proc._getActiveRequests().length
				: null;

		yield* Effect.logInfo(`proc[activeHandles]: ${activeHandles ?? "n/a"}`);
		yield* Effect.logInfo(`proc[activeRequests]: ${activeRequests ?? "n/a"}`);

		const eluNow = performance.eventLoopUtilization?.();
		const elu =
			eluNow && lastElu && performance.eventLoopUtilization
				? performance.eventLoopUtilization(eluNow, lastElu)
				: null;
		lastElu = eluNow ?? lastElu;

		if (elu) {
			yield* Effect.logInfo(
				`eventLoop[utilization]: ${(elu.utilization * 100).toFixed(1)}%`,
			);
		}
		yield* Effect.logInfo(
			`eventLoop[delayMs p50/p99/max]: ${formatDelayMs(elDelay.percentile(50))}/${formatDelayMs(elDelay.percentile(99))}/${formatDelayMs(elDelay.max)}`,
		);
		elDelay.reset();

		const heapStats = (() => {
			try {
				return v8.getHeapStatistics();
			} catch {
				return null;
			}
		})();

		if (heapStats) {
			yield* Effect.logInfo(
				`v8[heap total/used/limit MB]: ${mb(heapStats.total_heap_size)}/${mb(heapStats.used_heap_size)}/${mb(heapStats.heap_size_limit)}`,
			);
			yield* Effect.logInfo(
				`v8[heap malloced MB]: ${mb(heapStats.malloced_memory)}`,
			);
		}

		const heapSpaceStats = (() => {
			try {
				return v8.getHeapSpaceStatistics();
			} catch {
				return null;
			}
		})();

		if (heapSpaceStats) {
			const summary = heapSpaceStats.map((s) => ({
				space: s.space_name,
				sizeMB: Number(mb(s.space_size)),
				usedMB: Number(mb(s.space_used_size)),
				availableMB: Number(mb(s.space_available_size)),
				physicalMB: Number(mb(s.physical_space_size)),
			}));
			for (const element of summary) {
				const { space, ...rest } = element;
				const json = safeJson(rest);
				if (json) {
					yield* Effect.logInfo(`v8[heapSpaces][${space}]: ${json}`);
				}
			}
		}

		// Bun-only extras (safe to access conditionally).
		const bunMem =
			typeof Bun !== "undefined" &&
			"memoryUsage" in Bun &&
			typeof Bun.memoryUsage === "function"
				? Bun.memoryUsage()
				: null;
		if (bunMem) {
			const json = safeJson(bunMem);
			if (json) {
				yield* Effect.logInfo(`bun[memoryUsage]: ${json}`);
			}
		}

		if (resource) {
			// Note: these aren't bytes; keep them as raw numeric counters.
			for (const [key, value] of Object.entries(resource)) {
				yield* Effect.logInfo(`resource[${key}]: ${String(value)}`);
			}
		}

		if (heapSnapshotEnabled) {
			mkdirSync(dir, { recursive: true });
			const result = yield* Effect.either(writeHeapSnapshot(dir));

			if (result && Either.isLeft(result)) {
				yield* Effect.logError(
					`Failed to write V8 heap snapshot: ${String(result.left)}`,
				);
			} else if (result) {
				yield* Effect.logInfo(`Wrote V8 heap snapshot: ${result.right}`);
			}
		}
	});

	yield* snapshotEffect;

	yield* Effect.forkDaemon(
		snapshotEffect.pipe(
			Effect.schedule(Schedule.spaced(Duration.millis(intervalMs))),
		),
	);
});
