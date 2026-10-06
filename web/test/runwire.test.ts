import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { timelineInput } from "../src/logic/runwire.ts";
import { applyRunActivity, applyRunPatch, emptyDetail } from "../src/logic/rundetail.ts";
import { layoutTimeline, tailOf, taskState } from "../src/logic/runtimeline.ts";
import { fitPpm, rowCounts, rowFilter } from "../src/logic/runzoom.ts";
import { rowLabel, taskFacts, taskTip, tipText, turnTip } from "../src/logic/runlabels.ts";
import type { Attempt, Op, RunAgent, RunDetail, Task, Turn } from "../src/types.ts";

const real = (): RunDetail => JSON.parse(readFileSync(new URL("./fixtures/run-detail-qa.json", import.meta.url), "utf8"));
const attempt = (n: number, over: Partial<Attempt> = {}): Attempt => ({ n, tier: "standard", queuedTurn: 1, queuedAt: 10, phases: [{ k: "held", t: 10, turn: 1 }], agents: {}, cost: null, ...over });
const task = (id: string, over: Partial<Task> = {}): Task => ({ id, title: id, kind: "fix", writes: true, dependsOn: [], needsReport: [], tier: "standard", tierReason: "", addedTurn: 1, createdAt: 10,
  changedTurns: [], briefRev: 1, briefs: [{ rev: 1, at: 10, turn: 1, size: 100 }], attempts: [attempt(1)], ...over });
const turn = (n: number, over: Partial<Turn> = {}): Turn => ({ n, agent: "c-turn-" + n, reason: n === 1 ? "start" : "events", status: "running", startedAt: n * 100,
  wokenBy: [], learned: [], ops: [], cost: null, ...over });
const agent = (id: string, over: Partial<RunAgent> = {}): RunAgent => ({ id, name: id, role: "task", task: "T01", attempt: 1, status: "running", startedAt: 20, launches: [], cost: null, tier: "standard", model: "opus", tokens: null, ...over });
const base = (over: Partial<RunDetail> = {}): RunDetail => ({ ...emptyDetail("r_1", 5), version: 3, goalSize: 42, ...over });

test("the real run through the adapter: 53 rows and the numbers of the timeline's own fixture", () => {
  const d = real(), run = timelineInput(d);
  assert.equal(run.createdAt, d.startedAt); assert.equal(run.endedAt, d.endedAt); assert.equal(run.status, "completed");
  const L = layoutTimeline(run, { width: 720, now: d.endedAt! });
  assert.equal(L.rows.length, 53); assert.equal(L.turns.length, 35);
  assert.equal(L.edges.length, 17, "connectors with nothing selected");
  const S = layoutTimeline(run, { width: 720, now: d.endedAt!, selTask: "T21" });
  assert.equal(S.edges.length, 41, "connectors with T21 selected");
  assert.deepEqual(rowCounts(run, "T21"), { all: 53, open: 0, related: 27 });
  assert.equal(layoutTimeline(run, { width: 720, now: d.endedAt!, only: rowFilter(run, "related", "T21") }).rows.length, 27);
  assert.equal(fitPpm(run, 720, d.endedAt!).toFixed(2), "2.56"); assert.equal(fitPpm(run, 420, d.endedAt!).toFixed(2), "1.45");
  // every number of the layout is finite and inside the content
  for (const r of L.rows) for (const s of r.segs) assert.ok(Number.isFinite(s.x1) && s.x1 >= 0 && s.x2 <= L.width + 1e-6, r.id);
  // what the words read in addition: title, kind, writes, the attempt's cost, the turn's reason and cost, the notes version
  const t21 = run.tasks.find((t) => t.id === "T21")!, facts = taskFacts(run);
  assert.match(rowLabel(t21, facts.get("T21"), { tz: 120 }), /^T21, .+, fix, writes code, standard tier, done\. Added in turn 5 at /);
  assert.deepEqual(facts.get("T21")!.neededBy, ["T22", "T23", "T38"]);
  assert.ok(taskTip(t21, facts.get("T21"), { now: d.endedAt!, tz: 120 }).lines.map(tipText).some((l) => /· merged · \$\d+\.\d\d · standard tier$/.test(l)), "the attempt's cost and tier");
  const tip1 = turnTip(run.turns[0], { now: d.endedAt!, tz: 120 }).lines.map(tipText);
  assert.equal(tip1[0], "Started by the goal");
  assert.ok(tip1.some((l) => /^≡ notes v\d+$/.test(l)), tip1.join(" | ")); assert.ok(tip1.some((l) => /^\$\d+\.\d\d$/.test(l)));
  const woken = run.turns.find((t) => t.wokenBy?.length)!;
  assert.match(turnTip(woken, { now: d.endedAt!, tz: 120 }).lines.map(tipText)[0], /^Waited for T\d+/); // the wait it started under comes through, and was met
});

