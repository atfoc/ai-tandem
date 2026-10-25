// A chat's subagent settings (src/logic/subsettings.ts): what a view says of them, what the
// composer's Subagents chip and its popover show, and when the chip can be changed.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SUB_CAP, DEFAULT_SUB_DEPTH, SUB_CAP_MAX, SUB_CAP_MIN, SUB_DEPTHS, SUB_FIXED,
  capOff, clampCap, depthLabel, depthNote, depthOptions, pickSubs, subChange, subChip, subChipLabel, subChipTitle, subSettings, subSummary,
  type SubChange,
} from "../src/logic/subsettings.ts";
import { viewOf } from "../src/logic/branches.ts";
import type { BranchState, ChatView } from "../src/types.ts";

const chat = (o: Partial<ChatView> = {}) => ({ id: "c1", agent: "claude", locked: false, status: "ready", usage: { ctxIn: 0, ctxOut: 0, ctxWindow: 0, turns: 0 }, ...o }) as ChatView;

test("subSettings: a view with none of the three fields is depth 1 and cap 100", () => {
  assert.deepEqual(subSettings({}), { depth: 1, cap: 100 });
  assert.deepEqual(subSettings(chat()), { depth: DEFAULT_SUB_DEPTH, cap: DEFAULT_SUB_CAP });
});

test("subSettings: the depth and the cap a view names; Off is its own field", () => {
  assert.deepEqual(subSettings({ subDepth: 3, subCap: 25 }), { depth: 3, cap: 25 });
  assert.deepEqual(subSettings({ subDepth: 2 }), { depth: 2, cap: 100 });
  assert.deepEqual(subSettings({ subCap: 1 }), { depth: 1, cap: 1 });
  assert.deepEqual(subSettings({ subOff: true, subCap: 10 }), { depth: 0, cap: 10 });
  assert.deepEqual(subSettings({ subOff: true }), { depth: 0, cap: 100 });
  assert.deepEqual(subSettings({ subOff: true, subDepth: 2 }), { depth: 0, cap: 100 }, "Off wins over a depth sent with it");
  assert.deepEqual(subSettings({ subOff: false, subDepth: 2 }), { depth: 2, cap: 100 });
  // a zero is an absent field, as the server reads its own view
  assert.deepEqual(subSettings({ subDepth: 0, subCap: 0 }), { depth: 1, cap: 100 });
});

test("subSettings: the view of a branch shown has the chat's settings", () => {
  const c = chat({ subDepth: 2, subCap: 10, locked: true });
  const st = { chat: "c1", branch: "b1", cwd: "/x", model: "m", locked: true, usage: c.usage, status: "ready" } as BranchState;
  assert.deepEqual(subSettings(viewOf(c, st)), { depth: 2, cap: 10 });
  assert.deepEqual(subSettings(viewOf(c, undefined)), { depth: 2, cap: 10 }, "a branch not loaded yet");
});

test("depthLabel and depthNote", () => {
  assert.deepEqual(SUB_DEPTHS.map(depthLabel), ["Off", "1 level", "2 levels", "3 levels"]);
  assert.equal(depthNote(0), "The agent gets no subagent tools");
  assert.equal(depthNote(1), "The agent can start subagents; they cannot start their own");
  assert.equal(depthNote(2), "Subagents can start subagents of their own, down to level 2");
  assert.equal(depthNote(3), "Subagents can start subagents of their own, down to level 3");
});

test("subChipLabel: always the depth, the cap only when it is not 100", () => {
  assert.equal(subChipLabel({ depth: 1, cap: 100 }), "1 level");
  assert.equal(subChipLabel({ depth: 3, cap: 100 }), "3 levels");
  assert.equal(subChipLabel({ depth: 1, cap: 25 }), "1 level · 25 at once");
  assert.equal(subChipLabel({ depth: 2, cap: 7 }), "2 levels · 7 at once");
  assert.equal(subChipLabel({ depth: 0, cap: 100 }), "Off");
  assert.equal(subChipLabel({ depth: 0, cap: 25 }), "Off", "with depth Off nothing runs: no cap");
});

