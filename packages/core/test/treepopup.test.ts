import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTree, rowActions, rows } from "../src/logic/forktree.ts";
import { branchMark, busyBranches, escStep, isTreeKey, menuItems, MID_TURN_NOTE, modelNotes, pickedRow, rowMarks, startEntry, stoppable, treeKeyName } from "../src/logic/treepopup.ts";
import type { Catalog, Status, TreeView } from "../src/types.ts";

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

const IDLE: { busy: ReadonlySet<string>; readOnly: boolean } = { busy: new Set(), readOnly: false };
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

test("menuItems: while a branch runs only Fork to new chat at its end is disabled; Label never is", () => {
  const busy = { busy: new Set(["main", "a1b2c3d4"]), readOnly: false };
  // finished turns of a running branch: as on an idle one
  assert.deepEqual(menu(EXAMPLE, "main:3", busy), ["Branch and edit@3", "Fork and edit@3", "Label"]);
  assert.deepEqual(menu(EXAMPLE, "main:1", busy), ["Fork to new chat@3", "Relabel"]);
  assert.deepEqual(menu(EXAMPLE, "main:6", busy), ["Fork to new chat@8", "Label"]);
  assert.deepEqual(menu(EXAMPLE, "main:4", busy), [MID_TURN_NOTE, "Label"]);
  // the last reply of a running branch, at a point without an id: the fork of the whole branch waits
  assert.deepEqual(menu(EXAMPLE, "a1b2c3d4:4", busy), ["(Fork to new chat)@6", "Label"]);
  // another branch's turn does not gate it
  assert.deepEqual(menu(EXAMPLE, "a1b2c3d4:4", { busy: new Set(["main"]), readOnly: false }), ["Fork to new chat@6", "Label"]);
  assert.deepEqual(menu(EXAMPLE, "a1b2c3d4:3", busy), ["Branch and edit@3", "Fork and edit@3", "Relabel"]);
  // the running turn itself, as the server's tree sends it: no ok on its rows
  const run: TreeView = { current: "main", labels: [], branches: [{ id: "main", at: 0, len: 7, items: [
    { i: 0, kind: "user", text: "ask", before: 0, ok: true },
    { i: 1, kind: "text", text: "options", done: true, end: 3, ok: true },
    { i: 3, kind: "user", text: "more", before: 3, ok: true },
    { i: 4, kind: "text", text: "looking", done: true },
    { i: 6, kind: "text", text: "wri" },
  ] }] };
  const main = { busy: new Set(["main"]), readOnly: false };
  assert.deepEqual(menu(run, "main:1", main), ["Fork to new chat@3", "Label"]);
  assert.deepEqual(menu(run, "main:3", main), ["Branch and edit@3", "Fork and edit@3", "Label"]);
  assert.deepEqual(menu(run, "main:4", main), [MID_TURN_NOTE, "Label"]);
  assert.deepEqual(menu(run, "main:6", main), []);
});

test("branchMark: approval, running, subagents, error, stopped, none", () => {
  assert.equal(branchMark({ status: "approval" }), "approval");
  for (const s of ["thinking", "writing", "tool"] as const) assert.equal(branchMark({ status: s }), "running", s);
  assert.equal(branchMark({ status: "ready", subsRunning: 2 }), "subs");
  assert.equal(branchMark({ status: "error" }), "error");
  assert.equal(branchMark({ status: "stopped" }), "stopped");
  assert.equal(branchMark({ status: "ready" }), null);
  assert.equal(branchMark({ status: "ready", subsRunning: 0 }), null);
  assert.equal(branchMark(undefined), null);
  // the first that holds: a turn before the subagents, running subagents before how the last turn ended
  assert.equal(branchMark({ status: "approval", subsRunning: 1 }), "approval");
  assert.equal(branchMark({ status: "tool", subsRunning: 1 }), "running");
  assert.equal(branchMark({ status: "error", subsRunning: 1 }), "subs");
  assert.equal(branchMark({ status: "stopped", subsRunning: 3 }), "subs");
});

