import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SETTINGS, normBrief, normChanges, normDelivery, normDetail, normGoal, normNotes, normPatch, normReport, normRun } from "../src/logic/runnorm.ts";
import { runRowLine, runTaskTotal, runWord, limitsLabel } from "../src/logic/run.ts";
import { timelineInput } from "../src/logic/runwire.ts";
import { layoutTimeline } from "../src/logic/runtimeline.ts";
import { turnLabel, turnTip } from "../src/logic/runlabels.ts";
import { applyRunPatch } from "../src/logic/rundetail.ts";
import { notesChange, taskHistory, turnStart, turnThen } from "../src/logic/runfeed.ts";
import type { RunDetail, RunView } from "../src/types.ts";

const qa = (): RunDetail => JSON.parse(readFileSync(new URL("./fixtures/run-detail-qa.json", import.meta.url), "utf8"));
/** What the wire may hold in place of a record: anything. */
const wire = <T>(v: unknown): T => v as T;

const RUN = { id: "r_1", name: "A run", group: "g", created: "2026-10-05T10:00:00.000Z", agent: "claude", tiers: { deep: { model: "opus", effort: "high" }, standard: { model: "opus", effort: "medium" }, light: { model: "sonnet" } }, cwd: "/x", status: "running", started: "2026-10-05T10:00:01.000Z",
  settings: { ...SETTINGS }, activeMs: 5, asOf: 7, turns: 2, idleStreak: 0, counts: { held: 0, deps: 0, blocked: 0, slot: 0, setup: 0, work: 1, merge: 0, done: 2, failed: 0, cancelled: 0 }, cost: 1.5, attention: 0 };

test("normRun leaves a whole record as it is", () => {
  assert.deepEqual(normRun(wire<RunView>(RUN)), { ...RUN, draft: undefined, tierDefaults: undefined, wait: undefined, delivery: undefined });
});

test("normRun: counts and settings that are absent, null or partial are made whole", () => {
  for (const counts of [undefined, null, {}, { done: 3 }]) {
    const r = normRun(wire<RunView>({ ...RUN, counts }));
    assert.equal(Object.keys(r.counts).length, 10);
    for (const n of Object.values(r.counts)) assert.equal(typeof n, "number");
    assert.equal(runTaskTotal(r), counts && "done" in counts ? 3 : 0);
    assert.ok(!runRowLine(r).includes("NaN"));
  }
  for (const settings of [undefined, null, {}, { maxTurns: 12 }]) {
    const r = normRun(wire<RunView>({ ...RUN, settings }));
    assert.deepEqual(r.settings, { ...SETTINGS, ...(settings ?? {}) });
    assert.ok(!/NaN|undefined/.test(limitsLabel(r.settings)));
  }
});

test("normRun: numbers and texts that are absent", () => {
  const r = normRun(wire<RunView>({ id: "r_2", agent: "claude", status: "draft" }));
  assert.deepEqual([r.name, r.cwd, r.tiers.deep.model, r.group, r.activeMs, r.asOf, r.turns, r.idleStreak, r.attention, r.cost], ["", "", "", "__ungrouped__", 0, 0, 0, 0, 0, null]);
  assert.equal(r.started, undefined);
  assert.equal(normRun(wire<RunView>({ ...RUN, cost: undefined })).cost, null);
  assert.equal(normRun(wire<RunView>({ ...RUN, cost: 0 })).cost, 0);
  assert.equal(normRun(wire<RunView>({ ...RUN, draft: null })).draft, undefined);
});

test("normRun: a run that is not a draft always has `started`; a status this client does not know is kept", () => {
  // a run whose record the server could not read: listed with status error and little else
  const broken = normRun(wire<RunView>({ id: "r_3", name: "r_3", group: "__ungrouped__", created: "2026-10-01T08:00:00.000Z", agent: "claude", status: "error", reason: "the run's record could not be read" }));
  assert.equal(broken.started, "2026-10-01T08:00:00.000Z");
  assert.equal(runRowLine(broken), "Error: the run's record could not be read");
  const odd = normRun(wire<RunView>({ ...RUN, status: "hibernating" }));
  assert.equal(odd.status, "hibernating");
  assert.equal(runWord(odd), "hibernating");
  assert.equal(normRun(wire<RunView>({ ...RUN, status: undefined })).status, "stopped");
  assert.equal(normRun(wire<RunView>({ ...RUN, status: undefined, started: undefined })).status, "draft");
});

