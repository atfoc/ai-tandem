// The numbers of the board bench (a dev tool: never in a shipped build, README.md here). What the frames of one gesture say,
// the summary per board, mode and gesture over the repetitions, and that summary as markdown. Used by the bench page
// (bench.tsx) and by the scripts that collect its result (webkit.mjs, device.mjs). DOM-free and Node-free.
//
// The result the page makes, posts and leaves in `window.aiwbBenchResult`:
//   { kind: "aiwb-board-bench", version: 1, startedAt, endedAt (ISO),
//     env: { userAgent, dpr, width, height, isolated (the page's messages to the app were held back during the run) },
//     config: { reps, gestureMs, boards: string[], modes: string[], gestures: string[] },
//     idleMs (the median frame interval with nothing moving: the display's refresh as the page sees it),
//     runs: [{ board, mode, gesture, rep, filter (the computed `filter` of the canvas),
//              blendLayers: { present, visible } (the replacement's `.aiwb-canvas-layer` divs: in the page, and drawn),
//              moved (the view changed),
//              intervals: number[] (ms, rounded to 0.1), ...frameStats(intervals, idleMs) }],
//     summary: summarize(runs) }

const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** The median of a list of numbers (NaN for none). */
export const median = (xs) => quantile([...xs].sort((a, b) => a - b), 0.5);

/** What the frames of one gesture say. `intervals`: the times between consecutive frames (ms); `nominalMs`: the interval of
 *  a frame that was on time (the idle one). A janky frame took longer than one and a half nominal intervals: it missed one. */
export function frameStats(intervals, nominalMs) {
  const sorted = [...intervals].sort((a, b) => a - b);
  const durationMs = intervals.reduce((s, v) => s + v, 0);
  const janky = intervals.filter((v) => v > 1.5 * nominalMs).length;
  return {
    frames: intervals.length,
    durationMs: round(durationMs),
    fps: durationMs > 0 ? round((intervals.length * 1000) / durationMs) : 0,
    meanMs: intervals.length ? round(durationMs / intervals.length, 2) : NaN,
    medianMs: round(quantile(sorted, 0.5), 2),
    p95Ms: round(quantile(sorted, 0.95), 2),
    maxMs: round(sorted[sorted.length - 1] ?? NaN, 1),
    jankyPct: intervals.length ? round((100 * janky) / intervals.length) : 0,
  };
}

const spread = (xs) => ({ mean: round(xs.reduce((s, v) => s + v, 0) / xs.length), min: round(Math.min(...xs)), max: round(Math.max(...xs)) });

/** One line per board, mode and gesture (in the order first met): fps, p95 and janky share over the repetitions. */
export function summarize(runs) {
  const groups = new Map();
  for (const r of runs) {
    const key = `${r.board}\u0000${r.mode}\u0000${r.gesture}`;
    if (!groups.has(key)) groups.set(key, { board: r.board, mode: r.mode, gesture: r.gesture, runs: [] });
    groups.get(key).runs.push(r);
  }
  return [...groups.values()].map((g) => ({
    board: g.board, mode: g.mode, gesture: g.gesture, reps: g.runs.length,
    fps: spread(g.runs.map((r) => r.fps)),
    p95Ms: spread(g.runs.map((r) => r.p95Ms)),
    jankyPct: spread(g.runs.map((r) => r.jankyPct)),
  }));
}

/** How a line's fps compares with plain light's on the same board and gesture: "within" when the ranges over the
 *  repetitions overlap, else the difference of the means in percent of light's. */
export function versusLight(line, summary) {
  const light = summary.find((s) => s.board === line.board && s.gesture === line.gesture && s.mode === "light");
  if (!light || line.mode === "light") return "";
  if (line.fps.max >= light.fps.min && line.fps.min <= light.fps.max) return "within";
  const pct = round((100 * (line.fps.mean - light.fps.mean)) / light.fps.mean, 0);
  return `${pct > 0 ? "+" : ""}${pct}%`;
}

const range = (s, unit = "") => `${s.mean}${unit} (${s.min}–${s.max})`;

/** The result as markdown: where it ran, then a table per board. */
export function formatSummary(result, title = "Board bench") {
  const e = result.env ?? {};
  const out = [
    `### ${title}`,
    "",
    `${e.userAgent ?? "?"}; ${e.width}×${e.height} CSS px at ${e.dpr}x; idle frame ${round(result.idleMs, 2)} ms; ` +
      `${result.config?.reps} repetitions of ${result.config?.gestureMs} ms; messages to the app ${e.isolated ? "held back" : "NOT held back"}; ` +
      `${result.startedAt ?? "?"} to ${result.endedAt ?? "?"}`,
  ];
  const summary = result.summary ?? summarize(result.runs ?? []);
  for (const board of [...new Set(summary.map((s) => s.board))]) {
    out.push("", `**${board}**`, "", "| mode | gesture | fps mean (min–max) | vs light | p95 frame ms | janky % |", "|---|---|---|---|---|---|");
    for (const s of summary.filter((x) => x.board === board)) {
      out.push(`| ${s.mode} | ${s.gesture} | ${range(s.fps)} | ${versusLight(s, summary)} | ${range(s.p95Ms)} | ${range(s.jankyPct)} |`);
    }
  }
  const still = (result.runs ?? []).filter((r) => !r.moved);
  if (still.length) out.push("", `**${still.length} run(s) did not move the view**: ${still.map((r) => `${r.board}/${r.mode}/${r.gesture}#${r.rep}`).join(", ")}`);
  return out.join("\n");
}
