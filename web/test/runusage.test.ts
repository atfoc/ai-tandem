import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_KIND, NO_TIER, costShare, manyQuiet, missingNote, runUsage, usageMoney, usageTokens } from "../src/logic/runusage.ts";
import type { AgentRole, Op, OpName, RunAgent, RunDetail, Task, Tier, TokenCount, Turn } from "../src/types.ts";

const tok = (n: number): TokenCount => ({ in: n, out: n * 2, cacheRead: n * 10, cacheWrite: n * 3 });
let seq = 0;
const agent = (role: AgentRole, o: Partial<RunAgent> = {}): RunAgent => {
  const id = `a${++seq}`;
  return { id, name: id, role, status: "done", startedAt: 0, launches: [], cost: 1, tier: role === "orchestrator" ? "deep" : "standard", model: "m", tokens: tok(100), peakContext: 1000, ...o };
};
const work = (task: string, tier: Tier, o: Partial<RunAgent> = {}) => agent("task", { task, tier, ...o });
const task = (id: string, kind: string): Task => ({ id, kind } as Task);
const op = (name: OpName, error?: string): Op => ({ i: 0, t: 0, op: name, ...(error ? { error } : {}) });
const turn = (n: number, ops: Op[], o: Partial<Turn> = {}): Turn =>
  ({ n, agent: `t${n}`, reason: "wait", status: "done", startedAt: 0, wokenBy: [], learned: [], ops, cost: 1, ...o });
const detail = (agents: RunAgent[], tasks: Task[] = [], turns: Turn[] = []): RunDetail =>
  ({ run: "r", version: 1, status: "running", startedAt: 0, goalSize: 0, stops: [], turns, tasks, chatOps: [], notes: [], agents: Object.fromEntries(agents.map((a) => [a.id, a])) });

test("by tier: every agent in its own tier, deep, standard, light, a tier with no agent left out", () => {
  const u = runUsage(detail([
    work("T1", "light", { cost: 0.5 }), work("T2", "deep", { cost: 4 }), work("T3", "deep", { cost: 2 }),
    agent("orchestrator", { cost: 50, tier: "deep" }), agent("merge", { task: "T2", cost: 30, tier: "standard" }),
  ], [task("T1", "docs"), task("T2", "fix"), task("T3", "fix")]));
  assert.deepEqual(u.byTier.map((r) => [r.key, r.agents, r.cost]), [["deep", 3, 56], ["standard", 1, 30], ["light", 1, 0.5]]);
  assert.equal(u.byTier[0].costPerAgent, 56 / 3);
  assert.deepEqual(u.byTier[0].tokens, { in: 300, out: 600, cacheRead: 3000, cacheWrite: 900 });
  // the tier rows add up to the total, which is of every agent
  assert.deepEqual({ agents: u.total.agents, cost: u.total.cost, medianPeakContext: u.total.medianPeakContext }, { agents: 5, cost: 86.5, medianPeakContext: 1000 });
  assert.equal(u.byTier.reduce((n, r) => n + (r.cost ?? 0), 0), u.total.cost);
  assert.equal(u.byTier.reduce((n, r) => n + r.agents, 0), u.total.agents);
  assert.equal(u.bare, false);
});

test("by tier: agents with no tier (a run from before tiers) have a last row of their own", () => {
  const none = undefined as unknown as Tier;
  const u = runUsage(detail([work("T1", "deep", { cost: 1 }), agent("orchestrator", { cost: 5, tier: none }), agent("merge", { cost: 2, tier: none })]));
  assert.deepEqual(u.byTier.map((r) => [r.key, r.agents, r.cost]), [["deep", 1, 1], [NO_TIER, 2, 7]]);
  assert.equal(u.byTier.reduce((n, r) => n + (r.cost ?? 0), 0), u.total.cost);
});

test("agent time: the ended agents' start to end, added up", () => {
  const u = runUsage(detail([
    work("T1", "deep", { startedAt: 1000, endedAt: 61_000 }), work("T2", "deep", { startedAt: 2000, endedAt: 32_000 }),
    work("T3", "light", { startedAt: 5000, endedAt: undefined, status: "running" }),
  ]));
  assert.deepEqual(u.byTier.map((r) => [r.key, r.ms]), [["deep", 90_000], ["light", null]]);
  assert.equal(u.total.ms, 90_000);
});

