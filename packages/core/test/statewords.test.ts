import { test } from "node:test";
import assert from "node:assert/strict";
import { BOARD_WORDS, CHAT_WORDS, SERVER_WORDS, boardWord, chatWord, formatSince, needsAttention, needsYou, serverWord, waitingOn } from "../src/logic/statewords.ts";
import { sinceAfter } from "../src/logic/servers.ts";

test("a server's word: the goal's list, and the other states read Unreachable with their reason", () => {
  assert.equal(serverWord({ state: "connected" }), SERVER_WORDS.connected);
  assert.equal(serverWord({ state: "connecting" }).text, "Connecting…");
  assert.equal(serverWord({ state: "certificate_changed" }).text, "Certificate changed · paused");
  assert.equal(serverWord({ state: "too_old" }).tone, "warn");
  assert.equal(serverWord({ state: "unreachable" }), SERVER_WORDS.unreachable);
  assert.equal(serverWord({ state: "unreachable" }, { localNetworkDenied: true }).text, "Local network off");
  const refused = serverWord({ state: "secret_not_accepted" });
  assert.equal(refused.text, "Unreachable");
  assert.equal(refused.reason, "Secret not accepted");
  assert.equal(needsAttention({ state: "connecting" }), false);
  assert.equal(needsAttention({ state: "too_old" }), true);
});

test("a chat's word: approval first, then subagents, work, stopped and failed; idle has none", () => {
  assert.equal(chatWord({ status: "writing", approvals: 1 }), CHAT_WORDS.approval);
  assert.equal(chatWord({ status: "waiting", subsRunning: 2 })?.text, "Waiting on 2 subagents");
  assert.equal(chatWord({ status: "waiting", subsRunning: 1 })?.text, "Waiting on 1 subagent");
  assert.deepEqual(chatWord({ status: "waiting" }), CHAT_WORDS.background); // (background work, no subagent: not "Writing…")
  assert.deepEqual(chatWord({ status: "waiting", subsRunning: 0 }), { key: "background", text: "Waiting for background work", tone: "wait" });
  assert.equal(chatWord({ status: "tool" }), CHAT_WORDS.writing);
  assert.equal(chatWord({ status: "stopped" }), CHAT_WORDS.stopped);
  assert.equal(chatWord({ status: "error" }), CHAT_WORDS.failed);
  assert.equal(chatWord({ status: "ready" }), null);
  assert.equal(needsYou({ status: "error" }), true);
  assert.equal(needsYou({ status: "writing" }), false);
});

test("the goal's list: every word with its tone, so a screen cannot say it another way", () => {
  assert.deepEqual(Object.values(SERVER_WORDS).map((w) => [w.text, w.tone]), [
    ["Connected", "ok"], ["Connecting…", "wait"], ["Unreachable", "bad"], ["Offline", "bad"],
    ["Certificate changed · paused", "bad"], ["Local network off", "bad"], ["Too old", "warn"],
  ]);
  assert.deepEqual(Object.values(CHAT_WORDS).map((w) => [w.text, w.tone]), [
    ["Writing…", "ok"], ["Needs your approval", "warn"], ["Stopped", "bad"], ["Failed", "bad"],
    ["Waiting for background work", "wait"], // (the chat header's words for a turn that waits on a shell or a monitor: h2-design.md H2-5)
  ]);
  assert.deepEqual(waitingOn(3), { key: "subagents", text: "Waiting on 3 subagents", tone: "ok" });
  assert.equal(new Set([...Object.values(SERVER_WORDS), ...Object.values(CHAT_WORDS)].map((w) => w.key)).size, 12, "the keys are distinct");
});

test("the local network word shows only where the server cannot be reached; a connected, connecting, pinned or old server keeps its own", () => {
  const denied = { localNetworkDenied: true };
  for (const state of ["connected", "connecting", "certificate_changed", "too_old"] as const) assert.equal(serverWord({ state }, denied).key, serverWord({ state }).key, state);
  for (const state of ["unreachable", "not_started", "secret_not_accepted"] as const) assert.equal(serverWord({ state }, denied), SERVER_WORDS.localNetworkOff, state);
  assert.equal(serverWord({ state: "unreachable" }, { localNetworkDenied: false }), SERVER_WORDS.unreachable);
});

test("a chat that waits for approval says so over any other state, with the count or the status", () => {
  assert.equal(chatWord({ status: "approval" }), CHAT_WORDS.approval);
  assert.equal(chatWord({ status: "error", approvals: 2 }), CHAT_WORDS.approval);
  assert.equal(chatWord({ status: "ready", working: 1 }), CHAT_WORDS.writing);
  assert.equal(needsYou({ status: "approval" }), true);
  assert.equal(needsYou({ status: "waiting", subsRunning: 2 }), false);
  assert.equal(needsYou({ status: "ready" }), false);
});

