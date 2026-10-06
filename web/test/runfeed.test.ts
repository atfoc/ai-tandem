import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { callLine, choiceLabel, fmtTokens, interrupted, isWrite, launchNotes, launchWords, measuredAt, mergeAgents, notesChange, notesLine, opLine, opSentence, partsText, phaseLine,
  renameOf, runLive, sectionName, taskHistory, tokenLine, turnKept, turnReads, turnStart, turnThen, workedMs } from "../src/logic/runfeed.ts";
import { emptyDetail } from "../src/logic/rundetail.ts";
import type { Attempt, Op, RunAgent, RunDetail, RunEvent, Task, Turn } from "../src/types.ts";

const M = 60000, T0 = 1_700_000_000_000;
const at = (min: number) => T0 + min * M;
const attempt = (n: number, over: Partial<Attempt> = {}): Attempt => ({ n, tier: "standard", queuedTurn: 1, queuedAt: at(1), phases: [{ k: "held", t: at(1), turn: 1 }], agents: {}, cost: null, ...over });
const task = (id: string, over: Partial<Task> = {}): Task => ({ id, title: "Title of " + id, kind: "fix", writes: true, dependsOn: [], needsReport: [], tier: "standard", tierReason: "", addedTurn: 1, createdAt: at(1),
  changedTurns: [], briefRev: 1, briefs: [{ rev: 1, at: at(1), turn: 1, size: 100 }], attempts: [attempt(1)], ...over });
const turn = (n: number, a: number, b: number | null, ops: Partial<Op>[] = []): Turn => ({ n, agent: "a-turn-" + n, reason: n === 1 ? "start" : "events", status: b == null ? "running" : "done",
  startedAt: at(a), ...(b == null ? {} : { endedAt: at(b) }), wokenBy: [], learned: [], ops: ops.map((o, i) => ({ i, t: at(a) + i * 1000, op: "get_run", ...o })), cost: null });
const agent = (id: string, over: Partial<RunAgent> = {}): RunAgent => ({ id, name: id, role: "task", task: "T01", attempt: 1, status: "running", startedAt: at(5), launches: [{ n: 1, startedAt: at(5), resume: false }], cost: null, tier: "standard", model: "opus", tokens: null, ...over });
const op = (o: Partial<Op>): Op => ({ i: 0, t: at(3), op: "get_run", ...o });
const base = (over: Partial<RunDetail> = {}): RunDetail => ({ ...emptyDetail("r_1", at(0)), version: 3, ...over });

test("a call as a sentence", () => {
  assert.equal(opSentence(op({ op: "add_task", task: "T18", title: "Fix the picker", dependsOn: ["T03", "T05"] })), "added T18 Fix the picker ← T03, T05");
  assert.equal(opSentence(op({ op: "add_task", task: "T18", title: "Fix the picker", dependsOn: [] })), "added T18 Fix the picker");
  assert.equal(opSentence(op({ op: "update_task", task: "T11", changed: ["depends_on", "brief"] })), "changed T11: dependencies, brief");
  assert.equal(opSentence(op({ op: "update_task", task: "T11" })), "changed T11");
  assert.equal(opSentence(op({ op: "retry_task", task: "T41", attempt: 2, reason: "The failure looks transient." })), "retried T41 (attempt 2) · The failure looks transient.");
  assert.equal(opSentence(op({ op: "cancel_task", task: "T29", reason: "Not needed." })), "cancelled T29 · Not needed.");
  assert.equal(opSentence(op({ op: "set_notes", notesVersion: 6 })), "rewrote the notes → v6");
  assert.equal(opSentence(op({ op: "finish_run", outcome: "achieved" })), "finished the run: achieved");
  assert.equal(opSentence(op({ op: "finish_run", outcome: "not_achieved" })), "finished the run: not achieved");
  assert.equal(opSentence(op({ op: "finish_run", error: "3 tasks are still running" })), "finish run was refused · 3 tasks are still running");
  assert.equal(opSentence(op({ op: "add_task", error: "no task T99 to depend on" })), "add task was refused · no task T99 to depend on");
  assert.equal(opSentence(op({ op: "retry_task", task: "T07", error: "T07 is running" })), "retry task T07 was refused · T07 is running");
  assert.equal(opSentence(op({ op: "get_run" })), "looked at the run"); assert.equal(opSentence(op({ op: "get_task", task: "T03" })), "looked at T03");
  assert.equal(opSentence(op({ op: "get_agent", agent: "T03-work" })), "looked at agent T03-work"); assert.equal(opSentence(op({ op: "get_notes" })), "looked at the notes");
});

