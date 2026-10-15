// The `tree` event's parts put into a kept tree (src/logic/treepatch.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { patchTree } from "../src/logic/treepatch.ts";
import type { TreeBranchView, TreeView } from "../src/types.ts";

const B = "a1b2c3d4", C = "e5f6a7b8";
const main = (len: number): TreeBranchView => ({ id: "main", at: 0, len, items: [{ i: 0, kind: "user", text: "m0" }] });
const fork = (id: string, len: number): TreeBranchView => ({ id, from: "main", at: 1, len, items: [{ i: 1, kind: "user", text: id }] });
const view = (): TreeView => ({ current: "main", branches: [main(2), fork(B, 3)], labels: [{ branch: "main", item: 0, text: "start" }] });

test("a branch replaces the one of its id, where it is", () => {
  assert.deepEqual(patchTree(view(), { branch: main(6) }), { ...view(), branches: [main(6), fork(B, 3)] });
  assert.deepEqual(patchTree(view(), { branch: fork(B, 5) }), { ...view(), branches: [main(2), fork(B, 5)] });
});

test("a branch the tree lacks is appended", () => {
  assert.deepEqual(patchTree(view(), { branch: fork(C, 2) }).branches, [main(2), fork(B, 3), fork(C, 2)]);
  assert.deepEqual(patchTree({ current: "main", branches: [], labels: [] }, { branch: main(1) }).branches, [main(1)]);
});

test("labels replace all labels", () => {
  const labels = [{ branch: B, item: 1, text: "options" }];
  assert.deepEqual(patchTree(view(), { labels }), { ...view(), labels });
  assert.deepEqual(patchTree(view(), { labels: [] }).labels, []);
});

test("current replaces the current branch", () => {
  assert.deepEqual(patchTree(view(), { current: B }), { ...view(), current: B });
});

test("several parts at once, and none", () => {
  const labels = [{ branch: C, item: 1, text: "new" }];
  assert.deepEqual(patchTree(view(), { branch: fork(C, 2), current: C, labels }), { current: C, branches: [main(2), fork(B, 3), fork(C, 2)], labels });
  assert.deepEqual(patchTree(view(), {}), view());
});

test("the input is not changed, and what the patch leaves is the same object", () => {
  const v = view(), kept = v.branches[1];
  const next = patchTree(v, { branch: main(6), current: B, labels: [] });
  assert.deepEqual(v, view());
  assert.notEqual(next, v);
  assert.notEqual(next.branches, v.branches);
  assert.equal(next.branches[1], kept);
  assert.equal(patchTree(v, { current: B }).branches, v.branches);
});
