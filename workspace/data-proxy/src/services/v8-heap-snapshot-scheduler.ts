import { mkdirSync } from "node:fs";
import { join } from "node:path";
import v8 from "node:v8";
import { Clock, Duration, Effect, Either, Schedule } from "effect";
import {
	V8_HEAP_SNAPSHOT_DIR,
	V8_HEAP_SNAPSHOT_ENABLED,
	V8_HEAP_SNAPSHOT_INTERVAL_MS,
} from "../constants";

const writeHeapSnapshot = (dir: string) =>
	Effect.try({
		try: () => {
			const filePath = join(dir, `heap-${Date.now()}.heapsnapshot`);
			return v8.writeHeapSnapshot(filePath);
		},
		catch: (cause) => cause,
	});

/**
 * Starts a background fiber that periodically writes a V8 heap snapshot (Chrome
 * `.heapsnapshot` format) for the running process.
 */
export const startV8HeapSnapshotDaemon = Effect.gen(function* () {
	const enabled = yield* V8_HEAP_SNAPSHOT_ENABLED;
	if (!enabled) {
		yield* Effect.logInfo(
			"V8 heap snapshots disabled (DATA_PROXY_V8_HEAP_SNAPSHOT_ENABLED)",
		);
		return;
	}

	const rawInterval = yield* V8_HEAP_SNAPSHOT_INTERVAL_MS;
	const intervalMs = Math.max(1_000, rawInterval);
	const dir = yield* V8_HEAP_SNAPSHOT_DIR;

	yield* Effect.logInfo(
		`V8 heap snapshots enabled every ${intervalMs} ms → ${dir}, writing initial snapshot..`,
	);

	mkdirSync(dir, { recursive: true });

	const snapshotEffect = Effect.gen(function* () {
		const result = yield* Effect.either(writeHeapSnapshot(dir));

		const memory = process.memoryUsage();
		yield* Effect.logInfo(
			`Process RSS: ${(memory.rss / (1024 * 1024)).toFixed(2)} MB`,
		);
		yield* Effect.logInfo(
			`Process Heap Total: ${(memory.heapTotal / (1024 * 1024)).toFixed(2)} MB`,
		);
		yield* Effect.logInfo(
			`Process Heap Used: ${(memory.heapUsed / (1024 * 1024)).toFixed(2)} MB`,
		);
		yield* Effect.logInfo(
			`Process Array Buffers Used: ${(memory.arrayBuffers / (1024 * 1024)).toFixed(2)} MB`,
		);
		yield* Effect.logInfo(
			`Process External Memory Used: ${(memory.external / (1024 * 1024)).toFixed(2)} MB`,
		);

		if (Either.isLeft(result)) {
			yield* Effect.logError(
				`Failed to write V8 heap snapshot: ${String(result.left)}`,
			);
		} else {
			yield* Effect.logInfo(`Wrote V8 heap snapshot: ${result.right}`);
		}
	});

	yield* snapshotEffect;

	yield* Effect.forkDaemon(
		snapshotEffect.pipe(
			Effect.schedule(Schedule.spaced(Duration.millis(intervalMs))),
		),
	);
});