test("stoppable", () => {
  // what a stop ends: a turn, or subagents that still run (as the composer's Stop)
  for (const m of ["approval", "running", "subs"] as const) assert.ok(stoppable(m), m);
  for (const m of ["error", "stopped", null] as const) assert.ok(!stoppable(m), String(m));
});

test("rowMarks: each branch marks the row it ends at; the order when two end at one entry", () => {
  const t = buildTree(EXAMPLE);
  const st = (branch: string, status: Status, p: { subsRunning?: number; error?: string } = {}) => ({ branch, status, ...p });
  assert.deepEqual([...busyBranches([st("main", "tool"), st("a1b2c3d4", "ready"), st("x", "approval")])].sort(), ["main", "x"]);
  assert.deepEqual([...busyBranches([])], []);
  assert.deepEqual(rowMarks(t, [st("main", "ready"), st("a1b2c3d4", "ready")]), {});
  assert.deepEqual(rowMarks(t, [st("main", "writing"), st("a1b2c3d4", "ready")]), { "main:6": { mark: "running", branch: "main", subs: 0 } });
  assert.deepEqual(rowMarks(t, [st("main", "thinking", { subsRunning: 2 }), st("a1b2c3d4", "approval")]), {
    "main:6": { mark: "running", branch: "main", subs: 2 },
    "a1b2c3d4:4": { mark: "approval", branch: "a1b2c3d4", subs: 0 },
  });
  assert.deepEqual(rowMarks(t, [st("main", "ready", { subsRunning: 1 }), st("a1b2c3d4", "stopped")]), {
    "main:6": { mark: "subs", branch: "main", subs: 1 },
    "a1b2c3d4:4": { mark: "stopped", branch: "a1b2c3d4", subs: 0 },
  });
  // an error carries its text; the text of an older error does not show under another mark
  assert.deepEqual(rowMarks(t, [st("main", "error", { error: "no such folder" }), st("a1b2c3d4", "writing", { error: "old" })]), {
    "main:6": { mark: "error", branch: "main", subs: 0, error: "no such folder" },
    "a1b2c3d4:4": { mark: "running", branch: "a1b2c3d4", subs: 0 },
  });
  assert.deepEqual(rowMarks(t, [st("main", "error")]), { "main:6": { mark: "error", branch: "main", subs: 0 } });
  // a record of a branch the tree does not have yet marks nothing (not main's end)
  assert.deepEqual(rowMarks(t, [st("new1", "writing")]), {});
  // two branches that end at one entry (one branched off the other's end, with nothing said yet):
  // approval, running, subagents, error, stopped, whichever record comes first
  const same: TreeView = { current: "b2", labels: [], branches: [
    { id: "main", at: 0, len: 3, items: [{ i: 0, kind: "user", text: "ask", before: 0, ok: true }, { i: 1, kind: "text", text: "options", done: true, end: 3, ok: true }] },
    { id: "b2", from: "main", at: 3, len: 3, items: [] },
  ] };
  const ts = buildTree(same);
  const ranked = [st("main", "approval"), st("main", "writing"), st("main", "ready", { subsRunning: 1 }), st("main", "error", { error: "e" }), st("main", "stopped")];
  ranked.forEach((hi, i) => {
    for (const lo of ranked.slice(i + 1)) {
      const want = rowMarks(ts, [hi])["main:1"];
      assert.deepEqual(rowMarks(ts, [hi, { ...lo, branch: "b2" }]), { "main:1": want }, `${hi.status} over ${lo.status}`);
      assert.deepEqual(rowMarks(ts, [{ ...lo, branch: "b2" }, hi]), { "main:1": want }, `${hi.status} over ${lo.status}, listed last`);
    }
  });
  assert.deepEqual(rowMarks(ts, [st("b2", "writing")]), { "main:1": { mark: "running", branch: "b2", subs: 0 } });
  assert.deepEqual(rowMarks(ts, [st("main", "ready"), st("b2", "stopped")]), { "main:1": { mark: "stopped", branch: "b2", subs: 0 } });
});

