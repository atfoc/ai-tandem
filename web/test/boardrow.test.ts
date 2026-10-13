// A board's sidebar row (src/logic/boardrow.ts): the items of the row's menu, where "Move to…" can put the
// board, the texts; and the server of a chat on a board (serverFixed). The components are read as source
// (the unit tests have no DOM).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { BOARD_MENU_LABEL, UNGROUPED_LABEL, boardDeleteBody, boardMenu, moveTargets } from "../src/logic/boardrow.ts";
import { BOARD_SERVER, serverFixed } from "../src/logic/serverlists.ts";
import { showsServer } from "../src/logic/chatserver.ts";
import { keyOn, serverOfKey, ungroupedOn } from "../src/logic/keys.ts";
import { UNGROUPED, type Board, type ChatView, type Group } from "../src/types.ts";

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const board = (o: Partial<Board> = {}) => ({ id: "b_1", name: "Plan", group: UNGROUPED, created: "2026-01-01T00:00:00Z", ...o }) as Board;
/** The board b_1 of the section s_1: the same id as the local one, on another server. */
const far = (o: Partial<Board> = {}) => board({ id: keyOn("s_1", "b_1"), group: ungroupedOn("s_1"), ...o });
const chat = (o: Partial<ChatView> = {}) => ({ id: "c_1", agent: "claude", locked: false, ...o }) as ChatView;

test("boardMenu: a board of this computer has today's items in today's order", () => {
  assert.deepEqual(boardMenu(board()), ["rename", "reveal", "archive", "delete"]);
  assert.deepEqual(boardMenu(board({ archived: true })), ["unarchive", "delete"]);
  assert.deepEqual(boardMenu(board({ group: "g_1" })), ["rename", "reveal", "archive", "delete"], "in a group too: it is moved by a drag");
});

test("boardMenu: a board of a section is renamed, moved, archived and deleted, never revealed", () => {
  assert.equal(far().id, "s_1~b_1");
  assert.deepEqual(boardMenu(far()), ["rename", "move", "archive", "delete"]);
  assert.deepEqual(boardMenu(far({ archived: true })), ["unarchive", "delete"]);
  assert.deepEqual(boardMenu(far({ group: "s_1~g_1" })), ["rename", "move", "archive", "delete"]);
  // by the board's key alone: a view that still carried a server or a gone mark is a local board like another
  assert.deepEqual(boardMenu(board({ server: "s_1", gone: true } as Partial<Board>)), ["rename", "reveal", "archive", "delete"]);
});

test("the texts of the row's menu: no item removes a board from this sidebar only", () => {
  assert.deepEqual(BOARD_MENU_LABEL, {
    rename: "Rename", move: "Move to…", reveal: "Reveal in Finder", archive: "Archive", unarchive: "Unarchive", delete: "Delete",
  });
  assert.equal(BOARD_SERVER, "A chat on a board is on the board's server");
  const logic = src("logic/boardrow.ts");
  for (const gone of ["boardRow", "boardDeleteRefused", "isUnreachable", "remove:", "this sidebar"]) assert.ok(!logic.includes(gone), gone);
});

test("boardDeleteBody: the question before a board is deleted; a section's is removed on its server, for everyone who uses it", () => {
  assert.equal(boardDeleteBody(false), "The board file and all its chats are removed. This can't be undone.");
  assert.equal(boardDeleteBody(false, ""), "The board file and all its chats are removed. This can't be undone.");
  assert.equal(boardDeleteBody(true), "An agent is working on this board. Stop it and delete? The board file and all its chats are removed. This can't be undone.");
  assert.equal(boardDeleteBody(false, "Studio"), "The board and all its chats are removed on Studio, for everyone who uses that server. This can't be undone.");
  assert.equal(boardDeleteBody(true, "Studio"), "An agent is working on this board. Stop it and delete? The board and all its chats are removed on Studio, for everyone who uses that server. This can't be undone.");
  const side = src("Sidebar.tsx");
  assert.ok(side.includes("body: boardDeleteBody(busy.length > 0, there(b.id)),"));
  assert.ok(side.includes('actions: [{ label: "Delete", tone: "danger", run: async () => { await stopAll(busy); await flush(b.id); await api.deleteBoard(b.id); } }],'));
});

test("a chat on a board of a section names that server and says why it is fixed", () => {
  assert.equal(serverFixed(chat({ id: "s_1~c_1", board: "s_1~b_1" })), BOARD_SERVER);
  assert.equal(serverFixed(chat({ board: "b_1" })), BOARD_SERVER, "on a board of this computer the reason is the same; the chip is not shown");
  // started or forked: the place comes first
  for (const o of [{ locked: true }, { forkedFrom: "s_1~c_0" }]) assert.equal(serverFixed(chat({ id: "s_1~c_1", board: "s_1~b_1", ...o })), BOARD_SERVER, JSON.stringify(o));
  // the chip is shown for a section's chat, connected or not, and never for a chat of this computer
  assert.equal(showsServer({ server: "s_1", name: "Studio", connected: true }), true);
  assert.equal(showsServer({ server: "s_1", name: "Studio", connected: false }), true);
  assert.equal(showsServer({ server: "local", name: "This computer", connected: true }), false);
});