test("by kind: the orchestrator first, the kinds by cost, merge last", () => {
  const tasks = [task("T1", "review"), task("T2", "fix"), task("T3", "fix"), task("T4", "verify"), task("T5", "audit")];
  const u = runUsage(detail([
    agent("merge", { task: "T2", cost: 99 }),
    work("T1", "deep", { cost: 5 }), work("T2", "standard", { cost: 4 }), work("T3", "standard", { cost: 3 }),
    work("T4", "light", { cost: null }), work("T5", "light", { cost: null }), work("T2", "standard", { attempt: 2, cost: 1 }),
    agent("orchestrator", { cost: 0.1 }), agent("orchestrator", { cost: 0.2 }),
  ], tasks));
  assert.deepEqual(u.byKind.map((r) => [r.key, r.agents]), [["orchestrator", 2], ["fix", 3], ["review", 1], ["audit", 1], ["verify", 1], ["merge", 1]]);
  assert.equal(u.byKind[1].cost, 8);
  assert.equal(u.byKind[3].cost, null, "no agent of the kind has a cost");
  assert.equal(u.byKind[3].costPerAgent, null);

  // rows with no agent are left out, the fixed ones too
  assert.deepEqual(runUsage(detail([work("T1", "deep")], tasks)).byKind.map((r) => r.key), ["review"]);
  // equal costs: by key
  assert.deepEqual(runUsage(detail([work("T4", "deep"), work("T2", "deep"), work("T1", "deep")], tasks)).byKind.map((r) => r.key), ["fix", "review", "verify"]);
  // a task the detail does not have
  assert.deepEqual(runUsage(detail([work("T9", "deep"), agent("task")], tasks)).byKind.map((r) => [r.key, r.agents]), [[NO_KIND, 2]]);
});

test("the median peak context is the upper median of the known peaks", () => {
  const peaks = (...p: (number | undefined)[]) => runUsage(detail(p.map((peakContext) => work("T1", "deep", { peakContext })), [task("T1", "fix")]));
  assert.equal(peaks(30, 10, 20).byTier[0].medianPeakContext, 20, "odd");
  assert.equal(peaks(40, 10, 30, 20).byTier[0].medianPeakContext, 30, "even: the upper one");
  assert.equal(peaks(0, 50, undefined, 10).byTier[0].medianPeakContext, 50, "unknown peaks are left out");
  assert.equal(peaks(7).total.medianPeakContext, 7);
  const none = peaks(0, undefined);
  assert.equal(none.byTier[0].medianPeakContext, null);
  assert.equal(none.byKind[0].medianPeakContext, null);
  assert.equal(none.total.medianPeakContext, null);
});

test("a run whose agents report no cost and no tokens (Cursor)", () => {
  const off = { cost: null, tokens: null, peakContext: undefined };
  const d = detail([work("T1", "deep", off), work("T2", "standard", off), agent("orchestrator", off), agent("merge", off)], [task("T1", "fix"), task("T2", "fix")],
    [turn(1, [op("add_task")], { cost: null }), turn(2, [op("wait_for")], { cost: null })]);
  const u = runUsage(d);
  for (const r of [...u.byTier, ...u.byKind]) assert.deepEqual([r.cost, r.costPerAgent, r.tokens, r.medianPeakContext], [null, null, null, null], r.key);
  assert.deepEqual(u.byTier.map((r) => [r.key, r.agents]), [["deep", 2], ["standard", 2]]);
  assert.deepEqual(u.total, { agents: 4, cost: null, medianPeakContext: null, ms: null });
  assert.equal(u.bare, true);
  assert.deepEqual(u.turns, { done: 2, cost: null, quiet: 1, quietCost: null });
  assert.equal(missingNote(d), "This agent kind reports no cost, tokens or peak context.");
});