test("normDetail leaves the recorded run as it is", () => {
  const d = qa();
  assert.deepEqual(JSON.parse(JSON.stringify(normDetail(qa()))), JSON.parse(JSON.stringify(d)));
});

test("normDetail: every list of the detail may be null or absent", () => {
  for (const k of ["turns", "tasks", "stops", "notes", "chatOps"] as const) {
    for (const v of [null, undefined]) {
      const d = normDetail(wire<RunDetail>({ ...qa(), [k]: v }));
      assert.deepEqual(d[k], [], k);
      assert.doesNotThrow(() => layoutTimeline(timelineInput(d), { width: 800, ppm: 4, now: d.startedAt + 60000, tzOffsetMin: 0 }), k);
    }
  }
  const d = normDetail(wire<RunDetail>({ ...qa(), agents: null }));
  assert.deepEqual(d.agents, {});
  const bare = normDetail(wire<RunDetail>({ run: "r_1" }));
  assert.deepEqual([bare.version, bare.status, bare.startedAt, bare.goalSize, bare.turns, bare.tasks, bare.stops, bare.notes, bare.chatOps, bare.agents], [0, "stopped", 0, 0, [], [], [], [], [], {}]);
});

test("normDetail: a turn's ops, wokenBy and learned", () => {
  const src = qa();
  src.turns[0] = wire({ ...src.turns[0], ops: null, wokenBy: null, learned: undefined });
  const d = normDetail(src), t = d.turns[0];
  assert.deepEqual([t.ops, t.wokenBy, t.learned], [[], [], []]);
  // "ops": null used to throw in the turn's label and tooltip
  const tl = timelineInput(d);
  assert.doesNotThrow(() => turnLabel(tl.turns[0], { tz: 0 }));
  assert.doesNotThrow(() => turnTip(tl.turns[0], { now: d.startedAt, live: false, tz: 0 }));
  const noStart = normDetail(wire<RunDetail>({ ...qa(), turns: [{ n: 1, agent: "a", reason: "start", status: "done", cost: undefined }] }));
  assert.equal(noStart.turns[0].startedAt, noStart.startedAt);
  assert.equal(noStart.turns[0].cost, null);
});

test("normDetail: a task's dependsOn, attempts and briefs; an attempt's phases and agents", () => {
  const src = qa();
  src.tasks[0] = wire({ ...src.tasks[0], dependsOn: null, briefs: null, changedTurns: null });
  src.tasks[1] = wire({ ...src.tasks[1], attempts: null });
  src.tasks[2] = wire({ ...src.tasks[2], attempts: [{ ...src.tasks[2].attempts[0], phases: null, agents: null, conflicts: null, result: null }] });
  const d = normDetail(src);
  assert.deepEqual([d.tasks[0].dependsOn, d.tasks[0].briefs, d.tasks[0].changedTurns], [[], [], []]);
  assert.equal(d.tasks[0].briefRev, src.tasks[0].briefRev);
  // "at least one attempt": a task with none is drawn as held
  assert.equal(d.tasks[1].attempts.length, 1);
  assert.deepEqual([d.tasks[1].attempts[0].n, d.tasks[1].attempts[0].phases, d.tasks[1].attempts[0].agents, d.tasks[1].attempts[0].cost], [1, [], {}, null]);
  const a = d.tasks[2].attempts[0];
  assert.deepEqual([a.phases, a.agents, a.conflicts, a.result], [[], {}, undefined, undefined]);
  assert.doesNotThrow(() => layoutTimeline(timelineInput(d), { width: 800, ppm: 4, now: d.startedAt + 60000, tzOffsetMin: 0 }));
});