// Dates are built from local fields so the tests hold in any time zone.
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

test("formatSince: the time on the same day, 'yesterday', then the date", () => {
  const now = at(2026, 10, 22, 15, 30);
  assert.equal(formatSince(at(2026, 10, 22, 9, 12), now), "since 9:12");
  assert.equal(formatSince(at(2026, 10, 22, 14, 2), now), "since 14:02");
  assert.equal(formatSince(at(2026, 10, 22, 0, 5), now), "since 0:05");
  assert.equal(formatSince(at(2026, 10, 21, 23, 59), now), "since yesterday");
  assert.equal(formatSince(at(2026, 10, 21, 0, 0), now), "since yesterday");
  assert.equal(formatSince(at(2026, 10, 20, 23, 59), now), "since Oct 20");
  assert.equal(formatSince(at(2026, 3, 1, 8, 0), now), "since Mar 1");
  assert.equal(formatSince(at(2025, 12, 31, 8, 0), now), "since Dec 31, 2025");
});

test("formatSince: just after midnight, the day before is yesterday; a time in the future reads as now", () => {
  assert.equal(formatSince(at(2026, 10, 21, 23, 58), at(2026, 10, 22, 0, 1)), "since yesterday");
  assert.equal(formatSince(at(2026, 10, 22, 18, 0), at(2026, 10, 22, 9, 0)), "since 9:00");
  assert.equal(formatSince(at(2026, 1, 1, 12, 0), at(2026, 1, 2, 12, 0)), "since yesterday");
});

test("sinceAfter: a changed state or a new entry is stamped, an unchanged one keeps its record, a removed one loses it", () => {
  const a = { id: "a", name: "A", state: "connected" as const }, b = { id: "b", name: "B", state: "connected" as const };
  const first = sinceAfter({}, [], [a, b], 10);
  assert.deepEqual(first, { a: 10, b: 10 });
  assert.equal(sinceAfter(first, [a, b], [a, b], 20), first, "the same object when nothing changed");
  assert.equal(sinceAfter(first, [a, b], [{ ...a, name: "A2" }, b], 20), first, "a rename is no change of state");
  assert.deepEqual(sinceAfter(first, [a, b], [{ ...a, state: "unreachable" }, b], 20), { a: 20, b: 10 });
  assert.deepEqual(sinceAfter(first, [a, b], [a], 20), { a: 10 });
  assert.deepEqual(sinceAfter({ a: 10 }, [a], [a, b], 30), { a: 10, b: 30 });
  assert.deepEqual(sinceAfter({}, [a], [a], 40), { a: 40 }, "an entry the record lacks is stamped when seen");
});

test("a board's word: an agent at work first, then archived, this window's role, who else writes, else view only", () => {
  const base = { role: undefined, writer: "" as const, archived: false, worker: null };
  assert.equal(boardWord(base), BOARD_WORDS.view);
  assert.equal(boardWord({ ...base, role: "other" }), BOARD_WORDS.view);
  assert.equal(boardWord({ ...base, role: "held", writer: "window" }), BOARD_WORDS.editing);
  assert.equal(boardWord({ ...base, role: "taking" }), BOARD_WORDS.taking);
  assert.equal(boardWord({ ...base, role: "other", writer: "window" }), BOARD_WORDS.taken);
  assert.equal(boardWord({ ...base, role: "other", writer: "headless" }), BOARD_WORDS.agent);
  assert.equal(boardWord({ ...base, role: "lost" }), BOARD_WORDS.taken, "a lost board is another window's");
  assert.equal(boardWord({ ...base, role: "lost", writer: "headless" }), BOARD_WORDS.agent, "unless an agent has it by now");
  assert.equal(boardWord({ ...base, archived: true }), BOARD_WORDS.archived);
  assert.equal(boardWord({ ...base, archived: true, role: "held" }), BOARD_WORDS.archived);
});

test("an agent at work replaces the board's other words, with the agent's short name", () => {
  const w = boardWord({ role: "other", writer: "window", archived: false, worker: "claude" });
  assert.deepEqual(w, { key: "working", text: "Claude is working…", tone: "ok" });
  assert.equal(boardWord({ role: "held", writer: "window", archived: false, worker: "cursor" }).text, "Cursor is working…");
  assert.equal(boardWord({ role: undefined, writer: "", archived: false, worker: "mystery" }).text, "mystery is working…");
});

test("the board's words: texts and tones, with distinct keys", () => {
  assert.deepEqual(Object.values(BOARD_WORDS).map((w) => w.text), [
    "View only", "Taking over…", "Editing", "Another window is editing", "An agent is editing", "Archived · read-only",
    "Picking a point", "Selecting for the chat",
  ]);
  assert.equal(new Set(Object.values(BOARD_WORDS).map((w) => w.key)).size, 8);
});