test("sums are over the agents that have a figure", () => {
  const d = detail([work("T1", "deep", { cost: 2, tokens: null }), work("T1", "deep", { cost: null, tokens: tok(5) }), work("T1", "deep", { cost: 0, tokens: tok(1) })], [task("T1", "fix")]);
  const r = runUsage(d).byTier[0];
  assert.deepEqual([r.agents, r.cost, r.costPerAgent], [3, 2, 2 / 3]);
  assert.deepEqual(r.tokens, { in: 6, out: 12, cacheRead: 60, cacheWrite: 18 });
  assert.equal(missingNote(d), "Some agents reported no cost or tokens: the sums are of those that did.");
  // a zero is a figure
  assert.equal(runUsage(detail([work("T1", "deep", { cost: 0 })], [task("T1", "fix")])).total.cost, 0);
});

test("the note says what is missing", () => {
  assert.equal(missingNote(detail([work("T1", "deep")])), "");
  assert.equal(missingNote(detail([])), "");
  assert.equal(missingNote(detail([work("T1", "deep", { cost: null })])), "This agent kind reports no cost.");
  assert.equal(missingNote(detail([work("T1", "deep", { tokens: null, peakContext: 0 })])), "This agent kind reports no tokens or peak context.");
  assert.equal(missingNote(detail([work("T1", "deep", { peakContext: 0 })])), "", "an unknown peak alone is not worth a note");
  assert.equal(missingNote(detail([work("T1", "deep"), work("T1", "deep", { tokens: null })])), "Some agents reported no tokens: the sums are of those that did.");
  // on a live run the agents at work have no cost yet
  assert.equal(missingNote(detail([work("T1", "deep"), work("T1", "deep", { status: "running", cost: null })])), "The agents still at work have reported no cost yet.");
  assert.equal(missingNote(detail([work("T1", "deep", { cost: null }), work("T1", "deep", { status: "running", cost: null }), work("T1", "deep")])), "Some agents reported no cost: the sums are of those that did.");
});

test("quiet turns: the done ones none of whose ops changed the plan", () => {
  const u = runUsage(detail([], [], [
    turn(1, [op("get_run"), op("add_task"), op("wait_for")], { cost: 2 }),
    turn(2, [op("get_run"), op("set_notes"), op("wait_for")], { cost: 0.5 }),          // quiet
    turn(3, [op("update_task", "no such task"), op("add_task", "refused")], { cost: 0.25 }), // quiet: refused changes
    turn(4, [], { cost: null }),                                                        // quiet, no cost
    turn(5, [op("edit_notes"), op("tell_orchestrator"), op("get_task")], { cost: 1 }), // quiet
    turn(6, [op("cancel_task")], { cost: 3 }), turn(7, [op("retry_task")], { cost: 3 }), turn(8, [op("finish_run")], { cost: 3 }),
    turn(9, [op("update_task", "refused"), op("update_task")], { cost: 1 }),
    turn(10, [op("wait_for")], { status: "running", cost: 9 }), turn(11, [], { status: "failed", cost: 9 }),
  ]));
  assert.deepEqual(u.turns, { done: 9, cost: 13.75, quiet: 4, quietCost: 1.75 });
  assert.equal(manyQuiet(u.turns), true);
  assert.equal(manyQuiet({ done: 8, quiet: 2 }), false, "a quarter is not above a quarter");
  assert.equal(manyQuiet({ done: 8, quiet: 3 }), true);
  assert.equal(manyQuiet({ done: 0, quiet: 0 }), false);
});

test("an empty run", () => {
  assert.deepEqual(runUsage(detail([])), {
    byTier: [], byKind: [], total: { agents: 0, cost: null, medianPeakContext: null, ms: null }, bare: false, turns: { done: 0, cost: null, quiet: 0, quietCost: null },
  });
});

test("how the figures are written", () => {
  assert.deepEqual([usageTokens(1_400_000), usageTokens(400_000), usageTokens(950), usageTokens(0), usageTokens(null)], ["1.4M", "400k", "950", "0", "—"]);
  assert.deepEqual([usageMoney(258.55), usageMoney(0), usageMoney(null)], ["$258.55", "$0.00", "—"]);
  assert.deepEqual([costShare(5, 20), costShare(null, 20), costShare(5, null), costShare(5, 0), costShare(30, 20)], [0.25, 0, 0, 0, 1]);
});
