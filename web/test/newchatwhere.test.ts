// ⌘N: the key, and the place of the chat it makes for each selection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isNewChatKey, newChatPlace, newChatWhere, type NewChatStore } from "../src/logic/newchatwhere.ts";
import { NO_SEL } from "../src/logic/sel.ts";
import { UNGROUPED } from "../src/types.ts";

const chats = {
  c_plain: { group: "g_1" },
  c_loose: { group: UNGROUPED },
  c_board: { group: "g_1", board: "b_1" },
  c_run: { group: "g_1", run: "r_1" },
};

test("a chat of a group: the new chat goes in that group", () => {
  assert.deepEqual(newChatWhere({ ...NO_SEL, chat: "c_plain" }, chats), { group: "g_1" });
  assert.deepEqual(newChatWhere({ ...NO_SEL, chat: "c_loose" }, chats), { group: UNGROUPED });
});

test("a board, or a chat on it: the new chat goes on that board", () => {
  assert.deepEqual(newChatWhere({ ...NO_SEL, board: "b_1" }, chats), { board: "b_1" });
  assert.deepEqual(newChatWhere({ ...NO_SEL, board: "b_1", chat: "c_board" }, chats), { board: "b_1" });
  assert.deepEqual(newChatWhere({ ...NO_SEL, chat: "c_board" }, chats), { board: "b_1" }); // the chat used without its board
});

test("a run, or a chat on it: the new chat goes on that run", () => {
  assert.deepEqual(newChatWhere({ ...NO_SEL, run: "r_1" }, chats), { run: "r_1" });
  assert.deepEqual(newChatWhere({ ...NO_SEL, run: "r_1", chat: "c_run" }, chats), { run: "r_1" });
});

test("nothing selected, or a chat that is gone: ungrouped", () => {
  assert.deepEqual(newChatWhere(NO_SEL, chats), { group: UNGROUPED });
  assert.deepEqual(newChatWhere({ ...NO_SEL, chat: "c_gone" }, chats), { group: UNGROUPED });
  assert.deepEqual(newChatWhere({ ...NO_SEL, board: "b_2", chat: "c_gone" }, chats), { board: "b_2" });
});

const T = "2026-01-02T03:04:05Z";
const store = (sel: Partial<NewChatStore["sel"]>, over: Partial<NewChatStore> = {}): NewChatStore => ({
  sel: { ...NO_SEL, ...sel },
  chats: { ...chats, c_arch: { group: "g_arch" }, c_board_arch: { group: "g_1", board: "b_arch" }, c_run_arch: { group: "g_1", run: "r_arch" } },
  groups: [{ id: "g_1" }, { id: "g_arch", archived: true }],
  boards: { b_1: {}, b_arch: { archived: true }, b_far: { server: "s_1" }, b_far_arch: { server: "s_1", archived: true }, b_far_gone: { server: "s_1", gone: true } },
  runs: {
    r_1: { started: T }, r_draft: {}, r_arch: { started: T, archived: true },
    r_far: { server: "s_1", started: T }, r_far_draft: { server: "s_1" }, r_far_gone: { server: "s_1", started: T, gone: true },
  },
  ...over,
});

test("the place: where the buttons offer a chat, the same place as before", () => {
  assert.deepEqual(newChatPlace(store({})), { group: UNGROUPED });
  assert.deepEqual(newChatPlace(store({ chat: "c_gone" })), { group: UNGROUPED });
  assert.deepEqual(newChatPlace(store({ chat: "c_plain" })), { group: "g_1" });
  assert.deepEqual(newChatPlace(store({ chat: "c_loose" })), { group: UNGROUPED });
  assert.deepEqual(newChatPlace(store({ board: "b_1" })), { board: "b_1" });
  assert.deepEqual(newChatPlace(store({ board: "b_1", chat: "c_board" })), { board: "b_1" });
  assert.deepEqual(newChatPlace(store({ chat: "c_board" })), { board: "b_1" });
  assert.deepEqual(newChatPlace(store({ run: "r_1" })), { run: "r_1" });
  assert.deepEqual(newChatPlace(store({ run: "r_1", chat: "c_run" })), { run: "r_1" });
  assert.deepEqual(newChatPlace(store({ run: "r_draft" })), { run: "r_draft" }); // a draft on this computer
});

test("the place: none on an archived run", () => {
  assert.equal(newChatPlace(store({ run: "r_arch" })), null);
  assert.equal(newChatPlace(store({ run: "r_arch", chat: "c_run_arch" })), null);
});

test("the place: none on an archived board", () => {
  assert.equal(newChatPlace(store({ board: "b_arch" })), null);
  assert.equal(newChatPlace(store({ chat: "c_board_arch" })), null); // the chat used without its board
  assert.equal(newChatPlace(store({ board: "b_far_arch" })), null);
});

test("the place: none on an unstarted run on another server, one on a started run there", () => {
  assert.equal(newChatPlace(store({ run: "r_far_draft" })), null);
  assert.deepEqual(newChatPlace(store({ run: "r_far" })), { run: "r_far" });
});

test("the place: a board on another server offers a chat unless it is archived or gone there", () => {
  assert.deepEqual(newChatPlace(store({ board: "b_far" })), { board: "b_far" });
  assert.equal(newChatPlace(store({ board: "b_far_gone" })), null);
  assert.equal(newChatPlace(store({ run: "r_far_gone" })), null);
});

test("the place: none in an archived group, or on a board or run the store does not hold", () => {
  assert.equal(newChatPlace(store({ chat: "c_arch" })), null);
  assert.equal(newChatPlace(store({ board: "b_none" })), null);
  assert.equal(newChatPlace(store({ run: "r_none" })), null);
});

test("the shortcut: ⌘N on macOS, Ctrl+N elsewhere, with nothing else held", () => {
  const k = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, code: "KeyN" };
  assert.ok(isNewChatKey({ ...k, metaKey: true }, "MacIntel"));
  assert.ok(isNewChatKey({ ...k, ctrlKey: true }, "Win32"));
  assert.ok(isNewChatKey({ ...k, ctrlKey: true }, ""));
  assert.ok(!isNewChatKey({ ...k, ctrlKey: true }, "MacIntel")); // the caret's line down
  assert.ok(!isNewChatKey({ ...k, metaKey: true }, "Win32"));
  assert.ok(!isNewChatKey(k, "MacIntel"));
  assert.ok(!isNewChatKey({ ...k, metaKey: true, shiftKey: true }, "MacIntel"));
  assert.ok(!isNewChatKey({ ...k, metaKey: true, altKey: true }, "MacIntel"));
  assert.ok(!isNewChatKey({ ...k, ctrlKey: true, shiftKey: true }, "Win32"));
  assert.ok(!isNewChatKey({ ...k, ctrlKey: true, altKey: true }, "Win32"));
  assert.ok(!isNewChatKey({ ...k, metaKey: true, code: "KeyJ" }, "MacIntel"));
});
