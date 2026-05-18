#!/usr/bin/env bun
// Temp smoketest: polls hydromancer /info { type: "l2Book" }, computes
// depth-based illiquidity weight w_I per tick, writes JSONL, prints summary.
//
// Usage:
//   bun smoketest-l2book.ts --sanity-only
//   bun smoketest-l2book.ts --duration-s 60 --interval-ms 1000
//
// Run against the smoke-test proxy started with config.smoke.json.

import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type Level = { px: string; sz: string; n: number };
type BookSnapshot = {
	coin: string;
	time: number;
	levels: [Level[], Level[]]; // [bids, asks]
};

interface Args {
	url: string;
	coins: string[];
	intervalMs: number;
	durationS: number;
	out: string;
	a: number;
	b: number;
	targetW: number;
	maxConsecutiveErrors: number;
	sanityOnly: boolean;
}

function parseArgs(): Args {
	const argv = process.argv.slice(2);
	const flag = (k: string) => argv.includes(`--${k}`);
	const get = (k: string, d?: string) => {
		const i = argv.indexOf(`--${k}`);
		return i === -1 ? d : argv[i + 1];
	};
	return {
		url: get("url", "http://localhost:5384/proxy/info") as string,
		coins: (get("coins", "BTC,ETH") as string).split(","),
		intervalMs: Number(get("interval-ms", "1000")),
		durationS: Number(get("duration-s", "60")),
		out: get("out", "smoketest-l2book.jsonl") as string,
		a: Number(get("a", "100000")),
		b: Number(get("b", "1000")),
		targetW: Number(get("target-w", "0.5")),
		maxConsecutiveErrors: Number(get("max-consecutive-errors", "5")),
		sanityOnly: flag("sanity-only"),
	};
}

// 5-minute half-life decay constant.
const LAMBDA = Math.log(2) / 300;

function computeWeight(xD: number, a: number, b: number): number {
	if (xD <= 0) return 0;
	return Math.min(Math.log(1 + (xD * b) / a) / Math.log(1 + b), 0.95);
}

function runSanityCheck(a: number, b: number): boolean {
	// Reference table only valid for defaults a=100_000, b=1_000.
	if (a !== 100_000 || b !== 1_000) {
		console.log(`(sanity table skipped, non-default a=${a} b=${b})`);
		return true;
	}
	const cases: Array<[number, number]> = [
		[0, 0.0],
		[1_000, 0.347],
		[10_000, 0.668],
		[100_000, 0.95],
		[1_000_000, 0.95],
	];
	const tol = 0.001;
	let ok = true;
	for (const [xD, want] of cases) {
		const got = computeWeight(xD, a, b);
		const pass = Math.abs(got - want) <= tol;
		if (!pass) ok = false;
		console.log(
			`${pass ? "ok  " : "FAIL"}  w_I(x_d=${xD}) = ${got.toFixed(4)} (want ${want.toFixed(4)})`,
		);
	}
	return ok;
}

interface CoinState {
	prevEma?: number;
	prevTickMs?: number;
}

interface TickRow {
	ts_ms: number;
	coin: string;
	ok: boolean;
	stale: boolean;
	error: string | null;
	mid: number | null;
	d_bid: number | null;
	d_ask: number | null;
	d_min: number | null;
	ema_depth: number | null;
	x_d: number | null;
	w_I: number;
	last_update_time_ms: number | null;
	lag_ms: number | null;
}

function bestPrice(levels: Level[]): number | null {
	if (levels.length === 0) return null;
	return Number(levels[0].px);
}

function depthInRange(
	levels: Level[],
	predicate: (px: number) => boolean,
): number {
	let sum = 0;
	for (const lvl of levels) {
		const px = Number(lvl.px);
		if (!predicate(px)) continue;
		const sz = Number(lvl.sz);
		sum += px * sz;
	}
	return sum;
}

