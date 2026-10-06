import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  K, LEGEND, STATES, WRITE_OPS, buildAxis, chainOf, declaredWait, directEdges, edgeKind, gapLabels, isLive, relatedSide, laneTailSentence, lastAttempt, layoutTimeline,
  needsOf, opsSummary, planUnchanged, rowTier, stoppedMs, tailOf, tailSentence, taskState, tierWord, timeTicks, waitEnd, waitLabel, waitText, writerBusy,
  type Layout, type TLBar, type TLOp, type TLOutcome, type TLPhase, type TLPhaseKind, type TLRow, type TLRunWait, type TLTail, type TLTask,
} from "../src/logic/runtimeline.ts";
import { failNow, freeze, synthesize, type ScRun, type ScTask, type ScTurn } from "./fixtures/runscenario.ts";

const M = 60000, T0 = 1_700_000_000_000;
const at = (min: number) => T0 + min * M;
type TaskExtra = { deps?: string[]; writes?: boolean; merged?: boolean; conflicts?: string[] };
/** A task with one attempt: phases as [kind, minute, extra?], an end as [minute, outcome]. */
function task(id: string, turn: number, addMin: number, phases: [TLPhaseKind, number, Partial<TLPhase>?][], end?: [number, TLOutcome] | null, extra: TaskExtra = {}): ScTask {
  const ph = phases.map(([k, m, x]): TLPhase => ({ k, t: at(m), ...(x ?? {}) }));
  const started = ph.find((p) => p.k === "setup" || p.k === "work");
  return {
    id, title: id, kind: "fix", writes: !!extra.writes, dependsOn: extra.deps ?? [], addedTurn: turn, createdAt: at(addMin),
    attempts: [{ n: 1, queuedTurn: turn, queuedAt: at(addMin), phases: ph, startedAt: started?.t ?? null, endedAt: end ? at(end[0]) : null, outcome: end ? end[1] : null, mergedAt: extra.merged && end ? at(end[0]) : null, conflicts: extra.conflicts ?? [] }],
  };
}
/** A turn from minute a to minute b (null: still running): ops as [op, minute, extra?], and the tasks that woke it. */
const turn = (n: number, a: number, b: number | null, ops: [string, number, Partial<TLOp>?][] = [], woken: string[] = []): ScTurn => ({
  n, startedAt: at(a), endedAt: b == null ? null : at(b), status: b == null ? "running" : "done",
  ops: ops.map(([op, m, x], i) => ({ op, t: at(m), i, ...(x ?? {}) })), wokenBy: woken.map((t) => ({ task: t })),
});
/** A finished run of 100 minutes: A runs first, B waits on it and merges, C is added after A is done. */
function small(over: Partial<ScRun> = {}): ScRun {
  return {
    status: "completed", createdAt: at(0), endedAt: at(100), stops: [], limits: {},
    turns: [turn(1, 0, 10, [["set_notes", 2], ["add_task", 4, { task: "A" }], ["add_task", 6, { task: "B" }]]), turn(2, 40, 44, [["add_task", 42, { task: "C" }]], ["A"]), turn(3, 60, 61, [["get_task", 60.5, { task: "B" }]], ["B"])],
    tasks: [
      task("A", 1, 4, [["held", 4, { turn: 1 }], ["setup", 10], ["work", 10.2]], [40, "done"]),
      task("B", 1, 6, [["held", 6, { turn: 1 }], ["deps", 10, { on: ["A"] }], ["slot", 40], ["setup", 45], ["work", 45.5], ["merge", 59]], [60, "done"], { deps: ["A"], writes: true, merged: true }),
      task("C", 2, 42, [["held", 42, { turn: 2 }], ["setup", 44], ["work", 44.1]], [90, "done"], { deps: ["A"] }),
    ], ...over,
  };
}
const near = (a: number, b: number, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
/** The row's last segment, which must be an attempt bar. */
function lastBar(r: TLRow): TLBar {
  const s = r.segs.at(-1);
  assert.ok(s && s.k === "bar", `${r.id} ends with a bar`);
  return s;
}
/** The row's tail, which must be there. */
function tailOfRow(r: TLRow): TLTail {
  assert.ok(r.tail, `${r.id} has a tail`);
  return r.tail;
}
/** A layout without the two functions of its axis, so two layouts can be compared deeply. */
const plain = (L: Layout) => ({ ...L, axis: { ...L.axis, x: null, t: null } });
const qaRun = (): ScRun => JSON.parse(readFileSync(new URL("./fixtures/run-qa.json", import.meta.url), "utf8"));

test("axis, fit: the run fills the width; the map and its inverse agree", () => {
  const ax = buildAxis(small(), { width: 500, now: at(100) });
  near(ax.x(at(0)), K.PAD_L); near(ax.x(at(100)), 500 - K.PAD_R);
  near(ax.ppm, (500 - K.PAD_L - K.PAD_R) / 100);
  near(ax.t(ax.x(at(37))), at(37), 1);
  assert.equal(ax.width, 500);
  near(ax.x(at(110)) - ax.x(at(100)), 10 * ax.ppm); // It continues with the last slope.
});

test("axis, fixed zoom: the content grows past the viewport", () => {
  const ax = buildAxis(small(), { width: 500, ppm: 8, now: at(100) });
  near(ax.x(at(50)), K.PAD_L + 400);
  assert.equal(ax.width, K.PAD_L + 800 + K.PAD_R);
  assert.equal(ax.ppm, 8);
});

test("axis, a stop → resume break is GAP_W wide whatever its length, and fit leaves room for it", () => {
  const run = small({ endedAt: at(100 + 600), stops: [{ at: at(50), resumedAt: at(650) }] });
  const ax = buildAxis(run, { width: 500, now: at(700) });
  near(ax.x(at(650)) - ax.x(at(50)), K.GAP_W);
  near(ax.x(at(700)), 500 - K.PAD_R);
  near(ax.x(at(50)) - ax.x(at(0)), ax.x(at(700)) - ax.x(at(650))); // 50 working minutes on each side.
  assert.deepEqual(ax.gaps.map((g) => [Math.round(g.x2 - g.x1), g.open]), [[K.GAP_W, false]]);
  assert.ok(timeTicks(ax).every((t) => t.t <= at(50) || t.t >= at(650)), "no tick inside the break");
});

test("axis, live: room right of now, and now is the last anchor", () => {
  const run = freeze(small(), at(50));
  const ax = buildAxis(run, { width: 600, now: at(50) });
  assert.equal(ax.future, K.FUTURE);
  near(ax.x(at(50)), 600 - K.PAD_R - K.FUTURE);
  assert.deepEqual(ax.anchors.at(-1), { t: at(50), x: ax.x1 });
  assert.equal(buildAxis(run, { width: 300, now: at(50) }).future, K.FUTURE_MIN);
  assert.equal(isLive(run), true); assert.equal(isLive({ status: "stopping" }), true); assert.equal(isLive({ status: "stalled" }), false);
});

test("axis, a halted run ends where it stopped", () => {
  const run: ScRun = { ...freeze(small(), at(50)), status: "stopped", stops: [{ at: at(50), resumedAt: null }] };
  const ax = buildAxis(run, { width: 500, now: at(500) });
  assert.equal(ax.t1, at(50)); assert.equal(ax.gaps.length, 0); assert.equal(ax.future, 0);
});

test("ticks: round clock times, far enough apart", () => {
  const ax = buildAxis(small(), { width: 500, now: at(100) });
  const ticks = timeTicks(ax);
  assert.ok(ticks.length >= 2);
  for (const t of ticks) assert.equal(t.t % t.step, 0);
  for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i].x - ticks[i - 1].x >= K.TICK_MIN * 0.75);
});

test("ticks: round in local time when a zone offset is given", () => {
  const ax = buildAxis(small(), { width: 500, now: at(100) });
  const local = timeTicks(ax, 7);
  assert.ok(local.length >= 2);
  for (const t of local) { assert.equal((t.t + 7 * M) % t.step, 0); assert.notEqual(t.t % t.step, 0); }
  assert.deepEqual(layoutTimeline(small(), { width: 500, now: at(100), tzOffsetMin: 7 }).ticks, local);
});

test("rows: creation order, one group per adding turn, the filter keeps order", () => {
  const L = layoutTimeline(small(), { width: 500, now: at(100) });
  assert.deepEqual(L.rows.map((r) => [r.id, r.turn, r.first, r.y]), [["A", 1, true, 0], ["B", 1, false, K.ROW], ["C", 2, true, 2 * K.ROW]]);
  assert.equal(L.height, 3 * K.ROW);
  const F = layoutTimeline(small(), { width: 500, now: at(100), only: new Set(["B", "C"]) });
  assert.deepEqual(F.rows.map((r) => [r.id, r.first, r.y]), [["B", true, 0], ["C", true, K.ROW]]);
});

test("a task row: waits as lines, one bar per attempt, marks, no zero-length segment", () => {
  const L = layoutTimeline(small(), { width: 500, now: at(100) }), X = L.axis.x;
  const b = L.rows[1], bar = lastBar(b);
  assert.deepEqual(b.segs.map((s) => s.k), ["queued", "deps", "queued", "bar"]); // held and "no slot" are one line
  near(b.segs[0].x1, X(at(6))); near(b.segs[1].x2, X(at(40))); near(bar.x1, X(at(45))); near(bar.x2, X(at(60)));
  assert.deepEqual(b.segs[1].k === "deps" && b.segs[1].on, ["A"]);
  assert.equal(bar.outcome, "done");
  assert.deepEqual(b.marks.map((m) => [m.kind, m.glyph]), [["add", "◆"], ["end", "✓"]]);
  assert.equal(b.tail, null); assert.equal(b.state, "done");
  // A phase that ends when it starts is dropped: B is ready and set up in the same instant.
  const run = small(); run.tasks[1].attempts[0].phases[3].t = at(40);
  assert.deepEqual(layoutTimeline(run, { width: 500, now: at(100) }).rows[1].segs.map((s) => s.k), ["queued", "deps", "bar"]);
});

test("a bar is at least MIN_BAR; setting up is part of the work; a merge shows only from MIN_SEG, a short one as a cap", () => {
  const L = layoutTimeline(small(), { width: 500, now: at(100) });
  const bar = lastBar(L.rows[1]); // Its setup takes half a minute and its merge one minute.
  assert.deepEqual(bar.parts.map((p) => p.k), ["work", "merge"].filter((k) => k === "work" || L.axis.ppm >= K.MIN_SEG));
  // No setup part: the work part begins where the setup did.
  assert.deepEqual(lastBar(layoutTimeline(small(), { width: 500, ppm: 8, now: at(100) }).rows[1]).parts.map((p) => [p.k, p.from, p.to]), [["work", at(45), at(59)], ["merge", at(59), at(60)]]);
  assert.equal(bar.mergeCap, false);
  const run = small(); run.tasks[1].attempts[0].phases = run.tasks[1].attempts[0].phases.map((p) => (p.k === "merge" ? { ...p, t: at(59.99) } : p));
  const cap = lastBar(layoutTimeline(run, { width: 500, now: at(100) }).rows[1]);
  assert.equal(cap.mergeCap, true); assert.ok(!cap.parts.some((p) => p.k === "merge"));
  const tiny = small(); tiny.tasks[0].attempts[0].endedAt = at(10.3);
  const t = lastBar(layoutTimeline(tiny, { width: 500, now: at(100) }).rows[0]);
  near(t.x2 - t.x1, K.MIN_BAR);
});