test("a chat's call says so, and is not the orchestrator's", () => {
  const add = op({ op: "add_task", chat: "c1", task: "T18", title: "Document the fork tree" });
  assert.equal(opSentence(add), "a chat added T18 Document the fork tree");
  assert.deepEqual(opLine(add), { glyph: "+", tone: "chat", parts: ["a chat ", "added", " ", { task: "T18" }, " Document the fork tree"] });
  assert.equal(opSentence(op({ op: "cancel_task", chat: "c1", task: "T09", reason: "Not needed." })), "a chat cancelled T09 · Not needed.");
  assert.equal(opSentence(op({ op: "tell_orchestrator", chat: "c1", text: "Keep the e2e green." })), "a chat told the orchestrator · Keep the e2e green.");
  assert.equal(opSentence(op({ op: "cancel_task", chat: "c1", task: "T99", error: "no task T99" })), "a chat's cancel of T99 was refused · no task T99");
});

test("a line: its glyph and tone, task ids as parts", () => {
  assert.deepEqual(opLine(op({ op: "retry_task", task: "T41", attempt: 2, reason: "again" })), { glyph: "↻", tone: "orch", parts: ["retried", " ", { task: "T41" }, " (attempt 2)"], note: "again" });
  assert.deepEqual(opLine(op({ op: "add_task", task: "T02", title: "B", dependsOn: ["T01", "T03"] })).parts, ["added", " ", { task: "T02" }, " B", " ← ", { task: "T01" }, ", ", { task: "T03" }]);
  assert.deepEqual([opLine(op({ op: "set_notes" })).glyph, opLine(op({ op: "cancel_task", task: "T1" })).glyph, opLine(op({ op: "finish_run" })).glyph], ["≡", "✕", "⚑"]);
  assert.deepEqual([opLine(op({ op: "add_task", error: "x" })).glyph, opLine(op({ op: "add_task", error: "x" })).tone], ["⚠", "warn"]);
  assert.deepEqual([opLine(op({ op: "get_run" })).glyph, opLine(op({ op: "get_run" })).tone], ["·", "muted"]);
  assert.deepEqual([isWrite(op({ op: "get_run" })), isWrite(op({ op: "get_task", error: "no" })), isWrite(op({ op: "set_notes" })), isWrite(op({ op: "tell_orchestrator" }))], [false, true, true, true]);
});

// ---- what the dock's views say (part 2)

const ev = (seq: number, min: number, type: RunEvent["type"], x: string, text = "text of " + x): RunEvent => ({ seq, t: at(min), type, ...(type === "chat_op" ? { chat: x } : { task: x }), text });
const REAL = (): RunDetail => JSON.parse(readFileSync(new URL("./fixtures/run-detail-qa.json", import.meta.url), "utf8"));

test("a run that is not live measures what is open up to where it was halted or ended", () => {
  assert.deepEqual([runLive({ status: "running" }), runLive({ status: "stopping" }), runLive({ status: "stopped" }), runLive({ status: "stalled" }), runLive({ status: "error" }), runLive({ status: "completed" })], [true, true, false, false, false, false]);
  assert.equal(measuredAt({ status: "running", stops: [] }, at(50)), at(50));
  assert.equal(measuredAt({ status: "stopped", stops: [{ at: at(10), resumedAt: at(20), reason: "user" }, { at: at(30), reason: "app_quit" }] }, at(50)), at(30));
  assert.equal(measuredAt({ status: "completed", stops: [], endedAt: at(40) }, at(50)), at(40));
  assert.equal(workedMs([{ at: at(10), resumedAt: at(20), reason: "user" }], at(5), at(30)), 15 * M);
  assert.equal(workedMs(null, at(5), at(3)), 0);
});