function evalBook(
	book: BookSnapshot,
	state: CoinState,
	now: number,
	args: Args,
): TickRow {
	const lastUpdateTimeMs = book.time;
	const lagMs = now - lastUpdateTimeMs;
	const [bids, asks] = book.levels;
	const bestBid = bestPrice(bids);
	const bestAsk = bestPrice(asks);
	if (bestBid === null || bestAsk === null) {
		return {
			ts_ms: now,
			coin: book.coin,
			ok: true,
			stale: true,
			error: "empty_book",
			mid: null,
			d_bid: null,
			d_ask: null,
			d_min: null,
			ema_depth: state.prevEma ?? null,
			x_d: null,
			w_I: 0,
			last_update_time_ms: lastUpdateTimeMs,
			lag_ms: lagMs,
		};
	}
	const mid = (bestBid + bestAsk) / 2;
	const dBid = depthInRange(bids, (px) => px >= mid * 0.98 && px <= mid);
	const dAsk = depthInRange(asks, (px) => px >= mid && px <= mid * 1.02);
	const dMin = Math.min(dBid, dAsk);
	let ema: number;
	if (state.prevEma === undefined || state.prevTickMs === undefined) {
		ema = dMin;
	} else {
		const dtS = (now - state.prevTickMs) / 1000;
		const alpha = 1 - Math.exp(-LAMBDA * dtS);
		ema = state.prevEma + alpha * (dMin - state.prevEma);
	}
	state.prevEma = ema;
	state.prevTickMs = now;
	const xD = Math.min(ema, dMin);
	const wI = computeWeight(xD, args.a, args.b);
	return {
		ts_ms: now,
		coin: book.coin,
		ok: true,
		stale: false,
		error: null,
		mid,
		d_bid: dBid,
		d_ask: dAsk,
		d_min: dMin,
		ema_depth: ema,
		x_d: xD,
		w_I: wI,
		last_update_time_ms: lastUpdateTimeMs,
		lag_ms: lagMs,
	};
}

