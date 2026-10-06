import { test } from "node:test";
import assert from "node:assert/strict";
import {
  branchName, buildTree, childrenOf, entryId, FILTERS, forkLinks, labelAt, markerAt, nameOfBranch, ownerOf, pathTo, preview, rowActions, rows,
  sharedCount, siblingsOf, tipBranch, tipOf, tips, withLive,
  type ForkLink, type RowActions,
} from "../src/logic/forktree.ts";
import { LIVE_FORK } from "../src/logic/forkpoints.ts";
import type { ChatView, Item, TreeBranchView, TreeItem, TreeLabel, TreeView } from "../src/types.ts";

// The worked example, as GET /api/chats/{id}/tree sends it: main with two turns, and the branch
// a1b2c3d4 split from it at count 3, which is the current one.
const EXAMPLE: TreeView = {
  current: "a1b2c3d4",
  branches: [
    { id: "main", at: 0, len: 8, items: [
      { i: 0, kind: "user", text: "ask", before: 0, ok: true },
      { i: 1, kind: "text", text: "options", done: true, end: 3, ok: true },
      { i: 3, kind: "user", text: "redis", before: 3, ok: true },
      { i: 4, kind: "text", text: "looking", done: true },
      { i: 6, kind: "text", text: "lua", done: true, end: 8, ok: true },
    ] },
    { id: "a1b2c3d4", from: "main", at: 3, len: 6, items: [
      { i: 3, kind: "user", text: "memory", before: 3, ok: true },
      { i: 4, kind: "text", text: "map", done: true, end: 6 },
    ] },
  ],
  labels: [
    { branch: "main", item: 1, text: "options" },
    { branch: "a1b2c3d4", item: 3, text: "mem" },
  ],
};

// The example's live items, by branch.
const MAIN_ITEMS: Item[] = [
  { kind: "user", text: "ask" }, { kind: "text", text: "options", done: true }, { kind: "end", point: "p1" },
  { kind: "user", text: "redis" }, { kind: "text", text: "looking", done: true }, { kind: "tool", toolId: "t1", name: "Read", result: "ok" },
  { kind: "text", text: "lua", done: true }, { kind: "end", point: "p2" },
];
const BRANCH_ITEMS: Item[] = [
  ...MAIN_ITEMS.slice(0, 3), { kind: "user", text: "memory" }, { kind: "text", text: "map", done: true }, { kind: "end", point: "" },
];

const u = (i: number, text: string, p: Partial<TreeItem> = {}): TreeItem => ({ i, kind: "user", text, ...p });
const a = (i: number, text: string, p: Partial<TreeItem> = {}): TreeItem => ({ i, kind: "text", text, done: true, ...p });
const main = (len: number, ...items: TreeItem[]): TreeBranchView => ({ id: "main", at: 0, len, items });
const view = (current: string, branches: TreeBranchView[], labels: TreeLabel[] = []): TreeView => ({ current, branches, labels });
const lines = (v: TreeView, o: { filter?: "default" | "labeled"; query?: string } = {}) =>
  rows(buildTree(v), { filter: o.filter ?? "default", query: o.query }).map((x) => x.gutter + x.id);

// main: U ask → A options → U redis → A lua; b1 split after "options": U memory → A map
function sample(labels: TreeLabel[] = []): TreeView {
  return view("b1", [
    main(6, u(0, "ask", { before: 0, ok: true }), a(1, "options", { end: 3, ok: true }), u(3, "redis", { before: 3, ok: true }), a(4, "lua", { end: 6, ok: true })),
    { id: "b1", from: "main", at: 3, len: 6, items: [u(3, "memory", { before: 3, ok: true }), a(4, "map", { end: 6, ok: true })] },
  ], labels);
}

// main: U ask → A options, then Branch at its end: b1 U more → A sure
function branchedAtEnd(): TreeView {
  return view("b1", [
    main(3, u(0, "ask", { before: 0, ok: true }), a(1, "options", { end: 3, ok: true })),
    { id: "b1", from: "main", at: 3, len: 6, items: [u(3, "more", { before: 3, ok: true }), a(4, "sure", { end: 6, ok: true })] },
  ]);
}

test("the worked example: entries, parents, the leaf, rows and markers", () => {
  const t = buildTree(EXAMPLE);
  assert.deepEqual(t.order, ["main:0", "main:1", "main:3", "main:4", "main:6", "a1b2c3d4:3", "a1b2c3d4:4"]);
  assert.deepEqual(Object.keys(t.entries).sort(), [...t.order].sort());
  assert.equal(t.view, EXAMPLE);
  assert.deepEqual(t.order.map((id) => t.entries[id].parent), [null, "main:0", "main:1", "main:3", "main:4", "main:1", "a1b2c3d4:3"]);
  assert.deepEqual(t.entries["a1b2c3d4:3"], {
    id: "a1b2c3d4:3", branch: "a1b2c3d4", item: EXAMPLE.branches[1].items[0], parent: "main:1", label: "mem",
  });
  assert.equal(t.entries["main:1"].label, "options");
  assert.ok(t.order.every((id) => !t.entries[id].end));
  assert.equal(t.leaf, "a1b2c3d4:4");
  assert.deepEqual(pathTo(t, t.leaf), ["main:0", "main:1", "a1b2c3d4:3", "a1b2c3d4:4"]);
  assert.deepEqual(childrenOf(t, "main:1"), ["main:3", "a1b2c3d4:3"]);
  assert.deepEqual(childrenOf(t, null), ["main:0"]);
  assert.deepEqual(tips(t), ["main:6", "a1b2c3d4:4"]);
  assert.deepEqual(
    rows(t, { filter: "default" }).map((x) => x.gutter + x.id),
    ["main:0", "main:1", "├─ main:3", "│  main:4", "│  main:6", "└─ a1b2c3d4:3", "   a1b2c3d4:4"],
  );
  assert.deepEqual(siblingsOf(t, "a1b2c3d4:3"), ["main:3", "a1b2c3d4:3"]);
  assert.deepEqual(markerAt(t, "a1b2c3d4", 3), { n: 2, m: 2 });
  assert.deepEqual(markerAt(t, "main", 3), { n: 1, m: 2 });
  assert.equal(markerAt(t, "main", 1), null);
  assert.equal(markerAt(t, "a1b2c3d4", 1), null); // main's item, seen from the branch
  assert.equal(markerAt(t, "main", 2), null);     // an end mark: no entry
  assert.equal(markerAt(t, "main", 5), null);     // a tool call: no entry
  assert.equal(entryId("main", 3), "main:3");
});

