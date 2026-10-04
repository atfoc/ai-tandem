import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTree, rowActions, rows } from "../src/logic/forktree.ts";
import { escStep, isTreeKey, menuItems, MID_TURN_NOTE, pickedRow, startEntry, treeKeyName } from "../src/logic/treepopup.ts";
import type { TreeView } from "../src/types.ts";

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

const IDLE = { busy: false, readOnly: false };
// a menu as text: a disabled item in brackets, the point count after an @
const menu = (v: TreeView, id: string, p = IDLE) =>
  menuItems(buildTree(v), id, p).map((a) => (a.id === "label" || a.id === "note" ? a.label : `${a.disabled ? `(${a.label})` : a.label}@${a.at}`));

test("the example's popup: seven messages, each branch off its split, here and end", () => {
  const t = buildTree(EXAMPLE);
  const list = rows(t, { filter: "default" });
  // what a row shows: its gutter, who wrote it, the text, the label tag, and the mark at its end
  const drawn = list.map((r) => {
    const e = t.entries[r.id];
    return [r.gutter + (e.item.kind === "user" ? "you" : "agent"), e.item.text, e.label ?? "", r.isLeaf ? "● here" : r.isTip ? "end" : "", r.onPath ? "path" : "off"];
  });
  assert.deepEqual(drawn, [
    ["you", "ask", "", "", "path"],
    ["agent", "options", "options", "", "path"],
    ["├─ you", "redis", "", "", "off"],
    ["│  agent", "looking", "", "", "off"],
    ["│  agent", "lua", "", "end", "off"],
    ["└─ you", "memory", "mem", "", "path"],
    ["   agent", "map", "", "● here", "path"],
  ]);
});

test("menuItems: your message has Branch and edit, Fork and edit and Label", () => {
  assert.deepEqual(menu(EXAMPLE, "main:3"), ["Branch and edit@3", "Fork and edit@3", "Label"]);
  assert.deepEqual(menu(EXAMPLE, "main:0"), ["Branch and edit@0", "Fork and edit@0", "Label"]);
  assert.deepEqual(menu(EXAMPLE, "a1b2c3d4:3"), ["Branch and edit@3", "Fork and edit@3", "Relabel"]);
});

test("menuItems: a reply has Fork to new chat and Label; partway through a turn, the note and Label", () => {
  assert.deepEqual(menu(EXAMPLE, "main:1"), ["Fork to new chat@3", "Relabel"]);
  assert.deepEqual(menu(EXAMPLE, "main:6"), ["Fork to new chat@8", "Label"]);
  assert.deepEqual(menu(EXAMPLE, "main:4"), [MID_TURN_NOTE, "Label"]);
  // the last reply of a branch, at a point without an id: Fork at the branch's end
  assert.deepEqual(menu(EXAMPLE, "a1b2c3d4:4"), ["Fork to new chat@6", "Label"]);
});

test("menuItems: while the agent replies the branch and fork items are disabled, Label is not", () => {
  const busy = { busy: true, readOnly: false };
  assert.deepEqual(menu(EXAMPLE, "main:3", busy), ["(Branch and edit)@3", "(Fork and edit)@3", "Label"]);
  assert.deepEqual(menu(EXAMPLE, "main:1", busy), ["(Fork to new chat)@3", "Relabel"]);
  assert.deepEqual(menu(EXAMPLE, "main:4", busy), [MID_TURN_NOTE, "Label"]);
});

test("menuItems: an archived or legacy chat offers only Label, with the note where it applies", () => {
  for (const busy of [false, true]) {
    const p = { busy, readOnly: true };
    assert.deepEqual(menu(EXAMPLE, "main:3", p), ["Label"]);
    assert.deepEqual(menu(EXAMPLE, "main:1", p), ["Relabel"]);
    assert.deepEqual(menu(EXAMPLE, "main:6", p), ["Label"]);
    assert.deepEqual(menu(EXAMPLE, "main:4", p), [MID_TURN_NOTE, "Label"]);
  }
});

