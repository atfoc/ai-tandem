// A board's sidebar row (src/logic/boardrow.ts): the server's name after the title, the items of
// the row's menu, the texts; and the server choice of a chat on a board (serverChoice with the
// board's server). The components are read as source (the unit tests have no DOM).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ApiError } from "../src/api.ts";
import { BOARD_MENU_LABEL, boardDeleteRefused, boardMenu, boardRow, isUnreachable, moveTargets } from "../src/logic/boardrow.ts";
import { BOARD_LOCAL, BOARD_SERVER, serverChoice } from "../src/logic/serverlists.ts";
import { LOCAL_ENTRY, stateLabel, type ServerState, type ServerView } from "../src/logic/servers.ts";
import { UNGROUPED, type Board, type ChatView, type Group } from "../src/types.ts";

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const entry = (id: string, state: ServerState, name = "Studio"): ServerView => ({ id, name, state });
const board = (o: Partial<Board> = {}) => ({ id: "b_1", name: "Plan", group: "ungrouped", created: "2026-01-01T00:00:00Z", ...o }) as Board;
const lists = (state: ServerState = "connected") => ({ servers: [LOCAL_ENTRY, entry("s_1", state)] });
const chat = (o: Partial<ChatView> = {}) => ({ id: "c_1", agent: "claude", locked: false, ...o }) as ChatView;

test("boardRow: a board of this computer names no server", () => {
  assert.deepEqual(boardRow(board(), lists()), { server: null, off: false, gone: false });
  assert.deepEqual(boardRow(board({ server: "" }), lists("unreachable")), { server: null, off: false, gone: false });
  assert.deepEqual(boardRow(board(), {}), { server: null, off: false, gone: false });
});

test("boardRow: a board on a connected server has the server's name, not grey", () => {
  assert.deepEqual(boardRow(board({ server: "s_1" }), lists()), { server: "Studio", off: false, gone: false });
});

test("boardRow: while the server is not connected the name is grey and says so", () => {
  for (const state of ["connecting", "unreachable", "secret_not_accepted", "too_old"] as ServerState[]) {
    assert.deepEqual(boardRow(board({ server: "s_1" }), lists(state)), { server: "Studio", off: true, gone: false, title: "Studio is not connected" }, state);
  }
  // an entry the list no longer has
  assert.deepEqual(boardRow(board({ server: "s_9" }), lists()), { server: "Unknown server", off: true, gone: false, title: "Unknown server is not connected" });
});

test("boardRow: a board its server no longer has is gone, whatever the server's state", () => {
  for (const state of ["connected", "unreachable"] as ServerState[]) {
    assert.deepEqual(boardRow(board({ server: "s_1", gone: true }), lists(state)), { server: "Studio", off: false, gone: true, title: "No longer on Studio" }, state);
  }
});