test("a pending move puts the leaf at the last entry before its count", () => {
  assert.equal(buildTree(EXAMPLE, { branch: "main", count: 3 }).leaf, "main:1");
  assert.equal(buildTree(EXAMPLE, { branch: "main", count: 0 }).leaf, null);
  assert.equal(buildTree(EXAMPLE, { branch: "main", count: 8 }).leaf, "main:6");
  assert.equal(buildTree(EXAMPLE, { branch: "main", count: 5 }).leaf, "main:4");
  assert.equal(buildTree(EXAMPLE, { branch: "a1b2c3d4", count: 6 }).leaf, "a1b2c3d4:4");
  assert.equal(buildTree(EXAMPLE, { branch: "a1b2c3d4", count: 4 }).leaf, "a1b2c3d4:3");
  assert.equal(buildTree(EXAMPLE, { branch: "a1b2c3d4", count: 3 }).leaf, "main:1"); // below the split: main's part
  assert.equal(buildTree(EXAMPLE, { branch: "a1b2c3d4", count: 0 }).leaf, null);
  const r = rows(buildTree(EXAMPLE, { branch: "main", count: 3 }), { filter: "default" });
  assert.deepEqual(r.filter((x) => x.onPath).map((x) => x.id), ["main:0", "main:1"]);
  assert.deepEqual(r.filter((x) => x.isLeaf).map((x) => x.id), ["main:1"]);
  assert.ok(rows(buildTree(EXAMPLE, { branch: "main", count: 0 }), { filter: "default" }).every((x) => !x.onPath && !x.isLeaf));
});

test("branch names in the example: a label on the branch's own part, else its first message", () => {
  const t = buildTree(EXAMPLE);
  assert.equal(nameOfBranch(t, "a1b2c3d4"), "mem");
  assert.equal(nameOfBranch(t, "main"), "redis"); // the label on main:1 is above the split and names neither
  assert.equal(branchName(t, "a1b2c3d4:4"), "mem");
  assert.equal(branchName(t, "main:6"), "redis");
});

test("branch names come from labels, else the first message after the last split", () => {
  let t = buildTree(sample());
  assert.equal(branchName(t, "main:4"), "redis");
  assert.equal(branchName(t, "b1:4"), "memory");
  assert.equal(branchName(t, "main:1"), "main");
  t = buildTree(sample([{ branch: "main", item: 3, text: "shared store" }]));
  assert.equal(branchName(t, "main:4"), "shared store");
  assert.equal(nameOfBranch(t, "main"), "shared store");
  // above the split: shared by both branches, so it names neither
  t = buildTree(sample([{ branch: "main", item: 3, text: "shared store" }, { branch: "main", item: 1, text: "options" }]));
  assert.equal(branchName(t, "b1:4"), "memory");
  assert.equal(nameOfBranch(t, "b1"), "memory");
  assert.equal(branchName(t, "main:1"), "options");
  assert.deepEqual(siblingsOf(t, "b1:3"), ["main:3", "b1:3"]);
  // the nearest label to the branch's end wins
  t = buildTree(sample([{ branch: "b1", item: 3, text: "first" }, { branch: "b1", item: 4, text: "second" }]));
  assert.equal(nameOfBranch(t, "b1"), "second");
  // a long first message is cut
  const long = sample();
  long.branches[1].items[0] = u(3, "a very long message that goes on and on past forty characters", { before: 3, ok: true });
  assert.equal(nameOfBranch(buildTree(long), "b1"), "a very long message that goes on and on…");
});

test("a chat that never split has one branch, main", () => {
  const one = view("main", [main(6, u(0, "ask"), a(1, "options"), u(3, "redis"), a(4, "lua"))]);
  const t = buildTree(one);
  assert.equal(nameOfBranch(t, "main"), "main");
  assert.equal(t.leaf, "main:4");
  assert.deepEqual(tips(t), ["main:4"]);
  assert.deepEqual(lines(one), ["main:0", "main:1", "main:3", "main:4"]);
  assert.ok(t.order.every((id) => siblingsOf(t, id).length === 0 && markerAt(t, "main", t.entries[id].item.i) === null));
  // an empty chat
  const empty = buildTree(view("main", [main(0)]));
  assert.equal(empty.leaf, null);
  assert.equal(nameOfBranch(empty, "main"), "main");
  assert.deepEqual(rows(empty, { filter: "default" }), []);
  assert.deepEqual(tips(empty), []);
});

test("rows draw splits with ├─ and └─ and keep runs at one depth", () => {
  const r = rows(buildTree(sample()), { filter: "default" });
  assert.deepEqual(r.map((x) => x.gutter + x.id), ["main:0", "main:1", "├─ main:3", "│  main:4", "└─ b1:3", "   b1:4"]);
  assert.equal(r.find((x) => x.id === "main:1")!.fork, 2);
  assert.deepEqual(r.filter((x) => x.fork).map((x) => x.id), ["main:1"]);
  assert.ok(r.find((x) => x.id === "b1:4")!.isLeaf);
  assert.deepEqual(r.filter((x) => x.isLeaf).map((x) => x.id), ["b1:4"]);
  assert.ok(!r.find((x) => x.id === "main:4")!.onPath);
  assert.deepEqual(r.filter((x) => x.onPath).map((x) => x.id), ["main:0", "main:1", "b1:3", "b1:4"]);
  assert.deepEqual(r.filter((x) => x.isTip).map((x) => x.id), ["main:4", "b1:4"]);
  assert.deepEqual(Object.keys(r[0]).sort(), ["fork", "gutter", "id", "isLeaf", "isTip", "onPath"]);
});

test("filters and the search skip entries but keep the shape", () => {
  assert.deepEqual(FILTERS, [{ id: "default", label: "Messages" }, { id: "labeled", label: "Labeled" }]);
  const labeled = sample([{ branch: "main", item: 3, text: "redis" }, { branch: "b1", item: 3, text: "memory" }]);
  assert.deepEqual(lines(labeled, { filter: "labeled" }), ["├─ main:3", "└─ b1:3"]);
  assert.deepEqual(lines(sample(), { filter: "labeled" }), []);
  assert.deepEqual(lines(sample(), { query: "lua" }), ["main:4"]);
  assert.deepEqual(lines(sample(), { query: "  LUA " }), ["main:4"]);
  assert.deepEqual(lines(sample(), { query: "nothing like it" }), []);
  // the query matches labels too, and both sides of a split stay drawn as one
  assert.deepEqual(lines(EXAMPLE, { query: "MEM" }), ["a1b2c3d4:3"]);
  assert.deepEqual(lines(EXAMPLE, { query: "o" }), ["main:1", "├─ main:4", "└─ a1b2c3d4:3"]);
  assert.deepEqual(lines(EXAMPLE, { filter: "labeled" }), ["main:1", "a1b2c3d4:3"]);
  assert.deepEqual(lines(EXAMPLE, { filter: "labeled", query: "opt" }), ["main:1"]);
  // a single way shown stays at one depth, and a row counts the ways shown under it
  assert.deepEqual(lines(labeled, { query: "m" }), ["b1:3", "b1:4"]);
  const r = rows(buildTree(EXAMPLE), { filter: "default", query: "o" });
  assert.deepEqual(r.map((x) => x.fork), [2, 0, 0]);
  assert.deepEqual(r.map((x) => x.onPath), [true, false, true]);
});

