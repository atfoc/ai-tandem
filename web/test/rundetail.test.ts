import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRunPatch, applyRunEvent, applyRunActivity, emptyDetail, RunLoads } from "../src/logic/rundetail.ts";
import type { RunDetail, Task, Turn, RunAgent, Op, Attempt } from "../src/types.ts";

const attempt = (n: number, over: Partial<Attempt> = {}): Attempt => ({ n, tier: "standard", queuedTurn: 1, queuedAt: 10, phases: [{ k: "held", t: 10, turn: 1 }], agents: {}, cost: null, ...over });
const task = (id: string, over: Partial<Task> = {}): Task => ({ id, title: id, kind: "fix", writes: true, dependsOn: [], needsReport: [], tier: "standard", tierReason: "", addedTurn: 1, createdAt: 10,
  changedTurns: [], briefRev: 1, briefs: [{ rev: 1, at: 10, turn: 1, size: 100 }], attempts: [attempt(1)], ...over });
const turn = (n: number, over: Partial<Turn> = {}): Turn => ({ n, agent: "c-turn-" + n, reason: n === 1 ? "start" : "events", status: "running", startedAt: n * 100,
  wokenBy: [], learned: [], ops: [], cost: null, ...over });
const agent = (id: string, over: Partial<RunAgent> = {}): RunAgent => ({ id, name: id, role: "task", task: "T01", attempt: 1, status: "running", startedAt: 20, launches: [], cost: null, tier: "standard", model: "opus", tokens: null, ...over });
const op = (i: number, over: Partial<Op> = {}): Op => ({ i, t: 50 + i, op: "cancel_task", chat: "chat-1", task: "T01", reason: "no longer needed", ...over });

/** Freezes a value at every depth: a reducer that writes into its input throws. */
function freeze<T>(x: T): T {
  if (x && typeof x === "object" && !Object.isFrozen(x)) { Object.freeze(x); for (const v of Object.values(x)) freeze(v); }
  return x;
}
const base = (): RunDetail => freeze({ ...emptyDetail("r_1", 5), version: 3, goalSize: 42, turns: [turn(1), turn(2)], tasks: [task("T01"), task("T02")],
  agents: { a1: agent("a1"), a2: agent("a2", { task: "T02" }) }, notes: [{ v: 1, at: 30, turn: 1, size: 9 }], chatOps: [op(0)],
  stops: [{ at: 60, reason: "user" as const }] });

test("scalars replace; what the patch does not name stays, with its identity", () => {
  const d = base();
  const n = applyRunPatch(d, { status: "stopped", endedAt: 99, goalSize: 43 });
  assert.equal(n.status, "stopped"); assert.equal(n.endedAt, 99); assert.equal(n.goalSize, 43); assert.equal(n.startedAt, 5);
  assert.equal(n.version, 3, "the version is the event's business");
  for (const k of ["turns", "tasks", "agents", "notes", "chatOps", "stops"] as const) assert.equal(n[k], d[k], k);
  assert.notEqual(n, d);
});

test("git and result replace as a whole", () => {
  const n = applyRunPatch(base(), { git: { baseRef: "abc", integrationBranch: "run/x/integration" }, result: { outcome: "achieved", summary: "done", turn: 2, at: 90 } });
  assert.deepEqual(n.git, { baseRef: "abc", integrationBranch: "run/x/integration" });
  const m = applyRunPatch(n, { git: { baseRef: "abc", integrationBranch: "run/x/integration", resultHead: "def" } });
  assert.equal(m.git?.resultHead, "def"); assert.equal(m.result?.outcome, "achieved");
});

test("stops is the whole list: a resume closes the open stop", () => {
  const n = applyRunPatch(base(), { status: "running", stops: [{ at: 60, resumedAt: 80, reason: "user" }] });
  assert.deepEqual(n.stops, [{ at: 60, resumedAt: 80, reason: "user" }]);
});

