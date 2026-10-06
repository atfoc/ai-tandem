import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  clockTime, dateTime, idList, lastMoment, rowLabel, runEnd, stateWord, taskFacts, taskTip, tipText, turnLabel, turnTip,
  type TimelineRun, type TimelineTask, type TimelineTurn, type TipOpts,
} from "../src/logic/runlabels.ts";
import { layoutTimeline } from "../src/logic/runtimeline.ts";
import { failNow, freeze, synthesize, type ScRun } from "./fixtures/runscenario.ts";

const TZ = 120; // The zone the sample run was made in: two hours ahead of UTC.
const qaRun = (): ScRun => JSON.parse(readFileSync(new URL("./fixtures/run-qa.json", import.meta.url), "utf8"));
const liveRun = () => freeze(qaRun(), qaRun().createdAt + 6400_000, true);
const taskOf = (run: TimelineRun, id: string): TimelineTask => run.tasks.find((t) => t.id === id)!;
const turnOf = (run: TimelineRun, n: number): TimelineTurn => run.turns.find((t) => t.n === n)!;
const label = (run: TimelineRun, id: string, paused = false) => rowLabel(taskOf(run, id), taskFacts(run).get(id), { paused, tz: TZ });
/** A task's tooltip as plain lines, at the run's end or the moment it was frozen at. */
function tip(run: ScRun, id: string, o: Partial<TipOpts> = {}): string[] {
  const t = taskTip(taskOf(run, id), taskFacts(run).get(id), { now: run.frozenAt ?? run.endedAt!, stops: run.stops, tz: TZ, ...o });
  return [t.head, ...t.lines.map(tipText)];
}
function ttip(run: ScRun, n: number, o: Partial<TipOpts> = {}): string[] {
  const t = turnTip(turnOf(run, n), { now: run.frozenAt ?? run.endedAt!, stops: run.stops, tz: TZ, ...o });
  return [t.head, ...t.lines.map(tipText)];
}

test("clock times: HH:MM, and a full date and time with seconds, in the zone given", () => {
  const t = Date.UTC(2026, 9, 4, 21, 23, 6);
  assert.equal(clockTime(t, 120), "23:23"); assert.equal(clockTime(t, 0), "21:23"); assert.equal(clockTime(t, -330), "15:53");
  assert.equal(dateTime(t, 120), "4 Oct 2026, 23:23:06");
  // Past midnight the date moves on.
  assert.equal(dateTime(t, 180), "5 Oct 2026, 00:23:06"); assert.equal(clockTime(t + 37 * 60000, 120), "00:00");
  // Without a zone: the one of the machine, whatever it is.
  const d = new Date(t);
  assert.equal(clockTime(t), `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`);
});

test("id lists: three or more in a row become a range", () => {
  assert.equal(idList(["T18", "T19", "T20", "T21", "T22", "T23"]), "T18–T23");
  assert.equal(idList(["T01", "T02", "T05", "T07", "T08", "T09", "X"]), "T01, T02, T05, T07–T09, X");
  assert.equal(idList(["T09", "T10", "T11"]), "T09–T11"); assert.equal(idList(["A1", "B2", "B3", "B4"]), "A1, B2–B4");
  assert.equal(idList([]), "");
});

test("what the run says about a task: who needs it, and the turns that changed it", () => {
  const run = synthesize(qaRun()), facts = taskFacts(run);
  assert.deepEqual(facts.get("T21"), { neededBy: ["T22", "T23", "T38"], changedTurns: [] });
  assert.deepEqual(facts.get("T15"), { neededBy: ["T21", "T38"], changedTurns: [9, 10] });
  assert.equal(facts.size, 53);
  // A refused call changed nothing.
  assert.deepEqual(facts.get("T12")!.changedTurns, []);
  assert.ok(qaRun().turns[5].ops.some((p) => p.op === "update_task" && p.task === "T12" && p.error));
});