test("tool calls, notes and end marks are not entries: the tree holds messages and replies", () => {
  const live = withLive(view("main", [main(0)]), "main", "claude", MAIN_ITEMS);
  assert.deepEqual(lines(live), ["main:0", "main:1", "main:3", "main:4", "main:6"]);
});

test("branching at the end of a branch keeps it: it ends there, and stays a branch", () => {
  const v = branchedAtEnd();
  const t = buildTree(v);
  assert.equal(t.entries["main:1"].end, true);
  assert.deepEqual(t.order.filter((id) => t.entries[id].end), ["main:1"]);
  assert.deepEqual(tips(t), ["main:1", "b1:4"]);
  assert.deepEqual(siblingsOf(t, "b1:3"), ["main:1", "b1:3"]); // "Branch 2 of 2"
  assert.deepEqual(markerAt(t, "b1", 3), { n: 2, m: 2 });
  assert.equal(markerAt(t, "b1", 1), null);
  assert.equal(branchName(t, "main:1"), "main");
  assert.equal(nameOfBranch(t, "main"), "main");
  assert.equal(branchName(t, "b1:4"), "more");
  assert.equal(nameOfBranch(t, "b1"), "more");
  const r = rows(t, { filter: "default" });
  assert.deepEqual(r.map((x) => x.gutter + x.id), ["main:0", "main:1", "└─ b1:3", "   b1:4"]);
  assert.deepEqual(r.filter((x) => x.isTip).map((x) => x.id), ["main:1", "b1:4"]);
  assert.equal(r[1].fork, 2);
  assert.equal(tipOf(t, "main"), "main:1");
  assert.equal(tipBranch(t, "main:1"), "main");

  // a label keeps naming the branch that ended there
  const named = buildTree({ ...v, labels: [{ branch: "main", item: 1, text: "plan" }] });
  assert.equal(nameOfBranch(named, "main"), "plan");
  assert.equal(nameOfBranch(named, "b1"), "more");

  // going back to where main ended and carrying it on: it no longer ends there, and still two branches
  const on = view("main", [main(6, ...v.branches[0].items, u(3, "back on main"), a(4, "ok")), v.branches[1]]);
  const o = buildTree(on);
  assert.equal(o.entries["main:1"].end, undefined);
  assert.deepEqual(tips(o), ["main:4", "b1:4"]);
  assert.deepEqual(childrenOf(o, "main:1"), ["main:3", "b1:3"]);
  assert.deepEqual(lines(on), ["main:0", "main:1", "├─ main:3", "│  main:4", "└─ b1:3", "   b1:4"]);
  assert.equal(nameOfBranch(o, "main"), "back on main");

  // branching there once more starts a third branch; main still ends there
  const third = view("b2", [...v.branches, { id: "b2", from: "main", at: 3, len: 4, items: [u(3, "third")] }]);
  const w = buildTree(third);
  assert.equal(w.entries["main:1"].end, true);
  assert.deepEqual(tips(w), ["main:1", "b1:4", "b2:3"]);
  assert.deepEqual(siblingsOf(w, "b2:3"), ["main:1", "b1:3", "b2:3"]);
  assert.deepEqual(markerAt(w, "b2", 3), { n: 3, m: 3 });
  assert.deepEqual(lines(third), ["main:0", "main:1", "├─ b1:3", "│  b1:4", "└─ b2:3"]);
  assert.equal(rows(w, { filter: "default" })[1].fork, 3);
  assert.equal(nameOfBranch(w, "main"), "main");
});

test("a branch from the start of the chat is a second root", () => {
  const v = view("b1", [
    main(3, u(0, "ask", { before: 0, ok: true }), a(1, "options", { end: 3, ok: true })),
    { id: "b1", from: "main", at: 0, len: 3, items: [u(0, "ask again", { before: 0, ok: true }), a(1, "sure", { end: 3, ok: true })] },
  ]);
  const t = buildTree(v);
  assert.equal(t.entries["b1:0"].parent, null);
  assert.deepEqual(childrenOf(t, null), ["main:0", "b1:0"]);
  assert.deepEqual(siblingsOf(t, "b1:0"), ["main:0", "b1:0"]);
  assert.deepEqual(markerAt(t, "b1", 0), { n: 2, m: 2 });
  assert.deepEqual(markerAt(t, "main", 0), { n: 1, m: 2 });
  assert.deepEqual(lines(v), ["├─ main:0", "│  main:1", "└─ b1:0", "   b1:1"]);
  assert.equal(nameOfBranch(t, "main"), "ask");
  assert.equal(nameOfBranch(t, "b1"), "ask again");
  assert.equal(sharedCount(v, "main", "b1"), 0);
});

// The example with a third branch, split from a1b2c3d4 at the given count.
const nested = (at: number, items: TreeItem[] = [u(at, "deeper")]): TreeView => ({
  ...EXAMPLE,
  current: "e5f6a7b8",
  branches: [...EXAMPLE.branches, { id: "e5f6a7b8", from: "a1b2c3d4", at, len: at + 1, items }],
});

test("a branch off a branch hangs from that branch's path", () => {
  // at the end of a1b2c3d4: that branch ends there, and the new one goes on from it
  const v = nested(6);
  const t = buildTree(v);
  assert.equal(t.entries["e5f6a7b8:6"].parent, "a1b2c3d4:4");
  assert.equal(t.entries["a1b2c3d4:4"].end, true);
  assert.deepEqual(pathTo(t, t.leaf), ["main:0", "main:1", "a1b2c3d4:3", "a1b2c3d4:4", "e5f6a7b8:6"]);
  assert.deepEqual(lines(v), [
    "main:0", "main:1", "├─ main:3", "│  main:4", "│  main:6", "└─ a1b2c3d4:3", "   a1b2c3d4:4", "   └─ e5f6a7b8:6",
  ]);
  assert.deepEqual(tips(t), ["main:6", "a1b2c3d4:4", "e5f6a7b8:6"]);
  assert.equal(nameOfBranch(t, "e5f6a7b8"), "deeper");
  assert.equal(nameOfBranch(t, "a1b2c3d4"), "mem");
  // below the first split: the new branch hangs from main's part of a1b2c3d4's path
  const low = buildTree(nested(3));
  assert.equal(low.entries["e5f6a7b8:3"].parent, "main:1");
  assert.deepEqual(siblingsOf(low, "e5f6a7b8:3"), ["main:3", "a1b2c3d4:3", "e5f6a7b8:3"]);
  assert.deepEqual(markerAt(low, "e5f6a7b8", 3), { n: 3, m: 3 });
  // a branch without messages of its own ends where it split
  const bare = buildTree(nested(4, []));
  assert.equal(bare.leaf, "a1b2c3d4:3");
  assert.equal(tipOf(bare, "e5f6a7b8"), "a1b2c3d4:3");
  assert.equal(bare.entries["a1b2c3d4:3"].end, true);
  assert.equal(tipBranch(bare, "a1b2c3d4:3"), "e5f6a7b8");
});