test("turns: the record with the same n is replaced in place, a new one is added in order", () => {
  const d = base();
  const n = applyRunPatch(d, { turns: [turn(2, { status: "done", endedAt: 250, summary: "ok", cost: 1.5 }), turn(3)] });
  assert.deepEqual(n.turns.map((t) => t.n), [1, 2, 3]);
  assert.equal(n.turns[1].summary, "ok");
  assert.equal(n.turns[0], d.turns[0], "an untouched turn keeps its identity");
  const late = applyRunPatch(applyRunPatch(emptyDetail("r"), { turns: [turn(3)] }), { turns: [turn(1), turn(2)] });
  assert.deepEqual(late.turns.map((t) => t.n), [1, 2, 3], "sorted by n whatever the order of arrival");
});

test("a turn's ops arrive with the whole turn record", () => {
  const d = base();
  const a = applyRunPatch(d, { turns: [turn(2, { ops: [{ i: 0, t: 210, op: "get_run" }] })] });
  const b = applyRunPatch(a, { turns: [turn(2, { ops: [{ i: 0, t: 210, op: "get_run" }, { i: 1, t: 220, op: "update_task", task: "T01", error: "T01 is running. Cancel it first if it must change, then retry it." }] })] });
  assert.equal(b.turns[1].ops.length, 2); assert.ok(b.turns[1].ops[1].error);
});

test("tasks: replaced in place by id, new ones appended in arrival order", () => {
  const d = base();
  const n = applyRunPatch(d, { tasks: [task("T03"), task("T01", { title: "renamed" }), task("T04")] });
  assert.deepEqual(n.tasks.map((t) => t.id), ["T01", "T02", "T03", "T04"]);
  assert.equal(n.tasks[0].title, "renamed"); assert.equal(n.tasks[1], d.tasks[1]);
});

test("a task patch carries all its attempts: phases grow, a retry adds an attempt", () => {
  const d = base();
  const a = applyRunPatch(d, { tasks: [task("T01", { attempts: [attempt(1, { phases: [{ k: "held", t: 10, turn: 1 }, { k: "deps", t: 40, on: ["T02"] }] })] })] });
  assert.equal(a.tasks[0].attempts[0].phases.length, 2);
  const b = applyRunPatch(a, { tasks: [task("T01", { attempts: [attempt(1, { outcome: "failed", endedAt: 70, error: "boom" }), attempt(2, { queuedTurn: 2, queuedAt: 75 })] })] });
  assert.equal(b.tasks[0].attempts.length, 2); assert.equal(b.tasks[0].attempts[0].outcome, "failed");
});

test("chatOps by i, notes by v", () => {
  const n = applyRunPatch(base(), { chatOps: [op(1, { op: "retry_task", attempt: 2 }), op(0, { reason: "changed" })], notes: [{ v: 2, at: 44, chat: "chat-1", size: 5 }, { v: 1, at: 30, turn: 1, size: 10 }] });
  assert.deepEqual(n.chatOps.map((o) => [o.i, o.op]), [[0, "cancel_task"], [1, "retry_task"]]);
  assert.equal(n.chatOps[0].reason, "changed");
  assert.deepEqual(n.notes.map((x) => [x.v, x.size]), [[1, 10], [2, 5]]);
});

test("agents are merged by id", () => {
  const d = base();
  const n = applyRunPatch(d, { agents: { a2: agent("a2", { task: "T02", status: "done", endedAt: 88, cost: 2 }), a3: agent("a3", { role: "merge" }) } });
  assert.deepEqual(Object.keys(n.agents), ["a1", "a2", "a3"]);
  assert.equal(n.agents.a2.status, "done"); assert.equal(n.agents.a1, d.agents.a1);
  assert.equal(applyRunPatch(d, { agents: {} }).agents, d.agents);
});

test("an empty patch changes nothing; the input is never written to", () => {
  const d = base();                       // frozen at every depth
  assert.deepEqual(applyRunPatch(d, {}), d);
  applyRunPatch(d, { status: "stopped", stops: [], turns: [turn(9)], tasks: [task("T09")], chatOps: [op(5)], notes: [{ v: 9, at: 1, size: 1 }], agents: { z: agent("z") } });
  assert.equal(d.turns.length, 2); assert.equal(d.tasks.length, 2);
});

