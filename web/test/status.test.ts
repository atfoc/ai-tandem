import { test } from "node:test";
import assert from "node:assert/strict";
import { chatBusy, composerControls, isBusy, isWorking, refreshAfterRefusal, starting, workingBranches, workingOn } from "../src/logic/status.ts";
import type { BranchState, Status } from "../src/types.ts";

const BUSY: Status[] = ["thinking", "writing", "tool", "approval"];
const QUIET: Status[] = ["ready", "stopped", "error"];
const rec = (chat: string, branch: string, status: Status, subsRunning?: number): BranchState =>
  ({ chat, branch, cwd: "", model: "", locked: false, usage: { turns: 0 } as BranchState["usage"], status, subsRunning });

test("isBusy: the agent is in a turn or waits for approval", () => {
  for (const s of BUSY) assert.equal(isBusy(s), true, s);
  for (const s of QUIET) assert.equal(isBusy(s), false, s);
  assert.equal(isBusy(undefined), false);
});

test("chatBusy: some branch of the chat is in a turn or waits for approval", () => {
  // views without `working` (none working, or an older server): the current branch's status
  for (const s of BUSY) assert.equal(chatBusy({ status: s }), true, s);
  for (const s of QUIET) assert.equal(chatBusy({ status: s }), false, s);
  // another branch works while the current one is idle, stopped or can't start
  for (const s of QUIET) assert.equal(chatBusy({ status: s, working: 1 }), true, s);
  assert.equal(chatBusy({ status: "ready", working: 0 }), false);
  assert.equal(chatBusy({ status: "writing", working: 2 }), true);
});

test("workingBranches: the busy records, and the idle ones whose subagents run", () => {
  const states = [rec("c", "main", "ready"), rec("c", "b1", "tool"), rec("c", "b2", "ready", 1), rec("c", "b3", "approval", 2), rec("c", "b4", "stopped"), rec("c", "b5", "ready", 0)];
  assert.deepEqual(workingBranches(states).map((s) => s.branch), ["b1", "b2", "b3"]);
  assert.deepEqual(workingBranches([rec("c", "main", "ready"), rec("c", "b1", "error")]), []);
  assert.deepEqual(workingBranches([]), []);
});

test("isWorking: busy, or subagents running; results not sent yet do not count", () => {
  // a branch that is not the current one works
  assert.equal(isWorking({ status: "ready", working: 2 }), true);
  assert.equal(isWorking({ status: "stopped", working: 1 }), true);
  assert.equal(isWorking({ status: "ready", working: 0 }), false);
  // a branch that is not the current one is idle with running subagents: only the records tell
  assert.equal(isWorking({ status: "ready" }, [rec("c", "main", "ready"), rec("c", "b1", "ready", 1)]), true);
  assert.equal(isWorking({ status: "ready" }, [rec("c", "main", "ready"), rec("c", "b1", "ready")]), false);
  assert.equal(isWorking({ status: "ready" }, []), false);
  // the view still counts when the records are given
  assert.equal(isWorking({ status: "ready", subsRunning: 1 }, []), true);
  assert.equal(isWorking({ status: "thinking" }, [rec("c", "main", "ready")]), true);
  for (const s of BUSY) assert.equal(isWorking({ status: s }), true, s);
  for (const s of QUIET) assert.equal(isWorking({ status: s }), false, s);
  assert.equal(isWorking({ status: "ready", subsRunning: 1 }), true);
  assert.equal(isWorking({ status: "ready", subsRunning: 0 }), false);
  assert.equal(isWorking({ status: "ready", subsOwed: 2 }), false);
  assert.equal(isWorking({ status: "ready", subsRunning: 1, subsOwed: 2 }), true);
  assert.equal(isWorking({ status: "tool", subsRunning: 3 }), true);
});

test("workingOn: the chats a board's archive and delete confirmations warn about and stop", () => {
  const chats = [
    { id: "busy", board: "b1", status: "thinking" as Status },
    { id: "waiting", board: "b1", status: "ready" as Status, subsRunning: 2 },
    { id: "owed", board: "b1", status: "ready" as Status, subsOwed: 1 },
    { id: "idle", board: "b1", status: "ready" as Status },
    { id: "archived", board: "b1", status: "ready" as Status, subsRunning: 1, archived: true },
    { id: "elsewhere", board: "b2", status: "ready" as Status, subsRunning: 1 },
    { id: "plain", status: "tool" as Status },
  ];
  assert.deepEqual(workingOn(chats, "b1").map((c) => c.id), ["busy", "waiting"]);
  assert.deepEqual(workingOn(chats, "b2").map((c) => c.id), ["elsewhere"]);
  assert.deepEqual(workingOn(chats, "b3"), []);
  // every branch counts: two branches working with an idle current one, and a branch that is not
  // the current one idle with running subagents (from the records)
  const more = [
    ...chats,
    { id: "others", board: "b1", status: "ready" as Status, working: 2 },
    { id: "subs", board: "b1", status: "ready" as Status },
    { id: "quiet", board: "b1", status: "ready" as Status },
    { id: "gone", board: "b1", status: "ready" as Status, working: 1, archived: true },
  ];
  const records: Record<string, BranchState[]> = {
    subs: [rec("subs", "main", "ready"), rec("subs", "b1", "ready", 1)],
    quiet: [rec("quiet", "main", "ready"), rec("quiet", "b1", "stopped")],
    gone: [rec("gone", "main", "ready"), rec("gone", "b1", "tool")],
  };
  const statesOf = (chat: string) => records[chat] ?? [];
  assert.deepEqual(workingOn(more, "b1", statesOf).map((c) => c.id), ["busy", "waiting", "others", "subs"]);
  assert.deepEqual(workingOn(more, "b1").map((c) => c.id), ["busy", "waiting", "others"]); // without the records, the views
  assert.deepEqual(workingOn(chats, "b1", statesOf).map((c) => c.id), ["busy", "waiting"]);
});

