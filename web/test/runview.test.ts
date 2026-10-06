import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DOCK_MIN, agentMs, agentTitle, agentsAtWork, busySlots, canResume, clearIn, countsTitle, dockHeight, dockIn, escIn, hideAgentIn, meterTone, money, moneyLimit,
  openingView, raiseValue, resumeRaise, runDoing, runPane, selectIn, showAgentIn, stalledWords, stopConfirm, stoppedTotal, tabIn, taskCounts, taskTabIn, tokensShort, whenText, workingMs,
  type PanelState, type ViewState,
} from "../src/logic/runview.ts";
import type { RunCounts, RunSettings } from "../src/types.ts";

const counts = (o: Partial<RunCounts> = {}): RunCounts => ({ held: 0, deps: 0, blocked: 0, slot: 0, setup: 0, work: 0, merge: 0, done: 0, failed: 0, cancelled: 0, ...o });
const settings = (o: Partial<RunSettings> = {}): RunSettings => ({ maxParallel: 4, maxTurns: 60, maxCost: 0, wake: "each", maxIdleTurns: 3, agentTimeoutSec: 10800, agentRetries: 2, ...o });

test("how a run's view opens: a finished run on its result, any other with the dock closed", () => {
  assert.deepEqual(openingView("completed"), { sel: null, tab: "result", back: "result", dock: "open", taskTab: "report" });
  assert.deepEqual([openingView("gave_up").tab, openingView("gave_up").dock], ["result", "open"]);
  // a live run opens on its timeline alone; so does a halted one
  for (const s of ["running", "stopping", "stopped", "stalled", "error"] as const) assert.deepEqual(openingView(s), { sel: null, tab: "goal", back: "goal", dock: "closed", taskTab: "report" });
});

test("selecting opens the entity tab; closing it clears the selection and goes back to the run's tab", () => {
  let v = openingView("running");
  v = selectIn(v, { task: "T21" });
  assert.deepEqual([v.sel, v.tab, v.dock], [{ task: "T21" }, "entity", "open"]);
  v = tabIn(v, "notes");
  assert.deepEqual([v.sel, v.tab, v.back], [{ task: "T21" }, "notes", "notes"]);
  v = selectIn(v, { turn: 5 });
  assert.deepEqual([v.sel, v.tab, v.back], [{ turn: 5 }, "entity", "notes"]);
  v = clearIn(v);
  assert.deepEqual([v.sel, v.tab, v.dock], [null, "notes", "open"]);
  assert.equal(clearIn(v), v, "nothing selected: nothing changes");
  // a tab click opens a closed dock; the entity tab needs a selection; a selection keeps a maximised dock
  assert.deepEqual([tabIn(dockIn(v, "closed"), "goal").dock, tabIn(v, "entity")], ["open", v]);
  assert.equal(selectIn(dockIn(v, "max"), { task: "T01" }).dock, "max");
  assert.deepEqual([tabIn(dockIn(v, "closed"), "usage").tab, tabIn(v, "usage").back], ["usage", "usage"]);
  // clearing while another tab shows keeps that tab
  assert.equal(clearIn(tabIn(selectIn(v, { task: "T01" }), "goal")).tab, "goal");
  // the task's own tab is kept while the same task stays selected, and starts over with another
  const t = taskTabIn(selectIn(v, { task: "T01" }), "attempts");
  assert.deepEqual([selectIn(t, { task: "T01" }).taskTab, selectIn(t, { task: "T02" }).taskTab, clearIn(t).taskTab], ["attempts", "report", "report"]);
});