test("boardMenu: a board of this computer has today's items in today's order", () => {
  assert.deepEqual(boardMenu(board()), ["rename", "reveal", "archive", "delete"]);
  assert.deepEqual(boardMenu(board({ archived: true })), ["unarchive", "delete"]);
  assert.deepEqual(boardMenu(board({ gone: true })), ["rename", "reveal", "archive", "delete"], "gone is only of a board on another server");
  // the same as the row's menu is written today
  const node = src("Sidebar.tsx");
  const menu = node.slice(node.indexOf("const BoardNode"), node.indexOf("<div className={`side-board"));
  if (!menu.includes("boardMenu(")) {
    const labels = [...menu.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(labels, [...boardMenu(board({ archived: true })), ...boardMenu(board())].map((i) => BOARD_MENU_LABEL[i]));
  }
});

test("boardMenu: a board on another server is renamed, moved, archived and deleted, never revealed", () => {
  assert.deepEqual(boardMenu(board({ server: "s_1" })), ["rename", "move", "archive", "delete"]);
  assert.deepEqual(boardMenu(board({ server: "s_1", archived: true })), ["unarchive", "delete"]);
});

test("boardMenu: a gone board can only be removed from this sidebar", () => {
  assert.deepEqual(boardMenu(board({ server: "s_1", gone: true })), ["remove"]);
  assert.deepEqual(boardMenu(board({ server: "s_1", gone: true, archived: true })), ["remove"]);
});

test("the texts of the row's menu and of a refused delete", () => {
  assert.deepEqual(BOARD_MENU_LABEL, {
    rename: "Rename", move: "Move to…", reveal: "Reveal in Finder", archive: "Archive", unarchive: "Unarchive", delete: "Delete", remove: "Remove from this sidebar",
  });
  assert.equal(boardDeleteRefused("Plan", "Studio"), "“Plan” was not deleted: it is on Studio, which is not connected.");
  assert.equal(BOARD_SERVER, "A chat on a board is on the board's server");
  assert.equal(BOARD_LOCAL, "Boards and their chats are on this computer");
});

test("isUnreachable: the 503 of a call, and nothing else", () => {
  assert.equal(isUnreachable(new ApiError(503, "Studio is not connected.", true, "server_unreachable")), true);
  assert.equal(isUnreachable(new ApiError(503, "Service Unavailable", false)), true);
  for (const e of [new ApiError(504, "no answer", true, "no_answer"), new ApiError(404, "gone", true, "gone_there"), new ApiError(409, "x", true, "server_connected"),
    new Error("Failed to fetch"), { status: 503 }, "503", null, undefined]) assert.equal(isUnreachable(e), false, String(e));
});

test("serverChoice: a chat on a board of another server shows only that server and says why", () => {
  const servers = [LOCAL_ENTRY, entry("s_1", "connected"), entry("s_2", "connected", "Lab")];
  assert.deepEqual(serverChoice(servers, chat({ board: "b_1", server: "s_1" }), "s_1"), { options: [{ id: "s_1", label: "Studio" }], fixed: BOARD_SERVER });
  assert.deepEqual(serverChoice(servers, chat({ board: "b_1" }), "s_2").options, [{ id: "s_2", label: "Lab" }]);
  // started, forked or unconfirmed: the place comes first
  for (const o of [{ locked: true }, { forkedFrom: "c_0" }, { start: "unconfirmed" as const }]) {
    assert.equal(serverChoice(servers, chat({ board: "b_1", server: "s_1", ...o }), "s_1").fixed, BOARD_SERVER, JSON.stringify(o));
  }
  // the one option keeps the entry's state as its reason; an entry the list lacks is still the only option
  assert.deepEqual(serverChoice([LOCAL_ENTRY, entry("s_1", "unreachable")], chat({ board: "b_1" }), "s_1").options, [{ id: "s_1", label: "Studio", reason: stateLabel("unreachable") }]);
  assert.deepEqual(serverChoice([LOCAL_ENTRY], chat({ board: "b_1" }), "s_9"), { options: [{ id: "s_9", label: "Unknown server" }], fixed: BOARD_SERVER });
});

test("serverChoice: with no board server a chat's choice is as it was", () => {
  const servers = [LOCAL_ENTRY, entry("s_1", "connected")];
  const all = [{ id: "local", label: "This computer" }, { id: "s_1", label: "Studio" }];
  assert.deepEqual(serverChoice(servers, chat({ board: "b_1" })), { options: all, fixed: BOARD_LOCAL });
  assert.deepEqual(serverChoice(servers, chat({ board: "b_1" }), undefined), { options: all, fixed: BOARD_LOCAL });
  assert.deepEqual(serverChoice(servers, chat({ board: "b_1" }), "local"), { options: all, fixed: BOARD_LOCAL });
  assert.deepEqual(serverChoice(servers, chat({ board: "b_1" }), ""), { options: all, fixed: BOARD_LOCAL });
  // a board server says nothing of a chat on no board
  assert.deepEqual(serverChoice(servers, chat(), "s_1"), { options: all, fixed: "" });
  assert.deepEqual(serverChoice(servers, chat()), { options: all, fixed: "" });
});

test("moveTargets: the ungrouped area and every group that is not archived, never where the board is", () => {
  const groups = [{ id: "g_1", name: "Work" }, { id: "g_2", name: "Plans", parent: "g_1" }, { id: "g_3", name: "Old", archived: true }] as Group[];
  assert.deepEqual(moveTargets(groups, UNGROUPED), [{ id: "g_1", label: "Work" }, { id: "g_2", label: "Work / Plans" }]);
  assert.deepEqual(moveTargets(groups, "g_2"), [{ id: UNGROUPED, label: "Ungrouped" }, { id: "g_1", label: "Work" }]);
  assert.deepEqual(moveTargets([], UNGROUPED), [], "nowhere to move to");
});

test("the components: BoardTag shows boardRow, and the chat's choices read the board's server", () => {
  const tag = src("BoardTag.tsx"), choices = src("ChatChoices.tsx"), css = src("boardrow.css");
  assert.ok(/export function BoardTag\(\{ board \}: \{ board: Board \}\)/.test(tag));
  assert.ok(tag.includes("boardRow(board, { servers })") && tag.includes("if (!row.server) return null;"), "nothing for a board of this computer");
  assert.ok(tag.includes('${row.off ? "off" : ""}') && tag.includes("title={row.title}") && tag.includes("{row.server}"));
  assert.ok(/\.board-tag\.off[^{]*\{[^}]*color:/.test(css), "grey while the server is not connected");
  assert.ok(choices.includes("s.boards[c.board]?.server"), "the board's server is the store's");
  assert.ok(choices.includes("serverChoice(servers, c, useBoardServer(c))"));
  assert.ok(choices.includes("serverOf(c?.server ? c : { server: onBoard })"), "agents and folders are read by the board's server");
});