test("the phase line: each kind once, in the order it came, stops left out", () => {
  const a = attempt(1, { phases: [{ k: "held", t: at(0), turn: 1 }, { k: "deps", t: at(2), on: ["T13", "T02"] }, { k: "deps", t: at(20), on: ["T13"] }, { k: "held", t: at(37), turn: 9 },
    { k: "slot", t: at(38) }, { k: "setup", t: at(44) + 21000 }, { k: "work", t: at(44) + 25000 }, { k: "merge", t: at(55) }], endedAt: at(55) + 2000 });
  assert.equal(phaseLine(a, at(999)), "held 3m 00s · waited 35m 00s on T13, T02 · 6m 21s for a slot · setup 4s · work 10m 35s · merge 2s");
  // a wait under a second is not said; setup, work and merge always are
  assert.equal(phaseLine(attempt(1, { phases: [{ k: "held", t: at(0), turn: 1 }, { k: "slot", t: at(2) }, { k: "setup", t: at(2) + 20 }, { k: "work", t: at(2) + 500 }], endedAt: at(5) }), at(9)), "held 2m 00s · setup 0s · work 2m 59s");
  assert.equal(phaseLine(attempt(1, { phases: [{ k: "deps", t: at(0), on: ["T01"] }, { k: "blocked", t: at(4), on: ["T01"] }] }), at(10)), "waited 4m 00s on T01 · blocked 6m 00s by T01");
  // a run without git has no merge phase: the line has no merge part
  assert.equal(phaseLine(attempt(1, { phases: [{ k: "setup", t: at(0) }, { k: "work", t: at(1) }], endedAt: at(9) }), at(9)), "setup 1m 00s · work 8m 00s");
  assert.equal(phaseLine(attempt(1, { phases: [] }), at(9)), "");
});

test("the phase line of an open attempt: up to now while the run is live, up to the stop when it is halted", () => {
  const a = attempt(1, { phases: [{ k: "held", t: at(0), turn: 1 }, { k: "setup", t: at(2) }, { k: "work", t: at(3) }], startedAt: at(2) });
  assert.equal(phaseLine(a, at(30), []), "held 2m 00s · setup 1m 00s · work 27m 00s");
  // the time the run was stopped is no work
  assert.equal(phaseLine(a, at(30), [{ at: at(10), resumedAt: at(20), reason: "user" }]), "held 2m 00s · setup 1m 00s · work 17m 00s");
  // halted at minute 12: it does not grow with the clock
  const halted = [{ at: at(5), resumedAt: at(7), reason: "app_quit" as const }, { at: at(12), reason: "user" as const }];
  assert.equal(phaseLine(a, at(30), halted), "held 2m 00s · setup 1m 00s · work 7m 00s");
  assert.equal(phaseLine(a, at(500), halted), phaseLine(a, at(30), halted));
});

test("restarts: only a launch after a failed one counts; after a stop it continued, after no session it started over", () => {
  const launches = [
    { n: 1, startedAt: at(1), endedAt: at(5), resume: false, error: "the agent's process exited (code 137)" }, // failed
    { n: 2, startedAt: at(5), endedAt: at(9), resume: true },                                                   // stopped with the run
    { n: 3, startedAt: at(20), endedAt: at(20.5), resume: true, error: "no session" },                         // could not resume
    { n: 4, startedAt: at(20.5), resume: false },
  ];
  const notes = launchNotes({ launches });
  assert.deepEqual(notes, [
    { n: 2, t: at(5), kind: "restart", k: 1, why: "the agent's process exited (code 137)" },
    { n: 3, t: at(20), kind: "continued" },
    { n: 4, t: at(20.5), kind: "fresh" },
  ]);
  assert.deepEqual(notes.map((n) => launchWords(n, 2)), ["restarted (1 of 2)", "continued after the run was resumed", "started over: its session could not be resumed"]);
  assert.equal(launchWords(notes[0]), "restarted (1)");
  // one launch, or a stop alone: no restart
  assert.deepEqual(launchNotes({ launches: [launches[3]] }), []);
  assert.deepEqual(launchNotes({ launches: [{ n: 1, startedAt: at(1), endedAt: at(5), resume: false }, { n: 2, startedAt: at(9), resume: true }] }).map((n) => n.kind), ["continued"]);
  // three launches that all failed: two restarts (the last failure started nothing)
  const three = [1, 2, 3].map((n) => ({ n, startedAt: at(n), endedAt: at(n + 1), resume: n > 1, error: "timeout" }));
  assert.deepEqual(launchNotes({ launches: three }).map((n) => n.k), [1, 2]);
});