test("moveTargets: the ungrouped area and every group that is not archived, never where the board is", () => {
  const groups = [{ id: "g_1", name: "Work" }, { id: "g_2", name: "Plans", parent: "g_1" }, { id: "g_3", name: "Old", archived: true }] as Group[];
  assert.equal(UNGROUPED_LABEL, "Ungrouped");
  assert.deepEqual(moveTargets(groups, UNGROUPED), [{ id: "g_1", label: "Work" }, { id: "g_2", label: "Work / Plans" }]);
  assert.deepEqual(moveTargets(groups, "g_2"), [{ id: UNGROUPED, label: "Ungrouped" }, { id: "g_1", label: "Work" }]);
  assert.deepEqual(moveTargets(groups, "g_1"), [{ id: UNGROUPED, label: "Ungrouped" }, { id: "g_2", label: "Work / Plans" }]);
  assert.deepEqual(moveTargets([], UNGROUPED), [], "nowhere to move to");
  assert.deepEqual(moveTargets([], "g_9"), [{ id: UNGROUPED, label: "Ungrouped" }], "from a group the list no longer has");
});

test("moveTargets: a board of a section stays on its server: the ungrouped area offered is that server's own", () => {
  // the section's groups have the ids the local ones have: g_1 here is not g_1 there
  const there = [{ id: "s_1~g_1", name: "Shared" }, { id: "s_1~g_2", name: "Plans", parent: "s_1~g_1" }, { id: "s_1~g_3", name: "Old", archived: true }] as Group[];
  assert.equal(ungroupedOn("s_1"), "s_1~__ungrouped__");
  assert.deepEqual(moveTargets(there, "s_1~g_2"), [{ id: "s_1~__ungrouped__", label: "Ungrouped" }, { id: "s_1~g_1", label: "Shared" }]);
  assert.deepEqual(moveTargets(there, "s_1~g_1"), [{ id: "s_1~__ungrouped__", label: "Ungrouped" }, { id: "s_1~g_2", label: "Shared / Plans" }]);
  assert.deepEqual(moveTargets(there, ungroupedOn("s_1")), [{ id: "s_1~g_1", label: "Shared" }, { id: "s_1~g_2", label: "Shared / Plans" }], "from that server's ungrouped area: no ungrouped area is offered");
  assert.deepEqual(moveTargets([], ungroupedOn("s_1")), []);
  assert.deepEqual(moveTargets([], "s_1~g_9"), [{ id: "s_1~__ungrouped__", label: "Ungrouped" }]);
  assert.deepEqual(moveTargets([{ id: "s_2~g_1", name: "Elsewhere" }] as Group[], "s_2~g_1"), [{ id: "s_2~__ungrouped__", label: "Ungrouped" }], "another section's is its own");
  // every target is on the server of the group the board is in: never this computer's ungrouped area, never another section
  for (const current of ["s_1~g_1", "s_1~g_2", ungroupedOn("s_1")]) for (const t of moveTargets(there, current)) assert.equal(serverOfKey(t.id), "s_1", `${current} -> ${t.id}`);
  for (const t of moveTargets([{ id: "g_1", name: "Work" }] as Group[], "g_1")) assert.equal(serverOfKey(t.id), "local");
});

test("the sidebar's board row: the menu by the board's key, the targets from the groups of the board's own server, and no server after the name", () => {
  const side = src("Sidebar.tsx");
  assert.ok(side.includes("const groups = useStore((s) => groupsOn(s, serverOf(b)));"), "the groups of the board's own server, and of no other");
  assert.ok(side.includes(`const targets = moveTargets(groups, b.group).map((g) => ({ label: g.label, run: () => attempt("Couldn't move the board", () => api.moveBoard(b.id, g.id)) }));`));
  assert.ok(side.includes('const menu = boardMenu(b).filter((i) => i !== "move" || targets.length > 0)'), "no Move to… with nowhere to move to");
  assert.ok(side.includes("reveal: () => attempt(\"Couldn't reveal the board\", () => flush(b.id).then(() => api.reveal(b.id))),"));
  // a row inside a section carries no server name: the section says it
  for (const gone of ["BoardTag", "board-tag", "boardRow(", "remoteRow("]) assert.ok(!side.includes(gone), gone);
  for (const file of ["BoardTag.tsx", "boardrow.css", "BoardChoice.tsx", "boardchoice.css", "logic/boarddraft.ts"]) assert.equal(existsSync(new URL(`../src/${file}`, import.meta.url)), false, file);
  // the chat's choices read the server from the chat's own key, not from its board
  const choices = src("ChatChoices.tsx");
  assert.ok(choices.includes("const fixed = serverFixed(c);"));
  assert.ok(!choices.includes("s.boards[c.board]?.server") && !choices.includes("serverOnBoard"));
});
