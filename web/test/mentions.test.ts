import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMentions, resolveMentions, resolveName, openMention, mentionOptions } from "../src/logic/mentions.ts";
import type { Board, Group } from "../src/types.ts";
import { UNGROUPED } from "../src/types.ts";

const board = (id: string, name: string, group = UNGROUPED, archived = false): Board =>
  ({ id, name, group, created: "2026-09-01T00:00:00Z", ...(archived ? { archived: true, archiveOp: "op1" } : {}) });

const boards: Record<string, Board> = Object.fromEntries([
  board("b_arch0001", "arch", "g_one"),
  board("b_flow0001", "flows", "g_one"),
  board("b_flow0002", "flows", "g_two"),
  board("b_old00001", "old", UNGROUPED, true),
].map((b) => [b.id, b]));
const groups: Group[] = [{ id: "g_one", name: "One" }, { id: "g_two", name: "Two" }];
const ids = (bs: Board[]) => bs.map((b) => b.id);

test("@arch resolves", () => {
  assert.deepEqual(parseMentions("look at @arch please"), ["arch"]);
  assert.deepEqual(ids(resolveMentions("look at @arch please", boards)), ["b_arch0001"]);
});

test("@arch. (trailing punctuation) resolves", () => {
  assert.deepEqual(parseMentions("see @arch."), ["arch"]);
  assert.deepEqual(ids(resolveMentions("see @arch.", boards)), ["b_arch0001"]);
  assert.deepEqual(ids(resolveMentions("see @arch, then", boards)), ["b_arch0001"]);
});

test("@arch.excalidraw resolves", () => {
  assert.deepEqual(ids(resolveMentions("see @arch.excalidraw", boards)), ["b_arch0001"]);
});

test("unknown names resolve to nothing", () => {
  assert.deepEqual(ids(resolveMentions("mail @someone about @nothing", boards)), []);
  assert.deepEqual(resolveName("nothing", boards), []);
});

test("archived boards are excluded", () => {
  assert.deepEqual(ids(resolveMentions("see @old", boards)), []);
  assert.deepEqual(ids(resolveMentions("see @old", boards, [{ name: "old", id: "b_old00001" }])), []);
  assert.deepEqual(mentionOptions("o", boards, groups).map((o) => o.board.id), ["b_flow0001", "b_flow0002"]);
});

test("a picked mention resolves by id", () => {
  const picked = [{ name: "flows", id: "b_flow0002" }];
  assert.deepEqual(ids(resolveMentions("compare @flows with @arch", boards, picked)), ["b_flow0002", "b_arch0001"]);
});

test("a picked mention no longer in the text is dropped", () => {
  const picked = [{ name: "flows", id: "b_flow0002" }];
  assert.deepEqual(ids(resolveMentions("just @arch", boards, picked)), ["b_arch0001"]);
});

test("a typed name shared by two boards gives both", () => {
  assert.deepEqual(ids(resolveMentions("compare @flows", boards)), ["b_flow0001", "b_flow0002"]);
});

test("duplicates are listed once", () => {
  assert.deepEqual(ids(resolveMentions("@arch and @arch.", boards)), ["b_arch0001"]);
});

test("the mention being typed at the caret", () => {
  assert.deepEqual(openMention("look at @ar"), { q: "ar", at: 8 });
  assert.deepEqual(openMention("@"), { q: "", at: 0 });
  assert.equal(openMention("mail a@b"), null);
  assert.equal(openMention("look at @ar "), null);
});

test("the @ list names each board's group", () => {
  assert.deepEqual(
    mentionOptions("fl", boards, groups).map((o) => [o.board.id, o.group]),
    [["b_flow0001", "One"], ["b_flow0002", "Two"]],
  );
});