test("normDetail: a phase kind or an outcome this client does not know", () => {
  const src = qa(), a0 = src.tasks[0].attempts[0];
  src.tasks[0].attempts[0] = wire({ ...a0, phases: [...a0.phases, { k: "quarantine", t: a0.phases[0].t + 5 }, null, { k: "work" }], outcome: "evaporated" });
  const a = normDetail(src).tasks[0].attempts[0];
  assert.deepEqual(a.phases.map((p) => p.k), a0.phases.map((p) => p.k)); // the unknown kind, the null and the one without a time are not drawn
  assert.equal(a.outcome, "failed"); // it ended, and not in a way that is known to be good
  const src2 = qa();
  src2.tasks[0].attempts[0] = wire({ ...a0, phases: [{ k: "deps", t: 1, on: null }] });
  assert.equal(normDetail(src2).tasks[0].attempts[0].phases[0].on, undefined);
});

test("normDetail: an agent's launches, a note's size, a null agent", () => {
  const src = qa(), id = Object.keys(src.agents)[0];
  src.agents[id] = wire({ ...src.agents[id], launches: null, name: undefined, cost: undefined });
  src.agents.ghost = wire(null);
  src.notes = wire([{ v: 1, at: 5, turn: 1 }]);
  const d = normDetail(src);
  assert.deepEqual([d.agents[id].launches, d.agents[id].name, d.agents[id].cost], [[], id, null]);
  assert.ok(!("ghost" in d.agents));
  assert.equal(d.notes[0].size, 0);
});

test("normPatch: what a patch names is made whole; null or absent names nothing", () => {
  assert.deepEqual(normPatch(null), {});
  assert.deepEqual(normPatch(undefined), {});
  assert.deepEqual(normPatch(wire({ turns: null, tasks: null, stops: null, notes: null, chatOps: null, agents: null, git: null, result: null, status: "" })), {});
  const p = normPatch(wire({ status: "stopped", turns: [{ n: 3, agent: "a", reason: "events", status: "running", ops: null, wokenBy: null }], tasks: [{ id: "T09", attempts: null, dependsOn: null }],
    agents: { a: { role: "orchestrator", status: "running", launches: null } }, notes: [{ v: 2, at: 9 }] }), 1000);
  assert.equal(p.status, "stopped");
  assert.deepEqual([p.turns![0].ops, p.turns![0].wokenBy, p.turns![0].learned, p.turns![0].startedAt], [[], [], [], 1000]);
  assert.deepEqual([p.tasks![0].dependsOn, p.tasks![0].attempts.length, p.tasks![0].createdAt], [[], 1, 1000]);
  assert.deepEqual([p.agents!.a.launches, p.agents!.a.id, p.agents!.a.startedAt], [[], "a", 1000]);
  assert.equal(p.notes![0].size, 0);
  // a patch that is made whole applies to a detail
  const d = normDetail(qa());
  const next = applyRunPatch(d, p);
  assert.equal(next.tasks.find((t) => t.id === "T09")!.dependsOn.length, 0);
});

test("the texts loaded on demand", () => {
  assert.deepEqual(normChanges(wire({ files: null, commits: null })), { branch: "", base: "", head: "", files: [], commits: [], add: 0, del: 0, conflicts: undefined });
  assert.deepEqual(normChanges(wire({ branch: "b", base: "1", head: "2", files: [{ path: "a", add: 1, del: 0 }], commits: [], add: 1, del: 0, conflicts: ["a"] })).conflicts, ["a"]);
  assert.deepEqual(normReport(wire({ outcome: "completed" })), { outcome: "completed", summary: "", report: "" });
  assert.deepEqual(normReport(wire({ outcome: "completed", summary: "s", report: null })).report, "");
  assert.deepEqual(normBrief(wire({ rev: 1, at: 3 })), { rev: 1, at: 3, text: "", size: 0 });
  assert.deepEqual(normGoal(wire({})), { text: "" });
  assert.deepEqual(normGoal(wire(null)), { text: "" });
  assert.deepEqual(normNotes(wire({ v: 2, at: 4 })), { v: 2, at: 4, text: "", size: 0 });
});

