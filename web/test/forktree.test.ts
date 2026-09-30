// PROTOTYPE ONLY (branch fork-chat-feature)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  append, atFork, branchable, branchCount, branchName, emptyTree, endsTurn, forkOut, moveTo, pathTo, rows, setLabel, siblingsOf, thread, tips,
  type ChatTree,
} from "../src/logic/forktree.ts";
import type { Item } from "../src/types.ts";

const user = (text: string): Item => ({ kind: "user", text });
const reply = (text: string): Item => ({ kind: "text", text, done: true });
const tool = (name: string): Item => ({ kind: "tool", name, input: {}, result: "ok" });

function add(t: ChatTree, ...items: Item[]): ChatTree {
  for (const it of items) [t] = append(t, it, 0);
  return t;
}

// e1 U ask → e2 A options → e3 U redis → e4 A lua ; back to e2, e5 U memory → e6 A map
function sample() {
  let t = add(emptyTree(), user("ask"), reply("options"), user("redis"), reply("lua"));
  t = { ...t, leaf: "e2" };
  t = add(t, user("memory"), reply("map"));
  return t;
}

test("appending carries on the leaf's session until the leaf already has children", () => {
  const t = sample();
  assert.deepEqual(thread(t).map((e) => e.item.text), ["ask", "options", "memory", "map"]);
  assert.equal(t.entries.e3.session, "s1");
  assert.equal(t.entries.e5.session, "s2");
  assert.equal(t.entries.e6.session, "s2");
  assert.deepEqual(t.sessions.s2, { id: "s2", from: { session: "s1", at: "e2" } });
  assert.equal(branchCount(t), 2);
});

test("picking your message takes it back to the composer; picking a reply continues after it", () => {
  const t = sample();
  const a = moveTo(t, "e3");
  assert.equal(a.tree.leaf, "e2");
  assert.equal(a.draft, "redis");
  assert.ok(atFork(a.tree));
  const b = moveTo(t, "e4");
  assert.equal(b.tree.leaf, "e4");
  assert.equal(b.draft, undefined);
  assert.ok(!atFork(b.tree)); // the end of a branch: sending carries on its session
  const [c] = append(b.tree, user("more"), 0);
  assert.equal(c.entries[c.leaf!].session, "s1");
});

test("branches start only where a turn ended, or at your message from the turn before it", () => {
  // e1 U ask → e2 A looking → e3 T Read → e4 A answer → e5 U more → e6 A done
  const t = add(emptyTree(), user("ask"), reply("looking"), tool("Read"), reply("answer"), user("more"), reply("done"));
  assert.deepEqual(t.order.filter((id) => endsTurn(t, id)), ["e4", "e6"]);
  assert.deepEqual(t.order.filter((id) => branchable(t, id)), ["e1", "e4", "e5", "e6"]);
  assert.equal(moveTo(t, "e2").tree, t); // partway through a turn: nothing moves
  assert.equal(moveTo(t, "e3").tree, t);
  const a = moveTo(t, "e5");
  assert.equal(a.tree.leaf, "e4");
  assert.equal(a.draft, "more");
});

test("branching at the end of a branch keeps it: it ends there, and going back carries on its session", () => {
  // e1 U ask → e2 A options, then Branch at e2: e3 U more → e4 A sure
  let t = add(emptyTree(), user("ask"), reply("options"));
  [t] = append(t, user("more"), 0, true);
  t = add(t, reply("sure"));
  assert.equal(t.entries.e2.end, true);
  assert.deepEqual(t.sessions.s2, { id: "s2", from: { session: "s1", at: "e2" } });
  assert.equal(t.entries.e4.session, "s2");
  assert.deepEqual(tips(t), ["e2", "e4"]);
  assert.deepEqual(siblingsOf(t, "e3"), ["e2", "e3"]); // "Branch 2 of 2"
  assert.equal(branchName(t, "e2"), "main");
  assert.equal(branchName(t, "e4"), "more");
  assert.deepEqual(rows(t, { filter: "default" }).map((x) => x.gutter + x.id), ["e1", "e2", "└─ e3", "   e4"]);
  assert.equal(forkOut(t, "e4", "chatA").tree.entries.e2.end, undefined);
  // back to where the first branch ended: not a fork, so the next message carries on session s1
  t = moveTo(t, "e2").tree;
  assert.ok(!atFork(t));
  const [u] = append(t, user("back on main"), 0);
  assert.equal(u.entries[u.leaf!].session, "s1");
  assert.equal(u.entries.e2.end, undefined);
  assert.equal(branchCount(u), 2);
  // branching there once more starts a third session; the end mark stays while no one carries it on
  const [v] = append(t, user("third"), 0, true);
  assert.equal(v.entries[v.leaf!].session, "s3");
  assert.equal(v.entries.e2.end, true);
  assert.equal(branchCount(v), 3);
});