test("ownerOf: the branch whose own part holds an index", () => {
  const v = nested(6);
  assert.equal(ownerOf(v, "main", 0), "main");
  assert.equal(ownerOf(v, "main", 100), "main");
  assert.equal(ownerOf(v, "a1b2c3d4", 2), "main");
  assert.equal(ownerOf(v, "a1b2c3d4", 3), "a1b2c3d4");
  assert.equal(ownerOf(v, "e5f6a7b8", 1), "main");
  assert.equal(ownerOf(v, "e5f6a7b8", 5), "a1b2c3d4");
  assert.equal(ownerOf(v, "e5f6a7b8", 6), "e5f6a7b8");
  assert.equal(ownerOf(nested(2), "e5f6a7b8", 2), "e5f6a7b8");
  assert.equal(ownerOf(nested(2), "e5f6a7b8", 1), "main");
  assert.equal(ownerOf(v, "nosuch", 5), "main");
});

test("labelAt: a label shows on every branch whose thread holds its message", () => {
  assert.equal(labelAt(EXAMPLE, "a1b2c3d4", 1), "options"); // owned by main
  assert.equal(labelAt(EXAMPLE, "main", 1), "options");
  assert.equal(labelAt(EXAMPLE, "main", 3), undefined);
  assert.equal(labelAt(EXAMPLE, "a1b2c3d4", 3), "mem");
  assert.equal(labelAt(EXAMPLE, "a1b2c3d4", 4), undefined);
  assert.equal(labelAt(undefined, "main", 1), undefined);
  assert.equal(labelAt(nested(6), "e5f6a7b8", 3), "mem");
  assert.equal(labelAt(nested(6), "e5f6a7b8", 1), "options");
  assert.equal(labelAt(nested(3), "e5f6a7b8", 3), undefined);
});

test("sharedCount: the leading items two branches have in common", () => {
  assert.equal(sharedCount(EXAMPLE, "main", "a1b2c3d4"), 3);
  assert.equal(sharedCount(EXAMPLE, "a1b2c3d4", "main"), 3);
  assert.equal(sharedCount(EXAMPLE, "main", "main"), 8);
  assert.equal(sharedCount(EXAMPLE, "a1b2c3d4", "a1b2c3d4"), 6);
  const v = nested(5);
  assert.equal(sharedCount(v, "e5f6a7b8", "main"), 3);
  assert.equal(sharedCount(v, "main", "e5f6a7b8"), 3);
  assert.equal(sharedCount(v, "e5f6a7b8", "a1b2c3d4"), 5);
  assert.equal(sharedCount(v, "a1b2c3d4", "e5f6a7b8"), 5);
  // split below the point its parent split at: only main's part is shared with either
  assert.equal(sharedCount(nested(2), "e5f6a7b8", "a1b2c3d4"), 2);
  assert.equal(sharedCount(nested(2), "e5f6a7b8", "main"), 2);
  // two branches off the same branch share up to the lower split
  const two: TreeView = { ...v, branches: [...v.branches, { id: "c9d0e1f2", from: "a1b2c3d4", at: 4, len: 5, items: [] }] };
  assert.equal(sharedCount(two, "e5f6a7b8", "c9d0e1f2"), 4);
  assert.equal(sharedCount(two, "c9d0e1f2", "main"), 3);
});

test("withLive rebuilds one branch's own part from its live items", () => {
  const stale: TreeView = {
    ...EXAMPLE,
    branches: [{ ...EXAMPLE.branches[0], len: 1, items: [] }, { ...EXAMPLE.branches[1], len: 3, items: [] }],
  };
  const live = withLive(withLive(stale, "main", "claude", MAIN_ITEMS), "a1b2c3d4", "claude", BRANCH_ITEMS);
  assert.deepEqual(live, EXAMPLE);
  assert.deepEqual(stale.branches[0].items, []); // a copy: the view given is not changed
  // the other branch, the labels and the current branch are kept as they are
  const one = withLive(stale, "a1b2c3d4", "claude", BRANCH_ITEMS);
  assert.equal(one.branches[0], stale.branches[0]);
  assert.equal(one.labels, stale.labels);
  assert.equal(one.current, "a1b2c3d4");
  assert.deepEqual(one.branches[1], EXAMPLE.branches[1]);
  // a turn that is running shows in the tree as it comes in
  const more: Item[] = [...BRANCH_ITEMS, { kind: "user", text: "and then" }, { kind: "text", text: "wri" }];
  const grown = withLive(EXAMPLE, "a1b2c3d4", "claude", more);
  assert.equal(grown.branches[1].len, 8);
  assert.deepEqual(grown.branches[1].items.slice(2), [{ i: 6, kind: "user", text: "and then", before: 6 }, { i: 7, kind: "text", text: "wri" }]);
  assert.equal(buildTree(grown).leaf, "a1b2c3d4:7");
  // told that the branch runs, the same id rules pick the finished boundaries: the point before
  // the running turn's message is one
  const run = withLive(EXAMPLE, "main", "claude", [...MAIN_ITEMS, { kind: "user", text: "and then" }, { kind: "text", text: "wri" }], true);
  assert.equal(run.branches[0].len, 10);
  assert.deepEqual(run.branches[0].items.slice(0, 5), EXAMPLE.branches[0].items);
  assert.deepEqual(run.branches[0].items.slice(5), [{ i: 8, kind: "user", text: "and then", before: 8, ok: true }, { i: 9, kind: "text", text: "wri" }]);
  // a kind that cannot fork a running source: no row of the running branch is ok
  const was = LIVE_FORK.claude;
  LIVE_FORK.claude = false;
  try {
    assert.ok(withLive(EXAMPLE, "main", "claude", MAIN_ITEMS, true).branches[0].items.every((x) => !x.ok));
    assert.deepEqual(withLive(EXAMPLE, "main", "claude", MAIN_ITEMS), { ...EXAMPLE, branches: [EXAMPLE.branches[0], EXAMPLE.branches[1]] });
    const t = buildTree(withLive(EXAMPLE, "main", "claude", MAIN_ITEMS, true));
    for (const id of ["main:0", "main:1", "main:3", "main:4"]) assert.deepEqual(rowActions(t, id, busyOn("main")), { ...NOTHING, midTurn: id === "main:4" }, id);
    assert.deepEqual(rowActions(t, "main:6", busyOn("main")), { ...NOTHING, open: { view: "main" } });
    assert.equal(rowActions(t, "a1b2c3d4:3", busyOn("main")).branchEdit, 3); // the other branch is not running
  } finally {
    LIVE_FORK.claude = was;
  }
  // items not loaded yet: an empty own part
  const none = withLive(EXAMPLE, "a1b2c3d4", "claude", []);
  assert.deepEqual(none.branches[1], { id: "a1b2c3d4", from: "main", at: 3, len: 0, items: [] });
  assert.equal(buildTree(none).leaf, "main:1");
  // a branch the view does not have: the view unchanged
  assert.equal(withLive(EXAMPLE, "nosuch", "claude", MAIN_ITEMS), EXAMPLE);
});