test("subSummary and subChipTitle: both settings in words, then when they can be changed", () => {
  assert.equal(subSummary({ depth: 1, cap: 100 }), "1 level, at most 100 running at once");
  assert.equal(subSummary({ depth: 3, cap: 5 }), "3 levels, at most 5 running at once");
  assert.equal(subSummary({ depth: 0, cap: 5 }), "Off: the agent gets no subagent tools");
  assert.equal(subChipTitle({ depth: 2, cap: 10 }, SUB_FIXED.started), "Subagents — 2 levels, at most 10 running at once — fixed once the chat has started");
  assert.equal(subChipTitle({ depth: 0, cap: 10 }, "can be changed until you send the first message"),
    "Subagents — Off: the agent gets no subagent tools — can be changed until you send the first message");
});

test("depthOptions: Off and the three levels, the current one marked", () => {
  assert.deepEqual(depthOptions({ depth: 1, cap: 100 }), [
    { value: 0, label: "Off", on: false }, { value: 1, label: "1 level", on: true },
    { value: 2, label: "2 levels", on: false }, { value: 3, label: "3 levels", on: false },
  ]);
  assert.deepEqual(depthOptions({ depth: 0, cap: 100 }).filter((o) => o.on).map((o) => o.label), ["Off"]);
  assert.deepEqual(depthOptions({ depth: 3, cap: 100 }).filter((o) => o.on).map((o) => o.label), ["3 levels"]);
  // a depth a newer server allows is still shown as the current one
  assert.deepEqual(depthOptions({ depth: 4, cap: 100 }).map((o) => [o.label, o.on]), [["Off", false], ["1 level", false], ["2 levels", false], ["3 levels", false], ["4 levels", true]]);
});

test("the cap's range is 1 to 100 and the default is its right end; a cap set by an API client reads as it is", () => {
  assert.equal(SUB_CAP_MIN, 1);
  assert.equal(SUB_CAP_MAX, 100);
  assert.equal(DEFAULT_SUB_CAP, SUB_CAP_MAX);
  for (const cap of [1, 3, 37, 99, 100]) assert.deepEqual(subSettings({ subCap: cap }), { depth: 1, cap });
  assert.equal(subChipLabel(subSettings({ subCap: 3 })), "1 level · 3 at once");
});

test("clampCap: a whole number from 1 to 100", () => {
  assert.deepEqual([1, 37, 100, 0, -5, 101, 250, 36.6, 36.4].map(clampCap), [1, 37, 100, 1, 1, 100, 100, 37, 36]);
});

test("capOff: the Running at once section takes no pick with depth Off", () => {
  assert.equal(capOff({ depth: 0, cap: 100 }), true);
  for (const depth of [1, 2, 3]) assert.equal(capOff({ depth, cap: 100 }), false);
});

test("subChange: what a pick sends; nothing for the current value, or for a cap with depth Off", () => {
  const s = { depth: 1, cap: 100 };
  assert.deepEqual(subChange(s, "depth", 2), { subDepth: 2 });
  assert.deepEqual(subChange(s, "depth", 0), { subDepth: 0 }, "Off is sent as 0");
  assert.equal(subChange(s, "depth", 1), null);
  assert.deepEqual(subChange(s, "cap", 25), { subCap: 25 });
  assert.equal(subChange(s, "cap", 100), null);
  assert.equal(subChange({ depth: 0, cap: 100 }, "cap", 25), null);
  assert.equal(subChange({ depth: 0, cap: 25 }, "cap", 3), null, "with depth Off a cap saves nothing");
  assert.deepEqual(subChange({ depth: 0, cap: 25 }, "depth", 1), { subDepth: 1 });
});

test("subChange: the cap is any whole number from 1 to 100, rounded and held to the ends; the current cap saves nothing", () => {
  const s = { depth: 2, cap: 100 };
  for (const cap of [1, 37, 99]) assert.deepEqual(subChange(s, "cap", cap), { subCap: cap });
  assert.equal(subChange(s, "cap", 100), null);
  assert.deepEqual(subChange(s, "cap", 0), { subCap: 1 });
  assert.deepEqual(subChange(s, "cap", 101), null, "101 is held to 100, the current cap");
  assert.deepEqual(subChange({ depth: 2, cap: 50 }, "cap", 101), { subCap: 100 });
  assert.deepEqual(subChange(s, "cap", 36.6), { subCap: 37 });
  assert.equal(subChange({ depth: 2, cap: 37 }, "cap", 36.6), null, "36.6 is 37");
  assert.equal(subChange({ depth: 2, cap: 1 }, "cap", 0), null, "0 is 1");
  assert.equal(subChange(s, "cap", Number.NaN), null);
  assert.equal(subChange({ depth: 0, cap: 100 }, "cap", 37), null);
  assert.deepEqual(subChange({ depth: 0, cap: 100 }, "depth", 2), { subDepth: 2 });
});