test("a patch is idempotent, and applying older patches again before newer ones ends the same", () => {
  const p1 = { tasks: [task("T03")], turns: [turn(3)] }, p2 = { tasks: [task("T03", { title: "v2" })], status: "stopping" as const };
  const once = applyRunPatch(applyRunPatch(base(), p1), p2);
  assert.deepEqual(applyRunPatch(applyRunPatch(once, p1), p2), once);
  assert.deepEqual(applyRunPatch(once, p2), once);
});

test("applyRunEvent: the next version applies, an older one is stale, a jump is a gap", () => {
  const d = base();
  const n = applyRunEvent(d, { version: 4, patch: { status: "stopping" } });
  assert.ok(typeof n === "object"); assert.equal(n.version, 4); assert.equal(n.status, "stopping");
  assert.equal(applyRunEvent(d, { version: 3, patch: { status: "error" } }), "stale");
  assert.equal(applyRunEvent(d, { version: 1, patch: {} }), "stale");
  assert.equal(applyRunEvent(d, { version: 6, patch: {} }), "gap");
});

test("events queued while the detail was being fetched: older ones are dropped, the rest apply in order", () => {
  const fetched = { ...base(), version: 5 };
  const queued = [3, 4, 5, 6, 7].map((version) => ({ version, patch: { goalSize: version } }));
  let d: RunDetail = fetched;
  for (const ev of queued) { const r = applyRunEvent(d, ev); if (r === "gap") assert.fail("gap"); if (r !== "stale") d = r; }
  assert.equal(d.version, 7); assert.equal(d.goalSize, 7);
});

test("applyRunActivity sets the live values of agents the detail has, and nothing else", () => {
  const d = base();
  const n = applyRunActivity(d, { a1: { activity: "Bash: go test ./...", tools: 12 }, a2: { cost: 0.4 }, nobody: { activity: "x" } });
  assert.equal(n.agents.a1.activity, "Bash: go test ./..."); assert.equal(n.agents.a1.tools, 12); assert.equal(n.agents.a1.cost, null);
  assert.equal(n.agents.a2.cost, 0.4); assert.equal(n.agents.nobody, undefined);
  assert.equal(n.version, d.version); assert.equal(n.tasks, d.tasks);
  assert.equal(applyRunActivity(d, { nobody: { activity: "x" } }), d, "nothing known: the same object");
  // a later run_detail record of the agent replaces it whole: the server sends the live values in it
  const later = applyRunPatch(n, { agents: { a1: agent("a1", { status: "done", endedAt: 90, cost: 1, tools: 14 }) } });
  assert.equal(later.agents.a1.activity, undefined); assert.equal(later.agents.a1.tools, 14);
});

// ---- RunLoads: the events that arrive while a detail is fetched

const ev = (version: number) => ({ version, patch: { goalSize: version } });

test("RunLoads: events are queued while the fetch runs and applied to its answer, older ones dropped", () => {
  const L = new RunLoads();
  assert.equal(L.event("r_1", undefined, ev(4)), "ignored", "no detail and no fetch: nothing to change");
  const t = L.begin("r_1");
  assert.ok(L.fetching("r_1"));
  for (const v of [4, 5, 6, 7]) assert.equal(L.event("r_1", undefined, ev(v)), "queued");
  const d = L.end("r_1", t, { ...base(), version: 5 });
  assert.ok(typeof d === "object"); assert.equal(d.version, 7); assert.equal(d.goalSize, 7);
  assert.ok(!L.fetching("r_1"));
  const n = L.event("r_1", d, ev(8));
  assert.ok(typeof n === "object"); assert.equal(n.version, 8);
});

test("RunLoads: with a detail held, the next version applies, an older one keeps it, a jump is a gap", () => {
  const L = new RunLoads(), d = base();          // version 3
  assert.equal(L.event("r_1", d, ev(3)), d, "stale: the same object, so nothing re-renders");
  assert.equal(L.event("r_1", d, ev(5)), "gap");
  const n = L.event("r_1", d, ev(4));
  assert.ok(typeof n === "object"); assert.equal(n.version, 4);
});