test("tipOf and tipBranch: where a branch ends, and which branch ends at an entry", () => {
  const t = buildTree(EXAMPLE);
  assert.equal(tipOf(t, "main"), "main:6");
  assert.equal(tipOf(t, "a1b2c3d4"), "a1b2c3d4:4");
  assert.equal(tipBranch(t, "main:6"), "main");
  assert.equal(tipBranch(t, "a1b2c3d4:4"), "a1b2c3d4");
  assert.equal(tipBranch(t, "main:1"), null);
  assert.equal(tipBranch(t, "a1b2c3d4:3"), null);
  assert.equal(tipBranch(t, "nosuch:1"), null);
  assert.equal(tipOf(buildTree(view("main", [main(0)])), "main"), null);
  // the tips do not move with the leaf
  assert.equal(tipOf(buildTree(EXAMPLE, { branch: "main", count: 3 }), "a1b2c3d4"), "a1b2c3d4:4");
});

test("a branch the view does not have is read as main", () => {
  const v: TreeView = {
    current: "gone",
    branches: [EXAMPLE.branches[0], { ...EXAMPLE.branches[1], from: "gone" }],
    labels: [],
  };
  const t = buildTree(v);
  assert.equal(t.leaf, "main:6");
  assert.equal(t.entries["a1b2c3d4:3"].parent, "main:1");
  assert.equal(tipOf(t, "gone"), "main:6");
  assert.equal(sharedCount(v, "gone", "a1b2c3d4"), 3);
  // a record whose branches name each other still builds
  const loop = view("x", [main(1, u(0, "ask")), { id: "x", from: "y", at: 1, len: 2, items: [u(1, "x")] }, { id: "y", from: "x", at: 1, len: 2, items: [u(1, "y")] }]);
  assert.deepEqual(buildTree(loop).order, ["main:0", "x:1", "y:1"]);
  assert.equal(sharedCount(loop, "x", "y"), 1);
});

test("preview: a message in one line", () => {
  assert.equal(preview("## Plan\n\n- use **redis** with `lua`"), "Plan - use redis with lua");
  assert.equal(preview("<b>bold</b> and\n\tmore"), "bold and more");
  assert.equal(preview(""), "(empty)");
  assert.equal(preview("  \n "), "(empty)");
  assert.equal(preview("abcdefghij", 5), "abcd…");
  assert.equal(preview("abcde", 5), "abcde");
  assert.equal(preview("x".repeat(61)), "x".repeat(59) + "…");
});

// ---- the viewed branch, and the chats forked from this one

test("the leaf is the viewed branch when given", () => {
  // the server's current branch is a1b2c3d4; this client views main
  const t = buildTree(EXAMPLE, { branch: "main", count: Infinity });
  assert.equal(t.leaf, "main:6");
  const r = rows(t, { filter: "default" });
  assert.deepEqual(r.filter((x) => x.isLeaf).map((x) => x.id), ["main:6"]);
  assert.deepEqual(r.filter((x) => x.onPath).map((x) => x.id), ["main:0", "main:1", "main:3", "main:4", "main:6"]);
  assert.deepEqual(r.filter((x) => x.isTip && !x.isLeaf).map((x) => x.id), ["a1b2c3d4:4"]);
  assert.equal(buildTree(EXAMPLE, { branch: "a1b2c3d4", count: Infinity }).leaf, "a1b2c3d4:4");
  assert.equal(buildTree(EXAMPLE).leaf, "a1b2c3d4:4"); // not given: the server's current branch
  // a branch without messages of its own: where it split; one the view lacks: read as main
  assert.equal(buildTree({ ...nested(4, []), current: "main" }, { branch: "e5f6a7b8", count: Infinity }).leaf, "a1b2c3d4:3");
  assert.equal(buildTree(EXAMPLE, { branch: "gone", count: Infinity }).leaf, "main:6");
});

const chat = (id: string, p: Partial<ChatView> = {}): ChatView => ({ id, created: "2026-01-01T00:00:00Z", ...p } as ChatView);
const link = (chat: string, p: Partial<ForkLink> = {}): ForkLink => ({ chat, title: chat, archived: false, where: "loose", ...p });
const under = (chat: string, entry: string, title = chat): ForkLink => link(chat, { where: "entry", entry, title });
const linked = (v: TreeView, links: ForkLink[], o: { filter?: "default" | "labeled"; query?: string } = {}) =>
  rows(buildTree(v), { filter: o.filter ?? "default", query: o.query, links }).map((x) => x.gutter + x.id);

