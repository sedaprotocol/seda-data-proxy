import { Metric, MetricBoundaries, MetricLabel } from "effect";

/**
 * Always-on ingest metrics. Updated with `unsafeUpdate` so the WebSocket tick
 * path can stay plain JavaScript (no Effect, no spans). See DEVELOPING.md.
 *
 * `ws_tick_messages` counts cache writes. `ws_tick_handle_duration_ms` is the
 * wall time of one inbound callback (one envelope for Pyth/DxFeed).
 */
const tickMessages = Metric.counter("ws_tick_messages", {
	description:
		"Inbound WebSocket market-data updates written to the price cache",
	incremental: true,
}).register();

const tickHandleDurationMs = Metric.histogram(
	"ws_tick_handle_duration_ms",
	MetricBoundaries.fromIterable([
		0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100,
	]),
	"Duration in ms of applying one inbound WebSocket tick callback",
).register();

const labelCache = new Map<string, readonly MetricLabel.MetricLabel[]>();

const labelsFor = (
	venue: string,
	moduleName: string,
): readonly MetricLabel.MetricLabel[] => {
	const key = `${venue}:${moduleName}`;
	const cached = labelCache.get(key);
	if (cached !== undefined) {
		return cached;
	}
	const labels = [
		MetricLabel.make("venue", venue),
		MetricLabel.make("module", moduleName),
	] as const;
	labelCache.set(key, labels);
	return labels;
};

export const recordTickHandle = (
	venue: string,
	moduleName: string,
	durationMs: number,
	applied = 1,
): void => {
	if (applied <= 0) {
		return;
	}
	const labels = labelsFor(venue, moduleName);
	tickMessages.unsafeUpdate(applied, labels);
	tickHandleDurationMs.unsafeUpdate(durationMs, labels);
};