test("a row's label says everything the row draws", () => {
  const run = qaRun();
  assert.equal(label(run, "T21"), "T21, Never re-make a Claude fork that has no fork-point id from a, fix, writes code, done. Added in turn 5 at 00:09. Ran 01:00 to 01:08. Depends on T02, T03, T15, T19. Needed by T22, T23, T38.");
  assert.equal(label(run, "T01"), "T01, Record the baseline: builds, tests, race detector, flakes, verify, done. Added in turn 1 at 23:26. Ran 23:34 to 23:43. Needed by T49.");
  assert.match(label(run, "T15"), /Added in turn 3 at 23:58\. Changed in turn 9, 10\. Ran 00:49 to 01:00\./);
  const s = synthesize(qaRun());
  assert.match(label(s, "T41"), /, review, done\. Added in turn 19 at 01:42\. Attempt 1 ran 01:51 to 02:04, failed\. Attempt 2 ran 02:12 to 02:32, done\. Depends on /);
  assert.match(label(s, "T29"), /, fix, writes code, cancelled\. Added in turn 7 at 00:24\. Cancelled at 00:36, never started\. Depends on T10\.$/);
  assert.match(label(s, "T36"), /Ran 01:41 to 01:54\. Merge conflicts resolved in 2 files\. Depends on /);
});

test("the label of an open row says why it waits or since when it runs", () => {
  const live = liveRun();
  assert.match(label(live, "T11"), /, verify, working\. Added in turn 1 at 23:33\. Changed in turn 5\. Running since 00:47\. Depends on T19\.$/);
  assert.match(label(live, "T22"), /, fix, writes code, held, starts when turn 14 ends\. Added in turn 5 at 00:10\./);
  assert.match(label(live, "T29"), /, fix, writes code, ready, no free slot\. Added in turn 7 at 00:24\. Depends on T10\.$/);
  assert.match(label(live, "T31"), /, fix, writes code, waiting on T30\. Added in turn 9 at 00:36\./);
  const fb = failNow(liveRun(), "T26", qaRun().createdAt + 6100_000, "T23");
  assert.match(label(fb, "T23"), /, fix, writes code, blocked by T26\. Added in turn 5 at 00:10\./);
  assert.match(label(fb, "T26"), /, fix, writes code, failed\. Added in turn 6 at 00:20\. Ran 00:53 to 01:04\./);
  // A halted run: the task that was working is paused.
  assert.match(label(live, "T11", true), /, verify, paused\. .* Ran from 00:47, continues on resume\. Depends on T19\.$/);
  assert.equal(stateWord(taskOf(live, "T11")), "working"); assert.equal(stateWord(taskOf(live, "T11"), true), "paused");
});

test("a label needs no kind, no turn and no facts", () => {
  const bare: TimelineTask = { id: "U1", title: "Asked for in a chat", createdAt: Date.UTC(2026, 9, 4, 22, 0, 0), dependsOn: [], attempts: [] };
  assert.equal(rowLabel(bare, undefined, { tz: TZ }), "U1, Asked for in a chat, held, starts when the orchestrator's turn ends. Added at 00:00.");
  assert.deepEqual(taskTip(bare, undefined, { now: bare.createdAt + 60000, tz: TZ }).lines.map(tipText), ["Asked for in a chat", "Added at 00:00", "Starts when the orchestrator's turn ends", "Depends on nothing · needed by nothing"]);
  assert.equal(taskTip(bare, undefined, { now: bare.createdAt, tz: TZ }).head, "U1 · held");
});