test("forkLinks: where each fork left, earlier forks loose, a fork at the start (forkedAt absent with forkedBranch present), a fork of a fork is not listed", () => {
  const t = buildTree(EXAMPLE);
  const chats = [
    chat("c1", { name: "the chat" }),
    chat("f6", { forkedFrom: "c1", forkedBranch: "gone", forkedAt: 3, created: "2026-01-07T00:00:00Z" }),
    chat("f5", { forkedFrom: "c1", forkedAt: 3, name: "old fork", created: "2026-01-06T00:00:00Z" }),
    chat("f4", { forkedFrom: "c1", forkedBranch: "main", created: "2026-01-05T00:00:00Z" }),
    chat("f3", { forkedFrom: "c1", forkedBranch: "a1b2c3d4", forkedAt: 3, archived: true, created: "2026-01-04T00:00:00Z" }),
    chat("f2", { forkedFrom: "c1", forkedBranch: "a1b2c3d4", forkedAt: 6, name: "memory fork", created: "2026-01-03T00:00:00Z" }),
    chat("f1", { forkedFrom: "c1", forkedBranch: "main", forkedAt: 3, name: "redis fork", created: "2026-01-02T00:00:00Z" }),
    chat("g1", { forkedFrom: "f1", forkedBranch: "main", forkedAt: 3 }), // a fork of a fork: in f1's tree
    chat("x1", { forkedFrom: "other", forkedBranch: "main", forkedAt: 3 }),
  ];
  assert.deepEqual(forkLinks(t, chats, "c1"), [
    { chat: "f1", title: "redis fork", archived: false, where: "entry", entry: "main:1" },
    { chat: "f2", title: "memory fork", archived: false, where: "entry", entry: "a1b2c3d4:4" },
    { chat: "f3", title: "New chat", archived: true, where: "entry", entry: "main:1" }, // below the split: main's entry
    { chat: "f4", title: "New chat", archived: false, where: "start" },                 // the server leaves a count of 0 out
    { chat: "f5", title: "old fork", archived: false, where: "loose" },                 // no branch recorded: an earlier fork
    { chat: "f6", title: "New chat", archived: false, where: "loose" },                 // a branch the view lacks
  ]);
  assert.deepEqual(forkLinks(t, chats, "f1").map((l) => l.chat), ["g1"]);
  assert.deepEqual(forkLinks(t, chats, "nosuch"), []);
  // the last entry below the count: partway through a turn, at the end, and past it
  const at = (forkedAt: number, forkedBranch = "main") => forkLinks(t, [chat("f", { forkedFrom: "c1", forkedBranch, forkedAt })], "c1")[0];
  assert.equal(at(5).entry, "main:4");
  assert.equal(at(8).entry, "main:6");
  assert.equal(at(99).entry, "main:6");
  assert.equal(at(4, "a1b2c3d4").entry, "a1b2c3d4:3");
  assert.deepEqual(at(0), { chat: "f", title: "New chat", archived: false, where: "start" });
  // the same time: by id
  const same = ["b", "c", "a"].map((id) => chat(id, { forkedFrom: "c1", forkedBranch: "main", forkedAt: 3 }));
  assert.deepEqual(forkLinks(t, same, "c1").map((l) => l.chat), ["a", "b", "c"]);
});

test("rows: a fork link hangs under its entry and does not indent the run", () => {
  const one = view("main", [EXAMPLE.branches[0]]);
  assert.deepEqual(linked(one, [under("f1", "main:1")]), ["main:0", "main:1", "└─ fork:f1", "main:3", "main:4", "main:6"]);
  assert.deepEqual(linked(one, [under("f1", "main:1"), under("f2", "main:1")]), ["main:0", "main:1", "├─ fork:f1", "└─ fork:f2", "main:3", "main:4", "main:6"]);
  assert.deepEqual(linked(one, [under("f1", "main:6")]), ["main:0", "main:1", "main:3", "main:4", "main:6", "└─ fork:f1"]);
  // the row of a link, and the entry above it: still no split
  const l = under("f1", "main:1");
  const r = rows(buildTree(one), { filter: "default", links: [l] });
  assert.deepEqual(r[2], { id: "fork:f1", gutter: "└─ ", onPath: false, isLeaf: false, isTip: false, fork: 0, link: l });
  assert.equal(r[1].fork, 0);
  assert.ok(r.filter((x) => !x.link).every((x) => !("link" in x)));
  assert.deepEqual(r.filter((x) => !x.link), rows(buildTree(one), { filter: "default" }));
  // inside a branch: under that branch's lines
  assert.deepEqual(linked(sample(), [under("f1", "main:4"), under("f2", "b1:3")]), [
    "main:0", "main:1", "├─ main:3", "│  main:4", "│  └─ fork:f1", "└─ b1:3", "   └─ fork:f2", "   b1:4",
  ]);
  // from the start: before the first message; loose: last; an entry the tree lacks: from the start
  assert.deepEqual(linked(one, [link("old"), link("s", { where: "start" }), under("f1", "main:6"), under("lost", "gone:9")]), [
    "fork:s", "fork:lost", "main:0", "main:1", "main:3", "main:4", "main:6", "└─ fork:f1", "fork:old",
  ]);
  // a chat without messages
  assert.deepEqual(linked(view("main", [main(0)]), [link("s", { where: "start" }), link("old")]), ["fork:s", "fork:old"]);
});

test("rows: a link beside a split is one of the tees", () => {
  assert.deepEqual(linked(sample(), [under("f1", "main:1")]), ["main:0", "main:1", "├─ fork:f1", "├─ main:3", "│  main:4", "└─ b1:3", "   b1:4"]);
  assert.deepEqual(linked(sample(), [under("f1", "main:1"), under("f2", "main:1")]), [
    "main:0", "main:1", "├─ fork:f1", "├─ fork:f2", "├─ main:3", "│  main:4", "└─ b1:3", "   b1:4",
  ]);
  const r = rows(buildTree(sample()), { filter: "default", links: [under("f1", "main:1")] });
  assert.equal(r[1].fork, 2); // the link is not one of the ways
  // a branch that ends where another goes on: the one way on is drawn as a branch, and the link beside it
  assert.deepEqual(linked(branchedAtEnd(), [under("f1", "main:1")]), ["main:0", "main:1", "├─ fork:f1", "└─ b1:3", "   b1:4"]);
  // two roots: a fork from the start is a tee beside them
  const roots = view("b1", [
    main(3, u(0, "ask", { before: 0, ok: true }), a(1, "options", { end: 3, ok: true })),
    { id: "b1", from: "main", at: 0, len: 3, items: [u(0, "ask again", { before: 0, ok: true }), a(1, "sure", { end: 3, ok: true })] },
  ]);
  assert.deepEqual(linked(roots, [link("s", { where: "start" })]), ["├─ fork:s", "├─ main:0", "│  main:1", "└─ b1:0", "   b1:1"]);
});