test("a transcript opens in the side panel over the run's chat, and closes back to it", () => {
  const none: PanelState = { runAgent: null, subDrawer: null };
  let s = showAgentIn(none, "r1", "a1");
  assert.deepEqual(s, { runAgent: { run: "r1", agent: "a1" }, subDrawer: null });
  assert.equal(showAgentIn(s, "r1", "a1"), s, "the same one again: nothing changes");
  // the panel: the transcript, with the way back to the chat that was showing
  assert.deepEqual(runPane("r1", { ...s, chat: "c1", panel: true }), { agent: "a1", back: "c1" });
  assert.deepEqual(runPane("r1", { ...s, chat: "c1", panel: false }), { agent: "a1", back: null }, "a hidden chat panel: the transcript shows, with no chat to go back to");
  assert.deepEqual(runPane("r1", { ...s, chat: null, panel: true }), { agent: "a1", back: null });
  assert.deepEqual(runPane("r2", { ...s, chat: "c9", panel: true }), { chat: "c9" }, "another run's transcript is not this run's");
  assert.equal(runPane("r2", { ...s, chat: "c9", panel: false }), null);
  // a subagent of the agent in the app's drawer: another agent's transcript closes it, the same agent's keeps it
  s = { ...s, subDrawer: { chat: "a1", sub: "s1" } };
  assert.deepEqual(showAgentIn(s, "r1", "a2"), { runAgent: { run: "r1", agent: "a2" }, subDrawer: null });
  assert.deepEqual(showAgentIn({ runAgent: null, subDrawer: { chat: "a1", sub: "s1" } }, "r1", "a1").subDrawer, { chat: "a1", sub: "s1" });
  assert.equal(showAgentIn({ runAgent: null, subDrawer: { chat: "c1", sub: "s1" } }, "r1", "a1").subDrawer, null, "the drawer of the chat it lies over");
  // back: the transcript and its drawer go, a drawer of something else stays
  assert.deepEqual(hideAgentIn(s), none);
  assert.deepEqual(hideAgentIn({ runAgent: { run: "r1", agent: "a1" }, subDrawer: { chat: "c1", sub: "s1" } }).subDrawer, { chat: "c1", sub: "s1" });
  assert.equal(hideAgentIn(none), none);
  assert.deepEqual(runPane("r1", { ...hideAgentIn(s), chat: "c1", panel: true }), { chat: "c1" });
});

test("what a transcript's header says of its agent", () => {
  assert.equal(agentTitle({ name: "T11-a2-work", role: "task", task: "T11", attempt: 2 }), "T11 · work agent · attempt 2");
  assert.equal(agentTitle({ name: "T11-work", role: "task", task: "T11", attempt: 1 }), "T11 · work agent · attempt 1");
  assert.equal(agentTitle({ name: "T02-merge", role: "merge", task: "T02", attempt: 1 }), "T02 · merge agent");
  assert.equal(agentTitle({ name: "T02-a2-merge", role: "merge", task: "T02", attempt: 2 }), "T02 · merge agent · attempt 2");
  assert.equal(agentTitle({ name: "turn-007", role: "orchestrator", turn: 7 }), "Turn 7 · orchestrator");
  assert.equal(agentTitle({ name: "turn-x", role: "orchestrator" }), "turn-x · orchestrator");
  // elapsed: up to now while it runs, to its end, and for an interrupted agent to the end of its last launch
  const l = [{ n: 1, startedAt: 100, endedAt: 700, resume: false }];
  assert.equal(agentMs({ status: "running", startedAt: 100, launches: l }, 1100), 1000);
  assert.equal(agentMs({ status: "done", startedAt: 100, endedAt: 900, launches: l }, 5000), 800);
  assert.equal(agentMs({ status: "interrupted", startedAt: 100, launches: l }, 5000), 600);
  assert.equal(agentMs({ status: "interrupted", startedAt: 100, launches: [] }, 5000), 0);
  assert.deepEqual([96_400, 999, 1_400_000, 2_000_000, 12_600_000, 0].map(tokensShort), ["96k", "999", "1.4M", "2M", "13M", "0"]);
});