test("a turn bar's label: its number, its times and what it did", () => {
  const run = synthesize(qaRun());
  assert.equal(turnLabel(turnOf(run, 5), { tz: TZ }), "Turn 5, 00:03 to 00:14, added 6 tasks, changed 1");
  assert.equal(turnLabel(turnOf(run, 1), { tz: TZ }), "Turn 1, 23:23 to 23:34, added 12 tasks");
  assert.equal(turnLabel(turnOf(run, 2), { tz: TZ }), "Turn 2, 23:43 to 23:44, left the plan as it was");
  assert.equal(turnLabel(turnOf(run, 9), { tz: TZ }), "Turn 9, 00:31 to 00:39, added 1 task, changed 1, cancelled 1");
  assert.equal(turnLabel(turnOf(run, 16), { tz: TZ }), "Turn 16, 01:22 to 01:31, added 4 tasks, 1 refused call");
  assert.equal(turnLabel(turnOf(run, 24), { tz: TZ }), "Turn 24, 02:05 to 02:12, added 1 task, retried 1");
  assert.equal(turnLabel(turnOf(qaRun(), 35), { tz: TZ }), "Turn 35, 03:52 to 03:54, finished the run");
  const live = liveRun();
  assert.equal(turnLabel(turnOf(live, 14), { tz: TZ }), "Turn 14, running since 01:01, changed 1");
  assert.equal(turnLabel(turnOf(live, 14), { live: false, tz: TZ }), "Turn 14, started 01:01, not finished, changed 1");
  assert.equal(turnLabel({ ...turnOf(run, 2), status: "failed" }, { tz: TZ }), "Turn 2, 23:43 to 23:44, failed");
});

test("a task's tooltip: added, waited, ran, depends on", () => {
  assert.deepEqual(tip(qaRun(), "T15"), [
    "T15 · fix · done",
    "Make the missing-folder fix reach every branch of a chat (T0",
    "Added in turn 3 at 23:58, changed in turn 9, 10",
    "Waited 50m 51s: 9m 08s held, 35m 21s on T13, 6m 21s for a slot",
    "Ran 00:49 → 01:00 (10m 40s) · merged",
    "Depends on T02, T13 · needed by T21, T38",
  ]);
  assert.deepEqual(tip(qaRun(), "T01"), [
    "T01 · verify · done", "Record the baseline: builds, tests, race detector, flakes", "Added in turn 1 at 23:26",
    "Waited 7m 34s held", "Ran 23:34 → 23:43 (8m 52s)", "Depends on nothing · needed by T49",
  ]);
  // What is stressed: the turn, the total wait, the times, the ids.
  const t = taskTip(taskOf(qaRun(), "T15"), taskFacts(qaRun()).get("T15"), { now: qaRun().endedAt!, tz: TZ });
  assert.deepEqual(t.lines.flatMap((l) => l.filter((p) => typeof p !== "string").map((p) => p.b)), ["turn 3", "50m 51s", "00:49 → 01:00", "T02, T13", "T21, T38"]);
  // A cost shows when the attempt has one.
  const paid = qaRun(); paid.tasks[14].attempts[0] = { ...paid.tasks[14].attempts[0], cost: 2.886 } as ScRun["tasks"][0]["attempts"][0];
  assert.equal(tip(paid, "T15")[4], "Ran 00:49 → 01:00 (10m 40s) · merged · $2.89");
});

test("a task's tooltip: attempts, a cancel, conflicts, and a run across a stop", () => {
  const s = synthesize(qaRun());
  assert.deepEqual(tip(s, "T41").slice(3), [
    "Attempt 1: ran 01:51 → 02:04 (13m 14s) · failed", "Attempt 2: waited 2m 31s held", "Attempt 2: ran 02:12 → 02:32 (19m 47s)",
    "Depends on T09, T14, T17, T30–T33 · needed by T48, T50",
  ]);
  assert.deepEqual(tip(s, "T29").slice(3, 5), ["Waited 11m 29s: 2m 06s held, 9m 22s for a slot", "Cancelled at 00:36, never started"]);
  assert.equal(tip(s, "T36")[4], "Ran 01:41 → 01:54 (13m 24s) · merged, conflicts resolved in 2 files");
  // T47 ran across the six-hour stop: its duration leaves the stop out.
  assert.equal(tip(s, "T47")[4], "Ran 02:29 → 08:59 (29m 52s) · merged");
  assert.equal(tip(s, "T47", { stops: null })[4], "Ran 02:29 → 08:59 (6h 29m) · merged");
});