test("the merge agents of an attempt, one per round, in round order", () => {
  const agents = {
    w: agent("w", { name: "T03-work" }),
    r3: agent("r3", { name: "T03-merge-r3", role: "merge", task: "T03", attempt: 1, startedAt: at(30) }),
    r1: agent("r1", { name: "T03-merge", role: "merge", task: "T03", attempt: 1, startedAt: at(10) }),
    r2: agent("r2", { name: "T03-merge-r2", role: "merge", task: "T03", attempt: 1, startedAt: at(20) }),
    other: agent("other", { name: "T03-a2-merge", role: "merge", task: "T03", attempt: 2, startedAt: at(40) }),
    t4: agent("t4", { name: "T04-merge", role: "merge", task: "T04", attempt: 1 }),
  };
  assert.deepEqual(mergeAgents({ agents }, "T03", 1, "r3").map((a) => a.name), ["T03-merge", "T03-merge-r2", "T03-merge-r3"]);
  assert.deepEqual(mergeAgents({ agents }, "T03", 2).map((a) => a.name), ["T03-a2-merge"]);
  assert.deepEqual(mergeAgents({ agents }, "T01", 1), []);
  // the attempt's own agent counts even when its record names no task
  assert.deepEqual(mergeAgents({ agents: { x: agent("x", { name: "m", role: "merge", task: undefined }) } }, "T09", 1, "x").map((a) => a.id), ["x"]);
});

test("a task's history: every call on it, by turns and by chats, oldest first, said without its id", () => {
  const d = base({
    turns: [
      turn(1, 0, 2, [{ op: "add_task", task: "T05", title: "Five", dependsOn: ["T02", "T03"], briefRev: 1 }, { op: "add_task", task: "T06", dependsOn: ["T05"] }]),
      turn(2, 10, 12, [{ op: "get_task", task: "T05" }, { op: "update_task", task: "T05", changed: ["brief", "depends_on", "title"], dependsOn: ["T02"], briefRev: 2 }, { op: "update_task", task: "T05", error: "T05 is running" }]),
      turn(3, 30, 31, [{ op: "retry_task", task: "T05", attempt: 2, reason: "once more" }, { op: "cancel_task", task: "T05", reason: "not needed" }, { op: "update_task", task: "T05", changed: ["depends_on"], dependsOn: [] }]),
    ],
    chatOps: [{ i: 0, t: at(20), op: "cancel_task", chat: "c1", task: "T05", reason: "by the user" }, { i: 1, t: at(21), op: "retry_task", chat: "c1", task: "T05", error: "T05 is not failed" }, { i: 2, t: at(22), op: "add_task", chat: "c1", task: "T07" }],
  });
  const h = taskHistory(d, "T05");
  assert.deepEqual(h.map((r) => [r.turn, r.chat, r.glyph, partsText(r.parts) + (r.note ? " · " + r.note : "")]), [
    [1, null, "+", "added it ← T02, T03"],
    [2, null, "·", "looked at it"],
    [2, null, "~", "changed: brief (rev 2), dependencies (now T02), title"],
    [2, null, "⚠", "update task was refused · T05 is running"],
    [null, "c1", "✕", "cancelled · by the user"],
    [null, "c1", "⚠", "retry task was refused · T05 is not failed"],
    [3, null, "↻", "retried (attempt 2) · once more"],
    [3, null, "✕", "cancelled · not needed"],
    [3, null, "~", "changed: dependencies (now none)"],
  ]);
  assert.deepEqual(h.map((r) => r.tone), ["orch", "muted", "orch", "warn", "chat", "warn", "orch", "orch", "orch"]);
  assert.equal(new Set(h.map((r) => r.key)).size, h.length);
  assert.deepEqual(taskHistory(d, "T07").map((r) => [r.chat, partsText(r.parts)]), [["c1", "added it"]]);
  assert.deepEqual(taskHistory(d, "T99"), []);
});

test("a renamed file, as git prints it", () => {
  assert.deepEqual(renameOf("web/src/{conn.ts => connection.ts}"), { from: "web/src/conn.ts", to: "web/src/connection.ts" });
  assert.deepEqual(renameOf("docs/old-notes.md => docs/archive/notes.md"), { from: "docs/old-notes.md", to: "docs/archive/notes.md" });
  assert.deepEqual(renameOf("a/{ => new}/b.go"), { from: "a/b.go", to: "a/new/b.go" });
  assert.deepEqual(renameOf("{old => new}/x.ts"), { from: "old/x.ts", to: "new/x.ts" });
  assert.equal(renameOf("internal/chats/manager.go"), null);
});

// ---- process v3: tiers, waits, notes by section, tokens

const TZ = 0; // the clock times below are UTC
const say = (parts: ReturnType<typeof turnStart>) => partsText(parts, TZ);