test("Esc walks back one step per press: the transcript, a maximised dock, the selection, the dock", () => {
  // (the app's subagent drawer is above the view and takes its own Esc before any of these)
  let v: ViewState = dockIn(selectIn(openingView("running"), { turn: 5 }), "max");
  let transcript = true;
  const seen: string[] = [];
  const say = () => `${transcript ? "transcript" : "-"}/${v.sel ? "sel" : "none"}/${v.dock}/${v.tab}`;
  for (let i = 0; i < 8; i++) {
    seen.push(say());
    const next = escIn(v, transcript);
    if (next === null) break;
    if (next === "transcript") transcript = false; else v = next;
  }
  assert.deepEqual(seen, ["transcript/sel/max/entity", "-/sel/max/entity", "-/sel/open/entity", "-/none/open/goal", "-/none/closed/goal"]);
  assert.equal(escIn(v, transcript), null, "then Esc is not the view's");
  // the transcript closes first whatever the dock shows, and the view is left as it is
  assert.equal(escIn(openingView("running"), true), "transcript");
  assert.equal(escIn(openingView("completed"), true), "transcript");
  // a dock the user maximised: restore comes before the selection
  const max = dockIn(selectIn(openingView("running"), { task: "T01" }), "max");
  const step = escIn(max) as ViewState;
  assert.deepEqual([step.dock, step.sel], ["open", { task: "T01" }]);
  assert.equal(escIn(openingView("running")), null);
  assert.equal((escIn(openingView("completed")) as ViewState).dock, "closed");
});

test("the bar's status of a running run: the turn, the wait, or that it starts", () => {
  assert.equal(runDoing({ turnRunning: 14, turns: 14, wait: { tasks: ["T11"], mode: "all" } }), "turn 14 deciding");
  assert.equal(runDoing({ turns: 13, wait: { tasks: ["T11", "T23"], mode: "all" } }), "waiting for T11, T23");
  assert.equal(runDoing({ turns: 13, wait: { tasks: ["T07", "T09"], mode: "any" } }), "waiting for any of T07, T09");
  assert.equal(runDoing({ turns: 13, wait: { tasks: ["T07"], mode: "any" } }), "waiting for T07");
  assert.equal(runDoing({ turns: 13, wait: { tasks: ["T01", "T02", "T03", "T04", "T05"], mode: "all" } }), "waiting for T01, T02, T03 +2");
  assert.equal(runDoing({ turns: 13, wait: { tasks: [], mode: "all" } }), "waiting for tasks");
  assert.equal(runDoing({ turns: 13 }), "waiting for tasks");
  assert.equal(runDoing({ turns: 0 }), "starting");
});

const task = (id: string, outcome?: "done" | "failed" | "cancelled") =>
  ({ id, createdAt: 0, dependsOn: [], attempts: [{ n: 1, queuedTurn: 1, phases: [{ k: "work" as const, t: 0 }], outcome }] });

test("the bar's status: a run that has its result and still runs is finishing", () => {
  assert.equal(runDoing({ turns: 9 }, { result: { outcome: "achieved" }, tasks: [] }), "finishing…");
  assert.equal(runDoing({ turns: 9, wait: { tasks: ["T01"], mode: "all" } }, { result: {}, tasks: [task("T01")] }), "finishing…");
  assert.equal(runDoing({ turnRunning: 9, turns: 9 }, { result: {}, tasks: [] }), "turn 9 deciding", "the turn that set the result still runs");
  assert.equal(runDoing({ turns: 9 }, { tasks: [] }), "waiting for tasks");
  assert.equal(runDoing({ turns: 9 }, null), "waiting for tasks");
});