test("a task's tooltip in a live run: what it waits on so far, or what it does", () => {
  const live = liveRun();
  assert.deepEqual(tip(live, "T11").slice(3, 5), ["Waited 1h 14m: 2m 43s held, 32m 21s on T19, 38m 57s for a slot", "Running since 00:47 (22m 42s) · Bash: go test ./internal/chats/ -run TestFork"]);
  assert.deepEqual(tip(live, "T22").slice(3), ["Waited 59m 39s so far: 10m 19s held, 49m 20s on T21", "Starts when turn 14 ends", "Depends on T05, T21 · needed by nothing"]);
  assert.equal(tip(live, "T29")[0], "T29 · fix · ready");
  // A minute later only the open wait has grown.
  assert.equal(tip(live, "T22", { now: live.frozenAt! + 60000 })[3], "Waited 1h 00m so far: 11m 19s held, 49m 20s on T21");
  const fb = failNow(liveRun(), "T26", qaRun().createdAt + 6100_000, "T23");
  assert.equal(tip(fb, "T23")[3], "Waited 59m 12s so far: 4m 09s held, 50m 03s on T18, T21, 5m 00s blocked by T26");
  assert.equal(tip(fb, "T26")[4], "Ran 00:53 → 01:04 (11m 15s) · failed");
  assert.deepEqual(tip(live, "T11", { paused: true }).filter((l, i) => i === 0 || i === 4), ["T11 · verify · paused", "Ran from 00:47 (22m 42s) · continues on resume"]);
});

test("a turn's tooltip: when, what woke it, what it did", () => {
  const run = synthesize(qaRun());
  assert.deepEqual(ttip(run, 5), ["Turn 5 · 00:03 → 00:14 (11m 23s)", "Woken by T03, T05", "+ T18–T23 · ~ T11", "≡ rewrote the notes"]);
  assert.deepEqual(ttip(run, 1), ["Turn 1 · 23:23 → 23:34 (11m 10s)", "+ T01–T12", "≡ rewrote the notes"]);
  assert.deepEqual(ttip(run, 2), ["Turn 2 · 23:43 → 23:44 (1m 11s)", "Woken by T01", "Left the plan as it was", "≡ rewrote the notes"]);
  assert.deepEqual(ttip(run, 9).slice(2, 3), ["+ T31 · ~ T15 · ✕ T29"]);
  assert.deepEqual(ttip(run, 16).slice(2), ["+ T37–T40", "≡ rewrote the notes", "⚠ finish run was refused"]);
  assert.deepEqual(ttip(run, 24).slice(2, 3), ["+ T45 · ↻ T41"]);
  assert.deepEqual(ttip(qaRun(), 35), ["Turn 35 · 03:52 → 03:54 (1m 44s)", "Woken by T53", "⚑ finished the run"]);
  const live = liveRun();
  assert.deepEqual(ttip(live, 14), ["Turn 14 · running since 01:01 (8m 26s)", "Woken by T15, T25", "~ T22"]);
  assert.equal(ttip(live, 14, { live: false })[0], "Turn 14 · started 01:01, not finished");
  // The fields a fuller record brings: why it started, how its wakers ended, the notes version, its cost.
  const full: TimelineTurn = { ...turnOf(run, 5), cost: 3.336, wokenBy: [{ task: "T03", type: "task_done" }, { task: "T05", type: "task_failed" }],
    ops: turnOf(run, 5).ops.map((p) => (p.op === "set_notes" ? { ...p, notesVersion: 6 } : p)) };
  assert.deepEqual(turnTip(full, { now: 0, tz: TZ }).lines.map(tipText), ["Woken by T03 ✓, T05 !", "+ T18–T23 · ~ T11", "≡ notes v6", "$3.34"]);
  assert.equal(tipText(turnTip({ ...turnOf(run, 1), reason: "start" }, { now: 0, tz: TZ }).lines[0]), "Started by the goal");
  assert.equal(turnTip({ ...turnOf(run, 2), status: "failed" }, { now: 0, tz: TZ }).head, "Turn 2 · 23:43 → 23:44 (1m 11s) · failed");
});