test("normDetail: a call's dependsOn and changed, in a turn and from a chat; entries that are no record", () => {
  const src = qa();
  src.turns[0] = wire({ ...src.turns[0], ops: [{ i: 0, t: 5, op: "add_task", task: "T01", dependsOn: null, changed: null }, null, { i: 1, op: "update_task", task: "T01", dependsOn: ["T02"], changed: ["brief"] }],
    wokenBy: [null, { seq: 1, t: 5, type: "task_done", task: "T01", text: "" }], learned: [null] });
  src.chatOps = wire([{ i: 0, op: "cancel_task", chat: "c1", task: "T01", dependsOn: null, changed: null }, null]);
  src.stops = wire([null, { at: 9, reason: "user" }]);
  const d = normDetail(src), t = d.turns[0];
  assert.deepEqual(t.ops.map((o) => [o.i, o.dependsOn, o.changed]), [[0, undefined, undefined], [1, ["T02"], ["brief"]]]);
  assert.equal(t.ops[1].t, t.startedAt, "a call without a time has its turn's");
  assert.deepEqual([t.wokenBy.length, t.learned.length], [1, 0]);
  assert.deepEqual(d.chatOps.map((o) => [o.dependsOn, o.changed, o.t]), [[undefined, undefined, d.startedAt]]);
  assert.deepEqual(d.stops, [{ at: 9, reason: "user" }]);
  const p = normPatch(wire({ chatOps: [{ i: 1, op: "add_task", chat: "c1", dependsOn: null }, null], stops: [null], turns: [null], tasks: [null] }), 7);
  assert.deepEqual([p.chatOps!.length, p.chatOps![0].dependsOn, p.chatOps![0].t, p.stops, p.turns, p.tasks], [1, undefined, 7, [], [], []]);
});

test("normDetail: a task's briefs and attempts, an agent's launches: entries that are no record", () => {
  const src = qa(), id = Object.keys(src.agents)[0];
  src.tasks[0] = wire({ ...src.tasks[0], briefs: [null, { rev: 2, at: 5 }], briefRev: undefined, attempts: [null, ...src.tasks[0].attempts] });
  src.agents[id] = wire({ ...src.agents[id], launches: [null, { n: 1, startedAt: 5, resume: false }] });
  const d = normDetail(src);
  assert.deepEqual(d.tasks[0].briefs, [{ rev: 2, at: 5, size: 0 }]);
  assert.equal(d.tasks[0].briefRev, 2, "the brief in force is the last one listed");
  assert.equal(d.tasks[0].attempts.length, src.tasks[0].attempts.length - 1);
  assert.equal(d.agents[id].launches.length, 1);
});

test("what Go sends for nil slices and maps draws: every list null, at every level", () => {
  // internal/model/run.go: no slice of RunDetail, RunTurn, RunTask, RunAttempt or RunAgent has omitempty, so a nil one is `null`
  const d = normDetail(wire<RunDetail>({ run: "r_1", version: 3, status: "running", startedAt: 1000, goalSize: 10, stops: null, chatOps: null, agents: null, notes: null,
    turns: [{ n: 1, agent: "a1", reason: "start", status: "running", startedAt: 1000, wokenBy: null, learned: null, ops: null, cost: null }],
    tasks: [{ id: "T01", title: "One", kind: "implement", writes: true, dependsOn: null, addedTurn: 1, createdAt: 1500, changedTurns: null, briefRev: 1, briefs: null, attempts: null },
      { id: "T02", title: "Two", kind: "implement", writes: true, dependsOn: ["T01"], addedTurn: 1, createdAt: 1500, changedTurns: [], briefRev: 1, briefs: [],
        attempts: [{ n: 1, queuedTurn: 1, queuedAt: 1500, phases: null, agents: {}, cost: null }, { n: 2, queuedTurn: 1, queuedAt: 1600, phases: [{ k: "deps", t: 1600 }], agents: { work: "gone" }, cost: null }] }] }));
  const now = 60000;
  assert.doesNotThrow(() => layoutTimeline(timelineInput(d), { width: 800, ppm: 4, now, tzOffsetMin: 0 }));
  const words = (x: RunDetail) => { for (const t of x.turns) { turnStart(t, x.turns[x.turns.indexOf(t) - 1]); turnThen(t); } for (const t of x.tasks) taskHistory(x, t.id); notesChange(x, 1); };
  assert.doesNotThrow(() => words(d));
  // and a patch of the same kind applies
  const next = applyRunPatch(d, normPatch(wire({ tasks: [{ id: "T03", dependsOn: null, changedTurns: null, briefs: null, attempts: null }], turns: [{ n: 2, wokenBy: null, learned: null, ops: null }], agents: { a2: { launches: null } } }), d.startedAt));
  assert.equal(next.tasks.length, 3);
  assert.doesNotThrow(() => words(next));
  assert.doesNotThrow(() => layoutTimeline(timelineInput(next), { width: 800, ppm: 4, now, tzOffsetMin: 0 }));
});

