import { test } from "node:test";
import assert from "node:assert/strict";
import { messageButtons, threadTree, viewFor } from "../src/logic/forkmessage.ts";
import { messageActions } from "../src/logic/forkpoints.ts";
import { markerAt } from "../src/logic/forktree.ts";
import type { AgentKind, Item, TreeView } from "../src/types.ts";

type Items = (Item | undefined)[];

const mUser = (text = "u"): Item => ({ kind: "user", text });
const mText = (text = "t"): Item => ({ kind: "text", text, done: true });
const mOpen = (): Item => ({ kind: "text", text: "t" });
const mTool = (): Item => ({ kind: "tool", toolId: "t1", name: "Read", result: "ok" });
const mNote = (): Item => ({ kind: "note", tone: "muted", text: "Stopped." });
const mEnd = (point?: string): Item => ({ kind: "end", point });

/** Two finished turns, the second with a tool call between two replies. */
const twoTurns = (): Items => [mUser(), mText(), mEnd("p1"), mUser(), mText(), mTool(), mText(), mEnd("p2")];

/** The texts of the buttons of the message at index. */
const texts = (items: Items, index: number, p: { busy?: boolean; readOnly?: boolean; labeled?: boolean; agent?: AgentKind } = {}) =>
  messageButtons(messageActions({ agent: p.agent ?? "claude", items, index, busy: !!p.busy, readOnly: !!p.readOnly }), items, !!p.labeled)
    .map((b) => b.text);

test("messageButtons: what each kind of message offers, in order (A2)", () => {
  const items = twoTurns();
  assert.deepEqual(texts(items, 3), ["Branch and edit", "Fork and edit", "Label"]);   // your message
  assert.deepEqual(texts(items, 1), ["Branch", "Fork to new", "Label"]);              // a turn's last reply
  assert.deepEqual(texts(items, 6), ["Branch", "Fork to new", "Label"]);
  assert.deepEqual(texts(items, 4), ["Label"]);                                       // a reply partway through a turn
  assert.deepEqual(texts(items, 5), []);                                              // a tool call
  assert.deepEqual(texts(items, 2), []);                                              // an end mark
  assert.deepEqual(texts([...items, mNote()], 8), []);                                // a note
  assert.deepEqual(texts([...items, mUser(), mOpen()], 9), []);                       // a streaming reply
});

test("messageButtons: only Label while the agent replies and in a read-only chat", () => {
  const items = twoTurns();
  for (const p of [{ busy: true }, { readOnly: true }]) {
    assert.deepEqual(texts(items, 3, p), ["Label"]);
    assert.deepEqual(texts(items, 6, p), ["Label"]);
    assert.deepEqual(texts(items, 4, p), ["Label"]);
  }
});

test("messageButtons: a chat made before end marks offers Label, and Fork to new on its last reply", () => {
  const items: Items = [mUser(), mText(), mUser(), mText()];
  assert.deepEqual(texts(items, 0), ["Label"]);
  assert.deepEqual(texts(items, 1), ["Label"]);
  assert.deepEqual(texts(items, 2), ["Label"]);
  assert.deepEqual(texts(items, 3), ["Fork to new", "Label"]);
});

test("messageButtons: each button carries its action's point count; Label has none", () => {
  const items = twoTurns();
  const of = (index: number) => messageButtons(messageActions({ agent: "claude", items, index, busy: false, readOnly: false }), items, false)
    .map((b) => [b.id, b.at]);
  assert.deepEqual(of(3), [["branchEdit", 3], ["forkEdit", 3], ["label", undefined]]);
  assert.deepEqual(of(1), [["branch", 3], ["fork", 3], ["label", undefined]]);
  assert.deepEqual(of(6), [["branch", 8], ["fork", 8], ["label", undefined]]);
  assert.deepEqual(of(0), [["branchEdit", 0], ["forkEdit", 0], ["label", undefined]]);
});

test("messageButtons: the Label button tells a label is set, and Branch whether the branch ends there", () => {
  const items = twoTurns();
  assert.deepEqual(texts(items, 4, { labeled: true }), ["Label ✓"]);
  assert.deepEqual(texts(items, 3, { labeled: true }), ["Branch and edit", "Fork and edit", "Label ✓"]);
  const branch = (index: number) => messageButtons(messageActions({ agent: "claude", items, index, busy: false, readOnly: false }), items, false)[0];
  assert.match(branch(6).title, /^Carry on in a new branch/);   // the branch's last turn
  assert.match(branch(1).title, /^Continue from the end of this turn/);
  for (const b of messageButtons(messageActions({ agent: "claude", items, index: 3, busy: false, readOnly: false }), items, false)) assert.ok(b.title);
});

// main with two turns, and a branch split from it at count 3.
const VIEW: TreeView = {
  current: "main",
  branches: [
    { id: "main", at: 0, len: 8, items: [] },
    { id: "a1b2c3d4", from: "main", at: 3, len: 6, items: [
      { i: 3, kind: "user", text: "memory", before: 3, ok: true },
      { i: 4, kind: "text", text: "map", done: true, end: 6, ok: true },
    ] },
  ],
  labels: [],
};

test("viewFor: a view only for a branch it has", () => {
  assert.equal(viewFor(VIEW, "main"), VIEW);
  assert.equal(viewFor(VIEW, "a1b2c3d4"), VIEW);
  assert.equal(viewFor(VIEW, "ffffffff"), undefined);
  assert.equal(viewFor(undefined, "main"), undefined);
});

test("threadTree: the shown branch is read from its live items", () => {
  const items = twoTurns();
  const t = threadTree(VIEW, "main", "claude", items);
  assert.deepEqual(t.order.filter((id) => id.startsWith("main:")), ["main:0", "main:1", "main:3", "main:4", "main:6"]);
  assert.deepEqual(markerAt(t, "main", 3), { n: 1, m: 2 });   // the first message after the split
  assert.equal(markerAt(t, "main", 0), null);
  assert.equal(markerAt(t, "main", 4), null);
});

test("threadTree: one tree per view and item list", () => {
  const items = twoTurns();
  const t = threadTree(VIEW, "main", "claude", items);
  assert.equal(threadTree(VIEW, "main", "claude", items), t);
  const longer = [...items, mUser()];
  const t2 = threadTree(VIEW, "main", "claude", longer);
  assert.notEqual(t2, t);
  assert.ok(t2.entries["main:8"]);
  assert.notEqual(threadTree(VIEW, "a1b2c3d4", "claude", longer), t2);
  assert.notEqual(threadTree({ ...VIEW }, "main", "claude", items), t);
});