test("live: open bars and lines end at now and say why; not live: open bars are paused", () => {
  const run = freeze(small(), at(50));
  const L = layoutTimeline(run, { width: 600, now: at(50) }), X = L.axis.x;
  assert.ok(L.nowX != null); near(L.nowX, X(at(50))); assert.equal(L.end, null);
  const [a, b, c] = L.rows;
  assert.equal(a.tail, null);
  assert.equal(b.state, "work"); near(lastBar(b).x2, L.nowX); assert.equal(lastBar(b).open, true);
  assert.deepEqual(b.tail, { x: L.nowX + 16, tone: "live", reason: { k: "work" }, since: at(45) });
  assert.equal(tailSentence(tailOfRow(b), at(50)), "5m 00s");
  assert.equal(c.state, "work");
  const H = layoutTimeline(freeze(small(), at(43)), { width: 600, now: at(43) }), held = H.rows[2];
  assert.equal(held.state, "held"); assert.equal(tailSentence(tailOfRow(held), at(43)), "after turn 2");
  assert.ok(H.nowX != null); near(held.segs[0].x2, H.nowX); assert.equal(held.segs[0].open, true);
  const waiting = layoutTimeline(freeze(small(), at(20)), { width: 600, now: at(20) }).rows[1];
  assert.equal(tailSentence(tailOfRow(waiting), at(20)), "waiting on A");
  assert.equal(tailSentence(tailOfRow(H.rows[1]), at(43)), "3m 00s · ready, no slot");
  const stopped: ScRun = { ...run, status: "stopped", stops: [{ at: at(50), resumedAt: null }] };
  const P = layoutTimeline(stopped, { width: 600, now: at(999) });
  assert.equal(P.nowX, null); assert.equal(P.end?.status, "stopped");
  assert.equal(lastBar(P.rows[1]).paused, true); assert.equal(P.rows[1].paused, true); assert.equal(P.rows[1].tail, null);
  assert.deepEqual(P.rows[1].marks.at(-1), { kind: "end", outcome: "paused", glyph: "‖", x: P.rows[1].endX });
});

test("attempts: a failed attempt, the retry mark, the second bar; a task cancelled while pending", () => {
  const run = small();
  const c = run.tasks[2], a1 = c.attempts[0];
  a1.endedAt = at(50); a1.outcome = "failed"; a1.error = "x";
  c.attempts.push({ n: 2, queuedTurn: 3, queuedAt: at(60.5), phases: [{ k: "held", t: at(60.5), turn: 3 }, { k: "work", t: at(61) }], startedAt: at(61), endedAt: at(90), outcome: "done", conflicts: [] });
  run.turns[2].ops.push({ op: "retry_task", task: "C", t: at(60.5), i: 1 });
  const r = layoutTimeline(run, { width: 500, now: at(100) }).rows[2];
  assert.deepEqual(r.segs.map((s) => [s.k, s.attempt, s.k === "bar" ? s.outcome : null]), [["queued", 1, null], ["bar", 1, "failed"], ["queued", 2, null], ["bar", 2, "done"]]);
  assert.deepEqual(r.marks.map((m) => m.glyph), ["◆", "↻", "!", "✓"]);
  assert.deepEqual(r.marks.map((m) => [m.kind, m.attempt ?? null, m.final ?? null]), [["add", null, null], ["retry", null, null], ["end", 1, false], ["end", 2, true]]);
  const run2 = small(); const b = run2.tasks[1].attempts[0];
  b.phases = b.phases.slice(0, 2); b.endedAt = at(30); b.outcome = "cancelled"; b.startedAt = null;
  run2.turns[0].ops.push({ op: "cancel_task", task: "B", t: at(30), i: 9 });
  const rb = layoutTimeline(run2, { width: 500, now: at(100) }).rows[1];
  assert.deepEqual(rb.segs.map((s) => s.k), ["queued", "deps"]);
  assert.deepEqual(rb.marks.map((m) => m.glyph), ["◆", "✕"]); assert.equal(rb.state, "cancelled");
  assert.deepEqual(rb.marks[1], { kind: "end", outcome: "cancelled", glyph: "✕", x: rb.endX, attempt: 1, conflicts: 0, final: true });
});

test("edge kinds", () => {
  const run = small(), [a, b, c] = run.tasks;
  assert.equal(edgeKind(b, a), "release");   // B waited on A alone.
  assert.equal(edgeKind(c, a), "lineage");   // A was done before C was added.
  const two = small(); two.tasks[1].attempts[0].phases[1].on = ["A", "X"]; // B waited on A and on something else.
  assert.equal(edgeKind(two.tasks[1], two.tasks[0]), "waited");
  const live = freeze(small(), at(20));
  assert.equal(edgeKind(live.tasks[1], live.tasks[0]), "pending");
  const failed = failNow(freeze(small(), at(20)), "A", at(15), "B");
  assert.equal(edgeKind(failed.tasks[1], failed.tasks[0]), "blocked");
  assert.equal(taskState(failed.tasks[1]), "blocked");
  const tail = layoutTimeline(failed, { width: 600, now: at(20) }).rows[1].tail;
  assert.ok(tail); assert.equal(tail.tone, "warn"); assert.equal(tailSentence(tail, at(20)), "blocked by A");
});

test("connectors: with no selection only what explains timing; with one, its whole chain", () => {
  const L = layoutTimeline(small(), { width: 500, now: at(100) }), X = L.axis.x;
  assert.deepEqual(L.edges.map((e) => [e.from, e.to, e.kind, e.level]), [["A", "B", "release", "base"]]);
  const e = L.edges[0]; // A ended after B was added: straight down from A's end to B's line, with a dot.
  assert.equal(e.points.length, 2); near(e.points[0][0], X(at(40))); near(e.points[1][0], X(at(40))); near(e.points[1][1], K.ROW * 1.5); assert.ok(e.dot);
  const S = layoutTimeline(small(), { width: 800, now: at(100), selTask: "A" }), SX = S.axis.x;
  assert.deepEqual(S.edges.map((x) => [x.from, x.to, x.kind, x.level]), [["A", "B", "release", "direct"], ["A", "C", "lineage", "direct"]]);
  const l = S.edges[1]; // A ended before C was added: down, then along C's row to its ◆, with an arrow.
  assert.ok(SX(at(42)) - SX(at(40)) > 10);
  assert.equal(l.points.length, 3); near(l.points[2][0], SX(at(42)) - 5); assert.ok(l.arrow && !l.dot);
  // The same two minutes in a narrower chart are under 10 px: an elbow that short would put its
  // arrowhead on its own trunk (it reads as "✕"), so the connector goes straight down, with a dot.
  const N = layoutTimeline(small(), { width: 500, now: at(100), selTask: "A" }), n = N.edges[1];
  assert.ok(X(at(42)) - X(at(40)) < 10 && X(at(42)) - X(at(40)) > 1);
  assert.equal(n.kind, "lineage"); assert.equal(n.points.length, 2); assert.ok(n.dot && !n.arrow); near(n.points[1][0], X(at(40)));
  assert.deepEqual(S.rows.map((r) => [r.id, r.rel, !!r.dim]), [["A", "sel", false], ["B", "dependent", false], ["C", "dependent", false]]);
  assert.equal(layoutTimeline(small(), { width: 500, now: at(100), deps: "off" }).edges.length, 0);
  const live = layoutTimeline(freeze(small(), at(20)), { width: 600, now: at(20) });
  const P = live.edges[0]; // Unfinished: a bracket right of now.
  assert.ok(live.nowX != null); assert.equal(P.kind, "pending"); assert.equal(P.level, "base"); assert.equal(P.dot, null);
  assert.deepEqual(P.points, [[live.nowX + 3, K.ROW * 0.5], [live.nowX + 9, K.ROW * 0.5], [live.nowX + 9, K.ROW * 1.5], [live.nowX + 3, K.ROW * 1.5]]);
});

test("chain: direct and transitive, both directions", () => {
  const run = small(); run.tasks.push(task("D", 3, 60.5, [["work", 61]], [70, "done"], { deps: ["B"] }));
  const ch = chainOf(run, "B");
  assert.deepEqual([[...ch.up], [...ch.down], [...ch.directUp], [...ch.directDown]], [["A"], ["D"], ["A"], ["D"]]);
  assert.deepEqual([...chainOf(run, "A").down].sort(), ["B", "C", "D"]);
  const L = layoutTimeline(run, { width: 500, now: at(100), selTask: "D" });
  assert.deepEqual(L.rows.map((r) => r.rel), ["up", "dep", null, "sel"]); assert.equal(L.rows[2].dim, true);
  assert.deepEqual(L.edges.map((e) => [e.from, e.to, e.level]), [["A", "B", "far"], ["B", "D", "direct"]]);
});

test("a selected turn marks what it touched and what woke it", () => {
  const L = layoutTimeline(small(), { width: 500, now: at(100), selTurn: 2 });
  assert.deepEqual(L.rows.map((r) => [r.id, r.touched, r.woke, r.dim]), [["A", null, true, false], ["B", null, false, true], ["C", "+", false, false]]);
});

test("the orchestrator lane: bars, numbers in or after, a summary of what each did, notes left out, refusals shown", () => {
  const run = small(); run.turns[2].ops.push({ op: "finish_run", t: at(60.8), i: 3, error: "tasks are open" });
  const L = layoutTimeline(run, { width: 500, now: at(100) }), X = L.axis.x;
  assert.deepEqual(L.turns.map((t) => [t.n, t.num, t.opsMode, t.summary]), [[1, "in", "summary", "+2"], [2, "in", "summary", "+1"], [3, "after", "summary", "⚠"]]);
  near(L.turns[0].x1, X(at(0))); near(L.turns[0].x2, X(at(10))); assert.equal(L.turns[0].status, "done");
  // A turn with nothing to say has no summary; one whose text the next turn leaves no room for has none either.
  const quiet = small(); quiet.turns[2].ops = [];
  assert.deepEqual(layoutTimeline(quiet, { width: 500, now: at(100) }).turns.map((t) => t.opsMode), ["summary", "summary", "none"]);
  const close = small(); close.turns[0].ops.push({ op: "cancel_task", t: at(7), i: 3, task: "B", error: "no" }); close.turns[1].startedAt = at(11);
  const C = layoutTimeline(close, { width: 300, now: at(100) }); // "+2 ⚠" needs 24 px, and turn 2 starts 11 minutes (about 30 px) after turn 1
  assert.deepEqual([C.turns[0].summary, C.turns[0].opsMode], ["+2 ⚠", "summary"]);
  assert.equal(layoutTimeline(close, { width: 200, now: at(100) }).turns[0].opsMode, "none");
  assert.equal(opsSummary([{ op: "add_task" }, { op: "add_task" }, { op: "update_task" }, { op: "set_notes" }, { op: "get_run" }, { op: "retry_task", error: "no" }]), "+2 ~ ⚠");
  assert.equal(opsSummary([{ op: "constructor" }, { op: "get_agent" }]), "");
  const running = layoutTimeline(freeze(small(), at(42.5)), { width: 600, now: at(42.5) }).turns;
  assert.deepEqual(running.map((t) => [t.n, t.status]), [[1, "done"], [2, "running"]]);
});