test("rows: links under the filter and the search", () => {
  const labeled = sample([{ branch: "main", item: 3, text: "redis" }, { branch: "b1", item: 3, text: "memory" }]);
  const links = [under("f1", "main:4", "Redis notes"), under("f2", "b1:4", "Map"), link("s", { where: "start", title: "From the top" }), link("old", { title: "Old redis fork" })];
  assert.deepEqual(linked(labeled, links), [
    "fork:s", "main:0", "main:1", "├─ main:3", "│  main:4", "│  └─ fork:f1", "└─ b1:3", "   b1:4", "   └─ fork:f2", "fork:old",
  ]);
  // the Labeled filter: no links
  assert.deepEqual(linked(labeled, links, { filter: "labeled" }), ["├─ main:3", "└─ b1:3"]);
  assert.deepEqual(linked(labeled, links, { filter: "labeled", query: "redis" }), ["main:3"]);
  // a search: the links whose title has it; one whose entry is hidden hangs from the nearest shown above it
  assert.deepEqual(linked(labeled, links, { query: " REDIS " }), ["main:3", "└─ fork:f1", "fork:old"]);
  assert.deepEqual(linked(labeled, links, { query: "lua" }), ["main:4"]);
  // nothing shown above it: listed with those from the start
  assert.deepEqual(linked(labeled, links, { query: "notes" }), ["fork:f1"]);
  assert.deepEqual(linked(labeled, links, { query: "map" }), ["b1:4", "└─ fork:f2"]);
  assert.deepEqual(linked(labeled, links, { query: "top" }), ["fork:s"]);
  assert.deepEqual(linked(labeled, [under("f1", "main:1", "omega")], { query: "m" }), ["fork:f1", "b1:3", "b1:4"]);
  // the ways shown under an entry are a fan: its link is one of the tees
  assert.deepEqual(linked(EXAMPLE, [under("f1", "main:1", "an o")], { query: "o" }), ["main:1", "├─ fork:f1", "├─ main:4", "└─ a1b2c3d4:3"]);
  assert.deepEqual(linked(sample(), [under("f1", "main:1", "an o")], { query: "o" }), ["main:1", "└─ fork:f1", "b1:3"]);
});

// ---- what a row offers

const NOTHING: RowActions = { open: null, branchEdit: null, forkEdit: null, fork: null, midTurn: false };
const idle = { busy: new Set<string>(), readOnly: false };
const busyOn = (...ids: string[]) => ({ busy: new Set(ids), readOnly: false });

test("rowActions in the example: your messages, turn ends, a reply partway, and the ends of branches", () => {
  const t = buildTree(EXAMPLE);
  // your message: Branch and edit, Fork and edit; double-click is Branch and edit
  assert.deepEqual(rowActions(t, "main:0", idle), {
    ...NOTHING, branchEdit: 0, forkEdit: 0, open: { target: { branch: "main", at: 0, new: true }, edit: 0 },
  });
  assert.deepEqual(rowActions(t, "main:3", idle), {
    ...NOTHING, branchEdit: 3, forkEdit: 3, open: { target: { branch: "main", at: 3, new: true }, edit: 3 },
  });
  assert.deepEqual(rowActions(t, "a1b2c3d4:3", idle), {
    ...NOTHING, branchEdit: 3, forkEdit: 3, open: { target: { branch: "a1b2c3d4", at: 3, new: true }, edit: 3 },
  });
  // a turn's last reply: Fork to new chat; double-click opens the chat there
  assert.deepEqual(rowActions(t, "main:1", idle), { ...NOTHING, fork: 3, open: { target: { branch: "main", at: 3, new: false } } });
  // a reply partway through a turn: nothing but the note
  assert.deepEqual(rowActions(t, "main:4", idle), { ...NOTHING, midTurn: true });
  // the end of a branch: double-click shows that branch
  assert.deepEqual(rowActions(t, "main:6", idle), { ...NOTHING, fork: 8, open: { view: "main" } });
  // the end of a branch whose last mark has no id: Fork to new at the branch's end all the same
  assert.deepEqual(rowActions(t, "a1b2c3d4:4", idle), { ...NOTHING, fork: 6, open: { view: "a1b2c3d4" } });
  assert.deepEqual(rowActions(t, "nosuch:1", idle), NOTHING);
});

test("rowActions: nothing moves in a read-only chat", () => {
  const t = buildTree(EXAMPLE);
  const ends: Record<string, string> = { "main:6": "main", "a1b2c3d4:4": "a1b2c3d4" };
  for (const p of [{ busy: new Set<string>(), readOnly: true }, { busy: new Set(["main", "a1b2c3d4"]), readOnly: true }]) {
    for (const id of t.order) assert.deepEqual(rowActions(t, id, p), { ...NOTHING, midTurn: id === "main:4", open: ends[id] ? { view: ends[id] } : null }, id);
  }
});

test("rowActions: the end of a branch is viewed in a read-only chat", () => {
  const ro = { busy: new Set<string>(), readOnly: true };
  const t = buildTree(EXAMPLE);
  // viewing sends nothing: it is all an archived or legacy chat offers, on the end rows only
  assert.deepEqual(rowActions(t, "main:6", ro), { ...NOTHING, open: { view: "main" } });
  assert.deepEqual(rowActions(t, "a1b2c3d4:4", ro), { ...NOTHING, open: { view: "a1b2c3d4" } });
  assert.deepEqual(rowActions(t, "main:6", { busy: new Set(["main"]), readOnly: true }).open, { view: "main" });
  for (const id of ["main:0", "main:1", "main:3", "a1b2c3d4:3"]) assert.deepEqual(rowActions(t, id, ro), NOTHING, id);
  // a branch that ended where another was branched from it, and one that ends with your message
  assert.deepEqual(rowActions(buildTree(branchedAtEnd()), "main:1", ro), { ...NOTHING, open: { view: "main" } });
  const cut = buildTree(view("main", [EXAMPLE.branches[0], { id: "b1", from: "main", at: 3, len: 5, items: [u(3, "cut", { before: 3, ok: true })] }]));
  assert.deepEqual(rowActions(cut, "b1:3", ro), { ...NOTHING, open: { view: "b1" } });
});

test("rowActions: a busy branch gates its own rows only, and there the row's ok decides", () => {
  // main runs a third turn: the server's tree marks its finished boundaries ok, and nothing in the running turn
  const v = view("b1", [
    main(11, u(0, "ask", { before: 0, ok: true }), a(1, "options", { end: 3, ok: true }), u(3, "redis", { before: 3, ok: true }),
      a(4, "lua", { end: 6, ok: true }), u(6, "more", { before: 6, ok: true }), a(7, "looking"), a(9, "found")),
    { id: "b1", from: "main", at: 3, len: 6, items: [u(3, "memory", { before: 3, ok: true }), a(4, "map", { end: 6 })] },
  ]);
  const t = buildTree(v);
  const p = busyOn("main");
  // finished turns of the running branch: as on an idle one
  for (const id of ["main:0", "main:1", "main:3", "main:4"]) assert.deepEqual(rowActions(t, id, p), rowActions(t, id, idle), id);
  assert.deepEqual(rowActions(t, "main:1", p), { ...NOTHING, fork: 3, open: { target: { branch: "main", at: 3, new: false } } });
  assert.deepEqual(rowActions(t, "main:4", p), { ...NOTHING, fork: 6, open: { target: { branch: "main", at: 6, new: false } } });
  // the message that started the running turn drops it whole
  assert.deepEqual(rowActions(t, "main:6", p), { ...NOTHING, branchEdit: 6, forkEdit: 6, open: { target: { branch: "main", at: 6, new: true }, edit: 6 } });
  // inside the running turn: nothing, and no fork of the whole branch at its end; the end is still looked at,
  // by the branch's id: the tree's len (11 here) is old for a branch that runs and is not shown
  assert.deepEqual(rowActions(t, "main:7", p), { ...NOTHING, midTurn: true });
  assert.deepEqual(rowActions(t, "main:9", p), { ...NOTHING, open: { view: "main" } });
  assert.equal(rowActions(t, "main:9", idle).fork, 11);
  // the other branch is not gated by main's turn, its end fork included
  for (const id of ["b1:3", "b1:4"]) assert.deepEqual(rowActions(t, id, p), rowActions(t, id, idle), id);
  assert.deepEqual(rowActions(t, "b1:4", p), { ...NOTHING, fork: 6, open: { view: "b1" } });
  // and its own turn gates only its own end: main's rows are as idle
  assert.deepEqual(rowActions(t, "b1:4", busyOn("b1")), { ...NOTHING, open: { view: "b1" } });
  assert.equal(rowActions(t, "main:9", busyOn("b1")).fork, 11);
  // a row the server did not mark ok offers no point, busy or not
  const no = buildTree(view("main", [main(8, u(0, "ask", { before: 0 }), a(1, "options", { end: 3 }), u(3, "more", { before: 3 }), a(4, "wri"))]));
  for (const id of ["main:0", "main:1", "main:3"]) assert.deepEqual(rowActions(no, id, busyOn("main")), NOTHING, id);
});