test("RunLoads: a queue that starts past the answer is a gap; a queue wholly behind it changes nothing", () => {
  const L = new RunLoads();
  let t = L.begin("r_1");
  L.event("r_1", undefined, ev(7));
  assert.equal(L.end("r_1", t, { ...base(), version: 5 }), "gap");
  assert.ok(!L.fetching("r_1"), "the caller begins the next fetch");
  t = L.begin("r_1");
  L.event("r_1", undefined, ev(2)); L.event("r_1", undefined, ev(3));
  const fetched = base();
  assert.equal(L.end("r_1", t, fetched), fetched);
});

test("RunLoads: the newest fetch wins; a failed one drops its queue; drop and reset discard the answer", () => {
  const L = new RunLoads();
  const t1 = L.begin("r_1");
  L.event("r_1", undefined, ev(4));
  const t2 = L.begin("r_1");                     // a second fetch (after a snapshot): the queue starts again
  assert.equal(L.end("r_1", t1, base()), "superseded");
  assert.ok(L.fetching("r_1"), "the older answer does not end the newer fetch");
  assert.equal(L.end("r_1", t2, undefined), "failed");
  assert.ok(!L.fetching("r_1"));
  const t3 = L.begin("r_1");
  L.drop("r_1");
  assert.ok(!L.fetching("r_1"));
  assert.equal(L.end("r_1", t3, base()), "superseded");
  const t4 = L.begin("r_1"), u = L.begin("r_2");
  L.reset();
  assert.equal(L.end("r_1", t4, base()), "superseded"); assert.equal(L.end("r_2", u, base()), "superseded");
  assert.equal(L.event("r_1", undefined, ev(4)), "ignored");
});

test("RunLoads: runs do not share a queue, and activity waits in line with the versioned events", () => {
  const L = new RunLoads();
  const t = L.begin("r_1");
  const other = { ...base(), run: "r_2" };
  const n = L.event("r_2", other, ev(4));
  assert.ok(typeof n === "object"); assert.equal(n.version, 4);
  L.event("r_1", undefined, { agents: { a1: { activity: "Read store.go", tools: 3 } } });
  L.event("r_1", undefined, { version: 4, patch: { agents: { a2: agent("a2", { status: "done", endedAt: 70 }) } } });
  L.event("r_1", undefined, { agents: { a1: { tools: 4 }, nobody: { tools: 1 } } });
  const d = L.end("r_1", t, base());
  assert.ok(typeof d === "object");
  assert.equal(d.version, 4); assert.equal(d.agents.a1.activity, "Read store.go"); assert.equal(d.agents.a1.tools, 4);
  assert.equal(d.agents.a2.status, "done"); assert.equal(d.agents.nobody, undefined);
  const same = L.event("r_1", d, { agents: { nobody: { tools: 1 } } });
  assert.equal(same, d);
});

test("a run that goes on drops its delivery; any other patch keeps it", () => {
  const delivery = { state: "pending" as const, reason: "halted" as const, partial: true };
  const d = freeze({ ...base(), status: "stopped" as const, delivery });
  for (const status of ["running", "stopping"] as const) {
    const n = applyRunPatch(d, { status });
    assert.equal(n.status, status); assert.equal("delivery" in n, false, status);
  }
  assert.equal(applyRunPatch(d, { status: "stalled" }).delivery, delivery);
  assert.equal(applyRunPatch(d, { goalSize: 7 }).delivery, delivery);
  // the delivery a patch brings is taken, also with a live status beside it
  const applied = { state: "applied" as const, how: "ff" as const };
  assert.equal(applyRunPatch(d, { delivery: applied }).delivery, applied);
  assert.equal(applyRunPatch(d, { status: "completed", delivery: applied }).delivery, applied);
  assert.equal(d.delivery, delivery, "the input is not written");
  const ev = applyRunEvent(d, { version: 4, patch: { status: "running" } });
  assert.ok(typeof ev === "object" && !("delivery" in ev));
});