test("the real 53-task run lays out at 420 and 720 px with every number finite and inside the content", () => {
  const raw = readFileSync(new URL("./fixtures/run-qa.json", import.meta.url), "utf8");
  assert.ok(!raw.includes("/Users/"), "the fixture holds no local path");
  const qa = qaRun();
  assert.equal(qa.tasks.length, 53); assert.equal(qa.turns.length, 35);
  for (const run of [qa, synthesize(qa), freeze(qa, qa.createdAt + 6400_000, true)]) for (const width of [420, 720]) {
    const L = layoutTimeline(run, { width, now: run.frozenAt ?? run.endedAt ?? 0, selTask: "T21" });
    assert.equal(L.rows.length, run.tasks.length);
    assert.equal(L.width, width);
    const xs = [...L.turns.flatMap((t) => [t.x1, t.x2]), ...L.rows.flatMap((r) => [...r.segs.flatMap((s) => [s.x1, s.x2]), ...r.marks.map((m) => m.x)]), ...L.edges.flatMap((e) => e.points.map((p) => p[0]))];
    assert.ok(xs.length > 100 && xs.every((v) => Number.isFinite(v) && v >= 0 && v <= L.width + 1), "x in range");
    for (const r of L.rows) for (const s of r.segs) assert.ok(s.x2 >= s.x1);
  }
  const S = layoutTimeline(synthesize(qa), { width: 720, now: 0 });
  assert.equal(S.axis.gaps.length, 1);
  const row = (id: string) => { const r = S.rows.find((x) => x.id === id); assert.ok(r); return r; };
  assert.equal(lastBar(row("T47")).pauses.length, 1, "a bar that runs across a stop shows the pause");
  assert.deepEqual(row("T41").marks.map((m) => m.glyph), ["◆", "↻", "!", "✓"]);
  assert.equal(lastBar(row("T36")).conflicts, 2);
  assert.deepEqual([row("T29").state, row("T29").segs.some((s) => s.k === "bar"), row("T29").marks.at(-1)?.glyph], ["cancelled", false, "✕"]);
  const kinds = new Map<string, number>();
  for (const e of layoutTimeline(qa, { width: 720, now: 0 }).edges) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
  assert.deepEqual([...kinds], [["release", 17]], "with nothing selected only the connectors that released a task");
});

test("the tail of an open row: its parts, and the seven sentences", () => {
  const live = (t: ScTask): ScRun => small({ status: "running", endedAt: null, turns: [turn(1, 0, null)], tasks: [t] });
  const tail = (t: ScTask, now: number) => tailOfRow(layoutTimeline(live(t), { width: 600, now: at(now) }).rows[0]);
  const says = (t: ScTask, now: number) => tailSentence(tail(t, now), at(now));

  const held = task("A", 14, 4, [["held", 4, { turn: 14 }]]);
  assert.deepEqual(tail(held, 9), { x: 600 - K.PAD_R - K.FUTURE + 16, tone: "muted", reason: { k: "held", turn: 14 }, since: null });
  assert.equal(says(held, 9), "after turn 14");
  const reheld = task("A", 1, 4, [["held", 4, { turn: 1 }], ["slot", 5], ["held", 6, { turn: 3 }]]);
  assert.equal(says(reheld, 9), "after turn 3");
  const queued = task("A", 7, 4, []); // No phase yet: the turn that queued the attempt.
  assert.equal(says(queued, 9), "after turn 7");

  const deps = task("A", 1, 4, [["held", 4, { turn: 1 }], ["deps", 5, { on: ["T30", "T31"] }]]);
  assert.deepEqual(tail(deps, 9).reason, { k: "deps", on: ["T30", "T31"] }); assert.equal(tail(deps, 9).since, null);
  assert.equal(says(deps, 9), "waiting on T30, T31");

  const blocked = task("A", 1, 4, [["deps", 5, { on: ["T26", "T27"] }], ["blocked", 6, { on: ["T26"] }]]);
  assert.deepEqual([tail(blocked, 9).tone, tail(blocked, 9).since], ["warn", null]);
  assert.equal(says(blocked, 9), "blocked by T26");

  const slot = task("A", 1, 4, [["held", 4, { turn: 1 }], ["slot", 8]]);
  assert.deepEqual(tail(slot, 50), { x: 600 - K.PAD_R - K.FUTURE + 16, tone: "muted", reason: { k: "slot" }, since: at(8) });
  assert.equal(says(slot, 50), "42m 00s · ready, no slot");
  // A run without git: one writing task works at a time. A writing task that is ready while
  // another one works waits for that one, not for a slot.
  const w1 = task("W1", 1, 4, [["held", 4, { turn: 1 }], ["setup", 8], ["work", 8.5]], null, { writes: true });
  const w2 = task("W2", 1, 4, [["held", 4, { turn: 1 }], ["slot", 8]], null, { writes: true });
  const reader = task("R", 1, 4, [["held", 4, { turn: 1 }], ["slot", 8]]);
  const noGit = (tasks: ScTask[], git: boolean | null = false): ScRun => ({ status: "running", createdAt: at(0), stops: [], limits: {}, turns: [turn(1, 0, 8)], tasks, git });
  const rowSays = (run: ScRun, id: string) => tailSentence(tailOfRow(layoutTimeline(run, { width: 600, now: at(50) }).rows.find((r) => r.id === id)!), at(50));
  assert.equal(rowSays(noGit([w1, w2, reader]), "W2"), "42m 00s · ready, waits for the other writing task");
  assert.deepEqual(tailOfRow(layoutTimeline(noGit([w1, w2]), { width: 600, now: at(50) }).rows[1]).reason, { k: "slot", writer: true });
  assert.equal(rowSays(noGit([w1, w2, reader]), "R"), "42m 00s · ready, no slot");              // it does not write
  assert.equal(rowSays(noGit([w2, reader]), "W2"), "42m 00s · ready, no slot");                 // no writing task is at work
  assert.equal(rowSays(noGit([w1, w2], true), "W2"), "42m 00s · ready, no slot");               // with git
  assert.equal(rowSays(noGit([w1, w2], null), "W2"), "42m 00s · ready, no slot");          // nothing said about git
  assert.deepEqual([writerBusy({ git: false, tasks: [w1, w2] }, w2), writerBusy({ git: false, tasks: [w1, w2] }, w1), writerBusy({ git: true, tasks: [w1, w2] }, w2)], [true, false, false]);
  assert.deepEqual(tailOf(w2, null, true), { tone: "muted", reason: { k: "slot", writer: true }, since: at(8) });

  const setup = task("A", 1, 4, [["slot", 8], ["setup", 10]]);
  assert.deepEqual([tail(setup, 10.2).tone, tail(setup, 10.2).since], ["live", at(10)]);
  assert.equal(says(setup, 10.2), "12s · setting up");

  const work = task("A", 1, 4, [["setup", 10], ["work", 10.5]]);
  assert.deepEqual(tail(work, 32).reason, { k: "work" }); assert.equal(tail(work, 32).since, at(10)); // From the attempt's start, not the work phase's.
  assert.equal("activity" in tail(work, 32), false);
  assert.equal(says(work, 32), "22m 00s");
  work.attempts[0].activity = "Bash: go test ./...";
  assert.equal(tail(work, 32).activity, "Bash: go test ./...");
  assert.equal(says(work, 32), "22m 00s · Bash: go test ./...");
  assert.equal(says(work, 75.5), "1h 05m · Bash: go test ./...");

  const merge = task("A", 1, 4, [["setup", 10], ["work", 10.5], ["merge", 30]], null, { conflicts: ["a.ts"] });
  assert.deepEqual(tail(merge, 33).reason, { k: "merge", conflicts: true }); assert.equal(tail(merge, 33).since, at(30));
  assert.equal(says(merge, 33), "3m 00s · resolving conflicts");
  merge.attempts[0].conflicts = [];
  assert.equal(says(merge, 33.1), "3m 06s · merging");

  // The same parts without a layout, and nothing for a task that has ended.
  assert.deepEqual(tailOf(slot), { tone: "muted", reason: { k: "slot" }, since: at(8) });
  assert.equal(tailOf(small().tasks[0]), null);
  // A clock that runs behind never shows a negative time.
  assert.equal(tailSentence({ reason: { k: "setup" }, since: at(10) }, at(9)), "0s · setting up");
});

test("the tail does not change from one second to the next; only its sentence and what follows now do", () => {
  const run = freeze(qaRun(), qaRun().createdAt + 6400_000, true), now = run.frozenAt ?? 0;
  const A = layoutTimeline(run, { width: 720, now }), B = layoutTimeline(run, { width: 720, now: now + 1000 });
  const open = A.rows.filter((r) => r.tail);
  assert.ok(open.length >= 8, "the frozen run has open rows");
  assert.deepEqual(new Set(open.map((r) => r.state)), new Set(["held", "deps", "slot", "work"]));
  const still = (L: Layout) => L.rows.map((r) => r.tail && { ...r.tail, x: 0 });
  assert.deepEqual(still(A), still(B));
  for (const r of open) for (const v of Object.values(tailOfRow(r))) assert.ok(typeof v !== "string" || !/\d+(s|m|h)\b/.test(v) || v === r.tail?.activity, "no formatted duration in the tail");
  const ticking = open.filter((r) => r.tail?.since != null);
  assert.ok(ticking.length >= 4);
  for (const r of ticking) assert.notEqual(tailSentence(tailOfRow(r), now), tailSentence(tailOfRow(r), now + 1000));
  for (const r of open.filter((x) => x.tail?.since == null)) assert.equal(tailSentence(tailOfRow(r), now), tailSentence(tailOfRow(r), now + 1000));
  // Everything that is over lies at the same time: only the scale moved with now.
  const times = (L: Layout) => L.rows.map((r) => [r.id, r.state, r.y, r.segs.map((s) => [s.k, s.open, s.k === "bar" ? s.parts.map((p) => p.from) : s.from])]);
  assert.deepEqual(times(A), times(B));
});

