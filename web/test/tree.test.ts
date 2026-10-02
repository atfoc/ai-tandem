import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTree, boardChats, contents, groupPath, subtree } from "../src/logic/tree.ts";
import type { Board, ChatView, Group } from "../src/types.ts";
import { UNGROUPED } from "../src/types.ts";

const usage = { ctxIn: 0, ctxOut: 0, ctxWindow: 0, turns: 0 };
const arch = (x: boolean) => (x ? { archived: true, archiveOp: "op1" } : {});
const board = (id: string, name: string, group: string, archived = false): Board =>
  ({ id, name, group, created: "2026-09-01T00:00:00Z", ...arch(archived) });
const chat = (id: string, created: string, where: { group?: string; board?: string }, archived = false): ChatView =>
  ({ id, agent: "claude", cwd: "/tmp", model: "sonnet", locked: false, created, usage, status: "ready", ...where, ...arch(archived) });
const byId = <T extends { id: string }>(xs: T[]) => Object.fromEntries(xs.map((x) => [x.id, x]));
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

const groups: Group[] = [{ id: "g_b", name: "Second" }, { id: "g_a", name: "First" }, { id: "g_x", name: "Old", archived: true, archiveOp: "op9" }];
const boards = byId([
  board("b_zeta", "zeta", "g_a"),
  board("b_alpha", "alpha", "g_a"),
  board("b_alpha2", "alpha", "g_a"),
  board("b_loose", "loose", UNGROUPED),
  board("b_lost", "lost", "g_gone"),
  board("b_arch", "archived", "g_b", true),
  board("b_inold", "inold", "g_x", true),
]);
const chats = byId([
  chat("c_old", "2026-09-01T00:00:00Z", { group: "g_a" }),
  chat("c_new", "2026-09-03T00:00:00Z", { group: "g_a" }),
  chat("c_mid", "2026-09-02T00:00:00Z", { group: "g_a" }),
  chat("c_loose", "2026-09-01T00:00:00Z", { group: UNGROUPED }),
  chat("c_lost", "2026-09-01T00:00:00Z", { group: "g_gone" }),
  chat("c_arch", "2026-09-01T00:00:00Z", { group: "g_b" }, true),
  chat("c_board1", "2026-09-01T00:00:00Z", { board: "b_zeta" }),
  chat("c_board2", "2026-09-05T00:00:00Z", { board: "b_zeta" }),
  chat("c_board3", "2026-09-04T00:00:00Z", { board: "b_zeta" }, true),
]);
const s = { groups, boards, chats };

test("grouping, in the user's group order", () => {
  const t = buildTree(s, false);
  assert.deepEqual(t.groups.map((g) => g.group.id), ["g_b", "g_a"]);
  const a = t.groups[1];
  assert.deepEqual(ids(a.boards), ["b_alpha", "b_alpha2", "b_zeta"]);
  assert.deepEqual(ids(a.chats), ["c_new", "c_mid", "c_old"]);
});

test("ungrouped and unknown groups fall into loose", () => {
  const t = buildTree(s, false);
  assert.deepEqual(ids(t.loose.boards), ["b_loose", "b_lost"]);
  assert.deepEqual(ids(t.loose.chats), ["c_loose", "c_lost"].sort());
});

test("archived items are hidden", () => {
  const t = buildTree(s, false);
  assert.ok(!t.groups.some((g) => g.group.id === "g_x"));
  assert.deepEqual(ids(t.groups[0].boards), []);
  assert.deepEqual(ids(t.groups[0].chats), []);
  assert.ok(![...t.loose.boards, ...t.groups.flatMap((g) => g.boards)].some((b) => b.archived));
});

test("archived items are shown in place", () => {
  const t = buildTree(s, true);
  assert.deepEqual(t.groups.map((g) => g.group.id), ["g_b", "g_a", "g_x"]);
  assert.deepEqual(ids(t.groups[0].boards), ["b_arch"]);
  assert.deepEqual(ids(t.groups[0].chats), ["c_arch"]);
  assert.deepEqual(ids(t.groups[2].boards), ["b_inold"]);
  assert.deepEqual(ids(t.loose.boards), ["b_loose", "b_lost"]);
});