test("where a run that is not live ends: its end, else where it was halted, else its last moment", () => {
  const run = qaRun();
  assert.equal(runEnd(run), run.endedAt);
  const cut = liveRun();
  assert.equal(runEnd({ ...cut, status: "stopped", endedAt: null, stops: [{ at: cut.frozenAt! - 5000, resumedAt: null }] }), cut.frozenAt! - 5000);
  // Neither an end nor an open stop: the last thing that happened (here a call of turn 14).
  const lastOp = Math.max(...cut.turns.flatMap((t) => t.ops.map((p) => p.t)));
  const end = runEnd({ ...cut, status: "error", endedAt: null });
  assert.ok(end >= lastOp && end <= cut.frozenAt!);
  assert.equal(end, lastMoment(cut));
  // The last moment counts everything: a phase that began later, an attempt that ended later.
  const later = structuredClone(cut);
  later.tasks[10].attempts[0].phases.push({ k: "merge", t: cut.frozenAt! + 4000 });
  assert.equal(lastMoment(later), cut.frozenAt! + 4000);
  later.tasks[0].attempts[0].endedAt = cut.frozenAt! + 9000;
  assert.equal(lastMoment(later), cut.frozenAt! + 9000);
  assert.equal(lastMoment({ status: "running", createdAt: 5, turns: [], tasks: [] }), 5);
  // The layout ends such a run there.
  const L = layoutTimeline({ ...cut, status: "error", endedAt: null }, { width: 720, now: end });
  assert.equal(L.axis.t1, end); assert.equal(L.nowX, null);
});

test("a task a chat added or changed says so; a phase held by a chat names the chat's reply", () => {
  const t0 = Date.UTC(2026, 9, 4, 22, 0, 0), min = 60000;
  const byChat: TimelineTask = { id: "T08", title: "Document the fork tree", kind: "docs", writes: true, addedTurn: 6, addedBy: "c_ask", createdAt: t0, dependsOn: [],
    attempts: [{ n: 1, queuedTurn: 6, phases: [{ k: "held", t: t0, chat: "c_ask" }] }] };
  assert.equal(rowLabel(byChat, undefined, { tz: TZ }), "T08, Document the fork tree, docs, writes code, held, starts when the chat's reply ends. Added from a chat at 00:00.");
  const tipLines = taskTip(byChat, undefined, { now: t0 + min, tz: TZ }).lines.map(tipText);
  assert.deepEqual(tipLines, ["Document the fork tree", "Added from a chat at 00:00", "Waited 1m 00s held so far", "Starts when the chat's reply ends", "Depends on nothing · needed by nothing"]);
  // A chat's update outside a turn is among the task's facts, with its time; a refused one is not.
  const run = { turns: [], tasks: [byChat, { ...byChat, id: "T09", addedBy: null }],
    chatOps: [{ op: "update_task", t: t0 + 5 * min, i: 0, task: "T09", chat: "c_ask" }, { op: "update_task", t: t0 + 6 * min, i: 1, task: "T08", chat: "c_ask", error: "refused" },
      { op: "cancel_task", t: t0 + 7 * min, i: 2, task: "T09", chat: "c_ask" }] };
  const facts = taskFacts(run);
  assert.deepEqual(facts.get("T09"), { neededBy: [], changedTurns: [], chatChanged: [t0 + 5 * min] });
  assert.deepEqual(facts.get("T08"), { neededBy: [], changedTurns: [] });
  // T09 was added by turn 6 and changed from a chat.
  assert.ok(rowLabel(run.tasks[1], facts.get("T09"), { tz: TZ }).includes("Added in turn 6 at 00:00. Changed from a chat at 00:05."));
  assert.equal(taskTip(run.tasks[1], facts.get("T09"), { now: t0 + 9 * min, tz: TZ }).lines.map(tipText)[1], "Added in turn 6 at 00:00, changed from a chat at 00:05");
});