test("optional inputs may be null, undefined or left out", () => {
  const run = freeze(small({ stops: [{ at: at(20), resumedAt: at(30), reason: null }] }), at(50), true);
  run.turns.push(turn(3, 48, null, [["update_task", 49, { task: "C", error: null }]]));
  const nulls = JSON.stringify(run);
  assert.ok(["\"endedAt\":null", "\"outcome\":null", "\"mergedAt\":null", "\"reason\":null", "\"error\":null"].every((s) => nulls.includes(s)));
  const leftOut: ScRun = JSON.parse(JSON.stringify(run, (_k, v) => (v === null ? undefined : v)));
  assert.ok(!JSON.stringify(leftOut).includes("null"));
  const undef = (v: unknown): unknown => (v === null ? undefined : Array.isArray(v) ? v.map(undef) : typeof v === "object" ? Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, undef(x)])) : v);
  const undefineds = undef(run) as ScRun;
  assert.ok("endedAt" in undefineds && undefineds.endedAt === undefined);
  for (const sel of [{}, { selTask: "B" }, { selTurn: 2 }]) {
    const want = plain(layoutTimeline(run, { width: 600, now: at(50), ...sel }));
    assert.deepEqual(plain(layoutTimeline(leftOut, { width: 600, now: at(50), ...sel })), want);
    assert.deepEqual(plain(layoutTimeline(undefineds, { width: 600, now: at(50), ...sel })), want);
  }
  // Without stops, woken-by lists, conflicts or selection options at all.
  const bare = layoutTimeline({ status: "running", createdAt: at(0), turns: [{ n: 1, startedAt: at(0), status: "running", ops: [] }], tasks: [{ id: "A", addedTurn: 1, createdAt: at(1), dependsOn: [], attempts: [{ n: 1, queuedTurn: 1, phases: [{ k: "held", t: at(1) }] }] }] }, { width: 600, now: at(2), ppm: null, only: null, selTask: null, selTurn: 1, deps: undefined });
  assert.deepEqual(bare.rows.map((r) => [r.id, r.state, r.woke, r.tail?.reason]), [["A", "held", false, { k: "held", turn: 1 }]]);
});

test("a task with no attempt yet is held: its ◆ and nothing else", () => {
  const run = freeze(small(), at(50));
  run.tasks.push({ id: "N", title: "N", kind: "fix", writes: false, dependsOn: ["B"], addedTurn: 2, createdAt: at(43), attempts: [] });
  run.tasks.push(task("O", 2, 43.5, [["deps", 44, { on: ["N"] }]], null, { deps: ["N"] }));
  assert.equal(lastAttempt(run.tasks[3]), undefined); assert.equal(taskState(run.tasks[3]), "held");
  assert.equal(edgeKind(run.tasks[3], run.tasks[1]), "pending"); assert.equal(edgeKind(run.tasks[4], run.tasks[3]), "pending");
  const L = layoutTimeline(run, { width: 600, now: at(50) }), n = L.rows[3];
  assert.deepEqual([n.state, n.segs, n.marks.map((m) => m.glyph), n.endX], ["held", [], ["◆"], L.axis.x(at(43))]);
  assert.equal(tailSentence(tailOfRow(n), at(50)), "after turn 2");
  assert.deepEqual(L.edges.map((e) => [e.from, e.to, e.kind]), [["A", "B", "release"], ["B", "N", "pending"], ["N", "O", "pending"]]);
});

test("a bar that began without a setup phase still shows the stop it runs across", () => {
  const stops = [{ at: at(50), resumedAt: at(650) }];
  const run = small({ endedAt: at(700), stops, tasks: [
    task("A", 1, 4, [["held", 4, { turn: 1 }], ["setup", 10], ["work", 10.2]], [40, "done"]),            // Over before the stop.
    task("B", 1, 6, [["held", 6, { turn: 1 }], ["setup", 45], ["work", 45.5]], [660, "done"]),           // Across it.
    task("C", 2, 42, [["held", 42, { turn: 2 }], ["work", 44]], [670, "done"]),                          // Across it, begun by its work phase.
    task("D", 2, 43, [["held", 43, { turn: 2 }], ["slot", 44], ["work", 655]], [690, "done"]),           // Waiting across it, working after it.
  ] });
  const L = layoutTimeline(run, { width: 600, now: at(700) }), gap = L.axis.gaps[0];
  assert.deepEqual(L.rows.map((r) => lastBar(r).pauses), [[], [{ x1: gap.x1, x2: gap.x2 }], [{ x1: gap.x1, x2: gap.x2 }], []]);
});

test("the vocabulary names every state, and every write op has a glyph", () => {
  assert.deepEqual(Object.keys(STATES), ["held", "deps", "blocked", "slot", "setup", "work", "merge", "done", "failed", "cancelled"]);
  for (const s of Object.values(STATES)) assert.ok(s.glyph && s.word && s.tone);
  assert.deepEqual(WRITE_OPS, { add_task: "+", update_task: "~", retry_task: "↻", cancel_task: "✕", set_notes: "≡", finish_run: "⚑" });
});

test("rows are never moved: a group is a run of consecutive rows of one turn, and a task no turn added has no number", () => {
  const run = small();
  const [a, b, c] = run.tasks;
  // A task added late by turn 1, after turn 2's: it stays last. Then tasks added from outside a turn.
  const late = task("D", 1, 50, [["held", 50, { turn: 3 }], ["setup", 61], ["work", 61.5]], [80, "done"]);
  const chat0 = { ...task("E", 0, 62, [["setup", 62], ["work", 62.5]], [70, "done"]), addedTurn: 0 };
  const chatNull = { ...task("F", 0, 63, [["setup", 63], ["work", 63.5]], [71, "done"]), addedTurn: null };
  const { addedTurn: _, ...chatAbsent } = task("G", 0, 64, [["setup", 64], ["work", 64.5]], [72, "done"]);
  run.tasks = [a, b, c, late, chat0, chatNull, chatAbsent as ScTask, task("H", 3, 65, [["held", 65, { turn: 3 }], ["setup", 66], ["work", 66.5]], [75, "done"])];
  const L = layoutTimeline(run, { width: 600, now: at(100) });
  assert.deepEqual(L.rows.map((r) => [r.id, r.turn, r.first, r.y]), [
    ["A", 1, true, 0], ["B", 1, false, 22], ["C", 2, true, 44], ["D", 1, true, 66],
    ["E", null, true, 88], ["F", null, false, 110], ["G", null, false, 132], ["H", 3, true, 154]]);
  assert.deepEqual(L.rows[4].marks[0], { kind: "add", glyph: "◆", x: L.axis.x(at(62)), turn: undefined });
  // The filter keeps the order; rows of one turn that become neighbours are one group.
  const F = layoutTimeline(run, { width: 600, now: at(100), only: new Set(["B", "D", "G", "H"]) });
  assert.deepEqual(F.rows.map((r) => [r.id, r.turn, r.first]), [["B", 1, true], ["D", 1, false], ["G", null, true], ["H", 3, true]]);
  // Selecting such a task, or a turn, throws nothing; a held task with no turn still says something.
  layoutTimeline(run, { width: 600, now: at(100), selTask: "F" }); layoutTimeline(run, { width: 600, now: at(100), selTurn: 0 });
  const held: ScTask = { id: "N", title: "N", kind: "fix", writes: false, dependsOn: [], createdAt: at(40), attempts: [] };
  assert.deepEqual(tailOf(held), { tone: "muted", reason: { k: "held", turn: null }, since: null });
  assert.equal(tailSentence(tailOf(held)!, at(41)), "after the orchestrator's turn");
});

test("the elapsed time of a tail leaves out the time the run was stopped", () => {
  assert.equal(stoppedMs([{ at: at(10), resumedAt: at(20) }, { at: at(30), resumedAt: null }], at(15), at(40)), 15 * M);
  assert.equal(stoppedMs(null, at(0), at(40)), 0);
  // B works from minute 45; the run is stopped from 50 for six hours and is live again at 420.
  const run = freeze(small(), at(50));
  run.stops = [{ at: at(50), resumedAt: at(410) }];
  const L = layoutTimeline(run, { width: 600, now: at(420) }), b = tailOfRow(L.rows[1]);
  assert.deepEqual(b, { x: L.nowX! + 16, tone: "live", reason: { k: "work" }, since: at(45), stopped: 360 * M });
  assert.equal(tailSentence(b, at(420)), "15m 00s");
  // A stop that was over before the task began does not count, and no `stopped` is carried.
  run.stops = [{ at: at(20), resumedAt: at(30) }];
  assert.deepEqual(tailOf(run.tasks[1], run.stops), { tone: "live", reason: { k: "work" }, since: at(45) });
  // A slot wait across the stop: the same rule.
  const waiting = freeze(small(), at(43));
  waiting.stops = [{ at: at(41), resumedAt: at(42) }];
  assert.equal(tailSentence(tailOf(waiting.tasks[1], waiting.stops)!, at(43)), "2m 00s · ready, no slot");
});

test("the phase a task is in is drawn even when it began at this very moment", () => {
  // B's work phase begins at minute 45.5 and C's held phase at 42: lay each out at exactly that moment.
  const atWork = freeze(small(), at(45.5)), L = layoutTimeline(atWork, { width: 600, now: at(45.5) }), b = lastBar(L.rows[1]);
  assert.deepEqual(b.parts.map((p) => p.k), ["work"]);
  assert.deepEqual([b.open, b.paused, L.rows[1].state], [true, false, "work"]); near(b.x2, L.nowX!);
  const atAdd = freeze(small(), at(42)), H = layoutTimeline(atAdd, { width: 600, now: at(42) }), held = H.rows[2].segs;
  assert.deepEqual(held.map((s) => [s.k, s.open, s.x2 - s.x1]), [["queued", true, 0]]);
  // A bar that has only just begun is still MIN_BAR wide, and open.
  const atStart = freeze(small(), at(10)), S = layoutTimeline(atStart, { width: 600, now: at(10) }), a = lastBar(S.rows[0]);
  assert.deepEqual([a.open, a.x2 - a.x1, a.parts.map((p) => p.k)], [true, K.MIN_BAR, ["work"]]);
  // In a halted run it is paused, like any other open bar.
  const halted = layoutTimeline({ ...atWork, status: "stopped", endedAt: at(45.5) }, { width: 600, now: at(45.5) });
  assert.equal(lastBar(halted.rows[1]).paused, true);
  // Phases of no length that the task has left are still dropped (the zero-length case of the row test).
  assert.ok(layoutTimeline(small(), { width: 600, now: at(100) }).rows.every((r) => r.segs.every((s) => s.x2 > s.x1)));
});

// ---- what a chat on the run changed outside a turn (TLRun.chatOps), and T20's fixes