test("what a turn read: each thing once; a wait is no read", () => {
  const reads = turnReads(turn(2, 0, 1, [{ op: "get_task", task: "T03" }, { op: "get_task", task: "T05" }, { op: "get_run" }, { op: "add_task", task: "T09" }, { op: "get_task", task: "T03" },
    { op: "get_notes" }, { op: "get_agent", agent: "T03-work" }, { op: "get_run" }, { op: "get_task", task: "T77", error: "no task T77" }]));
  assert.deepEqual(reads, [{ task: "T03" }, ", ", { task: "T05" }, ", ", "the run", ", ", "the notes", ", ", "agent T03-work"]);
  assert.equal(partsText(reads), "T03, T05, the run, the notes, agent T03-work");
  assert.deepEqual(turnReads(turn(2, 0, 1, [{ op: "set_notes" }])), []);
  assert.deepEqual(turnReads(turn(2, 0, 1, [{ op: "get_run" }, { op: "wait_for", tasks: ["T02"], mode: "all" }])), ["the run"]);
});

test("why a turn started: the goal, a wait that was met, one that was not, no wait, a resume, nothing running", () => {
  const t = (over: Partial<Turn>): Turn => ({ ...turn(2, 6, 7), ...over });
  const wait = (tasks: string[], mode: "all" | "any" = "all") => ({ tasks, mode, turn: 1 });
  const clock = `${String(new Date(at(6)).getUTCHours()).padStart(2, "0")}:${String(new Date(at(6)).getUTCMinutes()).padStart(2, "0")}`;
  assert.equal(say(turnStart(t({ reason: "start", idle: true }))), "The goal");
  // a wait that was met: its tasks are parts (chips), the moment is one too
  assert.deepEqual(turnStart(t({ reason: "wait", wait: wait(["T03", "T05"]), waitMet: true })), ["Waited for all of ", { task: "T03" }, " ", { task: "T05" }, ": met at ", { at: at(6) }]);
  assert.equal(say(turnStart(t({ reason: "wait", wait: wait(["T03", "T05"]), waitMet: true }))), `Waited for all of T03 T05: met at ${clock}`);
  assert.equal(say(turnStart(t({ reason: "wait", wait: wait(["T03", "T05"], "any"), waitMet: true }))), `Waited for any of T03 T05: met at ${clock}`);
  assert.equal(say(turnStart(t({ reason: "wait", wait: wait(["T03"]), waitMet: true }))), `Waited for T03: met at ${clock}`);
  // started early: a failed task, a chat's change, nothing left running (the timeline's causes)
  assert.equal(say(turnStart(t({ reason: "events", wait: wait(["T03", "T05"], "any"), waitMet: false, wokenBy: [ev(1, 5, "task_failed", "T05")] }))), "Waited for any of T03 T05: started early, T05 failed");
  assert.equal(say(turnStart(t({ reason: "events", wait: wait(["T03", "T05"]), waitMet: false, wokenBy: [ev(1, 5, "chat_op", "c1")] }))), "Waited for all of T03 T05: started early, a chat changed the run");
  assert.equal(say(turnStart(t({ reason: "idle", idle: true, wait: wait(["T03", "T05"]), waitMet: false }))), "Waited for all of T03 T05: started early, nothing was left running");
  assert.equal(say(turnStart(t({ reason: "events", wait: wait(["T03"]), wokenBy: [] }))), "Waited for T03: started early");
  // a turn that records no wait started under the one the turn before it declared
  const prev = turn(1, 0, 2, [{ op: "wait_for", tasks: ["T01", "T02"], mode: "all" }]);
  assert.equal(say(turnStart(t({ reason: "events", wokenBy: [ev(1, 5, "task_failed", "T02")] }), prev)), "Waited for all of T01 T02: started early, T02 failed");
  // no wait
  assert.equal(say(turnStart(t({ reason: "events", wokenBy: [ev(1, 5, "task_done", "T03")] }))), "No wait declared: T03 finished");
  assert.deepEqual(turnStart(t({ reason: "events", wokenBy: [ev(1, 5, "task_done", "T03")] })), ["No wait declared: ", { task: "T03" }, " finished"]);
  assert.equal(say(turnStart(t({ reason: "events", wokenBy: [ev(1, 5, "task_done", "T03"), ev(2, 5, "task_failed", "T05"), ev(3, 5, "task_done", "T04"), ev(4, 5, "chat_op", "c1"), ev(5, 5, "task_done", "T03")] }))),
    "No wait declared: T05 failed, T03, T04 finished, a chat changed the run");
  assert.equal(say(turnStart(t({ reason: "events", wokenBy: [] }))), "No wait declared");
  assert.equal(say(turnStart(t({ reason: "events", wokenBy: [] }), turn(1, 0, 2, [{ op: "wait_for", tasks: ["T01"], error: "no task T01" }]))), "No wait declared");
  // a resume, with or without a wait; nothing running and no wait
  assert.equal(say(turnStart(t({ reason: "resume" }))), "Resumed");
  assert.equal(say(turnStart(t({ reason: "resume", wait: wait(["T03"]), waitMet: false }))), "Resumed");
  assert.equal(say(turnStart(t({ reason: "idle" }))), "Nothing was running and nothing could start");
  assert.equal(say(turnStart(t({ reason: "events", idle: true }))), "Nothing was running and nothing could start");
});

