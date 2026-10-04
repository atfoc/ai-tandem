import { test } from "node:test";
import assert from "node:assert/strict";
import { composerControls, isBusy, isWorking, workingOn } from "../src/logic/status.ts";
import type { Status } from "../src/types.ts";

const BUSY: Status[] = ["thinking", "writing", "tool", "approval"];
const QUIET: Status[] = ["ready", "stopped", "error"];

test("isBusy: the agent is in a turn or waits for approval", () => {
  for (const s of BUSY) assert.equal(isBusy(s), true, s);
  for (const s of QUIET) assert.equal(isBusy(s), false, s);
  assert.equal(isBusy(undefined), false);
});

test("isWorking: busy, or subagents running; results not sent yet do not count", () => {
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
});
