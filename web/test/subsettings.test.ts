// A chat's subagent settings (src/logic/subsettings.ts): what a view says of them, what the
// composer's Subagents chip and its popover show, and when the chip can be changed.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SUB_CAP, DEFAULT_SUB_DEPTH, SUB_CAPS, SUB_DEPTHS, SUB_FIXED,
  capOff, capOptions, depthLabel, depthNote, depthOptions, pickSubs, subChange, subChip, subChipLabel, subChipTitle, subSettings, subSummary,
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

test("capOptions: the five values, the current one marked", () => {
  assert.deepEqual(SUB_CAPS, [5, 10, 25, 50, 100]);
  assert.deepEqual(capOptions({ depth: 1, cap: 100 }).map((o) => o.label), ["5", "10", "25", "50", "100"]);
  for (const cap of SUB_CAPS) assert.deepEqual(capOptions({ depth: 1, cap }).filter((o) => o.on).map((o) => o.value), [cap]);
});

test("capOptions: a cap that is none of the five is listed in its place and marked", () => {
  assert.deepEqual(capOptions({ depth: 1, cap: 7 }).map((o) => [o.value, o.on]), [[5, false], [7, true], [10, false], [25, false], [50, false], [100, false]]);
  assert.deepEqual(capOptions({ depth: 1, cap: 1 }).map((o) => o.value), [1, 5, 10, 25, 50, 100]);
  assert.deepEqual(capOptions({ depth: 1, cap: 99 }).map((o) => o.value), [5, 10, 25, 50, 99, 100]);
  assert.equal(capOptions({ depth: 1, cap: 99 }).filter((o) => o.on).length, 1);
  // also while the section is greyed out
  assert.deepEqual(capOptions({ depth: 0, cap: 7 }).filter((o) => o.on).map((o) => o.label), ["7"]);
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
  assert.deepEqual(subChange({ depth: 0, cap: 25 }, "depth", 1), { subDepth: 1 });
});

test("subChip: open on a new chat alone", () => {
  assert.deepEqual(subChip(chat(), false), { kind: "open" });
  assert.deepEqual(subChip(chat({ board: "b1" }), false), { kind: "open" });
  assert.deepEqual(subChip(chat({ run: "r1" }), false), { kind: "open" }, "a user's chat on a run is an ordinary chat");
  assert.deepEqual(subChip(chat({ server: "s_1" }), false), { kind: "open" });
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

test("subChip: fixed while a first message on another server may have arrived", () => {
  assert.deepEqual(subChip(chat({ server: "s_1", start: "unconfirmed" }), false), { kind: "fixed", why: SUB_FIXED.unconfirmed });
});

test("subChip: none for a run's own agent", () => {
  assert.deepEqual(subChip(chat({ run: "r1", role: "orchestrator" as ChatView["role"] }), false), { kind: "none" });
  assert.deepEqual(subChip(chat({ run: "r1", role: "task" as ChatView["role"], locked: true }), false), { kind: "none" });
  assert.deepEqual(subChip(chat({ run: "r1", role: "task" as ChatView["role"] }), true), { kind: "none" });
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