test("modelNotes: only where the model or effort differs from the branch it split from", () => {
  const t = buildTree(EXAMPLE);
  const st = (branch: string, model: string, effort?: string) => ({ branch, model, ...(effort ? { effort } : {}) });
  const cat: Catalog = { default: { model: "opus" }, models: [
    { id: "opus", label: "Opus 5.5", efforts: ["low", "high"] },
    { id: "sonnet", label: "Sonnet 5.5", efforts: ["fast"], effortLabels: { fast: "Quick" } },
  ] };
  // the same model and effort: nothing
  assert.deepEqual(modelNotes(t, [st("main", "opus", "high"), st("a1b2c3d4", "opus", "high")], cat), {});
  assert.deepEqual(modelNotes(t, [st("main", "opus"), st("a1b2c3d4", "opus")], cat), {});
  // another model: on the branch's first own entry, with the catalog's names
  assert.deepEqual(modelNotes(t, [st("main", "opus", "high"), st("a1b2c3d4", "sonnet", "high")], cat), { "a1b2c3d4:3": "Sonnet 5.5 · High" });
  assert.deepEqual(modelNotes(t, [st("main", "opus", "high"), st("a1b2c3d4", "sonnet", "fast")], cat), { "a1b2c3d4:3": "Sonnet 5.5 · Quick" });
  assert.deepEqual(modelNotes(t, [st("main", "opus", "high"), st("a1b2c3d4", "sonnet")], cat), { "a1b2c3d4:3": "Sonnet 5.5" });
  // another effort only
  assert.deepEqual(modelNotes(t, [st("main", "opus", "high"), st("a1b2c3d4", "opus", "low")], cat), { "a1b2c3d4:3": "Opus 5.5 · Low" });
  assert.deepEqual(modelNotes(t, [st("main", "opus", "high"), st("a1b2c3d4", "opus")], cat), { "a1b2c3d4:3": "Opus 5.5" });
  // without a catalog, or a model it lacks: the ids
  assert.deepEqual(modelNotes(t, [st("main", "opus", "high"), st("a1b2c3d4", "sonnet", "xhigh")]), { "a1b2c3d4:3": "sonnet · Extra high" });
  assert.deepEqual(modelNotes(t, [st("main", "opus"), st("a1b2c3d4", "gpt-x", "odd")], cat), { "a1b2c3d4:3": "gpt-x · Odd" });
  // either record not known: nothing; main never has one
  assert.deepEqual(modelNotes(t, [st("a1b2c3d4", "sonnet")], cat), {});
  assert.deepEqual(modelNotes(t, [st("main", "opus")], cat), {});
  assert.deepEqual(modelNotes(t, [], cat), {});
  // a branch off a branch is compared with that branch, not with main
  const deep: TreeView = { ...EXAMPLE, branches: [...EXAMPLE.branches,
    { id: "e5f6a7b8", from: "a1b2c3d4", at: 6, len: 7, items: [{ i: 6, kind: "user", text: "deeper" }] },
    { id: "bare", from: "main", at: 8, len: 8, items: [] },
  ] };
  const td = buildTree(deep);
  assert.deepEqual(modelNotes(td, [st("main", "opus"), st("a1b2c3d4", "sonnet"), st("e5f6a7b8", "sonnet")], cat), { "a1b2c3d4:3": "Sonnet 5.5" });
  assert.deepEqual(modelNotes(td, [st("main", "opus"), st("a1b2c3d4", "opus"), st("e5f6a7b8", "sonnet")], cat), { "e5f6a7b8:6": "Sonnet 5.5" });
  // a branch without entries of its own has no row to say it on
  assert.deepEqual(modelNotes(td, [st("main", "opus"), st("bare", "sonnet")], cat), {});
});