test("the bar's wait leaves out the tasks the detail shows as ended, as the timeline does", () => {
  const wait = { tasks: ["T01", "T02", "T04"], mode: "all" as const };
  const tasks = [task("T01"), task("T02"), task("T03"), task("T04", "done")];
  assert.equal(runDoing({ turns: 3, wait }, { tasks }), "waiting for T01, T02");
  assert.equal(runDoing({ turns: 3, wait }, { tasks: [task("T01", "failed"), task("T02", "cancelled"), task("T04")] }), "waiting for T04");
  assert.equal(runDoing({ turns: 3, wait: { ...wait, mode: "any" } }, { tasks }), "waiting for any of T01, T02");
  assert.equal(runDoing({ turns: 3, wait: { ...wait, mode: "any" } }, { tasks: [task("T01", "done"), task("T02", "done"), task("T04")] }), "waiting for T04");
  // no detail loaded, or a task the detail does not have: named
  assert.equal(runDoing({ turns: 3, wait }), "waiting for T01, T02, T04");
  assert.equal(runDoing({ turns: 3, wait }, { tasks: [task("T04", "done")] }), "waiting for T01, T02");
  // none of them open: all are named, as on the timeline
  assert.equal(runDoing({ turns: 3, wait }, { tasks: [task("T01", "done"), task("T02", "done"), task("T04", "failed")] }), "waiting for T01, T02, T04");
});

test("the dock's height: the user's, or 46% of the area; never under 140 px, never over the area less 132", () => {
  assert.equal(dockHeight(null, 600), 276); assert.equal(dockHeight(undefined, 1000), 460);
  assert.equal(dockHeight(300, 600), 300); assert.equal(dockHeight(50, 600), DOCK_MIN); assert.equal(dockHeight(900, 600), 468);
  assert.equal(dockHeight(null, 200), 140); assert.equal(dockHeight(400, 250), 140, "a low window: the minimum wins");
});

test("working time ticks while the run runs; stopped time adds up", () => {
  assert.equal(workingMs({ status: "running", activeMs: 60000, asOf: 1000 }, 31000), 90000);
  assert.equal(workingMs({ status: "stopping", activeMs: 60000, asOf: 1000 }, 31000), 90000);
  assert.equal(workingMs({ status: "running", activeMs: 60000, asOf: 5000 }, 1000), 60000, "a clock behind the server's does not go back");
  for (const s of ["stopped", "stalled", "error", "completed", "gave_up"] as const) assert.equal(workingMs({ status: s, activeMs: 60000, asOf: 1000 }, 31000), 60000);
  assert.equal(stoppedTotal([{ at: 10, resumedAt: 40, reason: "user" }, { at: 100, reason: "app_quit" }], 150), 80);
  assert.equal(stoppedTotal(null, 150), 0);
});

test("meters: money, tones, busy slots, tasks by state", () => {
  assert.equal(money(117.618), "$117.62"); assert.equal(money(0), "$0.00"); assert.equal(moneyLimit(200), "$200"); assert.equal(moneyLimit(12.5), "$12.50");
  assert.deepEqual([meterTone(47, 60), meterTone(48, 60), meterTone(60, 60), meterTone(70, 60), meterTone(5, 0)], ["ok", "warn", "danger", "danger", "ok"]);
  const c = counts({ work: 3, merge: 1, done: 23, slot: 3, deps: 2, held: 1, failed: 1, cancelled: 2 });
  assert.equal(busySlots({ status: "running", counts: c }), 4); assert.equal(busySlots({ status: "stopped", counts: c }), 0);
  assert.equal(countsTitle(c), "23 done · 3 working · 1 merging · 3 ready, no free slot · 2 waiting on dependencies · 1 held · 1 failed · 2 cancelled");
  assert.equal(countsTitle(counts()), "No tasks yet");
});

test("a moment for a banner: the clock, with the day when it is not today", () => {
  const t = Date.UTC(2026, 9, 5, 1, 9, 0);
  assert.equal(whenText(t, t + 3600_000, 0), "01:09");
  assert.equal(whenText(t, t + 26 * 3600_000, 0), "5 Oct, 01:09");
  assert.equal(whenText(t, t + 3600_000, 120), "03:09");
});