test("rowActions: a branch that ends with your message opens at its end, to carry it on", () => {
  // b1 was cut before any reply: U cut, a note
  const v = view("main", [EXAMPLE.branches[0], { id: "b1", from: "main", at: 3, len: 5, items: [u(3, "cut", { before: 3, ok: true })] }]);
  const t = buildTree(v);
  assert.equal(tipBranch(t, "b1:3"), "b1");
  assert.deepEqual(rowActions(t, "b1:3", idle), {
    ...NOTHING, branchEdit: 3, forkEdit: 3, open: { view: "b1" },
  });
  // while b1 runs the row's ok still decides, and its end is still looked at
  assert.deepEqual(rowActions(t, "b1:3", busyOn("b1")), rowActions(t, "b1:3", idle));
  assert.deepEqual(rowActions(t, "b1:3", { busy: new Set(["b1"]), readOnly: true }), { ...NOTHING, open: { view: "b1" } });
  // main's message at the same point is not an end: Branch and edit
  assert.deepEqual(rowActions(t, "main:3", idle).open, { target: { branch: "main", at: 3, new: true }, edit: 3 });
});

test("rowActions: a branch another was branched from at its end still opens at that end", () => {
  const t = buildTree(branchedAtEnd());
  assert.deepEqual(rowActions(t, "main:1", idle), { ...NOTHING, fork: 3, open: { view: "main" } });
  assert.deepEqual(rowActions(t, "b1:4", idle), { ...NOTHING, fork: 6, open: { view: "b1" } });
  // a branch without messages of its own ends at an entry of the branch it came from
  const bare = buildTree(nested(4, []));
  assert.deepEqual(rowActions(bare, "a1b2c3d4:3", idle).open, { view: "e5f6a7b8" });
});

test("rowActions: a point without an id offers nothing, unless the entry is the end of a branch", () => {
  // marks without ids on the first two turns; the third turn's mark has one
  const v = view("main", [main(9,
    u(0, "ask", { before: 0 }), a(1, "options", { end: 3 }),
    u(3, "redis", { before: 3 }), a(4, "lua", { end: 6 }),
    u(6, "more", { before: 6 }), a(7, "done", { end: 9, ok: true }),
  )]);
  const t = buildTree(v);
  assert.deepEqual(rowActions(t, "main:0", idle), NOTHING);
  assert.deepEqual(rowActions(t, "main:1", idle), NOTHING); // its turn's last reply: not midTurn
  assert.deepEqual(rowActions(t, "main:3", idle), NOTHING);
  assert.deepEqual(rowActions(t, "main:4", idle), NOTHING);
  assert.deepEqual(rowActions(t, "main:6", idle), NOTHING);
  assert.deepEqual(rowActions(t, "main:7", idle), { ...NOTHING, fork: 9, open: { view: "main" } });
  // a message after a turn that ended without a mark has no point at all
  const cut = buildTree(view("main", [main(4, u(0, "ask", { before: 0 }), a(1, "half"), u(2, "again"), a(3, "ok"))]));
  assert.deepEqual(rowActions(cut, "main:2", idle), NOTHING);
  assert.deepEqual(rowActions(cut, "main:1", idle), { ...NOTHING, midTurn: true });
});

test("rowActions: the last reply of a branch forks at the branch's end, whatever the marks", () => {
  // an older chat: no marks at all
  const old = buildTree(view("main", [main(5, u(0, "ask"), a(1, "looking"), a(3, "answer"))]));
  assert.deepEqual(rowActions(old, "main:0", idle), NOTHING);
  assert.deepEqual(rowActions(old, "main:1", idle), { ...NOTHING, midTurn: true });
  assert.deepEqual(rowActions(old, "main:3", idle), { ...NOTHING, fork: 5, open: { view: "main" } });
  // a reply still open is not a place to fork from, and is not partway through a turn either
  const open = buildTree(view("main", [main(2, u(0, "ask"), { i: 1, kind: "text", text: "wri" })]));
  assert.deepEqual(rowActions(open, "main:1", idle), { ...NOTHING, open: { view: "main" } });
  assert.deepEqual(rowActions(open, "main:1", busyOn("main")), { ...NOTHING, open: { view: "main" } });
  // the fork of the whole branch is not for a busy one
  assert.deepEqual(rowActions(old, "main:3", busyOn("main")), { ...NOTHING, open: { view: "main" } });
  assert.equal(rowActions(old, "main:3", busyOn("other")).fork, 5);
  // "last" is by the branch's own part: main's last reply in the example is not a1b2c3d4's
  const t = buildTree(EXAMPLE);
  assert.equal(rowActions(t, "main:6", idle).fork, 8);
  assert.equal(rowActions(t, "main:1", idle).fork, 3);
});

test("a long chat is drawn without running out of stack", () => {
  const n = 30000;
  const items: TreeItem[] = [];
  for (let i = 0; i < n; i++) items.push(i % 2 ? a(i, "reply " + i) : u(i, "message " + i));
  const v = view("main", [main(n, ...items)], [{ branch: "main", item: n - 1, text: "the end" }]);
  const t = buildTree(v);
  assert.equal(rows(t, { filter: "default" }).length, n);
  assert.deepEqual(rows(t, { filter: "labeled" }).map((x) => x.gutter + x.id), [`main:${n - 1}`]);
  assert.equal(pathTo(t, t.leaf).length, n);
  assert.equal(nameOfBranch(t, "main"), "the end");
});
