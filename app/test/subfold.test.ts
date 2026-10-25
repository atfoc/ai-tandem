import { test } from "node:test";
import assert from "node:assert/strict";

import { foldedWaiting } from "../src/screens/subagents/fold.ts";
import type { Item } from "@aiwb/core/types.ts";

const perm = (decided?: boolean): Item => ({ kind: "perm", requestId: "q", toolName: "Bash", input: {}, ...(decided ? { decided: { allow: true } } : {}) }) as unknown as Item;
const tool: Item = { kind: "tool", toolId: "t1" } as Item;

test("an undecided request stays outside the fold, with its place", () => {
  assert.deepEqual(foldedWaiting([tool, perm(), tool, perm()], false), [1, 3]);
});

test("an answered request folds with the rest", () => {
  assert.deepEqual(foldedWaiting([tool, perm(true)], false), []);
});

test("a read-only screen's requests cannot be answered: they stay folded", () => {
  assert.deepEqual(foldedWaiting([tool, perm()], true), []);
});

test("no thread yet, holes in the thread", () => {
  assert.deepEqual(foldedWaiting(undefined, false), []);
  assert.deepEqual(foldedWaiting([null, perm()], false), [1]);
});
