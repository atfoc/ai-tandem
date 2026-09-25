import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTree, boardChats } from "../src/logic/tree.ts";
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