// ---- process v3: tiers and waits in the words (T14 §1)

const M = 60000, T0 = Date.UTC(2026, 9, 5, 10, 0, 0);
/** A task with one attempt per tier given, each 10 minutes long, the last one done. */
function tiered(tiers: string[], over: Partial<TimelineTask> = {}): TimelineTask {
  return {
    id: "T03", title: "Fix the cart total", kind: "fix", writes: true, addedTurn: 1, createdAt: T0, dependsOn: ["T01", "T02"], tier: tiers.at(-1),
    attempts: tiers.map((tier, i) => ({
      n: i + 1, queuedTurn: 1, tier, phases: [{ k: "work" as const, t: T0 + i * 20 * M }], startedAt: T0 + i * 20 * M, endedAt: T0 + (i * 20 + 10) * M,
      outcome: i === tiers.length - 1 ? "done" as const : "failed" as const, cost: i + 1,
    })), ...over,
  };
}
const tipOf = (task: TimelineTask, o: Partial<TipOpts> = {}) => { const t = taskTip(task, undefined, { now: T0 + 60 * M, tz: 0, ...o }); return [t.head, ...t.lines.map(tipText)]; };
const NAMES = { deep: { model: "Opus 5.5", effort: "Max" }, standard: { model: "Opus 5.5", effort: "Medium" }, light: { model: "Haiku 4.5" } };

test("a task's tooltip names its tier, and the tier, model and effort each attempt ran at", () => {
  // One attempt: the head has the tier; the attempt's line the tier with what it runs on.
  assert.deepEqual(tipOf(tiered(["deep"]), { tiers: NAMES }), [
    "T03 · fix · deep · done", "Fix the cart total", "Added in turn 1 at 10:00",
    "Ran 10:00 → 10:10 (10m 00s) · $1.00 · deep tier (Opus 5.5 · Max)", "Depends on T01, T02 · needed by nothing"]);
  // A model with no effort; no names given: the tier alone.
  assert.equal(tipOf(tiered(["light"]), { tiers: NAMES })[3], "Ran 10:00 → 10:10 (10m 00s) · $1.00 · light tier (Haiku 4.5)");
  assert.equal(tipOf(tiered(["standard"]))[3], "Ran 10:00 → 10:10 (10m 00s) · $1.00 · standard tier");
  assert.equal(tipOf(tiered(["standard"]), { tiers: { deep: NAMES.deep } })[3], "Ran 10:00 → 10:10 (10m 00s) · $1.00 · standard tier");
  assert.equal(tipOf(tiered(["standard"]), { tiers: null })[0], "T03 · fix · standard · done");
  // Retried on a higher tier: the head says the latest, each attempt its own.
  assert.deepEqual(tipOf(tiered(["standard", "deep"]), { tiers: NAMES }).filter((_l, i) => i === 0 || i === 3 || i === 4), [
    "T03 · fix · deep · done",
    "Attempt 1: ran 10:00 → 10:10 (10m 00s) · failed · $1.00 · standard tier (Opus 5.5 · Medium)",
    "Attempt 2: ran 10:20 → 10:30 (10m 00s) · $2.00 · deep tier (Opus 5.5 · Max)"]);
  // An attempt that runs says it too; one that never started has nothing to say.
  const open = tiered(["deep"]); open.attempts[0] = { ...open.attempts[0], endedAt: null, outcome: null, cost: null, activity: "Read cart.ts" };
  assert.equal(tipOf(open, { tiers: NAMES, now: T0 + 5 * M })[3], "Running since 10:00 (5m 00s) · Read cart.ts · deep tier (Opus 5.5 · Max)");
  const never = tiered(["deep"]); never.attempts[0] = { n: 1, queuedTurn: 1, tier: "deep", phases: [{ k: "held", t: T0 }], endedAt: T0 + M, outcome: "cancelled" };
  assert.deepEqual(tipOf(never, { tiers: NAMES }).slice(3, 5), ["Waited 1m 00s held", "Cancelled at 10:01, never started"]);
  // A record with no tier (a run of before v3) says nothing of one; the ✎ is gone from the head.
  const { tier: _t, ...old } = tiered(["deep"]); old.attempts = old.attempts.map(({ tier: _x, ...a }) => a);
  assert.deepEqual(tipOf(old, { tiers: NAMES }).filter((_l, i) => i === 0 || i === 3), ["T03 · fix · done", "Ran 10:00 → 10:10 (10m 00s) · $1.00"]);
  // The reports it is given whole are named with what it depends on, and in its label with its tier.
  const whole = tiered(["deep"], { needsReport: ["T02", "T09"] });
  assert.equal(tipOf(whole).at(-1), "Depends on T01, T02 (full reports of T02) · needed by nothing");
  assert.equal(rowLabel(whole, undefined, { tz: 0 }), "T03, Fix the cart total, fix, writes code, deep tier, done. Added in turn 1 at 10:00. Ran 10:00 to 10:10. Depends on T01, T02; full reports of T02.");
  assert.match(rowLabel(tiered(["standard", "deep"]), undefined, { tz: 0 }), /writes code, deep tier, done\./);
});