test("menuItems: a point without an id leaves only Label; a reply being written has no menu", () => {
  // an older chat: no ids at its points
  const old: TreeView = { current: "main", labels: [], branches: [{ id: "main", at: 0, len: 6, items: [
    { i: 0, kind: "user", text: "ask", before: 0 },
    { i: 1, kind: "text", text: "options", done: true, end: 3 },
    { i: 3, kind: "user", text: "redis", before: 3 },
    { i: 4, kind: "text", text: "lua", done: true, end: 6 },
  ] }] };
  assert.deepEqual(menu(old, "main:0"), ["Label"]);
  assert.deepEqual(menu(old, "main:3"), ["Label"]);
  assert.deepEqual(menu(old, "main:1"), ["Label"]);              // a turn's last reply, mid-branch: no point to fork at
  assert.deepEqual(menu(old, "main:4"), ["Fork to new chat@6", "Label"]); // the branch's last reply: Fork at its end
  // the agent is writing the last reply
  const writing: TreeView = { current: "main", labels: [], branches: [{ id: "main", at: 0, len: 2, items: [
    { i: 0, kind: "user", text: "ask", before: 0, ok: true },
    { i: 1, kind: "text", text: "opt" },
  ] }] };
  assert.deepEqual(menu(writing, "main:1", { busy: true, readOnly: false }), []);
  assert.deepEqual(menu(writing, "main:0", { busy: true, readOnly: false }), ["(Branch and edit)@0", "(Fork and edit)@0", "Label"]);
  assert.deepEqual(menu(EXAMPLE, "nosuch:9"), []);
});

test("the menu's points are the ones a double-click and the routes use", () => {
  const t = buildTree(EXAMPLE);
  for (const id of t.order) {
    const a = rowActions(t, id, IDLE);
    const at = (k: string) => { const m = menuItems(t, id, IDLE).find((x) => x.id === k); return m && "at" in m ? m.at : null; };
    assert.equal(at("branchEdit"), a.branchEdit, id);
    assert.equal(at("forkEdit"), a.forkEdit, id);
    assert.equal(at("fork"), a.fork, id);
  }
});

test("startEntry: the message the popup was opened at, by the branch that owns it; else the leaf", () => {
  const t = buildTree(EXAMPLE);
  assert.equal(startEntry(t), "a1b2c3d4:4");
  assert.equal(startEntry(t, { branch: "a1b2c3d4", item: 3 }), "a1b2c3d4:3");
  assert.equal(startEntry(t, { branch: "a1b2c3d4", item: 1 }), "main:1"); // below the split: main's
  assert.equal(startEntry(t, { branch: "main", item: 3 }), "main:3");
  assert.equal(startEntry(t, { branch: "main", item: 5 }), "a1b2c3d4:4"); // a tool call has no row: the leaf
  assert.equal(startEntry(buildTree(EXAMPLE, { branch: "main", count: 3 })), "main:1"); // a pending move's point
  assert.equal(startEntry(buildTree({ current: "main", branches: [], labels: [] })), null);
});

test("pickedRow: the entry's row, else the nearest one above it that the filter shows", () => {
  const t = buildTree(EXAMPLE);
  const all = rows(t, { filter: "default" });
  assert.equal(pickedRow(t, all, "a1b2c3d4:4"), "a1b2c3d4:4");
  assert.equal(pickedRow(t, all, null), null);
  const labeled = rows(t, { filter: "labeled" });
  assert.equal(pickedRow(t, labeled, "a1b2c3d4:4"), "a1b2c3d4:3");
  assert.equal(pickedRow(t, labeled, "main:6"), "main:1");
  assert.equal(pickedRow(t, rows(t, { filter: "default", query: "zzz" }), "main:6"), null);
});

test("escStep: the menu, then the search, then the popup; not under a dialog or in the label field", () => {
  const p = { dialog: false, labeling: false, menu: false, query: "" };
  assert.equal(escStep({ ...p, menu: true, query: "x" }), "menu");
  assert.equal(escStep({ ...p, query: "x" }), "search");
  assert.equal(escStep(p), "close");
  assert.equal(escStep({ ...p, labeling: true, menu: true, query: "x" }), "none");
  assert.equal(escStep({ ...p, dialog: true }), "none");
});

test("the shortcut: ⌘⇧B, Ctrl+Shift+B off macOS", () => {
  const k = { metaKey: false, ctrlKey: false, shiftKey: false, code: "KeyB" };
  assert.ok(isTreeKey({ ...k, metaKey: true, shiftKey: true }));
  assert.ok(isTreeKey({ ...k, ctrlKey: true, shiftKey: true }));
  assert.ok(!isTreeKey({ ...k, metaKey: true }));
  assert.ok(!isTreeKey({ ...k, shiftKey: true }));
  assert.ok(!isTreeKey({ ...k, metaKey: true, shiftKey: true, code: "KeyJ" }));
  assert.equal(treeKeyName("MacIntel"), "⌘⇧B");
  assert.equal(treeKeyName("Win32"), "Ctrl+Shift+B");
  assert.equal(treeKeyName(""), "Ctrl+Shift+B");
});
