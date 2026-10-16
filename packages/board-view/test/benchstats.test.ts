// The numbers of the board bench (dev/bench/stats.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error: a plain .mjs of the dev tools, without types
import { formatSummary, frameStats, median, summarize, versusLight } from "../dev/bench/stats.mjs";

test("frameStats: rate, quantiles and the frames that missed one", () => {
  const s = frameStats([16.7, 16.7, 16.6, 33.3, 16.7], 16.7);
  assert.equal(s.frames, 5);
  assert.equal(s.durationMs, 100);
  assert.equal(s.fps, 50);
  assert.equal(s.medianMs, 16.7);
  assert.equal(s.maxMs, 33.3);
  assert.equal(s.jankyPct, 20);
  assert.equal(median([3, 1, 2]), 2);
});

test("summarize and versusLight: ranges over the repetitions, overlap is within", () => {
  const run = (mode: string, rep: number, fps: number) => ({ board: "large", mode, gesture: "pan", rep, fps, p95Ms: 1000 / fps, jankyPct: 0, moved: true });
  const runs = [run("light", 1, 58), run("light", 2, 60), run("dark", 1, 20), run("dark", 2, 24), run("dark-css", 1, 57), run("dark-css", 2, 59)];
  const summary = summarize(runs);
  assert.deepEqual(summary.map((s: any) => s.mode), ["light", "dark", "dark-css"]);
  assert.deepEqual(summary[1].fps, { mean: 22, min: 20, max: 24 });
  assert.equal(versusLight(summary[2], summary), "within");
  assert.equal(versusLight(summary[1], summary), "-63%");
  const md = formatSummary({ env: { userAgent: "x", width: 1, height: 1, dpr: 3, isolated: true }, idleMs: 16.7, config: { reps: 2, gestureMs: 4000 }, runs, summary });
  assert.match(md, /\| dark \| pan \| 22 \(20–24\) \| -63% \|/);
});