test("then: what the turn waits for, or that it finished the run", () => {
  assert.deepEqual(turnThen(turn(2, 0, 1, [{ op: "add_task", task: "T18" }, { op: "wait_for", tasks: ["T18", "T19"], mode: "all" }])), ["waits for all of ", { task: "T18" }, " ", { task: "T19" }]);
  assert.equal(partsText(turnThen(turn(2, 0, 1, [{ op: "wait_for", tasks: ["T18", "T19"], mode: "any" }]))!), "waits for any of T18 T19");
  assert.equal(partsText(turnThen(turn(2, 0, 1, [{ op: "wait_for", tasks: ["T18"], mode: "any" }]))!), "waits for T18");
  // the last wait that was not refused
  assert.equal(partsText(turnThen(turn(2, 0, 1, [{ op: "wait_for", tasks: ["T01"] }, { op: "wait_for", tasks: ["T02", "T03"] }, { op: "wait_for", tasks: ["T99"], error: "no task T99" }]))!), "waits for all of T02 T03");
  assert.equal(partsText(turnThen(turn(2, 0, 1, [{ op: "wait_for", tasks: ["T01"] }, { op: "finish_run", outcome: "achieved" }]))!), "finished the run");
  assert.equal(partsText(turnThen(turn(2, 0, 1, [{ op: "finish_run", error: "T01 is running" }, { op: "wait_for", tasks: ["T01"] }]))!), "waits for T01");
  assert.equal(turnThen(turn(2, 0, 1, [{ op: "get_run" }, { op: "set_notes", notesVersion: 2 }])), null);
  assert.equal(turnThen(turn(2, 0, 1, [{ op: "wait_for", tasks: [] }])), null);
  assert.equal(turnThen(turn(2, 0, 1, [{ op: "finish_run", error: "T01 is running" }])), null);
});

test("a turn that left the plan as it was says so, with its cost when that is known", () => {
  const quiet = turn(2, 0, 1, [{ op: "get_run" }, { op: "edit_notes", heading: "Plan", notesVersion: 2 }, { op: "wait_for", tasks: ["T01"] }, { op: "add_task", error: "no task T99 to depend on" }]);
  assert.equal(turnKept(quiet, 0.42), "left the plan as it was · $0.42");
  assert.equal(turnKept(quiet, null), "left the plan as it was");
  assert.equal(turnKept(quiet, undefined), "left the plan as it was");
  assert.equal(turnKept(turn(2, 0, 1), 0), "left the plan as it was · $0.00");
  for (const o of ["add_task", "update_task", "cancel_task", "retry_task", "finish_run"]) assert.equal(turnKept(turn(2, 0, 1, [{ op: o as Op["op"], task: "T01" }]), 1), null, o);
  // a turn that still runs, or failed, may not have had its say
  assert.equal(turnKept(turn(2, 0, null, [{ op: "get_run" }]), 1), null);
  assert.equal(turnKept({ ...quiet, status: "failed" }, 1), null);
});