test("editing the first message starts a new root with a fresh session", () => {
  const t = moveTo(sample(), "e1").tree;
  assert.equal(t.leaf, null);
  const [u] = append(t, user("ask again"), 0);
  assert.equal(u.entries[u.leaf!].parent, null);
  assert.deepEqual(u.sessions[u.entries[u.leaf!].session], { id: "s3" });
});

test("branch names come from labels, else the first message after the last fork", () => {
  let t = sample();
  assert.equal(branchName(t, "e4"), "redis");
  assert.equal(branchName(t, "e6"), "memory");
  assert.equal(branchName(t, "e2"), "main");
  t = setLabel(t, "e3", "shared store");
  assert.equal(branchName(t, "e4"), "shared store");
  t = setLabel(t, "e2", "options"); // above the fork: shared by both branches, so it names neither
  assert.equal(branchName(t, "e6"), "memory");
  assert.equal(branchName(t, "e2"), "options");
  assert.deepEqual(siblingsOf(t, "e5"), ["e3", "e5"]);
});

test("rows draw forks with ├─ and └─ and keep runs at one depth", () => {
  const r = rows(sample(), { filter: "default" });
  assert.deepEqual(r.map((x) => x.gutter + x.id), ["e1", "e2", "├─ e3", "│  e4", "└─ e5", "   e6"]);
  assert.equal(r.find((x) => x.id === "e2")!.fork, 2);
  assert.ok(r.find((x) => x.id === "e6")!.isLeaf);
  assert.ok(!r.find((x) => x.id === "e4")!.onPath);
});

test("filters skip entries but keep the shape; folding hides what is under a row", () => {
  let t = add(emptyTree(), user("ask"), tool("Read"), reply("answer"));
  assert.deepEqual(rows(t, { filter: "default" }).map((x) => x.id), ["e1", "e3"]);
  const labeled = setLabel(setLabel(sample(), "e3", "redis"), "e5", "memory");
  assert.deepEqual(rows(labeled, { filter: "labeled" }).map((x) => x.gutter + x.id), ["├─ e3", "└─ e5"]);
  const f = rows(sample(), { filter: "default", folded: new Set(["e2"]) });
  assert.deepEqual(f.map((x) => x.id), ["e1", "e2"]);
  assert.equal(f[1].folded, 4);
  assert.deepEqual(rows(sample(), { filter: "default", query: "lua" }).map((x) => x.id), ["e4"]);
});

test("fork to a new chat copies the way to the entry into one new session", () => {
  const t = sample();
  const a = forkOut(t, "e4", "chatA");
  assert.deepEqual(a.tree.order, ["e1", "e2", "e3", "e4"]);
  assert.equal(a.tree.leaf, "e4");
  assert.deepEqual(a.tree.sessions, { s1: { id: "s1", from: { session: "s1", at: "e4", chat: "chatA" } } });
  const b = forkOut(t, "e5", "chatA");
  assert.deepEqual(b.tree.order, ["e1", "e2"]);
  assert.equal(b.draft, "memory");
  assert.deepEqual(pathTo(b.tree, b.tree.leaf), ["e1", "e2"]);
});
