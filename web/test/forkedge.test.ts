// Edge cases of the chat forking logic: stopped turns, subagent rows, threads from before the
// feature, branches of branches, deep trees, labels, and what Back leaves in the composer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cutBefore, messageActions, pointOK, sessionEnd, toTreeItems, turnEnd } from "../src/logic/forkpoints.ts";
import { afterBack, bannerOf, bannerText, moveValid, quoteLimit } from "../src/logic/branchview.ts";
import { buildTree, labelAt, markerAt, nameOfBranch, ownerOf, rowActions, rows, sharedCount, withLive } from "../src/logic/forktree.ts";
import { messageButtons, viewFor } from "../src/logic/forkmessage.ts";
import { menuItems, startEntry } from "../src/logic/treepopup.ts";
import type { Held, Item, PendingMove, Reference, Target, TreeBranchView, TreeView } from "../src/types.ts";

type Items = (Item | undefined)[];
const user = (text = "u"): Item => ({ kind: "user", text });
const text = (t = "t"): Item => ({ kind: "text", text: t, done: true });
const end = (point = "p"): Item => ({ kind: "end", point });
const tool = (): Item => ({ kind: "tool", toolId: "t1", name: "Bash", result: "ok" });
const note = (): Item => ({ kind: "note", tone: "muted", text: "Stopped." });
const subres = (): Item => ({ kind: "subresult", subagent: "s1" });
const acts = (items: Items, index: number, busy = false) => messageActions({ agent: "claude", items, index, busy, readOnly: false });

const q = (item: number, comment?: string): Reference => ({ quote: "x", item, start: 0, end: 1, ...(comment ? { comment } : {}) });
const held = (t: string, references: Reference[] = []): Held => ({ text: t, mentions: [], references });
const move = (t: Target, h: Held, put: Held | null = null): PendingMove => ({ ...t, held: h, put });

// ---- points: stopped turns, subagent rows, a thread from before the feature

/** A finished turn, then a turn the agent began by itself (a background command's notification)
 *  that Stop ended: a note and a second end mark, no user item. */
const stoppedAuto = (): Items => [
  user(), text(), end("p1"), // 0..2
  user(), tool(), text(), end("p2"), // 3..6
  note(), end("p3"), // 7, 8
];

test("a stopped agent-begun turn: the last reply still branches at its own mark, the session ends past the second", () => {
  const items = stoppedAuto();
  assert.equal(turnEnd(items, 5), 7);
  assert.equal(sessionEnd(items, 7), false); // the second mark is past it
  assert.equal(sessionEnd(items, 9), true);
  const a = acts(items, 5);
  assert.equal(a.branch, 7);
  assert.equal(a.fork, 7);
  assert.equal(pointOK("claude", items, 9), true);
});

test("a turn stopped before its mark: its reply offers only Fork to new (as the last reply), its message Branch and edit", () => {
  const items: Items = [user(), text(), end("p1"), user(), text("half"), note()];
  const reply = acts(items, 4);
  assert.deepEqual([reply.branch, reply.fork, reply.midTurn], [null, 6, false]);
  assert.equal(acts(items, 3).branchEdit, 3);
  // the message after the cut turn has no point: a reply lies between it and the last mark
  const more: Items = [...items, user(), text(), end("p3")];
  assert.equal(cutBefore(more, 6), null);
  assert.deepEqual(messageButtons(acts(more, 6), more, false).map((b) => b.id), ["label"]);
  assert.equal(acts(more, 4).fork, null); // no longer the last reply
});

test("subagent rows: a result row after the mark leaves the turn's point, and the delivery turn has its own", () => {
  const items: Items = [user(), tool(), text("SPAWNED"), end("p1"), subres(), text("got it"), end("p2"), user(), text(), end("p3")];
  assert.equal(acts(items, 2).branch, 4);
  assert.equal(acts(items, 5).branch, 7);
  assert.equal(acts(items, 7).branchEdit, 7);
  assert.equal(acts(items, 4).label, false); // the result row offers nothing
  assert.deepEqual(toTreeItems("claude", items).map((r) => r.i), [0, 2, 5, 7, 8]);
});