// ---- process v3: tiers, waits, usage, delivery

test("the defaults of a run's settings are the v3 ones", () => {
  assert.deepEqual([SETTINGS.wake, SETTINGS.maxParallel, SETTINGS.applyResult], ["declared", 8, undefined]);
  assert.equal(normRun(wire<RunView>({ ...RUN, settings: { wake: "each", applyResult: "manual" } })).settings.applyResult, "manual");
});

test("normRun: tiers always have their three keys, each with a model; a wait's tasks are a list", () => {
  for (const tiers of [undefined, null, {}, { deep: { model: "opus", effort: "max" } }, { deep: null, light: {} }]) {
    const r = normRun(wire<RunView>({ ...RUN, tiers }));
    assert.deepEqual(Object.keys(r.tiers), ["deep", "standard", "light"]);
    for (const c of Object.values(r.tiers)) assert.equal(typeof c.model, "string");
  }
  assert.deepEqual(normRun(wire<RunView>({ ...RUN, tiers: { deep: { model: "opus", effort: "max" } } })).tiers, { deep: { model: "opus", effort: "max" }, standard: { model: "" }, light: { model: "" } });
  // a draft's defaults are made whole too; a started run has none
  assert.deepEqual(normRun(wire<RunView>({ ...RUN, tierDefaults: { light: { model: "haiku" } } })).tierDefaults, { deep: { model: "" }, standard: { model: "" }, light: { model: "haiku" } });
  assert.equal(normRun(wire<RunView>({ ...RUN, tierDefaults: null })).tierDefaults, undefined);
  assert.deepEqual(normRun(wire<RunView>({ ...RUN, wait: { tasks: null, mode: "any", turn: 4 } })).wait, { tasks: [], mode: "any", turn: 4 });
  assert.deepEqual(normRun(wire<RunView>({ ...RUN, wait: { tasks: ["T01", "T02"] } })).wait, { tasks: ["T01", "T02"], mode: "all", turn: 0 });
  for (const wait of [undefined, null]) assert.equal(normRun(wire<RunView>({ ...RUN, wait })).wait, undefined);
  const r = normRun(wire<RunView>({ ...RUN, delivery: "blocked", dirty: true }));
  assert.deepEqual([r.delivery, r.dirty], ["blocked", true]);
  assert.equal(normRun(wire<RunView>({ ...RUN, delivery: null })).delivery, undefined);
});

