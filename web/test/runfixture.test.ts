// The sample run of the mock server (dev/runmock.mjs): a real 53-task run in the contract's shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyRunPatch, emptyDetail } from "../src/logic/rundetail.ts";
import { taskState } from "../src/logic/runtimeline.ts";
import { normDetail } from "../src/logic/runnorm.ts";
import { TASK_STATES, TIERS, type RunDetail, type RunPatch } from "../src/types.ts";

const raw = readFileSync(new URL("./fixtures/run-detail-qa.json", import.meta.url), "utf8");
const d: RunDetail = JSON.parse(raw);
const ascending = (xs: number[]) => xs.every((x, i) => i === 0 || x > xs[i - 1]);
const ordered = (xs: number[]) => xs.every((x, i) => i === 0 || x >= xs[i - 1]);

test("the sample run is the finished 53-task, 35-turn run", () => {
  assert.equal(d.status, "completed"); assert.equal(d.result?.outcome, "achieved");
  assert.equal(d.tasks.length, 53); assert.equal(d.turns.length, 35); assert.equal(Object.keys(d.agents).length, 88);
  assert.ok(d.endedAt! > d.startedAt);
  assert.ok(!raw.includes("/Users/") && !raw.includes("/home/"), "no absolute path of the machine it ran on");
});

test("turns ascend by n, and each one's ops by i", () => {
  assert.ok(ascending(d.turns.map((t) => t.n)));
  assert.deepEqual(d.turns.map((t) => t.n), d.turns.map((_, i) => i + 1));
  for (const t of d.turns) {
    assert.deepEqual(t.ops.map((o) => o.i), t.ops.map((_, i) => i), `turn ${t.n}`);
    assert.ok(ordered(t.ops.map((o) => o.t)), `turn ${t.n}: ops in time order`);
    assert.ok(t.endedAt! >= t.startedAt);
  }
  assert.ok(ordered(d.turns.map((t) => t.startedAt)));
});

test("every task has at least one attempt, in order, with phases in time order", () => {
  assert.equal(new Set(d.tasks.map((t) => t.id)).size, d.tasks.length, "ids are unique");
  assert.ok(ordered(d.tasks.map((t) => t.createdAt)), "tasks are in creation order");
  const known = new Set(d.tasks.map((t) => t.id)), turns = new Set(d.turns.map((t) => t.n));
  for (const t of d.tasks) {
    assert.ok(t.attempts.length >= 1, t.id);
    assert.deepEqual(t.attempts.map((a) => a.n), t.attempts.map((_, i) => i + 1), t.id);
    assert.ok(turns.has(t.addedTurn), `${t.id}: added by a turn of the run`);
    for (const dep of t.dependsOn) assert.ok(known.has(dep), `${t.id} depends on ${dep}`);
    assert.ok(t.briefs.some((b) => b.rev === t.briefRev), `${t.id}: the brief in force is listed`);
    for (const a of t.attempts) {
      assert.ok(a.phases.length >= 1, `${t.id} attempt ${a.n}`);
      assert.ok(ordered(a.phases.map((p) => p.t)), `${t.id}: phases in time order`);
      assert.ok(turns.has(a.queuedTurn));
    }
    assert.ok(TASK_STATES.includes(taskState(t)));
  }
  assert.ok(d.tasks.every((t) => taskState(t) === "done"), "the run ended with every task done");
});

test("every agent a turn or an attempt names is in agents, under its own id", () => {
  for (const [id, a] of Object.entries(d.agents)) assert.equal(a.id, id);
  for (const t of d.turns) {
    const a = d.agents[t.agent];
    assert.ok(a, `turn ${t.n}`); assert.equal(a.role, "orchestrator"); assert.equal(a.turn, t.n);
  }
  const named = new Set(d.turns.map((t) => t.agent));
  for (const t of d.tasks) for (const at of t.attempts) {
    for (const [role, id] of Object.entries(at.agents)) {
      const a = d.agents[id];
      assert.ok(a, `${t.id} attempt ${at.n} ${role}`);
      assert.equal(a.role, role === "work" ? "task" : "merge"); assert.equal(a.task, t.id); assert.equal(a.attempt, at.n);
      named.add(id);
    }
  }
  assert.equal(named.size, Object.keys(d.agents).length, "and no agent is left over");
});

test("notes ascend by v; a finished run has no open stop", () => {
  assert.ok(ascending(d.notes.map((n) => n.v)));
  assert.ok(d.stops.every((s) => s.resumedAt !== undefined));
});

test("the detail sent as one patch to an empty detail gives its collections back", () => {
  const { run: _run, version: _version, ...patch } = d;
  const out = applyRunPatch(emptyDetail(d.run, d.startedAt), patch satisfies RunPatch);
  assert.deepEqual({ ...out, version: d.version }, d);
  for (const k of ["turns", "tasks", "chatOps", "notes", "stops", "agents"] as const) assert.deepEqual(out[k], d[k], k);
  // and in two halves, the second arriving first: the same turns in the same order
  const half = Math.floor(d.turns.length / 2);
  const split = applyRunPatch(applyRunPatch(emptyDetail(d.run), { turns: d.turns.slice(half) }), { turns: d.turns.slice(0, half) });
  assert.deepEqual(split.turns, d.turns);
});