test("stop: what the confirmation says", () => {
  assert.deepEqual(stopConfirm({ counts: counts({ work: 3, merge: 1 }), turnRunning: undefined }), { title: "Stop this run?", body: "4 agents are working. They are interrupted and continue where they stopped when you resume." });
  assert.equal(agentsAtWork({ counts: counts({ work: 3, setup: 1 }), turnRunning: 14 }), 5);
  assert.equal(stopConfirm({ counts: counts(), turnRunning: 2 }).body, "1 agent is working. It is interrupted and continues where it stopped when you resume.");
  assert.match(stopConfirm({ counts: counts({ slot: 2 }) }).body, /^No agent is working right now\./);
});

test("resume: which limit has to be raised, and to what", () => {
  assert.deepEqual(resumeRaise({ status: "stalled", stalledBy: "turns", settings: settings({ maxTurns: 12 }) }), { key: "maxTurns", value: 32, unit: "turns", was: 12 });
  assert.equal(resumeRaise({ status: "stalled", stalledBy: "turns", settings: settings({ maxTurns: 490 }) })!.value, 500);
  assert.deepEqual(resumeRaise({ status: "stalled", stalledBy: "cost", settings: settings({ maxCost: 40 }) }), { key: "maxCost", value: 60, unit: "dollars", was: 40 });
  assert.equal(resumeRaise({ status: "stalled", stalledBy: "cost", settings: settings({ maxCost: 12.5 }) })!.value, 19);
  assert.equal(resumeRaise({ status: "stalled", stalledBy: "idle", settings: settings() }), null);
  assert.equal(resumeRaise({ status: "stopped", settings: settings() }), null); assert.equal(resumeRaise({ status: "error", stalledBy: "turns", settings: settings() }), null);
  assert.deepEqual([raiseValue("maxTurns", " 80 "), raiseValue("maxTurns", "80.6"), raiseValue("maxTurns", ""), raiseValue("maxTurns", "many")], [80, 81, null, null]);
  assert.deepEqual([raiseValue("maxCost", "$60"), raiseValue("maxCost", "60.456"), raiseValue("maxCost", " ")], [60, 60.46, null]);
  assert.deepEqual(["stopped", "stalled", "error", "running", "stopping", "completed", "gave_up", "draft"].map((s) => canResume(s as never)), [true, true, true, false, false, false, false, false]);
  assert.equal(stalledWords({ stalledBy: "turns", settings: settings({ maxTurns: 12 }) }), "the limit of 12 orchestrator turns");
  assert.equal(stalledWords({ stalledBy: "cost", settings: settings({ maxCost: 40 }) }), "the cost limit of $40");
  assert.equal(stalledWords({ stalledBy: "idle", settings: settings() }), "3 idle turns in a row");
});

test("the meters' task counts come from the detail's tasks when it is loaded, else from the run", () => {
  const t = (phases: string[], outcome?: string): any => ({ attempts: [{ outcome: "failed", phases: [{ k: "work", t: 1 }] }, { outcome, phases: phases.map((k, i) => ({ k, t: i })) }] });
  const tasks = [t(["slot", "setup", "work", "merge"], "done"), t(["slot", "setup", "work"]), t(["deps"]), t([]), t(["slot", "setup", "work"], "failed"), t(["deps"], "cancelled"), { attempts: [] } as any];
  const own = counts({ done: 9 });
  const c = taskCounts(tasks, own);
  assert.deepEqual(c, counts({ done: 1, work: 1, deps: 1, held: 2, failed: 1, cancelled: 1 }));
  assert.equal(countsTitle(c), "1 done · 1 working · 1 waiting on dependencies · 2 held · 1 failed · 1 cancelled");
  assert.equal(busySlots({ status: "running", counts: c }), 1);
  assert.deepEqual(taskCounts([], own), counts(), "a detail without tasks has none, whatever the run still says");
  assert.equal(taskCounts(null, own), own); assert.equal(taskCounts(undefined, own), own);
});