test("the calls of v3 as sentences: a section edit, a rewrite, a wait, a tier", () => {
  assert.equal(opSentence(op({ op: "edit_notes", heading: "Decisions", notesVersion: 12 })), "edited notes § Decisions → v12");
  assert.equal(opSentence(op({ op: "edit_notes", heading: "## Decisions", notesVersion: 12 })), "edited notes § Decisions → v12");
  assert.equal(opSentence(op({ op: "edit_notes", notesVersion: 12 })), "edited notes → v12");
  assert.equal(opSentence(op({ op: "edit_notes", heading: "Plan" })), "edited notes § Plan");
  assert.equal(opSentence(op({ op: "set_notes", notesVersion: 13 })), "rewrote the notes → v13");
  assert.equal(opSentence(op({ op: "edit_notes", chat: "c1", heading: "Plan", notesVersion: 4 })), "a chat edited notes § Plan → v4");
  assert.equal(opSentence(op({ op: "edit_notes", heading: "Gone", error: "no section Gone" })), "edit notes was refused · no section Gone");
  // as a line of a turn's list the section is set apart and the version is a link
  assert.deepEqual(callLine(op({ op: "edit_notes", heading: "Decisions", notesVersion: 12 })), { glyph: "≡", tone: "orch", parts: ["edited notes", " § ", { em: "Decisions" }, " → ", { notes: 12 }] });
  assert.deepEqual(callLine(op({ op: "set_notes", notesVersion: 13 })), { glyph: "≡", tone: "orch", parts: ["rewrote the notes", " → ", { notes: 13 }] });
  assert.equal(partsText(callLine(op({ op: "set_notes", chat: "c1", notesVersion: 5 })).parts), "a chat rewrote the notes → v5");
  assert.equal(sectionName("###  Open questions "), "Open questions");
  // a wait
  assert.equal(opSentence(op({ op: "wait_for", tasks: ["T18", "T19"], mode: "all" })), "waits for all of T18, T19");
  assert.equal(opSentence(op({ op: "wait_for", tasks: ["T18", "T19"] })), "waits for all of T18, T19");
  assert.equal(opSentence(op({ op: "wait_for", tasks: ["T18", "T19"], mode: "any" })), "waits for any of T18, T19");
  assert.equal(opSentence(op({ op: "wait_for", tasks: ["T18"], mode: "any" })), "waits for T18");
  assert.equal(opSentence(op({ op: "wait_for", tasks: [] })), "waits for nothing");
  assert.equal(opSentence(op({ op: "wait_for", tasks: ["T99"], error: "no task T99" })), "wait for was refused · no task T99");
  assert.deepEqual(opLine(op({ op: "wait_for", tasks: ["T18", "T19"], mode: "all" })), { glyph: "·", tone: "muted", parts: ["waits for all of ", { task: "T18" }, ", ", { task: "T19" }] });
  assert.deepEqual([isWrite(op({ op: "edit_notes" })), isWrite(op({ op: "wait_for", tasks: ["T02"] })), isWrite(op({ op: "wait_for", error: "no" }))], [true, false, true]);
  // a tier
  assert.equal(opSentence(op({ op: "add_task", task: "T18", title: "Fix the picker", tier: "deep", dependsOn: ["T03"] })), "added T18 at deep: Fix the picker ← T03");
  assert.equal(opSentence(op({ op: "add_task", task: "T18", title: "Fix the picker", tier: "light", tierReason: "A one-line change.", needsReport: ["T03"] })), "added T18 at light: Fix the picker · A one-line change.");
  assert.equal(opSentence(op({ op: "add_task", task: "T18", tier: "standard" })), "added T18 at standard");
  assert.equal(opSentence(op({ op: "retry_task", task: "T03", tier: "deep", attempt: 2, reason: "It ran out of time on standard." })), "retried T03 at deep (attempt 2) · It ran out of time on standard.");
  assert.equal(opSentence(op({ op: "retry_task", task: "T03", tier: "deep" })), "retried T03 at deep");
  assert.equal(opSentence(op({ op: "add_task", chat: "c1", task: "T18", title: "Docs", tier: "light" })), "a chat added T18 at light: Docs");
  assert.equal(opSentence(op({ op: "update_task", task: "T11", changed: ["tier", "tier_reason", "needs_report"] })), "changed T11: tier, reason for the tier, full reports");
});

test("a task's history says the tier and the reports it is given", () => {
  const d = base({ turns: [turn(1, 0, 2, [{ op: "add_task", task: "T05", tier: "standard", tierReason: "An ordinary change.", dependsOn: ["T02"] }]),
    turn(2, 5, 6, [{ op: "update_task", task: "T05", changed: ["tier", "needs_report"], tier: "deep", needsReport: ["T02"] }, { op: "update_task", task: "T05", changed: ["needs_report"] }, { op: "retry_task", task: "T05", tier: "deep", attempt: 2, reason: "again" }])] });
  assert.deepEqual(taskHistory(d, "T05").map((r) => partsText(r.parts) + (r.note ? " · " + r.note : "")),
    ["added it at standard ← T02 · An ordinary change.", "changed: tier (now deep), full reports (now T02)", "changed: full reports (now none)", "retried at deep (attempt 2) · again"]);
});