test("a board chat with instructionsSent still appears when archived are hidden", () => {
  const chats = byId([
    chat("c_live", "2026-09-05T00:00:00Z", { board: "b_zeta" }),
    { ...chat("c_legacy", "2026-09-04T00:00:00Z", { board: "b_zeta" }), instructionsSent: true },
    chat("c_arch", "2026-09-03T00:00:00Z", { board: "b_zeta" }, true),
  ]);
  assert.deepEqual(ids(boardChats(chats, "b_zeta", false)), ["c_live", "c_legacy"]);
});

test("board chats only under their board, newest first", () => {
  for (const show of [false, true]) {
    const t = buildTree(s, show);
    const all = [...t.loose.chats, ...t.groups.flatMap((g) => g.chats)];
    assert.ok(!all.some((c) => c.board), "no board chat among plain chats");
  }
  assert.deepEqual(ids(boardChats(chats, "b_zeta", false)), ["c_board2", "c_board1"]);
  assert.deepEqual(ids(boardChats(chats, "b_zeta", true)), ["c_board2", "c_board3", "c_board1"]);
  assert.deepEqual(boardChats(chats, "b_alpha", true), []);
});

// Work > Infra > Deep, Work > Old (archived), Loose top; Orphan's parent is gone.
const nested: Group[] = [
  { id: "g_deep", name: "Deep", parent: "g_infra" },
  { id: "g_work", name: "Work" },
  { id: "g_infra", name: "Infra", parent: "g_work" },
  { id: "g_old", name: "Old", parent: "g_work", archived: true, archiveOp: "op2" },
  { id: "g_oldkid", name: "Old kid", parent: "g_old", archived: true, archiveOp: "op2" },
  { id: "g_orphan", name: "Orphan", parent: "g_gone" },
];
const ns = {
  groups: nested,
  boards: byId([board("b_w", "w", "g_work"), board("b_i", "i", "g_infra"), board("b_d", "d", "g_deep"), board("b_ok", "ok", "g_oldkid", true)]),
  chats: byId([chat("c_d", "2026-09-01T00:00:00Z", { group: "g_deep" }), chat("c_i", "2026-09-01T00:00:00Z", { group: "g_infra" })]),
};

test("subgroups nest under their parent, in the user's order", () => {
  const t = buildTree(ns, false);
  assert.deepEqual(t.groups.map((g) => g.group.id), ["g_work", "g_orphan"]);
  const work = t.groups[0];
  assert.deepEqual(work.children.map((g) => g.group.id), ["g_infra"]);
  const infra = work.children[0];
  assert.deepEqual(ids(infra.boards), ["b_i"]);
  assert.deepEqual(ids(infra.chats), ["c_i"]);
  assert.deepEqual(infra.children.map((g) => g.group.id), ["g_deep"]);
  assert.deepEqual(ids(infra.children[0].boards), ["b_d"]);
});

test("an archived group hides its subgroups; shown archived, they are in place", () => {
  assert.ok(!JSON.stringify(buildTree(ns, false)).includes("g_oldkid"));
  const work = buildTree(ns, true).groups[0];
  assert.deepEqual(work.children.map((g) => g.group.id), ["g_infra", "g_old"]);
  assert.deepEqual(work.children[1].children.map((g) => g.group.id), ["g_oldkid"]);
  assert.deepEqual(ids(work.children[1].children[0].boards), ["b_ok"]);
});

test("contents counts the whole subtree", () => {
  const work = buildTree(ns, false).groups[0];
  const c = contents(work);
  assert.deepEqual(ids(c.boards).sort(), ["b_d", "b_i", "b_w"]);
  assert.deepEqual(ids(c.chats).sort(), ["c_d", "c_i"]);
});

test("subtree and groupPath", () => {
  assert.deepEqual([...subtree(nested, "g_work")].sort(), ["g_deep", "g_infra", "g_old", "g_oldkid", "g_work"]);
  assert.deepEqual([...subtree(nested, "g_deep")], ["g_deep"]);
  assert.deepEqual(groupPath(nested, "g_deep"), ["Work", "Infra", "Deep"]);
  assert.deepEqual(groupPath(nested, "g_orphan"), ["Orphan"]);
  assert.deepEqual(groupPath(nested, UNGROUPED), []);
  assert.deepEqual(groupPath(nested, "g_nope"), []);
});

test("a parent cycle in bad state doesn't hang", () => {
  const cyc: Group[] = [{ id: "g_a", name: "A", parent: "g_b" }, { id: "g_b", name: "B", parent: "g_a" }];
  assert.deepEqual(groupPath(cyc, "g_a"), ["B", "A"]);
  buildTree({ groups: cyc, boards: {}, chats: {} }, false);
});
