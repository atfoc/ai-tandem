import { test } from "node:test";
import assert from "node:assert/strict";
import { branchNameFor, editLabel } from "../src/logic/attribution.ts";
import { agentShortName } from "../src/agents.ts";
import type { TreeView } from "../src/types.ts";

// main with two turns, and the branch a1b2c3d4 split from it at count 3.
const SPLIT: TreeView = {
  current: "a1b2c3d4",
  branches: [
    { id: "main", at: 0, len: 6, items: [
      { i: 0, kind: "user", text: "ask", before: 0, ok: true },
      { i: 1, kind: "text", text: "options", done: true, end: 3, ok: true },
      { i: 3, kind: "user", text: "redis", before: 3, ok: true },
      { i: 4, kind: "text", text: "looking", done: true, end: 6, ok: true },
    ] },
    { id: "a1b2c3d4", from: "main", at: 3, len: 6, items: [
      { i: 3, kind: "user", text: "memory", before: 3, ok: true },
      { i: 4, kind: "text", text: "map", done: true, end: 6 },
    ] },
  ],
  labels: [{ branch: "a1b2c3d4", item: 3, text: "mem" }],
};
const ONE: TreeView = { current: "main", branches: [SPLIT.branches[0]], labels: [] };

test("editLabel: the agent's short name without a branch name", () => {
  assert.equal(editLabel("claude"), agentShortName("claude"));
  assert.equal(editLabel("claude", undefined), agentShortName("claude"));
  assert.equal(editLabel("claude", ""), agentShortName("claude"));
  assert.equal(editLabel("no-such-agent"), agentShortName("no-such-agent"));
});

test("editLabel: the agent and the branch name", () => {
  assert.equal(editLabel("claude", "mem"), `${agentShortName("claude")} · mem`);
  assert.equal(editLabel("cursor", "main"), `${agentShortName("cursor")} · main`);
});

test("branchNameFor: a branch of a chat that split is named as the header names it", () => {
  assert.equal(branchNameFor(SPLIT, "a1b2c3d4"), "mem");
  assert.equal(branchNameFor(SPLIT, "main"), "redis");
  assert.equal(editLabel("claude", branchNameFor(SPLIT, "a1b2c3d4")), `${agentShortName("claude")} · mem`);
});

test("branchNameFor: a chat with one branch gives no branch part", () => {
  assert.equal(branchNameFor(ONE, "main"), undefined);
  assert.equal(editLabel("claude", branchNameFor(ONE, "main")), agentShortName("claude"));
});

test("branchNameFor: an unknown branch id gives no branch part", () => {
  assert.equal(branchNameFor(SPLIT, "ffff0000"), undefined);
  assert.equal(editLabel("claude", branchNameFor(SPLIT, "ffff0000")), agentShortName("claude"));
});

test("branchNameFor: no tree, no branch, or a listed branch with nothing of its own yet gives no branch part", () => {
  assert.equal(branchNameFor(undefined, "main"), undefined);
  assert.equal(branchNameFor(SPLIT, undefined), undefined);
  const fresh: TreeView = { ...SPLIT, branches: [...SPLIT.branches, { id: "0badf00d", from: "main", at: 6, len: 6, items: [] }] };
  assert.equal(branchNameFor(fresh, "0badf00d"), undefined);
});