test("a version of the notes: the call that made it, and its line", () => {
  const d = base({
    turns: [turn(1, 0, 2, [{ op: "set_notes", notesVersion: 1 }]), turn(9, 20, 21, [{ op: "get_notes" }, { op: "edit_notes", heading: "## Decisions", notesVersion: 12 }, { op: "edit_notes", heading: "Gone", notesVersion: 14, error: "no section Gone" }]),
      turn(10, 30, 31, [{ op: "set_notes", notesVersion: 13 }, { op: "edit_notes", notesVersion: 15 }])],
    chatOps: [{ i: 0, t: at(40), op: "edit_notes", chat: "c1", heading: "Risks", notesVersion: 16 }, { i: 1, t: at(41), op: "set_notes", chat: "c1", notesVersion: 17 }],
  });
  assert.deepEqual(notesChange(d, 12), { kind: "edit", heading: "Decisions", turn: 9 });
  assert.deepEqual(notesChange(d, 13), { kind: "rewrite", turn: 10 });
  assert.deepEqual(notesChange(d, 16), { kind: "edit", heading: "Risks", chat: "c1" });
  assert.equal(notesChange(d, 14), null); // a refused call wrote nothing
  assert.equal(notesChange(d, 99), null);
  assert.equal(notesChange({ turns: [], chatOps: [] }, 1), null);
  const line = (v: number, n: { turn?: number; chat?: string } = {}) => partsText(notesLine({ v, ...n }, notesChange(d, v)));
  assert.equal(line(12, { turn: 9 }), "v12 · turn 9 edited § Decisions");
  assert.deepEqual(notesLine({ v: 12, turn: 9 }, notesChange(d, 12)), ["v12 · ", "turn 9 ", "edited § ", { em: "Decisions" }]);
  assert.equal(line(13, { turn: 10 }), "v13 · turn 10 rewrote the notes");
  assert.equal(line(1), "v1 · turn 1 rewrote the notes");
  assert.equal(line(15), "v15 · turn 10 edited a section");
  assert.equal(line(16, { chat: "c1" }), "v16 · a chat edited § Risks");
  assert.deepEqual(notesLine({ v: 17, chat: "c1" }, notesChange(d, 17)), ["v17 · ", { chat: "c1" }, " ", "rewrote the notes"]);
  // a version no recorded call made says what its own record does
  assert.equal(line(99, { turn: 4 }), "v99 · written in turn 4");
  assert.equal(line(99, { chat: "c1" }), "v99 · written from a chat");
  assert.equal(line(99), "v99 · written");
});

test("tokens: 950, 400k, 1.4M; an agent's line leaves out what is not known", () => {
  assert.deepEqual([0, 950, 999, 1000, 1499, 41_000, 400_000, 999_499, 999_500, 1_400_000, 2_000_000, 2_140_000].map(fmtTokens), ["0", "950", "999", "1k", "1k", "41k", "400k", "999k", "1M", "1.4M", "2M", "2.1M"]);
  const tokens = { in: 41_000, out: 18_000, cacheRead: 2_100_000, cacheWrite: 160_000 };
  assert.equal(tokenLine({ tokens, peakContext: 96_000 }), "in 41k · out 18k · cache 2.1M read / 160k written · peak 96k");
  assert.equal(tokenLine({ tokens, peakContext: 0 }), "in 41k · out 18k · cache 2.1M read / 160k written");
  assert.equal(tokenLine({ tokens }), "in 41k · out 18k · cache 2.1M read / 160k written");
  assert.equal(tokenLine({ tokens: null, peakContext: 96_000 }), "peak 96k");
  assert.equal(tokenLine({ tokens: null }), "");
});

test("a model and effort in the catalogue's words", () => {
  const models = [{ id: "opus", label: "Opus 5.5", efforts: ["high", "max"] }, { id: "gpt", label: "GPT-5.4", efforts: ["medium"], effortLabels: { medium: "Balanced" } }];
  assert.equal(choiceLabel({ model: "opus", effort: "max" }, models), "Opus 5.5 · Max");
  assert.equal(choiceLabel({ model: "gpt", effort: "medium" }, models), "GPT-5.4 · Balanced");
  assert.equal(choiceLabel({ model: "opus" }, models), "Opus 5.5");
  assert.equal(choiceLabel({ model: "unknown-model", effort: "high" }, models), "unknown-model · High");
  assert.equal(choiceLabel({ model: "unknown-model", effort: "high" }), "unknown-model · High");
  assert.equal(choiceLabel(agent("a1", { model: "opus", effort: "high" }), models), "Opus 5.5 · High");
  assert.equal(choiceLabel(null, models), ""); assert.equal(choiceLabel({ model: "" }, models), "");
});