/** A turn from minute a to b with these ops, as [op, extra]. */
const turnAt = (n: number, a: number, b: number | null, ops: [string, object?][] = [], over: Partial<TimelineTurn> = {}): TimelineTurn => ({
  n, startedAt: T0 + a * M, endedAt: b == null ? null : T0 + b * M, status: b == null ? "running" : "done",
  ops: ops.map(([op, x], i) => ({ op, t: T0 + (a + 1) * M, i, ...(x ?? {}) })), ...over,
});
const turnTipOf = (turn: TimelineTurn, o: Partial<TipOpts> = {}) => turnTip(turn, { now: T0 + 60 * M, tz: 0, ...o }).lines.map(tipText);

test("a turn's tooltip names the wait it started under, how that ended, and the wait it declared", () => {
  const all = { tasks: ["T03", "T05"], mode: "all" as const }, any = { tasks: ["T07", "T09"], mode: "any" as const };
  // Met: what it waited for (under a wait for all of them, what woke it is those very tasks: not said twice).
  assert.deepEqual(turnTipOf(turnAt(5, 10, 14, [["add_task", { task: "T18" }], ["wait_for", { tasks: ["T18", "T19"], mode: "all" }]],
    { reason: "wait", wait: all, waitMet: true, wokenBy: [{ task: "T05", type: "task_done" }] })), ["Waited for T03, T05", "+ T18", "Then waits for T18, T19"]);
  // Met, any one: which one it was.
  assert.deepEqual(turnTipOf(turnAt(5, 10, 14, [["wait_for", { tasks: ["T07", "T09"], mode: "any" }]], { reason: "wait", wait: any, waitMet: true, wokenBy: [{ task: "T07", type: "task_done" }] })),
    ["Waited for any of T07, T09", "Woken by T07 ✓", "Left the plan as it was", "Then waits for any of T07, T09"]);
  // Early, with each cause.
  const early = (over: Partial<TimelineTurn>) => turnTipOf(turnAt(5, 10, 14, [["add_task", { task: "T18" }]], { wait: all, waitMet: false, ...over }))[0];
  assert.equal(early({ reason: "events", wokenBy: [{ task: "T05", type: "task_failed" }] }), "Waited for T03, T05 · started early: T05 failed");
  assert.equal(early({ reason: "events", wokenBy: [{ task: "", type: "chat_op" }] }), "Waited for T03, T05 · started early: a chat changed the run");
  assert.equal(early({ reason: "idle", wokenBy: [] }), "Waited for T03, T05 · started early: nothing was left running");
  assert.equal(early({ reason: "resume" }), "Waited for T03, T05 · started early: resumed");
  assert.equal(early({ reason: "events" }), "Waited for T03, T05 · started early");
  assert.equal(early({ wait: any, reason: "idle" }), "Waited for any of T07, T09 · started early: nothing was left running");
  // Three ids or more in a row are a range, as everywhere in the tooltips.
  assert.equal(early({ wait: { tasks: ["T03", "T04", "T05", "T09"], mode: "all" }, waitMet: true }), "Waited for T03–T05, T09");
  // The stressed part is what it waited for.
  const tip = turnTip(turnAt(5, 10, 14, [], { wait: all, waitMet: true }), { now: 0, tz: 0 });
  assert.deepEqual(tip.lines[0], ["Waited for ", { b: "T03, T05" }, ""]);
  // A turn whose record does not say what it waited for: the wait the turn before it declared.
  const before = turnAt(4, 0, 5, [["wait_for", { tasks: ["T03"], mode: "all" }]]);
  assert.equal(turnTipOf(turnAt(5, 10, 14, [], { waitMet: true }), { before })[0], "Waited for T03");
  // No wait: what woke it, or why it started, as before.
  assert.deepEqual(turnTipOf(turnAt(5, 10, 14, [["add_task", { task: "T18" }]], { reason: "events", wokenBy: [{ task: "T03", type: "task_done" }] })), ["Woken by T03 ✓", "+ T18"]);
  assert.equal(turnTipOf(turnAt(1, 0, 5, [], { reason: "start" }))[0], "Started by the goal");
  // What it declared: its last wait_for that was not refused; none once it finished the run, none while it runs.
  assert.deepEqual(turnTipOf(turnAt(5, 10, 14, [["wait_for", { tasks: ["T01"], mode: "all" }], ["wait_for", { tasks: ["T02"], mode: "any", error: "T02 is done" }]])),
    ["Left the plan as it was", "⚠ wait for was refused", "Then waits for T01"]);
  assert.deepEqual(turnTipOf(turnAt(9, 10, 14, [["finish_run"]])), ["⚑ finished the run"]);
  assert.deepEqual(turnTipOf(turnAt(5, 10, null, [["wait_for", { tasks: ["T01"], mode: "all" }]])), ["No task was added or changed yet"]);
  // Notes: a section edit is said as one; the cost stays last.
  assert.deepEqual(turnTipOf(turnAt(5, 10, 14, [["edit_notes", { notesVersion: 12 }], ["wait_for", { tasks: ["T01"], mode: "all" }]], { cost: 0.42 })),
    ["Left the plan as it was", "≡ notes v12", "Then waits for T01", "$0.42"]);
  assert.equal(turnTipOf(turnAt(5, 10, 14, [["edit_notes"]]))[1], "≡ edited the notes");
});