test("a chat's changes: the usual glyphs on the task's row, with no turn, and nothing on the orchestrator lane", () => {
  const run = small({
    status: "running", endedAt: null,
    turns: [turn(1, 0, 10, [["add_task", 4, { task: "A" }], ["add_task", 6, { task: "B" }]]), turn(2, 40, 44, [["update_task", 41, { task: "A" }]], ["A"])],
    tasks: [
      task("A", 1, 4, [["held", 4, { turn: 1 }], ["setup", 10], ["work", 10.2]], [40, "done"]),
      task("B", 1, 6, [["held", 6, { turn: 1 }], ["deps", 10, { on: ["A"] }], ["slot", 40]], [52, "cancelled"], { deps: ["A"] }),
      // Added by a chat while turn 2 was the latest turn: no turn added it.
      { ...task("C", 2, 50, [["held", 50, { chat: "c1" }]]), addedBy: "c1" },
      task("D", 2, 42, [["held", 42, { turn: 2 }], ["slot", 44], ["held", 55, { chat: "c1" }]]),
      // Cancelled by the orchestrator, then retried by a chat: only the retry is the chat's.
      { ...task("E", 2, 42.5, [["held", 42.5, { turn: 2 }], ["slot", 44]], [45, "cancelled"]),
        attempts: [...task("E", 2, 42.5, [["held", 42.5, { turn: 2 }], ["slot", 44]], [45, "cancelled"]).attempts,
          { n: 2, queuedTurn: 2, queuedAt: at(56), phases: [{ k: "held" as const, t: at(56), chat: "c1" }] }] },
    ],
    chatOps: [
      { op: "add_task", t: at(50), i: 0, task: "C", chat: "c1" },
      { op: "cancel_task", t: at(52), i: 1, task: "B", chat: "c1" },
      { op: "update_task", t: at(55), i: 2, task: "D", chat: "c1" },
      { op: "retry_task", t: at(56), i: 3, task: "E", chat: "c1" },
      { op: "update_task", t: at(57), i: 4, task: "A", chat: "c1", error: "T01 is done: it cannot be changed" },
    ],
  });
  const L = layoutTimeline(run, { width: 600, now: at(60) }), X = L.axis.x;
  // A mark says the turn that made it; a chat's has none (every plan change is drawn alike).
  const marks = (id: string) => L.rows.find((r) => r.id === id)!.marks.map((m) => [m.glyph, m.turn ?? "", m.kind]);
  // A: the orchestrator's update is turn 2's; the chat's refused update draws nothing.
  assert.deepEqual(marks("A"), [["◆", 1, "add"], ["~", 2, "update"], ["✓", "", "end"]]);
  // B: cancelled by the chat: the same ✕ cap as any cancel.
  const b = L.rows[1].marks.at(-1)!;
  assert.deepEqual([b.glyph, b.kind, b.outcome], ["✕", "end", "cancelled"]);
  // C: its ◆ is at the op's time; no turn added it, so it has no gutter number, a group of its own and no block.
  assert.deepEqual(marks("C"), [["◆", "", "add"]]); near(L.rows[2].marks[0].x, X(at(50)));
  assert.deepEqual(L.rows.map((r) => [r.id, r.turn, r.first]), [["A", 1, true], ["B", 1, false], ["C", null, true], ["D", 2, true], ["E", 2, false]]);
  assert.deepEqual(L.groups.map((g) => [g.turn, g.y1, g.y2]), [[1, 0, 2 * K.ROW], [2, 3 * K.ROW, 5 * K.ROW]]);
  // D: the chat's ~ at the op's time.
  assert.deepEqual(marks("D"), [["◆", 2, "add"], ["~", "", "update"]]); near(L.rows[3].marks[1].x, X(at(55)));
  // E: the orchestrator's cancel, then the chat's ↻.
  assert.deepEqual(marks("E"), [["◆", 2, "add"], ["↻", "", "retry"], ["✕", "", "end"]]);
  // Nothing of it on the lane, and a selected turn is not said to have touched what the chat changed.
  assert.deepEqual(L.turns.map((t) => t.summary), ["+2", "~"]);
  const S = layoutTimeline(run, { width: 600, now: at(60), selTurn: 2 });
  assert.deepEqual(S.rows.map((r) => r.touched ?? ""), ["~", "", "", "", ""]);
  // A phase held by a chat says so, whatever the latest turn was; a later op is not drawn yet.
  assert.deepEqual(tailOfRow(L.rows[2]).reason, { k: "held", turn: null, chat: true });
  assert.equal(tailSentence(tailOfRow(L.rows[2]), at(60)), "after the chat's reply");
  assert.equal(tailSentence(tailOfRow(L.rows[3]), at(60)), "after the chat's reply");
  assert.equal(tailSentence(tailOfRow(L.rows[4]), at(60)), "after the chat's reply");
  assert.deepEqual(layoutTimeline(run, { width: 600, now: at(54) }).rows[3].marks.map((m) => m.glyph), ["◆"]);
  // Without chatOps only the chat's ~ and ↻ are gone.
  const plain = layoutTimeline({ ...run, chatOps: null }, { width: 600, now: at(60) });
  assert.deepEqual(plain.rows.map((r) => r.marks.map((m) => m.glyph).join("")), ["◆~✓", "◆✕", "◆", "◆", "◆✕"]);
});

test("no ruler label under a break's pill, on either side of it", () => {
  for (const [w, ppm] of [[420, null], [720, null], [720, 8], [420, 4]] as const) {
    const L = layoutTimeline(synthesize(qaRun()), { width: w, ppm, now: 0 });
    assert.equal(L.axis.gaps.length, 1);
    const mid = (L.axis.gaps[0].x1 + L.axis.gaps[0].x2) / 2;
    // The pill is about 104 px wide around mid; a label is written from its tick to about 40 px right of it.
    for (const t of L.ticks) assert.ok(t.x + 40 <= mid - 52 || t.x >= mid + 52, `${w}/${ppm}: a label at ${t.x} is under the pill at ${mid}`);
  }
});

test("fit: the content is never wider than its viewport", () => {
  const live = freeze(qaRun(), qaRun().createdAt + 6400_000);
  let wide = 0, n = 0;
  for (const w of [420, 519, 600, 720, 815, 1000]) for (let now = live.frozenAt!; now < live.frozenAt! + 3 * 3600_000; now += 37_000) {
    n++; if (layoutTimeline(live, { width: w, now }).width > w) wide++;
  }
  assert.equal(wide, 0, `${wide} of ${n} fit layouts are wider than their viewport`);
});

test("a selected turn that is not in the run dims nothing", () => {
  const L = layoutTimeline(small(), { width: 500, now: at(100), selTurn: 99 });
  assert.deepEqual(L.rows.map((r) => !!r.dim), [false, false, false]);
  assert.deepEqual(layoutTimeline(small(), { width: 500, now: at(100), selTurn: 2 }).rows.map((r) => !!r.dim), [false, true, false]);
});

// ---- process v3: what the orchestrator added and waits for, what a row needs, tiers (T14 §1)

/** `small()` with its waits: turn 1 waits for A, turn 2 starts when that is met and waits for any
 *  of B and C, turn 3 starts when B is done, reads a task and leaves the plan as it was. */
function waiting(over: Partial<ScRun> = {}): ScRun {
  const run = small();
  run.turns = [
    turn(1, 0, 10, [["add_task", 4, { task: "A" }], ["add_task", 6, { task: "B" }], ["wait_for", 9, { tasks: ["A"], mode: "all" }]]),
    { ...turn(2, 40, 44, [["add_task", 42, { task: "C" }], ["wait_for", 43.5, { tasks: ["B", "C"], mode: "any" }]], ["A"]), reason: "wait", wait: { tasks: ["A"], mode: "all" }, waitMet: true },
    { ...turn(3, 60, 61, [["get_task", 60.5, { task: "B" }]], ["B"]), reason: "wait", wait: { tasks: ["B", "C"], mode: "any" }, waitMet: true },
  ];
  return { ...run, ...over };
}
/** The events that woke a turn, as [task, type]. */
const woke = (...events: [string, string][]): ScTurn["wokenBy"] => events.map(([task, type]) => ({ task, type }));
/** `waiting()` as it was at minute `min`, live. */
const liveAt = (min: number, over: Partial<ScRun> = {}): ScRun => ({ ...freeze(waiting(), at(min)), ...over });

test("groups: each run of consecutive rows a turn added, over that turn's time", () => {
  const run = small();
  const [a, b, c] = run.tasks;
  // D was added late by turn 1, after turn 2's C; E by a chat; F by a turn the run does not have.
  const d = task("D", 1, 50, [["held", 50, { turn: 3 }], ["work", 61]], [80, "done"]);
  const e = { ...task("E", 2, 62, [["work", 62]], [70, "done"]), addedBy: "c1" };
  const f = task("F", 9, 63, [["work", 63]], [71, "done"]);
  run.tasks = [a, b, c, d, e, f];
  const L = layoutTimeline(run, { width: 500, now: at(100) }), X = L.axis.x;
  assert.deepEqual(L.groups, [
    { turn: 1, y1: 0, y2: 2 * K.ROW, x1: X(at(0)), x2: X(at(10)) },          // A and B: consecutive
    { turn: 2, y1: 2 * K.ROW, y2: 3 * K.ROW, x1: X(at(40)), x2: X(at(44)) },
    { turn: 1, y1: 3 * K.ROW, y2: 4 * K.ROW, x1: X(at(0)), x2: X(at(10)) },  // D: turn 1 again, not next to its other rows
  ]);
  // A block is as wide as its turn's bar and as high as its rows; every first row of a turn on the lane starts one.
  for (const g of L.groups) { const bar = L.turns.find((t) => t.n === g.turn)!; assert.deepEqual([g.x1, g.x2], [bar.x1, bar.x2]); }
  assert.deepEqual(L.groups.map((g) => g.y1), L.rows.filter((r) => r.first && r.turn != null && r.turn !== 9).map((r) => r.y));
  // The filter makes rows of one turn neighbours: one group.
  const F = layoutTimeline(run, { width: 500, now: at(100), only: new Set(["B", "D", "E"]) });
  assert.deepEqual(F.groups.map((g) => [g.turn, g.y1, g.y2]), [[1, 0, 2 * K.ROW]]);
  // The real run: one group per numbered first row, in order from the top.
  const Q = layoutTimeline(qaRun(), { width: 720, now: 0 });
  assert.equal(Q.groups.length, Q.rows.filter((r) => r.first && r.turn != null).length);
  assert.ok(Q.groups.length > 10 && Q.groups.every((g, i) => g.y2 > g.y1 && g.x2 > g.x1 && (i === 0 || g.y1 >= Q.groups[i - 1].y2)));
  assert.equal(Q.groups.reduce((n, g) => n + (g.y2 - g.y1) / K.ROW, 0), 53);
});

