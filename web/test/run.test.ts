import { test } from "node:test";
import assert from "node:assert/strict";
import { isDraft, limitsLabel, tiersLabel, runBusy, runChats, runDot, runRowLine, runTaskTotal, runTasksDone, runWord, runWorking, runningRuns,
  startBlock, workingOnRun, workingRunChats } from "../src/logic/run.ts";
import { TASK_STATES, type ChatView, type RunCounts, type RunStatus, type RunView } from "../src/types.ts";

const counts = (over: Partial<RunCounts> = {}): RunCounts =>
  ({ ...Object.fromEntries(TASK_STATES.map((k) => [k, 0])) as RunCounts, ...over });
const run = (status: RunStatus, over: Partial<RunView> = {}): RunView => ({
  id: "r_1", name: "Checkout rewrite", group: "g_1", created: "2026-10-01T00:00:00Z",
  agent: "claude", tiers: { deep: { model: "opus" }, standard: { model: "opus" }, light: { model: "opus" } }, cwd: "/work/shop", git: true,
  settings: { maxParallel: 4, maxTurns: 60, maxCost: 0, wake: "each", maxIdleTurns: 3, agentTimeoutSec: 10800, agentRetries: 2 },
  ...(status === "draft" ? {} : { started: "2026-10-01T00:01:00Z" }),
  status, activeMs: 0, asOf: 0, turns: 0, idleStreak: 0, counts: counts(), cost: 0, attention: 0, ...over,
});
const usage = { ctxIn: 0, ctxOut: 0, ctxWindow: 0, turns: 0 };
const chat = (id: string, created: string, over: Partial<ChatView> = {}): ChatView =>
  ({ id, agent: "claude", cwd: "/work/shop", model: "opus", locked: false, created, usage, status: "ready", ...over });
const byId = <T extends { id: string }>(xs: T[]) => Object.fromEntries(xs.map((x) => [x.id, x]));
const STATUSES: RunStatus[] = ["draft", "running", "stopping", "stopped", "stalled", "error", "completed", "gave_up"];

test("isDraft: exactly while the goal was not sent", () => {
  assert.equal(isDraft(run("draft")), true);
  for (const s of STATUSES.slice(1)) assert.equal(isDraft(run(s)), false, s);
});

test("runWorking: running or stopping, and not archived", () => {
  assert.deepEqual(STATUSES.filter((s) => runWorking(run(s))), ["running", "stopping"]);
  assert.equal(runWorking(run("running", { archived: true })), false);
  assert.equal(runWorking(run("stopping", { archived: true })), false);
});

test("runningRuns counts what a restart interrupts", () => {
  assert.equal(runningRuns([]), 0);
  assert.equal(runningRuns(STATUSES.map((s) => run(s))), 2);
  assert.equal(runningRuns([run("running"), run("running", { archived: true }), run("completed")]), 1);
});

test("the three counters come from counts: cancelled tasks are not tasks, a slot is setup, work or merge", () => {
  const r = run("running", { counts: counts({ held: 1, deps: 2, blocked: 1, slot: 3, setup: 1, work: 2, merge: 1, done: 12, failed: 1, cancelled: 4 }) });
  assert.equal(runTaskTotal(r), 24);
  assert.equal(runTasksDone(r), 12);
  assert.equal(runBusy(r), 4);
  assert.equal(runTaskTotal(run("draft")), 0);
});

test("runWord", () => {
  assert.deepEqual(STATUSES.map((s) => runWord(run(s))),
    ["Not started", "Running", "Stopping…", "Stopped", "Stalled", "Error", "Completed", "Gave up"]);
});

test("runDot names a dot of the chat rows, or none", () => {
  assert.deepEqual(STATUSES.map((s) => runDot(run(s))),
    [null, "thinking", "thinking", "waiting", "approval", "error", null, "error"]); // stalled is amber, gave up is red
});

