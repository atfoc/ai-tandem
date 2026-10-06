import { test } from "node:test";
import assert from "node:assert/strict";
import { inPrefix, prefixEnd, prefixMark, prefixText, subInPrefix } from "../src/logic/prefix.ts";
import type { Item, Subagent, TreeView } from "../src/types.ts";

const tree: TreeView = {
  current: "b2",
  branches: [
    { id: "main", at: 0, len: 9, items: [] },
    { id: "b1", from: "main", at: 4, len: 7, items: [] },
    { id: "b2", from: "b1", at: 6, len: 6, items: [] },
  ],
  labels: [],
};

test("prefixEnd: main is the fork's prefix, 0 when it is no fork", () => {
  assert.equal(prefixEnd(tree, "main"), 0);
  assert.equal(prefixEnd(undefined, "main"), 0);
  assert.equal(prefixEnd(tree, "main", 5), 5);
  assert.equal(prefixEnd(undefined, "main", 5), 5); // needs no tree
  assert.equal(prefixEnd(tree, "", 5), 5); // a missing branch is main
});

test("prefixEnd: a branch shares `at` items with the branch it split from", () => {
  assert.equal(prefixEnd(tree, "b1"), 4);
  assert.equal(prefixEnd(tree, "b2"), 6);
});

test("prefixEnd: an unknown branch or a missing tree gives 0", () => {
  assert.equal(prefixEnd(tree, "nope"), 0);
  assert.equal(prefixEnd(undefined, "b1"), 0);
  assert.equal(prefixEnd(undefined, "b1", 5), 0);
});

test("prefixEnd: a branch of a forked chat uses its own at, also inside the fork's prefix", () => {
  assert.equal(prefixEnd(tree, "b1", 8), 4);  // splits inside the fork's prefix
  assert.equal(prefixEnd(tree, "b2", 5), 6);  // splits after it
  assert.equal(prefixEnd(tree, "main", 8), 8);
});

test("prefixMark: before the first own item, after the last when there is none, not inside a cut", () => {
  assert.equal(prefixMark(0, 5), null);  // no prefix
  assert.equal(prefixMark(4, 7), 4);
  assert.equal(prefixMark(4, 4), 4);     // nothing of its own yet
  assert.equal(prefixMark(4, 3), null);  // shown cut inside the prefix (or not loaded)
  assert.equal(prefixMark(4, 0), null);
});

test("prefixText: a fork's on main, a branch's elsewhere", () => {
  assert.equal(prefixText("main"), "Copied from the chat this was forked from up to here");
  assert.equal(prefixText("b1"), "Shared with the branch this started from up to here");
});

test("inPrefix: items before the end; a subagent's own items have no index", () => {
  assert.equal(inPrefix(3, 4), true);
  assert.equal(inPrefix(4, 4), false);
  assert.equal(inPrefix(0, 0), false);
  assert.equal(inPrefix(undefined, 4), false);
});

test("subInPrefix: by the tool call that started it, through the subagents it is nested in", () => {
  const items: (Item | null)[] = [
    { kind: "user", text: "go" },
    { kind: "tool", name: "Agent", toolId: "t1", subagent: "s1" },
    null,
    { kind: "tool", name: "Agent", toolId: "t2", subagent: "s2" },
  ];
  const s = (id: string, tool: string, parent?: string): Subagent => ({ id, tool, parent, status: "stopped" });
  const subs = { s1: s("s1", "t1"), s2: s("s2", "t2"), n1: s("n1", "tn", "s1"), n2: s("n2", "tm", "s2") };
  assert.equal(subInPrefix(subs.s1, subs, items, 3), true);
  assert.equal(subInPrefix(subs.s2, subs, items, 3), false);
  assert.equal(subInPrefix(subs.n1, subs, items, 3), true);   // nested in one started in the prefix
  assert.equal(subInPrefix(subs.n2, subs, items, 3), false);
  assert.equal(subInPrefix(subs.s1, subs, items, 0), false);  // no prefix
  assert.equal(subInPrefix(subs.s1, subs, undefined, 3), false); // thread not loaded
  assert.equal(subInPrefix(undefined, subs, items, 3), false);
  assert.equal(subInPrefix(s("x", "gone"), subs, items, 3), false); // its call is not in the thread
});