test("menuItems: an archived or legacy chat offers only Label, with the note where it applies", () => {
  for (const busy of [new Set<string>(), new Set(["main", "a1b2c3d4"])]) {
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
    { i: 0, kind: "user", text: "ask", before: 0 }, // no finished turn yet: the start is no point
    { i: 1, kind: "text", text: "opt" },
  ] }] };
  assert.deepEqual(menu(writing, "main:1", { busy: new Set(["main"]), readOnly: false }), []);
  assert.deepEqual(menu(writing, "main:0", { busy: new Set(["main"]), readOnly: false }), ["Label"]);
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
    // a double-click: the end of a branch shows that branch; elsewhere it is the menu's first point
    if (a.open && "view" in a.open) assert.equal(a.open.view, { "main:6": "main", "a1b2c3d4:4": "a1b2c3d4" }[id], id);
    else if (a.open) assert.equal(a.open.target.at, a.branchEdit ?? a.fork, id);
  }
  assert.deepEqual(t.order.filter((id) => { const o = rowActions(t, id, IDLE).open; return !!o && "view" in o; }), ["main:6", "a1b2c3d4:4"]);
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

test("rowMarks under a filter or a search: a branch whose end row is hidden marks its last row shown", () => {
  const t = buildTree(EXAMPLE);
  const st = (branch: string, status: Status, p: { subsRunning?: number; error?: string } = {}) => ({ branch, status, ...p });
  const asks = { mark: "approval", branch: "a1b2c3d4", subs: 0 };
  // the branch's only labeled row is a1b2c3d4:3, its end a1b2c3d4:4
  assert.deepEqual(rowMarks(t, [st("a1b2c3d4", "approval")]), { "a1b2c3d4:4": asks });
  assert.deepEqual(rowMarks(t, [st("a1b2c3d4", "approval")], [{ id: "a1b2c3d4:3" }]), { "a1b2c3d4:3": asks });
  const labeled = rows(t, { filter: "labeled" });
  assert.deepEqual(labeled.map((r) => r.id), ["main:1", "a1b2c3d4:3"]);
  assert.deepEqual(rowMarks(t, [st("main", "writing", { subsRunning: 1 }), st("a1b2c3d4", "approval")], labeled), {
    "main:1": { mark: "running", branch: "main", subs: 1 },
    "a1b2c3d4:3": asks,
  });
  assert.ok(stoppable(rowMarks(t, [st("a1b2c3d4", "approval")], labeled)["a1b2c3d4:3"].mark)); // and so its Stop
  // the list with every row: as with none
  const all = rows(t, { filter: "default" });
  const both = [st("main", "error", { error: "no such folder" }), st("a1b2c3d4", "tool")];
  assert.deepEqual(rowMarks(t, both, all), rowMarks(t, both));
  // a branch with no row of its own listed gets no mark: not on a row of the branch it split from
  assert.deepEqual(rowMarks(t, [st("a1b2c3d4", "approval")], [{ id: "main:1" }]), {});
  assert.deepEqual(rowMarks(t, [st("main", "writing"), st("a1b2c3d4", "approval")], [{ id: "main:3" }]), { "main:3": { mark: "running", branch: "main", subs: 0 } });
  assert.deepEqual(rowMarks(t, [st("main", "writing"), st("a1b2c3d4", "approval")], []), {});
  // two branches moved to one row: the order of the marks holds there too
  const ts = buildTree({ current: "b2", branches: [
    { id: "main", at: 0, len: 4, items: [{ i: 0, kind: "user", text: "ask", before: 0, ok: true }, { i: 1, kind: "text", text: "reply", done: true, end: 2, ok: true }, { i: 2, kind: "user", text: "more", before: 2, ok: true }] },
    { id: "b2", from: "main", at: 4, len: 4, items: [] },
  ], labels: [] });
  assert.deepEqual(rowMarks(ts, [st("main", "writing"), st("b2", "approval")], [{ id: "main:1" }]), { "main:1": { mark: "approval", branch: "b2", subs: 0 } });
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
  // a fork link's row is picked by its own id
  const linked = rows(t, { filter: "default", links: [{ chat: "f1", title: "a fork", archived: false, where: "entry", entry: "main:1" }] });
  assert.equal(pickedRow(t, linked, "fork:f1"), "fork:f1");
  assert.equal(pickedRow(t, all, "fork:f1"), null);
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