test("waits: one per gap between two turns, with what the orchestrator waited for and whether that was met", () => {
  const L = layoutTimeline(waiting(), { width: 500, now: at(100) }), X = L.axis.x;
  assert.deepEqual(L.waits, [
    { after: 1, x1: X(at(10)), x2: X(at(40)), open: false, mode: "all", tasks: ["A"], ended: "met", label: "A", numW: 0 },
    { after: 2, x1: X(at(44)), x2: X(at(60)), open: false, mode: "any", tasks: ["B", "C"], ended: "met", label: "any: B C", numW: 0 },
  ]); // The run is over: nothing after turn 3.
  assert.deepEqual(L.turns.map((t) => [t.n, t.early, t.earlyCause]), [[1, false, null], [2, false, null], [3, false, null]]);
  // A turn's own record of its wait wins; without it, what the turn before declared (its last wait_for that was not refused).
  const derived = waiting(); delete derived.turns[1].wait; delete derived.turns[2].wait;
  derived.turns[0].ops.push({ op: "wait_for", t: at(9.5), i: 3, tasks: ["B"], mode: "any", error: "B is not a task" });
  assert.deepEqual(layoutTimeline(derived, { width: 500, now: at(100) }).waits.map((w) => [w.tasks, w.mode, w.ended]), [[["A"], "all", "met"], [["B", "C"], "any", "met"]]);
  assert.deepEqual(declaredWait(derived.turns[0]), { tasks: ["A"], mode: "all" });
  assert.equal(declaredWait(derived.turns[2]), null); assert.equal(declaredWait({ ops: [{ op: "wait_for", t: 0, i: 0, tasks: [] }] }), null);
  // No wait declared (the run of before v3): the gap is still a wait, with no tasks, no label and no verdict.
  const none = layoutTimeline(small(), { width: 500, now: at(100) });
  assert.deepEqual(none.waits.map((w) => [w.after, w.tasks, w.mode, w.ended, w.label]), [[1, [], "all", null, null], [2, [], "all", null, null]]);
  assert.ok(none.turns.every((t) => !t.early));
  // A gap under WAIT_MIN px is not drawn; a running turn has no wait after it.
  const tight = waiting(); tight.turns[1].startedAt = at(10.5);
  assert.deepEqual(layoutTimeline(tight, { width: 500, now: at(100) }).waits.map((w) => w.after), [2]);
  assert.deepEqual(layoutTimeline(liveAt(42), { width: 500, now: at(42) }).waits.map((w) => [w.after, w.open]), [[1, false]]);
});

test("a turn that started before its wait was met is early, and says what started it", () => {
  const started = (over: Partial<ScTurn>) => {
    const run = waiting(); run.turns[1] = { ...run.turns[1], waitMet: false, reason: "events", wokenBy: [], ...over };
    const L = layoutTimeline(run, { width: 500, now: at(100) });
    return [L.waits[0].ended, L.turns[1].early, L.turns[1].earlyCause];
  };
  assert.deepEqual(started({ wokenBy: woke(["B", "task_failed"]) }), ["early", true, "B failed"]);
  assert.deepEqual(started({ wokenBy: woke(["B", "task_failed"], ["A", "task_done"], ["C", "task_failed"]) }), ["early", true, "B, C failed"]);
  assert.deepEqual(started({ wokenBy: woke(["", "chat_op"]) }), ["early", true, "a chat changed the run"]);
  assert.deepEqual(started({ reason: "idle" }), ["early", true, "nothing was left running"]);
  assert.deepEqual(started({ reason: "resume" }), ["early", true, "resumed"]);
  assert.deepEqual(started({ wokenBy: woke(["B", "task_done"]) }), ["early", true, "B finished"]);
  assert.deepEqual(started({}), ["early", true, null]);                 // Nothing says why.
  assert.deepEqual(started({ waitMet: undefined }), ["early", true, null]); // The server leaves a false out.
  assert.deepEqual(started({ waitMet: true }), ["met", false, null]);
  // Only the turn after the wait is early; with no wait at all a turn is never early, whatever started it.
  const run = waiting(); run.turns[1] = { ...run.turns[1], waitMet: false, reason: "idle" };
  assert.deepEqual(layoutTimeline(run, { width: 500, now: at(100) }).turns.map((t) => t.early), [false, true, false]);
  assert.deepEqual(waitEnd({ reason: "idle", wokenBy: woke(["B", "task_failed"]) }), { wait: null, ended: null, cause: null });
  assert.deepEqual(waitEnd({ reason: "events", wokenBy: woke(["B", "task_failed"]) }, { ops: [{ op: "wait_for", t: 0, i: 0, tasks: ["A", "B"] }] }),
    { wait: { tasks: ["A", "B"], mode: "all" }, ended: "early", cause: "B failed" });
});

test("the open wait of a live run runs to now: the run's own wait, else what the latest turn declared", () => {
  const L = layoutTimeline(liveAt(50), { width: 600, now: at(50) }), X = L.axis.x;
  assert.deepEqual(L.waits.at(-1), { after: 2, x1: X(at(44)), x2: X(at(50)), open: true, mode: "any", tasks: ["B", "C"], ended: null, label: null, numW: 0 });
  assert.equal(L.waits.at(-1)!.x2, L.nowX);
  const own = layoutTimeline(liveAt(50, { wait: { tasks: ["C"], mode: "all" } }), { width: 600, ppm: 20, now: at(50) });
  assert.deepEqual([own.waits.at(-1)!.tasks, own.waits.at(-1)!.mode, own.waits.at(-1)!.label, own.waits.at(-1)!.open], [["C"], "all", "C", true]);
  // A wait with no task is none: the latest turn's stands.
  assert.deepEqual(layoutTimeline(liveAt(50, { wait: { tasks: [], mode: "all" } }), { width: 600, now: at(50) }).waits.at(-1)!.tasks, ["B", "C"]);
  // A run that is not live has no open wait, whatever it says.
  const halted = { ...liveAt(50), status: "stopped" as const, stops: [{ at: at(50) }] };
  assert.ok(layoutTimeline(halted, { width: 600, now: at(50) }).waits.every((w) => !w.open));
});

test("the ids on a wait: all or any, at most three then +n, and only where they fit", () => {
  assert.equal(waitLabel({ tasks: ["T07", "T09"], mode: "all" }), "T07 T09");
  assert.equal(waitLabel({ tasks: ["T07", "T09"], mode: "any" }), "any: T07 T09");
  assert.equal(waitLabel({ tasks: ["T07", "T09", "T11"], mode: "all" }), "T07 T09 T11");
  assert.equal(waitLabel({ tasks: ["T07", "T09", "T11", "T12"], mode: "all" }), "T07 T09 T11 +1");
  assert.equal(waitLabel({ tasks: ["A", "B", "C", "D", "E"], mode: "any" }), "any: A B C +2");
  // The rule: characters × 6.2 px ≤ the line's length − 10 px − the room of the number written after the bar.
  // "A B C +2" is 8 characters, 49.6 px: it needs a line of 59.6 px. The line is 30 minutes long.
  const wide = (ppm: number, tasks: string[], turn1End = 10) => {
    const run = waiting(); run.turns[0].endedAt = at(turn1End); run.turns[1].wait = { tasks, mode: "all" };
    const L = layoutTimeline(run, { width: 500, ppm, now: at(100) });
    return { ...L.waits[0], num: L.turns[0].num };
  };
  const five = ["A", "B", "C", "D", "E"];
  assert.equal(wide(2, five).label, "A B C +2"); near(wide(2, five).x2 - wide(2, five).x1, 60);       // 49.6 ≤ 50
  assert.equal(wide(59.6 / 30 + 1e-6, five).label, "A B C +2");                                       // just enough
  assert.equal(wide(59.6 / 30 - 1e-3, five).label, null);                                             // just too little
  assert.deepEqual(wide(1.98, five).tasks, five);                                                     // the wait is there all the same
  // A turn too short for its number has it written after its bar: that room is taken first. Turn 1
  // lasts a minute (a bar of MIN_BAR), so the line is 77 px long, less 10, less 9 for "1": 58 px.
  const short9 = wide(2, ["T001", "T002"], 1), short10 = wide(2, ["T001", "T0002"], 1);
  assert.deepEqual([short9.num, short9.numW], ["after", K.NUM_W + 2]); near(short9.x2 - short9.x1, 77);
  assert.equal(short9.label, "T001 T002");  // 9 characters, 55.8 px
  assert.equal(short10.label, null);        // 10 characters, 62 px: more than 58, though less than the 67 a line with no number leaves
  const long10 = wide(2.5, ["T001", "T0002"]); // The same ten characters on a line of 75 px after a bar with its number inside.
  assert.deepEqual([long10.num, long10.numW, long10.label], ["in", 0, "T001 T0002"]);
});

test("a turn that left the plan as it was is idle; one that runs or failed is not", () => {
  const L = layoutTimeline(waiting(), { width: 500, now: at(100) });
  assert.deepEqual(L.turns.map((t) => [t.n, t.idle]), [[1, false], [2, false], [3, true]]); // Turn 3 only read a task.
  assert.equal(planUnchanged([{ op: "get_run" }, { op: "set_notes" }, { op: "edit_notes" }, { op: "wait_for" }]), true);
  assert.equal(planUnchanged([{ op: "add_task", error: "no such dependency" }, { op: "finish_run", error: "tasks are open" }]), true);
  for (const op of ["add_task", "update_task", "cancel_task", "retry_task", "finish_run"]) assert.equal(planUnchanged([{ op: "get_run" }, { op }]), false, op);
  assert.equal(planUnchanged([]), true);
  // While it runs it has not left anything yet; a failed turn is drawn as failed.
  const running = layoutTimeline(liveAt(41), { width: 500, now: at(41) }).turns;
  assert.deepEqual(running.map((t) => [t.n, t.status, t.idle]), [[1, "done", false], [2, "running", false]]);
  const failed = waiting(); failed.turns[2].status = "failed";
  assert.equal(layoutTimeline(failed, { width: 500, now: at(100) }).turns[2].idle, false);
  // What it did later than now does not count yet.
  const early = waiting({ status: "running", endedAt: null }); early.turns[1].ops[0].t = at(47);
  assert.equal(layoutTimeline(early, { width: 500, now: at(45) }).turns[1].idle, true);
});