test("it starts where the goal was sent, keeps task events as wakers, gives an open attempt its agent's activity", () => {
  const d = base({ status: "running",
    turns: [turn(1, { wokenBy: [{ seq: 1, t: 90, type: "task_done", task: "T02", text: "ok" }, { seq: 2, t: 95, type: "chat_op", chat: "chat-1", text: "A chat on the run says: hurry" }] })],
    tasks: [task("T01", { attempts: [attempt(1, { phases: [{ k: "work", t: 20 }], startedAt: 20, agents: { work: "a1" } })] }),
            task("T02", { attempts: [attempt(1, { phases: [{ k: "work", t: 20 }], startedAt: 20, endedAt: 80, outcome: "done", agents: { work: "a2" } })] }),
            task("T03", { attempts: [attempt(1, { phases: [{ k: "work", t: 20 }, { k: "merge", t: 60 }], startedAt: 20, conflicts: ["a.go"], agents: { work: "a3", merge: "a4" } })] })],
    agents: { a1: agent("a1", { activity: "Edit: store.go" }), a2: agent("a2", { activity: "stale" }), a3: agent("a3", { activity: "its last words", status: "done" }), a4: agent("a4", { role: "merge", activity: "Edit: a.go" }) } });
  const tl = timelineInput(d);
  assert.equal(tl.createdAt, 5); assert.equal(tl.status, "running");
  assert.deepEqual([tl.git, tl.finishing], [false, false], "no `git` in the detail: a run without git; no result yet");
  assert.deepEqual(tl.turns[0].wokenBy, [{ task: "T02", type: "task_done" }, { task: "", type: "chat_op" }]); // a chat's change wakes as "a chat"
  assert.equal(tl.tasks[0].attempts[0].activity, "Edit: store.go");
  assert.equal(tl.tasks[1].attempts[0].activity, undefined, "an ended attempt gets none");
  assert.equal(tl.tasks[1], d.tasks[1], "and its task is the detail's own record");
  assert.equal(tl.tasks[2].attempts[0].activity, "Edit: a.go", "while merging: the merge agent's");
  assert.equal(d.tasks[0].attempts[0].agents.work, "a1"); assert.equal("activity" in d.tasks[0].attempts[0], false, "the detail is not written to");
  assert.equal(tailOf(tl.tasks[0])!.activity, "Edit: store.go");
});

test("the same detail gives the same object; a new detail changes only what changed", () => {
  const d0 = base({ status: "running", turns: [turn(1), turn(2)],
    tasks: [task("T01", { attempts: [attempt(1, { phases: [{ k: "work", t: 20 }], startedAt: 20, agents: { work: "a1" } })] }), task("T02"), task("T03")],
    agents: { a1: agent("a1") } });
  const a = timelineInput(d0);
  assert.equal(timelineInput(d0), a);
  // run_activity: a new detail; only the task whose agent said something is a new object
  const d1 = applyRunActivity(d0, { a1: { activity: "Bash: go test" } });
  assert.notEqual(d1, d0);
  const b = timelineInput(d1);
  assert.notEqual(b, a);
  assert.notEqual(b.tasks[0], a.tasks[0]); assert.equal(b.tasks[0].attempts[0].activity, "Bash: go test");
  assert.equal(b.tasks[1], a.tasks[1]); assert.equal(b.tasks[2], a.tasks[2]);
  assert.equal(b.turns[0], a.turns[0]); assert.equal(b.turns[1], a.turns[1]);
  // the same activity again (a tool count changed): the task is the object it was
  const d2 = applyRunActivity(d1, { a1: { tools: 9 } }), c = timelineInput(d2);
  assert.notEqual(c, b); assert.equal(c.tasks[0], b.tasks[0]);
  // run_detail: one task and one turn replaced
  const t2 = task("T02", { attempts: [attempt(1, { phases: [{ k: "held", t: 10, turn: 1 }, { k: "slot", t: 30 }] })] });
  const d3 = applyRunPatch(d2, { tasks: [t2], turns: [turn(2, { status: "done", endedAt: 300 })] }), e = timelineInput(d3);
  assert.equal(e.tasks[0], c.tasks[0]); assert.equal(e.tasks[1], t2); assert.equal(e.tasks[2], c.tasks[2]);
  assert.equal(e.turns[0], c.turns[0]); assert.notEqual(e.turns[1], c.turns[1]); assert.equal(e.turns[1].endedAt, 300);
  assert.equal(taskState(e.tasks[1]), "slot");
});