test("subChip: open on a new chat alone", () => {
  assert.deepEqual(subChip(chat(), false), { kind: "open" });
  assert.deepEqual(subChip(chat({ board: "b1" }), false), { kind: "open" });
  assert.deepEqual(subChip(chat({ id: "s_1~c_1" }), false), { kind: "open" });
  assert.deepEqual(subChip(chat({ agent: "" }), false), { kind: "open" });
});

test("subChip: fixed on a started chat, a branch and a fork, with the reason", () => {
  assert.deepEqual(subChip(chat({ locked: true }), false), { kind: "fixed", why: SUB_FIXED.started });
  assert.deepEqual(subChip(chat({ locked: true, branches: 3 }), false), { kind: "fixed", why: SUB_FIXED.started });
  assert.deepEqual(subChip(chat({ locked: true, branch: "ab12" }), false), { kind: "fixed", why: SUB_FIXED.copy });
  assert.deepEqual(subChip(chat({ locked: true, forkedFrom: "c0" }), false), { kind: "fixed", why: SUB_FIXED.copy });
  // a fork without a message of its own: its model and effort are open, these are not
  assert.deepEqual(subChip(chat({ locked: true, fresh: true, forkedFrom: "c0" }), false), { kind: "fixed", why: SUB_FIXED.copy });
  assert.deepEqual(subChip(chat({ locked: false, fresh: true, forkedFrom: "c0" }), false), { kind: "fixed", why: SUB_FIXED.copy });
  // a move to a new branch is pending: the next message starts a branch
  assert.deepEqual(subChip(chat({ locked: true }), true), { kind: "fixed", why: SUB_FIXED.copy });
  assert.deepEqual(subChip(chat(), true), { kind: "fixed", why: SUB_FIXED.copy });
  assert.deepEqual(subChip(chat({ branches: 2 }), false), { kind: "fixed", why: SUB_FIXED.copy });
});

test("subChip: a chat of a section is as one of this computer: open until it starts, fixed after, with the same reasons", () => {
  assert.deepEqual(subChip(chat({ id: "s_1~c_1" }), false), { kind: "open" });
  assert.deepEqual(subChip(chat({ id: "s_1~c_1", board: "s_1~b_1" }), false), { kind: "open" });
  assert.deepEqual(subChip(chat({ id: "s_1~c_1", locked: true }), false), { kind: "fixed", why: SUB_FIXED.started });
  assert.deepEqual(subChip(chat({ id: "s_1~c_1", locked: true, forkedFrom: "s_1~c_0" }), false), { kind: "fixed", why: SUB_FIXED.copy });
  assert.deepEqual(Object.keys(SUB_FIXED), ["started", "copy"]);
});

test("pickSubs: sends the change alone and takes the chat the server answers with", async () => {
  const sent: SubChange[] = [], taken: ChatView[] = [];
  const answer = chat({ subDepth: 2 });
  await pickSubs(async (p) => { sent.push(p); return { chat: answer }; }, { subDepth: 2 }, (c) => taken.push(c));
  assert.deepEqual(sent, [{ subDepth: 2 }]);
  assert.deepEqual(taken, [answer]);
  // an answer with no chat: the `chat` event brings the change
  await pickSubs(async () => ({}), { subCap: 5 }, (c) => taken.push(c));
  assert.equal(taken.length, 1);
});

test("pickSubs: a refusal is thrown to the caller, and nothing is taken", async () => {
  const taken: ChatView[] = [];
  await assert.rejects(pickSubs(async () => { throw new Error("the chat has started: its subagent settings are fixed"); }, { subCap: 5 }, (c) => taken.push(c)),
    /its subagent settings are fixed/);
  assert.equal(taken.length, 0);
});