test("a result row held after the last mark does not count as said: the branch's end is still its end", () => {
  const items: Items = [user(), text(), end("p1"), subres()];
  assert.equal(sessionEnd(items, 3), true);
  assert.equal(moveValid("claude", items, { branch: "main", at: 4, new: false }), true);
});

test("a thread from before the feature (no end marks): only Label, and Fork to new on the last reply", () => {
  const items: Items = [user(), text(), user(), tool(), text()];
  assert.deepEqual(messageButtons(acts(items, 0), items, false).map((b) => b.id), ["label"]);
  assert.deepEqual(messageButtons(acts(items, 1), items, false).map((b) => b.id), ["label"]);
  assert.deepEqual(messageButtons(acts(items, 2), items, false).map((b) => b.id), ["label"]);
  assert.deepEqual(messageButtons(acts(items, 4), items, false).map((b) => [b.id, b.at]), [["fork", 5], ["label", undefined]]);
  assert.equal(pointOK("claude", items, 0), false);
});

// ---- the tree: deep trees, branches of branches, a branch gone from under the client

/** main (9 items) → b1 at 6 → b2 at 9 (of b1) → b3 at 12 (of b2); every turn is user, text, end. */
function nested(depth: number): TreeView {
  const turn = (i: number, name: string): TreeBranchView["items"] => [
    { i, kind: "user", text: `q ${name}`, before: i, ok: true },
    { i: i + 1, kind: "text", text: `a ${name}`, done: true, end: i + 3, ok: true },
  ];
  const branches: TreeBranchView[] = [{ id: "main", at: 0, len: 9, items: [...turn(0, "m0"), ...turn(3, "m1"), ...turn(6, "m2")] }];
  for (let d = 1; d <= depth; d++) {
    const at = 3 + 3 * d;
    branches.push({ id: `b${d}`, from: d === 1 ? "main" : `b${d - 1}`, at, len: at + 6, items: [...turn(at, `b${d}x`), ...turn(at + 3, `b${d}y`)] });
  }
  return { current: `b${depth}`, branches, labels: [] };
}

test("branches of branches: owners, shared counts, markers and names", () => {
  const v = nested(3);
  assert.equal(ownerOf(v, "b3", 0), "main");
  assert.equal(ownerOf(v, "b3", 6), "b1");
  assert.equal(ownerOf(v, "b3", 9), "b2");
  assert.equal(ownerOf(v, "b3", 12), "b3");
  assert.equal(sharedCount(v, "b3", "main"), 6);
  assert.equal(sharedCount(v, "b3", "b1"), 9);
  assert.equal(sharedCount(v, "b2", "b3"), 12);
  const t = buildTree(v);
  assert.equal(t.leaf, "b3:16");
  assert.deepEqual(markerAt(t, "b3", 6), { n: 2, m: 2 });
  assert.deepEqual(markerAt(t, "b3", 9), { n: 2, m: 2 });
  assert.deepEqual(markerAt(t, "b3", 12), { n: 2, m: 2 });
  assert.equal(markerAt(t, "b3", 3), null);
  assert.equal(nameOfBranch(t, "b3"), "q b3x");
  assert.equal(nameOfBranch(t, "main"), "q m2");
});

test("a deep tree: forty nested branches build, and every row's gutter is three characters a level", () => {
  const t = buildTree(nested(40));
  const list = rows(t, { filter: "default" });
  assert.equal(list.length, t.order.length);
  assert.equal(list.filter((r) => r.isLeaf).length, 1);
  for (const r of list) assert.equal(r.gutter.length % 3, 0);
  assert.equal(Math.max(...list.map((r) => r.gutter.length)), 3 * 40);
});