test("the lane tail of a live run: what the orchestrator waits for, or the turn that runs", () => {
  assert.equal(waitText({ tasks: ["T11", "T23"], mode: "all" }), "waits for T11 and T23");
  assert.equal(waitText({ tasks: ["T07", "T09"], mode: "any" }), "waits for any of T07, T09");
  assert.equal(waitText(null), "next turn when a task ends");
  assert.equal(waitText({ tasks: [], mode: "all" }), "next turn when a task ends");
  assert.equal(waitText({ tasks: ["T11"], mode: "all" }), "waits for T11");
  assert.equal(waitText({ tasks: ["T07", "T09", "T11"], mode: "all" }), "waits for T07, T09 and T11");
  assert.equal(waitText({ tasks: ["T07", "T09", "T11", "T12", "T13"], mode: "all" }), "waits for T07, T09, T11 +2");
  assert.equal(waitText({ tasks: ["T07", "T09", "T11", "T12"], mode: "any" }), "waits for any of T07, T09, T11 +1");
  // Between two turns: the wait the latest turn declared (B and C both run at minute 50).
  const L = layoutTimeline(liveAt(50), { width: 600, now: at(50) });
  assert.deepEqual(L.laneTail, { x: L.nowX! + 16, text: "waits for any of B, C", turn: null, since: null });
  assert.equal(laneTailSentence(L.laneTail!, at(50)), "waits for any of B, C");
  assert.equal(laneTailSentence(L.laneTail!, at(55)), "waits for any of B, C"); // Nothing in it counts time.
  // The run's own wait wins; of its tasks only those still open are named (A is done).
  const own = layoutTimeline(liveAt(50, { wait: { tasks: ["A", "B", "C"], mode: "all" } }), { width: 600, now: at(50) });
  assert.equal(own.laneTail!.text, "waits for B and C");
  assert.equal(layoutTimeline(liveAt(50, { wait: { tasks: ["A"], mode: "all" } }), { width: 600, now: at(50) }).laneTail!.text, "waits for A"); // none open: as declared
  // No declared wait.
  const undeclared = liveAt(50); undeclared.turns[1].ops.pop();
  assert.equal(layoutTimeline(undeclared, { width: 600, now: at(50) }).laneTail!.text, "next turn when a task ends");
  // The run has its result and is still running (the result is being applied): no next turn, no wait.
  const fin = layoutTimeline(liveAt(50, { finishing: true }), { width: 600, now: at(50) });
  assert.deepEqual(fin.laneTail, { x: fin.nowX! + 16, text: "finishing…", turn: null, since: null });
  assert.equal(laneTailSentence(fin.laneTail!, at(55)), "finishing…");
  assert.equal(layoutTimeline({ ...undeclared, finishing: true }, { width: 600, now: at(50) }).laneTail!.text, "finishing…");
  // (a turn that still runs says so, with the result or without)
  assert.equal(layoutTimeline(liveAt(42.5, { finishing: true }), { width: 600, now: at(42.5) }).laneTail!.text, "turn 2 · deciding");
  // A turn runs: its number and how long it has been deciding, the time the run was stopped left out.
  const R = layoutTimeline(liveAt(42.5), { width: 600, now: at(42.5) });
  assert.deepEqual(R.laneTail, { x: R.nowX! + 16, text: "turn 2 · deciding", turn: 2, since: at(40) });
  assert.equal(laneTailSentence(R.laneTail!, at(42.5)), "turn 2 · deciding 2m 30s");
  assert.equal(laneTailSentence(R.laneTail!, at(43.17)), "turn 2 · deciding 3m 10s");
  const stopped = layoutTimeline(liveAt(42.5, { stops: [{ at: at(41), resumedAt: at(42) }] }), { width: 600, now: at(42.5) }).laneTail!;
  assert.equal(stopped.stopped, M); assert.equal(laneTailSentence(stopped, at(42.5)), "turn 2 · deciding 1m 30s");
  // Nothing: a run that is not live, one that is stopping between two turns, one with no turn yet.
  assert.equal(layoutTimeline(waiting(), { width: 600, now: at(100) }).laneTail, null);
  assert.equal(layoutTimeline(liveAt(50, { status: "stopping" }), { width: 600, now: at(50) }).laneTail, null);
  assert.equal(layoutTimeline(liveAt(42.5, { status: "stopping" }), { width: 600, now: at(42.5) }).laneTail!.text, "turn 2 · deciding");
  assert.equal(layoutTimeline({ status: "running", createdAt: at(0), turns: [], tasks: [] }, { width: 600, now: at(1) }).laneTail, null);
});

test("awaited rows: the open rows of the wait the orchestrator is in right now", () => {
  const awaited = (run: ScRun, now: number) => layoutTimeline(run, { width: 600, now: at(now) }).rows.filter((r) => r.awaited).map((r) => r.id);
  assert.deepEqual(awaited(liveAt(50), 50), ["B", "C"]);
  assert.deepEqual(awaited(liveAt(50, { wait: { tasks: ["A", "C", "Z"], mode: "all" } }), 50), ["C"]); // A is done; Z is no row
  assert.deepEqual(awaited(liveAt(42.5), 42.5), []);                          // a turn runs: there is no wait
  assert.deepEqual(awaited(liveAt(42.5, { wait: { tasks: ["A", "B"], mode: "all" } }), 42.5), []);
  assert.deepEqual(awaited(liveAt(50, { status: "stopping" }), 50), []);
  assert.deepEqual(awaited(waiting(), 100), []);                              // not live
  const undeclared = liveAt(50); undeclared.turns[1].ops.pop();
  assert.deepEqual(awaited(undeclared, 50), []);
  assert.ok(layoutTimeline(small(), { width: 600, now: at(100) }).rows.every((r) => r.awaited === false));
});

test("the needs cell: up to three ids, of more the first two and +n, each with the tone of how it stands", () => {
  const dep = (id: string, end: [number, TLOutcome] | null) => task(id, 1, 1, [["work", 2]], end);
  const tasks: TLTask[] = [dep("A", [10, "done"]), dep("B", null), dep("F", [10, "failed"]), dep("X", [10, "cancelled"])];
  const by = new Map(tasks.map((t) => [t.id, t]));
  assert.equal(needsOf({ dependsOn: [] }, by), null);
  assert.deepEqual(needsOf({ dependsOn: ["A"] }, by), { ids: [{ id: "A", tone: "done" }], more: 0, moreTone: null, title: "Needs A" });
  assert.deepEqual(needsOf({ dependsOn: ["A", "B", "F"], needsReport: null }, by), {
    ids: [{ id: "A", tone: "done" }, { id: "B", tone: "open" }, { id: "F", tone: "warn" }], more: 0, moreTone: null, title: "Needs A, B, F" });
  // Four or more: two ids and "+n"; the title names them all, and those whose reports are given whole.
  assert.deepEqual(needsOf({ dependsOn: ["X", "A", "B", "Z"], needsReport: ["X", "B", "Q"] }, by), {
    ids: [{ id: "X", tone: "warn" }, { id: "A", tone: "done" }], more: 2, moreTone: "open", title: "Needs X, A, B, Z · full reports of X, B" }); // Q is no dependency; Z is no task: not finished
  assert.deepEqual(needsOf({ dependsOn: ["A", "B", "A", "F", "X"] }, by)!.moreTone, "warn"); // the worst of what "+3" hides
  assert.deepEqual(needsOf({ dependsOn: ["B", "B", "A", "A"] }, by)!.moreTone, "done");
  assert.equal(needsOf({ dependsOn: ["T02", "T03"], needsReport: ["T02"] }, by)!.title, "Needs T02, T03 · full reports of T02");
  // Three ids are written while they fit the cell; of three long ones two, and "+1".
  const idsOf = (deps: string[]) => { const n = needsOf({ dependsOn: deps }, by)!; return [n.ids.map((d) => d.id).join(" "), n.more]; };
  assert.deepEqual([idsOf(["T03", "T18", "T21"]), idsOf(["T03", "T18", "T121"]), idsOf(["T201", "T216", "T219"]), idsOf(["T201", "T216"])],
    [["T03 T18 T21", 0], ["T03 T18 T121", 0], ["T201 T216", 1], ["T201 T216", 0]]);
  // On the rows: B waits on A while A runs, and has it done later.
  const live = layoutTimeline(freeze(small(), at(20)), { width: 600, now: at(20) });
  assert.deepEqual(live.rows.map((r) => r.needs?.ids ?? null), [null, [{ id: "A", tone: "open" }]]);
  assert.deepEqual(layoutTimeline(small(), { width: 600, now: at(100) }).rows.map((r) => r.needs?.title ?? null), [null, "Needs A", "Needs A"]);
  const failed = layoutTimeline(failNow(freeze(small(), at(20)), "A", at(15), "B"), { width: 600, now: at(20) });
  assert.deepEqual(failed.rows[1].needs!.ids, [{ id: "A", tone: "warn" }]);
  const t21 = layoutTimeline(qaRun(), { width: 720, now: 0 }).rows.find((r) => r.id === "T21")!.needs!;
  assert.deepEqual([t21.ids.map((d) => d.id), t21.more, t21.moreTone, t21.title], [["T02", "T03"], 2, "done", "Needs T02, T03, T15, T19"]);
});

test("the tier of a row: deep, std or light; a change of tier across attempts; the tier on a retry that changed it", () => {
  assert.deepEqual([tierWord("deep"), tierWord("standard"), tierWord("light"), tierWord("huge"), tierWord(null), tierWord(undefined)], ["deep", "std", "light", undefined, undefined, undefined]);
  const tiered = (tiers: (string | null)[], own?: string): TLTask => ({ ...task("T", 1, 1, []), tier: own, attempts: tiers.map((tier, i) => ({ n: i + 1, queuedTurn: 1, phases: [{ k: "work" as const, t: at(10 * (i + 1)) }], tier })) });
  assert.deepEqual(rowTier(tiered(["standard"])), { tier: "standard", word: "std", mixed: false, title: "standard" });
  assert.deepEqual(rowTier(tiered(["light"])), { tier: "light", word: "light", mixed: false, title: "light" });
  // The latest attempt's tier, and what the earlier ones ran at.
  assert.deepEqual(rowTier(tiered(["standard", "deep"], "deep")), { tier: "deep", word: "deep", mixed: true, title: "deep (attempt 1 ran at standard)" });
  assert.deepEqual(rowTier(tiered(["standard", "standard", "light", "deep"])), { tier: "deep", word: "deep", mixed: true, title: "deep (attempts 1, 2 ran at standard, attempt 3 ran at light)" });
  assert.deepEqual(rowTier(tiered(["deep", "deep"])), { tier: "deep", word: "deep", mixed: false, title: "deep" });
  assert.deepEqual(rowTier(tiered(["deep", "standard", "deep"]))!.title, "deep (attempt 2 ran at standard)");
  // The task's own tier when its attempt names none; nothing when the record has no tier (a run of before v3).
  assert.equal(rowTier(tiered([null], "light"))!.word, "light"); assert.equal(rowTier(tiered([], "deep"))!.word, "deep");
  assert.equal(rowTier(tiered([null])), null); assert.equal(rowTier(tiered(["huge"])), null);
  assert.ok(layoutTimeline(small(), { width: 500, now: at(100) }).rows.every((r) => r.tier === null));
  // On the rows, with the retry that raised the tier: "↻ deep".
  const run = small(), c = run.tasks[2];
  c.attempts[0] = { ...c.attempts[0], endedAt: at(50), outcome: "failed", tier: "standard" };
  c.attempts.push({ n: 2, queuedTurn: 3, queuedAt: at(60.5), phases: [{ k: "held", t: at(60.5), turn: 3 }, { k: "work", t: at(61) }], startedAt: at(61), endedAt: at(90), outcome: "done", conflicts: [], tier: "deep" });
  c.tier = "deep";
  const retry = (over: Partial<TLOp>) => {
    const r = small(); r.tasks[2] = c; r.turns[2].ops.push({ op: "retry_task", task: "C", t: at(60.5), i: 1, ...over });
    const row = layoutTimeline(r, { width: 500, now: at(100) }).rows[2];
    return [row.tier!.word, row.tier!.mixed, row.marks.find((m) => m.kind === "retry")!.tier ?? null];
  };
  assert.deepEqual(retry({ tier: "deep", attempt: 2 }), ["deep", true, "deep"]);
  assert.deepEqual(retry({}), ["deep", true, "deep"]);                    // the call names neither: the attempt that began at the call
  assert.deepEqual(retry({ tier: "standard", attempt: 2 }), ["deep", true, null]); // the same tier as before: nothing to write
  assert.deepEqual(retry({ tier: "light", attempt: 2 }), ["deep", true, "light"]);
  c.attempts[1].tier = "standard"; c.tier = "standard";
  assert.deepEqual(retry({ attempt: 2 }), ["std", false, null]);
  // A chat's retry outside a turn says it too.
  c.attempts[1].tier = "deep";
  const chat = small({ chatOps: [{ op: "retry_task", task: "C", t: at(60.5), i: 0, chat: "c1", tier: "deep", attempt: 2 }] }); chat.tasks[2] = c;
  assert.deepEqual(layoutTimeline(chat, { width: 500, now: at(100) }).rows[2].marks.find((m) => m.kind === "retry"), { kind: "retry", glyph: "↻", x: layoutTimeline(chat, { width: 500, now: at(100) }).axis.x(at(60.5)), tier: "deep" });
});