test("normDetail: a task's needsReport and a turn's wait tasks are lists; an op's lists stay absent", () => {
  const d = normDetail(wire<RunDetail>({ run: "r_1", version: 2, status: "running", startedAt: 100,
    turns: [{ n: 1, agent: "a", reason: "start", status: "done", ops: [{ i: 0, op: "add_task", task: "T01", needsReport: null, dependsOn: null }, { i: 1, op: "wait_for", tasks: null }, { i: 2, op: "wait_for", tasks: ["T01"], mode: "any" },
      { i: 3, op: "edit_notes", heading: "Plan", notesVersion: 2, size: 10 }] },
      { n: 2, agent: "b", reason: "wait", status: "running", wait: { tasks: null, mode: "all", turn: 1 }, waitMet: true }, { n: 3, agent: "c", reason: "idle", status: "running", wait: null }],
    tasks: [{ id: "T01", needsReport: null, attempts: [{ n: 1 }] }, { id: "T02", tier: "deep", tierReason: "Hard.", needsReport: ["T01"], dependsOn: ["T01"], attempts: [{ n: 1, tier: "standard" }, { n: 2, tier: "deep" }] }, { id: "T03", tier: "huge" }],
    agents: { a: { role: "orchestrator", status: "done" }, w: { role: "task", status: "done", tier: "light", model: "sonnet", effort: "medium", tokens: { in: 5, out: 7 }, peakContext: 900 } } }));
  assert.deepEqual(d.tasks.map((t) => [t.needsReport, t.tier, t.tierReason]), [[[], "standard", ""], [["T01"], "deep", "Hard."], [[], "standard", ""]]);
  assert.deepEqual(d.tasks.map((t) => t.attempts.map((a) => a.tier)), [["standard"], ["standard", "deep"], ["standard"]]);
  const ops = d.turns[0].ops;
  assert.deepEqual([ops[0].needsReport, ops[0].dependsOn, ops[1].tasks, ops[2].tasks, ops[2].mode, ops[3].heading, ops[3].notesVersion], [undefined, undefined, undefined, ["T01"], "any", "Plan", 2]);
  assert.deepEqual([d.turns[0].wait, d.turns[1].wait, d.turns[1].waitMet, d.turns[2].wait], [undefined, { tasks: [], mode: "all", turn: 1 }, true, undefined]);
  // an agent's tier, model and tokens: what the server left out is the middle tier, no model, no tokens
  assert.deepEqual([d.agents.a.tier, d.agents.a.model, d.agents.a.tokens, d.agents.a.peakContext], ["standard", "", null, undefined]);
  assert.deepEqual([d.agents.w.tier, d.agents.w.model, d.agents.w.effort, d.agents.w.tokens, d.agents.w.peakContext], ["light", "sonnet", "medium", { in: 5, out: 7, cacheRead: 0, cacheWrite: 0 }, 900]);
  assert.equal(d.delivery, undefined);
});

test("a delivery: its files stay absent when there are none, in a detail, in a patch and from the routes", () => {
  assert.deepEqual(normDelivery(wire({ state: "blocked", reason: "local_changes", files: ["a.md"], more: 2 })), { state: "blocked", reason: "local_changes", files: ["a.md"], more: 2 });
  for (const files of [undefined, null, []]) assert.equal(normDelivery(wire({ state: "pending", reason: "manual", files })).files, undefined);
  assert.equal(normDelivery(wire({})).state, "none");
  const d = normDetail(wire<RunDetail>({ run: "r_1", version: 2, status: "completed", startedAt: 1, git: { baseRef: "a", integrationBranch: "b", branch: "main" }, delivery: { state: "applied", how: "ff", commit: "c", files: [] } }));
  assert.deepEqual(d.delivery, { state: "applied", how: "ff", commit: "c", files: undefined });
  assert.equal(d.git?.branch, "main");
  // a patch names a delivery or not at all; applied, it replaces the one the detail has
  assert.deepEqual(normPatch(wire({ delivery: null })), {});
  const p = normPatch(wire({ delivery: { state: "blocked", reason: "conflict", files: ["x.go"] }, tasks: [{ id: "T09", needsReport: null }], turns: [{ n: 2, agent: "a", reason: "wait", status: "running", wait: { tasks: null } }] }), 50);
  assert.deepEqual([p.delivery?.files, p.tasks![0].needsReport, p.turns![0].wait?.tasks], [["x.go"], [], []]);
  assert.deepEqual(applyRunPatch(d, p).delivery, { state: "blocked", reason: "conflict", files: ["x.go"] });
  assert.deepEqual(applyRunPatch(d, {}).delivery, d.delivery);
});