test("the current branch gone from the tree the client holds: nothing throws, viewFor hides the marks", () => {
  const v: TreeView = { ...nested(1), current: "gone" };
  assert.equal(viewFor(v, "gone"), undefined);
  const t = buildTree(v); // read as main
  assert.equal(t.leaf, "main:7");
  assert.equal(nameOfBranch(t, "gone"), nameOfBranch(t, "main"));
  assert.equal(withLive(v, "gone", "claude", [user(), text(), end()]), v);
  assert.equal(quoteLimit(v, 5, "gone", "main"), 0);
  assert.equal(startEntry(t, { branch: "gone", item: 99 }), t.leaf);
  assert.deepEqual(menuItems(t, "gone:1", { busy: false, readOnly: false }), []);
  assert.equal(rowActions(t, "gone:1", { busy: false, readOnly: false }).open, null);
});

test("labels: a blank one is none, the same text twice stays two labels, an owner's label shows through a child branch", () => {
  const v: TreeView = { ...nested(2), labels: [
    { branch: "main", item: 0, text: "same" }, { branch: "main", item: 3, text: "same" },
    { branch: "b1", item: 6, text: "" }, { branch: "main", item: 6, text: "main only" },
  ] };
  assert.equal(labelAt(v, "b2", 0), "same");
  assert.equal(labelAt(v, "b2", 3), "same");
  assert.equal(labelAt(v, "b2", 6), undefined); // b1 owns index 6 there, and its label is blank
  assert.equal(labelAt(v, "main", 6), "main only");
  const t = buildTree(v);
  assert.equal(t.entries["b1:6"].label, undefined);
  assert.equal(rows(t, { filter: "labeled" }).length, 3);
});

// A branch is named by its label, and the name goes into the header's crumb and the banner: a
// long label is cut there as a name taken from a message is.
test("a branch named by a long label is cut at 40 characters", () => {
  const long = "A long label made of many words ".repeat(12).trim();
  const v: TreeView = { ...nested(1), labels: [{ branch: "b1", item: 6, text: long }] };
  const t = buildTree(v);
  assert.ok(nameOfBranch(t, "main").length <= 40);
  assert.ok(nameOfBranch(t, "b1").length <= 40, `the name is ${nameOfBranch(t, "b1").length} characters long`);
  const items: Items = [user(), text(), end(), user(), text(), end(), user(), text(), end()];
  const b = bannerText(bannerOf(t, { branch: "main", at: 9, new: false }, items, "b1"));
  assert.ok(b.length < 200, `the banner is ${b.length} characters long`);
});

// The name is the label as typed, as the tags in the thread and the tree show it: only its length
// is cut, the characters a message's preview drops stay.
const labeled = (label: string) => nameOfBranch(buildTree({ ...nested(1), labels: [{ branch: "b1", item: 6, text: label }] }), "b1");

test("a branch named by a label keeps the label's markdown characters", () => {
  assert.equal(labeled("try_2 *new*"), "try_2 *new*");
  assert.equal(labeled("a|b"), "a|b");
});

test("a branch named by a label made only of markdown characters is not named (empty)", () => {
  assert.equal(labeled("***"), "***");
  assert.equal(labeled("---"), "---");
  assert.equal(labeled("<v2>"), "<v2>");
});

test("a branch named by a label of more than 40 characters is cut to 40 ending in an ellipsis", () => {
  const long = "try_2 *new* ".repeat(5).trim(); // 59 characters
  assert.equal(labeled(long), long.slice(0, 39) + "…");
  assert.equal(labeled(long).length, 40);
  assert.equal(labeled("x".repeat(40)), "x".repeat(40)); // 40 fit
});

// ---- Back: what the composer holds

test("Back keeps what was typed during the move, without the quotes past the limit", () => {
  const m = move({ branch: "b", at: 6, new: true }, held("before"));
  assert.deepEqual(afterBack(m, held("typed", [q(2), q(8)]), 6), held("typed", [q(2)]));
});