function quantile(sorted: number[], q: number): number {
	if (sorted.length === 0) return Number.NaN;
	const idx = (sorted.length - 1) * q;
	const lo = Math.floor(idx);
	const hi = Math.ceil(idx);
	if (lo === hi) return sorted[lo];
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function summarize(rows: TickRow[], args: Args): void {
	const total = rows.length;
	const errors = rows.filter((r) => !r.ok).length;
	const stales = rows.filter((r) => r.ok && r.stale).length;
	const live = rows.filter((r) => r.ok && !r.stale && r.error === null);
	const lags = rows
		.filter((r) => r.lag_ms !== null)
		.map((r) => r.lag_ms as number)
		.sort((x, y) => x - y);
	const wIs = live.map((r) => r.w_I).sort((x, y) => x - y);
	const dMins = live.map((r) => r.d_min as number).sort((x, y) => x - y);
	const xDs = live.map((r) => r.x_d as number).sort((x, y) => x - y);

	console.log("\n=== summary ===");
	console.log(
		`ticks: total=${total} live=${live.length} stale=${stales} error=${errors}`,
	);
	if (lags.length) {
		console.log(
			`lag_ms: p50=${quantile(lags, 0.5).toFixed(0)}  p90=${quantile(lags, 0.9).toFixed(0)}  p99=${quantile(lags, 0.99).toFixed(0)}  max=${lags[lags.length - 1]}`,
		);
	}
	if (wIs.length) {
		const mean = wIs.reduce((acc, v) => acc + v, 0) / wIs.length;
		const variance =
			wIs.reduce((acc, v) => acc + (v - mean) ** 2, 0) / wIs.length;
		const stddev = Math.sqrt(variance);
		console.log(
			`w_I:    min=${wIs[0].toFixed(4)}  p10=${quantile(wIs, 0.1).toFixed(4)}  p50=${quantile(wIs, 0.5).toFixed(4)}  p90=${quantile(wIs, 0.9).toFixed(4)}  max=${wIs[wIs.length - 1].toFixed(4)}  mean=${mean.toFixed(4)}  stddev=${stddev.toFixed(4)}`,
		);
	}
	if (dMins.length) {
		console.log(
			`d_min:  min=${dMins[0].toFixed(0)}  p10=${quantile(dMins, 0.1).toFixed(0)}  p50=${quantile(dMins, 0.5).toFixed(0)}  p90=${quantile(dMins, 0.9).toFixed(0)}  max=${dMins[dMins.length - 1].toFixed(0)}`,
		);
	}
	if (xDs.length) {
		const p50xD = quantile(xDs, 0.5);
		const aStar =
			(p50xD * args.b) /
			(Math.exp(args.targetW * Math.log(1 + args.b)) - 1);
		console.log(
			`tuning: p50_xD=${p50xD.toFixed(0)}  target_w_I=${args.targetW}  suggested a*=${aStar.toFixed(0)}`,
		);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function main() {
	const args = parseArgs();
	console.log("args:", JSON.stringify(args));
	console.log("\n=== sanity check ===");
	if (!runSanityCheck(args.a, args.b)) {
		console.error("sanity check failed, aborting");
		process.exit(1);
	}
	if (args.sanityOnly) return;

	const outPath = resolve(args.out);
	writeFileSync(outPath, "");
	console.log(`output: ${outPath}`);

	const states: Record<string, CoinState> = {};
	for (const c of args.coins) states[c] = {};
	const rows: TickRow[] = [];
	let consecutiveErrors = 0;
	const startTime = Date.now();
	const endTime = startTime + args.durationS * 1000;
	console.log(
		`\n=== polling ${args.url} every ${args.intervalMs}ms for ${args.durationS}s, coins=${args.coins.join(",")} ===`,
	);

	while (Date.now() < endTime) {
		const tickStart = Date.now();
		try {
			const res = await fetch(args.url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ type: "l2Book", coins: args.coins }),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
			const body = (await res.json()) as Record<string, BookSnapshot | null>;
			const now = Date.now();
			consecutiveErrors = 0;
			for (const coin of args.coins) {
				const book = body[coin];
				if (book == null) {
					const row: TickRow = {
						ts_ms: now,
						coin,
						ok: true,
						stale: true,
						error: "missing",
						mid: null,
						d_bid: null,
						d_ask: null,
						d_min: null,
						ema_depth: states[coin].prevEma ?? null,
						x_d: null,
						w_I: 0,
						last_update_time_ms: null,
						lag_ms: null,
					};
					rows.push(row);
					appendFileSync(outPath, `${JSON.stringify(row)}\n`);
					process.stdout.write(`${coin}: missing\n`);
					continue;
				}
				const row = evalBook(book, states[coin], now, args);
				rows.push(row);
				appendFileSync(outPath, `${JSON.stringify(row)}\n`);
				process.stdout.write(
					`${coin}: w_I=${row.w_I.toFixed(4)} d_min=${row.d_min?.toFixed(0) ?? "-"} ema=${row.ema_depth?.toFixed(0) ?? "-"} lag=${row.lag_ms ?? "-"}ms${row.stale ? " STALE" : ""}\n`,
				);
			}
		} catch (err) {
			consecutiveErrors++;
			const now = Date.now();
			const row: TickRow = {
				ts_ms: now,
				coin: "*",
				ok: false,
				stale: false,
				error: err instanceof Error ? err.message : String(err),
				mid: null,
				d_bid: null,
				d_ask: null,
				d_min: null,
				ema_depth: null,
				x_d: null,
				w_I: 0,
				last_update_time_ms: null,
				lag_ms: null,
			};
			rows.push(row);
			appendFileSync(outPath, `${JSON.stringify(row)}\n`);
			console.error(
				`tick error (${consecutiveErrors}/${args.maxConsecutiveErrors}):`,
				row.error,
			);
			if (consecutiveErrors >= args.maxConsecutiveErrors) {
				console.error("max consecutive errors hit, aborting");
				break;
			}
		}

		const elapsed = Date.now() - tickStart;
		if (elapsed < args.intervalMs) await sleep(args.intervalMs - elapsed);
	}

	summarize(rows, args);
	console.log(`\nwrote ${rows.length} rows to ${outPath}`);
}

main().catch((err) => {
	console.error("fatal:", err);
	process.exit(1);
});