test("direct edges of one task, up and down, for the row under the pointer", () => {
  const run = small(); run.tasks.push(task("D", 3, 60.5, [["work", 61]], [70, "done"], { deps: ["B", "A"] }));
  const L = layoutTimeline(run, { width: 800, now: at(100) }), now = L.axis.t1;
  const of = (id: string, rows = L.rows) => directEdges(run, rows, L.axis, id, now);
  assert.deepEqual(of("B").map((e) => [e.from, e.to, e.kind, e.level]), [["A", "B", "release", "direct"], ["B", "D", "lineage", "direct"]]); // up, then down
  assert.deepEqual(of("A").map((e) => [e.from, e.to, e.kind]), [["A", "B", "release"], ["A", "C", "lineage"], ["A", "D", "lineage"]]);       // only down
  assert.deepEqual(of("D").map((e) => [e.from, e.to]), [["B", "D"], ["A", "D"]]);                                                              // only up
  // The same paths as the direct connectors of that task selected.
  const S = layoutTimeline(run, { width: 800, now: at(100), selTask: "B" });
  assert.deepEqual(of("B"), S.edges.filter((e) => e.level === "direct"));
  // Up goes down the chart from the dependency's end, and down from this task's end to its dependent's row.
  const [up, down] = of("B");
  near(up.points[0][0], L.axis.x(at(40))); near(up.points.at(-1)![1], K.ROW * 1.5);
  near(down.points[0][0], L.axis.x(at(60))); near(down.points.at(-1)![1], K.ROW * 3.5);
  // Nothing is laid out again: a row the filter hides has no edge, and a task that is not shown has none at all.
  const F = layoutTimeline(run, { width: 800, now: at(100), only: new Set(["B", "D"]) });
  assert.deepEqual(directEdges(run, F.rows, F.axis, "B", now).map((e) => [e.from, e.to]), [["B", "D"]]);
  assert.deepEqual(directEdges(run, F.rows, F.axis, "A", now), []);
  assert.deepEqual(of("nope"), []);
  // An unfinished dependency: the bracket right of now, as in the layout.
  const live = freeze(small(), at(20)), V = layoutTimeline(live, { width: 600, now: at(20) });
  assert.deepEqual(directEdges(live, V.rows, V.axis, "B", V.axis.t1), V.edges.map((e) => ({ ...e, level: "direct" })));
});

test("a selected turn: the rows it waited for, the row that woke it early, and the first row it added", () => {
  const tags = (run: ScRun, selTurn: number) => { const L = layoutTimeline(run, { width: 500, now: at(100), selTurn }); return { rows: L.rows.map((r) => [r.id, r.touched, !!r.waited, !!r.woke, !!r.dim]), first: L.selFirst }; };
  // Turn 2 waited for A, which met its wait (A is not said to have woken it), and added C.
  assert.deepEqual(tags(waiting(), 2), { rows: [["A", null, true, false, false], ["B", null, false, false, true], ["C", "+", false, false, false]], first: "C" });
  // Turn 3 waited for any of B and C; it added nothing.
  assert.deepEqual(tags(waiting(), 3), { rows: [["A", null, false, false, true], ["B", null, true, false, false], ["C", null, true, false, false]], first: null });
  assert.equal(tags(waiting(), 1).first, "A");
  // Started early by B's failure: B woke it (and is not also "waited for"), C was waited for.
  const early = waiting(); early.turns[2] = { ...early.turns[2], waitMet: false, reason: "events", wokenBy: woke(["B", "task_failed"]) };
  assert.deepEqual(tags(early, 3).rows, [["A", null, false, false, true], ["B", null, false, true, false], ["C", null, true, false, false]]);
  // Started early by a task that was not waited for.
  early.turns[2].wokenBy = woke(["A", "task_failed"]);
  assert.deepEqual(tags(early, 3).rows.map((r) => [r[0], r[2], r[3]]), [["A", false, true], ["B", true, false], ["C", true, false]]);
  // With no wait at all, what woke it is "woke it", as before.
  assert.deepEqual(tags(small(), 2), { rows: [["A", null, false, true, false], ["B", null, false, false, true], ["C", "+", false, false, false]], first: "C" });
  // The first row it added among the rows shown; nothing with a task selected or no selection.
  assert.equal(layoutTimeline(waiting(), { width: 500, now: at(100), selTurn: 1, only: new Set(["B", "C"]) }).selFirst, "B");
  assert.equal(layoutTimeline(waiting(), { width: 500, now: at(100), selTask: "A" }).selFirst, null);
  assert.equal(layoutTimeline(waiting(), { width: 500, now: at(100) }).selFirst, null);
});

test("the legend: two headed groups, ten lines, nothing of the vocabulary that was cut", () => {
  assert.deepEqual(LEGEND.map((g) => [g.head, g.lines.length]), [["Orchestrator", 5], ["Tasks", 5]]);
  const items = LEGEND.flatMap((g) => g.lines.flat());
  assert.equal(new Set(items.map((i) => i.sample)).size, items.length, "each sample once");
  assert.ok(items.every((i) => i.text && i.sample));
  assert.deepEqual(LEGEND[0].lines.map((l) => l.map((i) => i.text).join(" · ")), [
    "a turn · one that changed nothing", "one that started before its wait was met", "the turn that added the task, and when",
    "it changed · retried · cancelled the task", "waiting for tasks · a task it waits for"]);
  assert.deepEqual(LEGEND[1].lines.map((l) => l.map((i) => i.text).join(" · ")), [
    "queued", "waiting on what it needs · blocked", "working · done, merged · failed · paused", "the dependency whose end let it start", "refused call · merge conflict"]);
  assert.deepEqual(items.filter((i) => i.glyph).map((i) => [i.sample, i.glyph]), [["add", "◆"], ["marks", "~ ↻ ✕"], ["paused", "‖"], ["warn", "⚠"]]);
  const said = JSON.stringify(LEGEND);
  for (const cut of ["held", "slot", "setup", "chat", "✎", "writes code"]) assert.ok(!said.includes(cut), cut);
  // The layout draws nothing the legend has no line for: the kinds of a row's lines and of a bar's parts.
  const L = layoutTimeline(synthesize(qaRun()), { width: 720, now: 0 });
  const kinds = new Set(L.rows.flatMap((r) => r.segs.flatMap((s) => (s.k === "bar" ? s.parts.map((p) => "part " + p.k) : [s.k]))));
  assert.deepEqual([...kinds].sort(), ["deps", "part merge", "part work", "queued"]);
  assert.ok(L.rows.every((r) => r.marks.every((m) => !("by" in m) && !("byOrchestrator" in m))) && L.turns.every((t) => !("marks" in t)));
});

test("pause labels: one that does not fit beside its neighbour is shortened before it is left out", () => {
  const gap = (x: number, ms: number, reason = "user") => ({ x1: x - 7, x2: x + 7, from: 0, to: ms, open: false, reason });
  const texts = (...g: ReturnType<typeof gap>[]) => gapLabels(g).map((l) => l.text);
  assert.deepEqual(texts(gap(100, 600_000, "app_quit"), gap(400, 300_000)), ["app closed 10m 00s", "stopped 5m 00s"]);
  assert.deepEqual(gapLabels([gap(100, 600_000)]).map((l) => l.x), [100]);
  assert.deepEqual(texts(gap(100, 600_000, "app_quit"), gap(190, 300_000)), ["app closed 10m 00s", "5m 00s"]);
  assert.deepEqual(texts(gap(100, 600_000, "app_quit"), gap(180, 300_000)), ["app closed 10m 00s", "5m"]);
  assert.deepEqual(texts(gap(100, 600_000, "app_quit"), gap(150, 300_000)), ["10m 00s", "5m"], "the one before it gives way too");
  assert.deepEqual(texts(gap(100, 600_000, "app_quit"), gap(135, 300_000)), ["10m", "5m"]);
  assert.deepEqual(texts(gap(100, 600_000, "app_quit"), gap(115, 300_000), gap(420, 45_000)), ["app closed 10m 00s", null, "stopped 45s"], "no form fits: left out, and the first keeps its words");
  assert.deepEqual(texts(gap(100, 5_400_000), gap(140, 45_000)), ["1h", "45s"]);
  assert.deepEqual(texts(), []);
});

test("the side of a row its direct edges go to, of the rows that are listed", () => {
  const t = (id: string, dependsOn: string[] = []) => ({ id, dependsOn }) as TLTask;
  const run = { tasks: [t("T1"), t("T2", ["T1"]), t("T3", ["T2"]), t("T4", ["T2"]), t("T5", ["T3"])] };
  const rows = (...ids: string[]) => new Map(ids.map((id, i) => [id, { y: i * 26 }]));
  const all = rows("T1", "T2", "T3", "T4", "T5");
  assert.equal(relatedSide(run, all, "T1"), "below");
  assert.equal(relatedSide(run, all, "T2"), null, "needs T1 above, needed by T3 and T4 below");
  assert.equal(relatedSide(run, all, "T4"), "above");
  assert.equal(relatedSide(run, all, "T5"), "above", "T3 only: T2 is not a direct edge");
  assert.equal(relatedSide(run, rows("T2", "T3", "T4"), "T2"), "below", "T1 is not listed");
  assert.equal(relatedSide(run, rows("T1"), "T1"), null);
  assert.equal(relatedSide(run, all, "T9"), null);
});