// ---- process v3

test("every task, attempt and agent has a tier; an agent has its model and its usage", () => {
  for (const t of d.tasks) {
    assert.ok(TIERS.includes(t.tier), t.id); assert.ok(t.tierReason.length > 10 && /[.]$/.test(t.tierReason), `${t.id}: a sentence`);
    assert.ok(Array.isArray(t.needsReport), t.id);
    for (const dep of t.needsReport) assert.ok(t.dependsOn.includes(dep), `${t.id}: needsReport is a part of dependsOn`);
    for (const a of t.attempts) assert.ok(TIERS.includes(a.tier), `${t.id} attempt ${a.n}`);
  }
  assert.ok(d.tasks.some((t) => t.needsReport.length) && d.tasks.some((t) => t.dependsOn.length && !t.needsReport.length));
  assert.deepEqual([...new Set(d.tasks.map((t) => t.tier))].sort(), ["deep", "light", "standard"]);
  for (const a of Object.values(d.agents)) {
    assert.ok(TIERS.includes(a.tier), a.name); assert.ok(a.model, a.name);
    if (a.role === "orchestrator") assert.equal(a.tier, "deep");
    else if (a.role === "merge") assert.equal(a.tier, "standard");
    else assert.equal(a.tier, d.tasks.find((t) => t.id === a.task)!.attempts[a.attempt! - 1].tier, a.name);
    assert.ok(a.tokens && a.tokens.in > 0 && a.tokens.out > 0 && a.tokens.cacheRead > 0 && a.tokens.cacheWrite > 0, a.name);
    assert.ok(a.peakContext! > 0 && a.peakContext! <= 200000, a.name);
  }
  // one model and effort per tier
  const by = new Map<string, Set<string>>();
  for (const a of Object.values(d.agents)) by.set(a.tier, (by.get(a.tier) ?? new Set()).add(`${a.model}/${a.effort}`));
  assert.deepEqual([...by].map(([k, v]) => [k, [...v]]).sort(), [["deep", ["opus/high"]], ["light", ["sonnet/medium"]], ["standard", ["opus/medium"]]]);
});

test("an add_task op carries the tier of the task it added", () => {
  const ops = d.turns.flatMap((t) => t.ops).filter((o) => o.op === "add_task" && !o.error);
  assert.equal(ops.length, 53);
  for (const o of ops) {
    const t = d.tasks.find((x) => x.id === o.task)!;
    assert.deepEqual([o.tier, o.tierReason], [t.tier, t.tierReason], o.task);
    assert.deepEqual(o.needsReport ?? [], t.needsReport, o.task);
    assert.notDeepEqual(o.needsReport, [], "absent when empty");
  }
});

test("every turn but the first starts under the wait the turn before declared, and that wait was met", () => {
  const known = new Set(d.tasks.map((t) => t.id));
  assert.deepEqual([d.turns[0].reason, d.turns[0].wait, d.turns[0].waitMet], ["start", undefined, undefined]);
  for (const [i, t] of d.turns.entries()) {
    const last = t.ops.at(-1)!, next = d.turns[i + 1];
    if (!next) { assert.equal(last.op, "finish_run"); continue; }
    assert.equal(last.op, "wait_for", `turn ${t.n} ends with its wait`);
    assert.ok(last.tasks!.length >= 1 && last.tasks!.every((x) => known.has(x)));
    assert.deepEqual(next.wait, { tasks: last.tasks, mode: last.mode, turn: t.n }, `turn ${next.n}`);
    assert.deepEqual([next.reason, next.waitMet], ["wait", true], `turn ${next.n}`);
    // met: all of its tasks woke the turn, or (any) one of them did
    const woke = new Set(next.wokenBy.map((e) => e.task));
    assert.ok(last.mode === "all" ? last.tasks!.every((x) => woke.has(x)) : last.tasks!.some((x) => woke.has(x)), `turn ${next.n}`);
  }
  assert.ok(d.turns.some((t) => t.wait?.mode === "any") && d.turns.some((t) => t.wait?.mode === "all" && t.wait.tasks.length > 1));
});

test("some turns edit a section of the notes, and some change nothing in the plan", () => {
  const edits = d.turns.flatMap((t) => t.ops).filter((o) => o.op === "edit_notes");
  assert.equal(edits.length, 8);
  for (const o of edits) { assert.ok(o.heading); assert.ok(o.notesVersion! > 0 && o.size! > 0); assert.ok(d.notes.some((n) => n.v === o.notesVersion)); }
  const quiet = d.turns.filter((t) => t.ops.every((o) => o.op.startsWith("get_") || o.op === "wait_for" || o.op === "set_notes" || o.op === "edit_notes"));
  assert.deepEqual(quiet.map((t) => t.n), [2, 12, 17, 18, 20, 23, 27, 31, 32, 33]);
});

test("the sample run is whole as it is: normDetail changes nothing in it", () => {
  assert.equal(d.git?.branch, "main");
  assert.equal(d.delivery, undefined, "the mock gives each scenario its delivery");
  assert.deepEqual(JSON.parse(JSON.stringify(normDetail(JSON.parse(raw)))), d);
});