test("a chat's changes come through: its ops, the task it added, the phase it holds", () => {
  const ops: Op[] = [{ i: 0, t: 50, op: "add_task", chat: "c1", turn: 1, task: "T02", title: "From a chat" }, { i: 1, t: 60, op: "cancel_task", chat: "c1", turn: 1, task: "T01", reason: "not needed" }];
  const d = base({ status: "running", turns: [turn(1, { status: "done", endedAt: 40 })], chatOps: ops,
    tasks: [task("T01", { attempts: [attempt(1, { phases: [{ k: "held", t: 10, turn: 1 }, { k: "slot", t: 40 }], endedAt: 60, outcome: "cancelled", cancel: { t: 60, reason: "not needed", chat: "c1" } })] }),
            task("T02", { addedBy: "c1", createdAt: 50, attempts: [attempt(1, { queuedBy: "c1", queuedAt: 50, phases: [{ k: "held", t: 50, chat: "c1" }] })] })] });
  const run = timelineInput(d), L = layoutTimeline(run, { width: 600, now: 70 });
  assert.equal(run.chatOps, ops);
  assert.deepEqual(L.rows.map((r) => [r.id, r.turn]), [["T01", 1], ["T02", null]]);
  assert.deepEqual(L.rows[0].marks.map((m) => [m.glyph, m.turn ?? null]), [["◆", 1], ["✕", null]]); // a chat's marks are the usual glyphs
  assert.deepEqual(L.rows[1].marks.map((m) => [m.glyph, m.turn ?? null]), [["◆", null]]);             // no turn added it
  assert.deepEqual(L.rows[1].tail?.reason, { k: "held", turn: null, chat: true });
  assert.match(rowLabel(run.tasks[1]), /held, starts when the chat's reply ends\. Added from a chat at /);
});

test("lists the server left out or sent as null are empty lists, and the layout takes them", () => {
  const bare = { run: "r_1", version: 1, status: "running", startedAt: 5, goalSize: 1, stops: null, turns: null, tasks: null, chatOps: null, agents: {}, notes: null } as unknown as RunDetail;
  const empty = timelineInput(bare);
  assert.deepEqual([empty.stops, empty.turns, empty.tasks, empty.chatOps], [[], [], [], []]);
  assert.equal(layoutTimeline(empty, { width: 600, now: 100 }).rows.length, 0);
  const holes = base({ status: "running",
    turns: [{ ...turn(1), ops: null, wokenBy: null } as unknown as Turn],
    tasks: [{ ...task("T01"), dependsOn: null } as unknown as Task, { ...task("T02"), attempts: null } as unknown as Task, task("T03", { attempts: [{ ...attempt(1), phases: null } as unknown as Attempt] })] });
  const run = timelineInput(holes);
  assert.deepEqual(run.turns[0].ops, []); assert.deepEqual(run.turns[0].wokenBy, []);
  assert.deepEqual(run.tasks[0].dependsOn, []); assert.deepEqual(run.tasks[1].attempts, []); assert.deepEqual(run.tasks[2].attempts[0].phases, []);
  const L = layoutTimeline(run, { width: 600, now: 400, selTask: "T01" });
  assert.deepEqual(L.rows.map((r) => r.state), ["held", "held", "held"]);
  assert.equal(taskFacts(run).size, 3);
});

// ---- process v3

test("a task's needsReport and a turn's wait tasks are lists in the timeline's input too", () => {
  const holes = base({ status: "running",
    turns: [turn(1), { ...turn(2), reason: "wait", wait: { tasks: null, mode: "all", turn: 1 }, waitMet: true } as unknown as Turn],
    tasks: [{ ...task("T01"), needsReport: null } as unknown as Task, task("T02", { dependsOn: ["T01"], needsReport: ["T01"] })] });
  const run = timelineInput(holes) as unknown as RunDetail;
  assert.equal(run.turns[0].wait, undefined);
  assert.deepEqual([run.turns[1].wait, run.turns[1].waitMet, run.turns[1].reason], [{ tasks: [], mode: "all", turn: 1 }, true, "wait"]);
  assert.deepEqual(run.tasks.map((t) => t.needsReport), [[], ["T01"]]);
  assert.equal(run.tasks[1], holes.tasks[1], "a whole task is the record itself");
});

test("a delivery arrives with a patch and replaces the one before; an activity event carries an agent's fullest context", () => {
  const d0 = base({ status: "completed", agents: { a1: agent("a1", { tokens: { in: 1, out: 2, cacheRead: 3, cacheWrite: 4 }, peakContext: 1000 }) } });
  assert.equal(d0.delivery, undefined);
  const d1 = applyRunPatch(d0, { delivery: { state: "blocked", reason: "local_changes", files: ["a.md"] } });
  assert.deepEqual(d1.delivery, { state: "blocked", reason: "local_changes", files: ["a.md"] });
  const d2 = applyRunPatch(d1, { delivery: { state: "applied", how: "ff", commit: "abc", branch: "main" } });
  assert.deepEqual(d2.delivery, { state: "applied", how: "ff", commit: "abc", branch: "main" });
  assert.equal(applyRunPatch(d2, { status: "completed" }).delivery, d2.delivery);
  const d3 = applyRunActivity(d2, { a1: { peakContext: 52000, tools: 3 } });
  assert.deepEqual([d3.agents.a1.peakContext, d3.agents.a1.tools, d3.agents.a1.tokens], [52000, 3, { in: 1, out: 2, cacheRead: 3, cacheWrite: 4 }]);
  assert.equal(applyRunActivity(d3, { a1: { activity: "Read x" } }).agents.a1.peakContext, 52000);
});