test("composerControls: Stop shows while subagents run; Send and Esc follow the agent", () => {
  // idle, nothing running: as before
  assert.deepEqual(composerControls({ status: "ready" }), { stop: false, blocked: false, esc: false });
  assert.deepEqual(composerControls({ status: "ready", subsRunning: 0 }), { stop: false, blocked: false, esc: false });
  // idle and waiting on subagents: Stop shows, a message can still be sent, Esc does nothing
  assert.deepEqual(composerControls({ status: "ready", subsRunning: 1 }), { stop: true, blocked: false, esc: false });
  // results not sent yet give nothing to stop
  assert.deepEqual(composerControls({ status: "ready", subsOwed: 2 }), { stop: false, blocked: false, esc: false });
  assert.deepEqual(composerControls({ status: "stopped", subsOwed: 1 }), { stop: false, blocked: false, esc: false });
  // busy: as before, with or without subagents
  for (const s of BUSY) {
    assert.deepEqual(composerControls({ status: s }), { stop: true, blocked: true, esc: true }, s);
    assert.deepEqual(composerControls({ status: s, subsRunning: 2 }), { stop: true, blocked: true, esc: true }, s);
  }
  // other branches of the chat work, the branch shown is idle: nothing to stop here, a message can be sent
  const view = { status: "ready" as Status, working: 2 };
  assert.deepEqual(composerControls(view), { stop: false, blocked: false, esc: false });
  // no pending move: the options change nothing
  for (const liveFork of [false, true]) {
    assert.deepEqual(composerControls({ status: "ready" }, { newBranch: false, liveFork }), { stop: false, blocked: false, esc: false });
    for (const s of BUSY) assert.deepEqual(composerControls({ status: s }, { newBranch: false, liveFork }), { stop: true, blocked: true, esc: true }, s);
  }
});

test("composerControls: a message that starts a new branch is sent while the source runs, when the agent kind can", () => {
  for (const s of BUSY) {
    // the source's own Stop and Esc stay; only Send is free
    assert.deepEqual(composerControls({ status: s }, { newBranch: true, liveFork: true }), { stop: true, blocked: false, esc: true }, s);
    assert.deepEqual(composerControls({ status: s, subsRunning: 1 }, { newBranch: true, liveFork: true }), { stop: true, blocked: false, esc: true }, s);
    // an agent kind that cannot branch from a running source waits for the turn's end
    assert.deepEqual(composerControls({ status: s }, { newBranch: true, liveFork: false }), { stop: true, blocked: true, esc: true }, s);
  }
  // a source at rest: as without a move
  for (const liveFork of [false, true]) {
    assert.deepEqual(composerControls({ status: "ready" }, { newBranch: true, liveFork }), { stop: false, blocked: false, esc: false });
    assert.deepEqual(composerControls({ status: "ready", subsRunning: 1 }, { newBranch: true, liveFork }), { stop: true, blocked: false, esc: false });
  }
});

test("composerControls: while the agent of a fork without a message starts, no Stop, no Esc, no Send", () => {
  for (const s of BUSY) {
    assert.equal(starting({ status: s, fresh: true }), true, s);
    assert.equal(starting({ status: s }), false, s);
    assert.equal(starting({ status: s, fresh: false }), false, s);
    assert.deepEqual(composerControls({ status: s, fresh: true }), { stop: false, blocked: true, esc: false }, s);
    assert.deepEqual(composerControls({ status: s, fresh: true, subsRunning: 1 }), { stop: false, blocked: true, esc: false }, s);
    for (const liveFork of [false, true]) for (const newBranch of [false, true])
      assert.deepEqual(composerControls({ status: s, fresh: true }, { newBranch, liveFork }), { stop: false, blocked: true, esc: false }, s);
    // not fresh: as before
    assert.deepEqual(composerControls({ status: s, fresh: false }), { stop: true, blocked: true, esc: true }, s);
    assert.deepEqual(composerControls({ status: s, fresh: false }, { newBranch: true, liveFork: true }), { stop: true, blocked: false, esc: true }, s);
  }
  // a fresh fork whose agent runs: as any idle chat
  for (const s of QUIET) {
    assert.equal(starting({ status: s, fresh: true }), false, s);
    assert.deepEqual(composerControls({ status: s, fresh: true }), composerControls({ status: s }), s);
  }
  assert.deepEqual(composerControls({ status: "ready", fresh: true }), { stop: false, blocked: false, esc: false });
  assert.deepEqual(composerControls({ status: "ready", fresh: true, subsRunning: 1 }), { stop: true, blocked: false, esc: false });
});

test("refreshAfterRefusal: the chat is read again after a 409 that tells of stale state", () => {
  assert.equal(refreshAfterRefusal(409), true);
  assert.equal(refreshAfterRefusal(409, undefined), true);
  assert.equal(refreshAfterRefusal(409, "busy"), true);
  assert.equal(refreshAfterRefusal(409, "window"), false);
  assert.equal(refreshAfterRefusal(409, "cap"), false);
  assert.equal(refreshAfterRefusal(429, "cap"), false);
  assert.equal(refreshAfterRefusal(429), false);
  assert.equal(refreshAfterRefusal(400), false);
  assert.equal(refreshAfterRefusal(400, "busy"), false);
});