test("a turn bar's label says an early start and its cause, and a plan left as it was", () => {
  const wait = { tasks: ["T03", "T05"], mode: "all" as const };
  assert.equal(turnLabel(turnAt(5, 10, 14, [["add_task", { task: "T18" }]], { wait, waitMet: false, reason: "events", wokenBy: [{ task: "T05", type: "task_failed" }] }), { tz: 0 }),
    "Turn 5, 10:10 to 10:14, started early: T05 failed, added 1 task");
  assert.equal(turnLabel(turnAt(5, 10, 14, [["get_run"]], { wait, waitMet: false, reason: "idle" }), { tz: 0 }), "Turn 5, 10:10 to 10:14, started early: nothing was left running, left the plan as it was");
  assert.equal(turnLabel(turnAt(5, 10, 14, [["add_task", { task: "T18" }]], { wait, waitMet: true }), { tz: 0 }), "Turn 5, 10:10 to 10:14, added 1 task");
  assert.equal(turnLabel(turnAt(5, 10, null, []), { tz: 0 }), "Turn 5, running since 10:10"); // nothing left yet
  assert.equal(turnLabel(turnAt(5, 10, 14, [], { waitMet: false, reason: "resume" }), { tz: 0, before: turnAt(4, 0, 5, [["wait_for", { tasks: ["T03"] }]]) }), "Turn 5, 10:10 to 10:14, started early: resumed, left the plan as it was");
});