test("runRowLine: a draft, and a running run from its start to its tasks", () => {
  assert.equal(runRowLine(run("draft")), "Not started");
  assert.equal(runRowLine(run("running")), "Starting…");
  assert.equal(runRowLine(run("running", { turns: 1, turnRunning: 1 })), "Turn 1");
  assert.equal(runRowLine(run("running", { turns: 7, counts: counts({ done: 12, work: 4, deps: 4 }) })), "Turn 7 · 12 of 20 tasks done");
  assert.equal(runRowLine(run("running", { turns: 7, counts: counts({ done: 12, work: 4, deps: 4, cancelled: 3 }) })), "Turn 7 · 12 of 20 tasks done");
  assert.equal(runRowLine(run("running", { turns: 2, counts: counts({ work: 1 }) })), "Turn 2 · 0 of 1 task done");
  assert.equal(runRowLine(run("running", { turns: 3, counts: counts({ cancelled: 2 }) })), "Turn 3", "only cancelled tasks: none");
});

test("runRowLine: halted and ended runs", () => {
  const c = counts({ done: 18, failed: 2, cancelled: 1 });
  assert.equal(runRowLine(run("stopping", { turns: 7, counts: c })), "Stopping…");
  assert.equal(runRowLine(run("stopped", { turns: 7, counts: c, reason: "You stopped it." })), "Stopped");
  assert.equal(runRowLine(run("stalled", { stalledBy: "turns", reason: "The run reached its limit of 60 orchestrator turns." })), "Stalled: turn limit");
  assert.equal(runRowLine(run("stalled", { stalledBy: "cost" })), "Stalled: cost limit");
  assert.equal(runRowLine(run("stalled", { stalledBy: "idle" })), "Stalled: idle turns");
  assert.equal(runRowLine(run("stalled")), "Stalled");
  assert.equal(runRowLine(run("error", { reason: "the orchestrator's turn failed three times" })), "Error: the orchestrator's turn failed three times");
  assert.equal(runRowLine(run("error")), "Error");
  assert.equal(runRowLine(run("completed", { counts: c, outcome: "achieved" })), "Completed · 20 tasks");
  assert.equal(runRowLine(run("gave_up", { counts: c, outcome: "not_achieved" })), "Gave up · 20 tasks");
  assert.equal(runRowLine(run("completed", { counts: counts({ done: 1 }) })), "Completed · 1 task");
  assert.equal(runRowLine(run("gave_up")), "Gave up");
});

test("startBlock: the folder first, then the server's refusal, then the goal", () => {
  const ok = run("draft");
  assert.equal(startBlock(ok, "Add a dark mode"), "");
  assert.equal(startBlock(ok, ""), "Type a goal first");
  assert.equal(startBlock(ok, "  \n "), "Type a goal first");
  assert.equal(startBlock({ ...ok, blocked: "Not a git repository: pick a folder inside one." }, "go"), "Not a git repository: pick a folder inside one.");
  assert.equal(startBlock({ ...ok, blocked: "Not a git repository." }, ""), "Not a git repository.", "before the empty goal");
  assert.equal(startBlock({ ...ok, folderMissing: true, blocked: "Not a git repository." }, ""), "Pick a folder that exists first", "before everything");
  assert.equal(startBlock({ ...ok, cwd: "" }, "go"), "Pick a folder that exists first");
});

test("limitsLabel", () => {
  const s = run("draft").settings;
  assert.equal(limitsLabel(s), "4 parallel · 60 turns");
  assert.equal(limitsLabel({ ...s, maxCost: 20 }), "4 parallel · 60 turns · $20");
  assert.equal(limitsLabel({ ...s, maxCost: 12.5 }), "4 parallel · 60 turns · $12.50");
  assert.equal(limitsLabel({ maxParallel: 1, maxTurns: 1, maxCost: 0 }), "1 parallel · 1 turn");
});

test("tiersLabel: three models, two equal, one for all", () => {
  const names: Record<string, string> = { opus: "Opus 5.5", sonnet: "Sonnet 5.5", haiku: "Haiku 4.5" };
  const label = (m: string) => names[m];
  const t = (deep: string, standard: string, light: string) => ({ deep: { model: deep, effort: "max" }, standard: { model: standard }, light: { model: light } });
  assert.equal(tiersLabel(t("opus", "sonnet", "haiku"), label), "Opus 5.5 · Sonnet 5.5 · Haiku 4.5");
  assert.equal(tiersLabel(t("opus", "opus", "sonnet"), label), "Opus 5.5 · Opus 5.5 · Sonnet 5.5"); // the place tells the tier
  assert.equal(tiersLabel(t("opus", "sonnet", "opus"), label), "Opus 5.5 · Sonnet 5.5 · Opus 5.5");
  assert.equal(tiersLabel(t("opus", "opus", "opus"), label), "Opus 5.5");
  assert.equal(tiersLabel(t("opus", "gpt-x", "haiku"), label), "Opus 5.5 · gpt-x · Haiku 4.5"); // not in the catalogue: its id
  assert.equal(tiersLabel(t("opus", "sonnet", "haiku")), "opus · sonnet · haiku"); // no catalogue yet
  assert.equal(tiersLabel(t("", "", "")), "none");
  assert.equal(tiersLabel(t("opus", "", "haiku"), label), "Opus 5.5 · none · Haiku 4.5");
});

const chats = byId([
  chat("c_old", "2026-10-01T00:00:00Z", { run: "r_1" }),
  chat("c_new", "2026-10-03T00:00:00Z", { run: "r_1" }),
  chat("c_tie_b", "2026-10-02T00:00:00Z", { run: "r_1" }),
  chat("c_tie_a", "2026-10-02T00:00:00Z", { run: "r_1" }),
  chat("c_arch", "2026-10-04T00:00:00Z", { run: "r_1", archived: true, archiveOp: "op1" }),
  chat("c_other", "2026-10-05T00:00:00Z", { run: "r_2" }),
  chat("c_plain", "2026-10-05T00:00:00Z", { group: "g_1" }),
  chat("c_board", "2026-10-05T00:00:00Z", { board: "b_1" }),
  chat("a_turn", "2026-10-06T00:00:00Z", { run: "r_1", role: "orchestrator", status: "thinking" }),
  chat("a_task", "2026-10-06T00:00:00Z", { run: "r_1", role: "task", status: "tool" }),
]);
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

test("runChats: the user's chats on the run, newest first, the id breaking ties", () => {
  assert.deepEqual(ids(runChats(chats, "r_1", false)), ["c_new", "c_tie_a", "c_tie_b", "c_old"]);
  assert.deepEqual(ids(runChats(chats, "r_1", true)), ["c_arch", "c_new", "c_tie_a", "c_tie_b", "c_old"]);
  assert.deepEqual(ids(runChats(chats, "r_2", false)), ["c_other"]);
  assert.deepEqual(runChats(chats, "r_none", true), []);
});

test("runChats never lists a run's own agents", () => {
  for (const show of [false, true]) assert.ok(!runChats(chats, "r_1", show).some((c) => c.role));
});

test("workingOnRun: the run works, or an agent works in one of its chats", () => {
  assert.equal(workingOnRun(run("running"), {}), true);
  assert.equal(workingOnRun(run("stopping"), {}), true);
  assert.equal(workingOnRun(run("stopped"), chats), false, "its own agents' records do not count");
  const busy = { ...chats, c_old: chat("c_old", "2026-10-01T00:00:00Z", { run: "r_1", status: "writing" }) };
  assert.equal(workingOnRun(run("stopped"), busy), true);
  assert.deepEqual(ids(workingRunChats(busy, "r_1")), ["c_old"]);
  const subs = { c: chat("c", "2026-10-01T00:00:00Z", { run: "r_1", subsRunning: 1 }) };
  assert.equal(workingOnRun(run("completed"), subs), true, "subagents still running");
  const archived = { c: chat("c", "2026-10-01T00:00:00Z", { run: "r_1", status: "tool", archived: true }) };
  assert.equal(workingOnRun(run("completed"), archived), false);
  const elsewhere = { c: chat("c", "2026-10-01T00:00:00Z", { run: "r_2", status: "tool" }) };
  assert.equal(workingOnRun(run("draft"), elsewhere), false);
});
