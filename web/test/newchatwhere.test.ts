// ⌘N: the key, and the place of the chat it makes for each selection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isNewChatKey, newChatPlace, newChatWhere, type NewChatStore } from "../src/logic/newchatwhere.ts";
import { reachable } from "../src/logic/sections.ts";
import { ungroupedOn } from "../src/logic/keys.ts";
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

// The same ids in the section of the server s_1: its group g_1, its board b_1 and its run r_1 are that server's own.
const far = {
  "s_1~c_plain": { group: "s_1~g_1" },
  "s_1~c_loose": { group: "s_1~__ungrouped__" },
  "s_1~c_nowhere": {},
  "s_1~c_board": { group: "s_1~g_1", board: "s_1~b_1" },
  "s_1~c_run": { group: "s_1~g_1", run: "s_1~r_1" },
};

test("a chat of a section: the new chat goes in that chat's group on that server, never in the local one with the same id", () => {
  const all = { ...chats, ...far };
  assert.deepEqual(newChatWhere({ ...NO_SEL, chat: "s_1~c_plain" }, all), { group: "s_1~g_1" });
  assert.deepEqual(newChatWhere({ ...NO_SEL, chat: "s_1~c_loose" }, all), { group: "s_1~__ungrouped__" });
  assert.deepEqual(newChatWhere({ ...NO_SEL, chat: "s_1~c_board" }, all), { board: "s_1~b_1" });
  assert.deepEqual(newChatWhere({ ...NO_SEL, board: "s_1~b_1" }, all), { board: "s_1~b_1" });
  assert.deepEqual(newChatWhere({ ...NO_SEL, run: "s_1~r_1", chat: "s_1~c_run" }, all), { run: "s_1~r_1" });
  assert.deepEqual(newChatWhere({ ...NO_SEL, run: "s_1~r_1" }, all), { run: "s_1~r_1" });
});

test("a chat in no group of a section: the new chat goes to the ungrouped area of that server", () => {
  const all = { ...chats, ...far, c_nowhere: {} };
  assert.equal(ungroupedOn("s_1"), "s_1~__ungrouped__");
  assert.deepEqual(newChatWhere({ ...NO_SEL, chat: "s_1~c_nowhere" }, all), { group: "s_1~__ungrouped__" });
  assert.deepEqual(newChatWhere({ ...NO_SEL, chat: "c_nowhere" }, all), { group: UNGROUPED }, "of this computer: this computer's");
  // a chat of a section that the store does not hold counts as none: with nothing, ungrouped on this computer
  assert.deepEqual(newChatWhere({ ...NO_SEL, chat: "s_1~c_gone" }, all), { group: UNGROUPED });
});

test("nothing selected, or a chat that is gone: ungrouped", () => {
  assert.deepEqual(newChatWhere(NO_SEL, chats), { group: UNGROUPED });
  assert.deepEqual(newChatWhere({ ...NO_SEL, chat: "c_gone" }, chats), { group: UNGROUPED });
  assert.deepEqual(newChatWhere({ ...NO_SEL, board: "b_2", chat: "c_gone" }, chats), { board: "b_2" });
});

const T = "2026-01-02T03:04:05Z";
/** The store as ⌘N reads it. s_1 is connected (the local server holds its tree), s_2 is not; `gone` marks what its
 *  server no longer has. reachable is the page's own rule (logic/sections.ts). */
const store = (sel: Partial<NewChatStore["sel"]>, over: Partial<NewChatStore> & { sections?: Record<string, unknown>; gone?: Record<string, true> } = {}): NewChatStore => {
  const sections = (over.sections ?? { s_1: {} }) as Parameters<typeof reachable>[0]["sections"];
  const gone = over.gone ?? { "s_1~b_gone": true, "s_1~r_gone": true };
  return {
    sel: { ...NO_SEL, ...sel },
    chats: { ...chats, ...far, c_arch: { group: "g_arch" }, c_board_arch: { group: "g_1", board: "b_arch" }, c_run_arch: { group: "g_1", run: "r_arch" },
      "s_1~c_arch": { group: "s_1~g_arch" }, "s_2~c_plain": { group: "s_2~g_1" }, "s_2~c_nowhere": {}, "s_2~c_board": { board: "s_2~b_1" } },
    groups: [{ id: "g_1" }, { id: "g_arch", archived: true }, { id: "s_1~g_1" }, { id: "s_1~g_arch", archived: true }],
    boards: { b_1: {}, b_arch: { archived: true }, "s_1~b_1": {}, "s_1~b_arch": { archived: true }, "s_1~b_gone": {}, "s_2~b_1": {} },
    runs: {
      r_1: { started: T }, r_draft: {}, r_arch: { started: T, archived: true },
      "s_1~r_1": { started: T }, "s_1~r_draft": {}, "s_1~r_arch": { archived: true }, "s_1~r_gone": { started: T }, "s_2~r_1": { started: T },
    } as NewChatStore["runs"],
    reachable: (key) => reachable({ sections, gone }, key),
    ...over,
  };
};

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
  assert.equal(newChatPlace(store({ run: "s_1~r_arch" })), null);
});

test("the place: none on an archived board", () => {
  assert.equal(newChatPlace(store({ board: "b_arch" })), null);
  assert.equal(newChatPlace(store({ chat: "c_board_arch" })), null); // the chat used without its board
  assert.equal(newChatPlace(store({ board: "s_1~b_arch" })), null);
});

test("the place: in a connected section the chat is made where the user is, on that server", () => {
  assert.deepEqual(newChatPlace(store({ chat: "s_1~c_plain" })), { group: "s_1~g_1" });
  assert.deepEqual(newChatPlace(store({ chat: "s_1~c_loose" })), { group: "s_1~__ungrouped__" });
  assert.deepEqual(newChatPlace(store({ chat: "s_1~c_nowhere" })), { group: "s_1~__ungrouped__" });
  assert.deepEqual(newChatPlace(store({ board: "s_1~b_1" })), { board: "s_1~b_1" });
  assert.deepEqual(newChatPlace(store({ chat: "s_1~c_board" })), { board: "s_1~b_1" });
  assert.deepEqual(newChatPlace(store({ run: "s_1~r_1" })), { run: "s_1~r_1" });
  // a run made in a section is on that server before it starts: it takes a chat as a local draft does
  assert.deepEqual(newChatPlace(store({ run: "s_1~r_draft" })), { run: "s_1~r_draft" });
  assert.equal(newChatPlace(store({ chat: "s_1~c_arch" })), null, "none in an archived group of that server");
});

test("the place: none in a section whose server is not connected: there is nothing to make it from", () => {
  assert.equal(newChatPlace(store({ chat: "s_2~c_plain" })), null, "in a group");
  assert.equal(newChatPlace(store({ chat: "s_2~c_nowhere" })), null, "in that server's ungrouped area");
  assert.equal(newChatPlace(store({ board: "s_2~b_1" })), null);
  assert.equal(newChatPlace(store({ chat: "s_2~c_board" })), null);
  assert.equal(newChatPlace(store({ run: "s_2~r_1" })), null);
  // the same places once the local server no longer holds the tree of s_1 either
  const down = { sections: {} };
  assert.equal(newChatPlace(store({ chat: "s_1~c_plain" }, down)), null);
  assert.equal(newChatPlace(store({ chat: "s_1~c_loose" }, down)), null);
  assert.equal(newChatPlace(store({ board: "s_1~b_1" }, down)), null);
  assert.equal(newChatPlace(store({ run: "s_1~r_1" }, down)), null);
  // this computer's places are untouched by any of it
  assert.deepEqual(newChatPlace(store({ chat: "c_plain" }, down)), { group: "g_1" });
  assert.deepEqual(newChatPlace(store({ board: "b_1" }, down)), { board: "b_1" });
  assert.deepEqual(newChatPlace(store({}, down)), { group: UNGROUPED });
  // and once the tree of s_2 is here, its places offer a chat
  const up = { sections: { s_1: {}, s_2: {} } };
  assert.deepEqual(newChatPlace(store({ chat: "s_2~c_plain" }, up)), { group: "s_2~g_1" });
  assert.deepEqual(newChatPlace(store({ chat: "s_2~c_nowhere" }, up)), { group: "s_2~__ungrouped__" });
  assert.deepEqual(newChatPlace(store({ board: "s_2~b_1" }, up)), { board: "s_2~b_1" });
});

test("the place: none on a board or a run its server no longer has, on screen as it still is", () => {
  assert.equal(newChatPlace(store({ board: "s_1~b_gone" })), null);
  assert.equal(newChatPlace(store({ run: "s_1~r_gone" })), null);
  assert.deepEqual(newChatPlace(store({ board: "s_1~b_gone" }, { gone: {} })), { board: "s_1~b_gone" });
  assert.deepEqual(newChatPlace(store({ run: "s_1~r_gone" }, { gone: {} })), { run: "s_1~r_gone" });
});

test("the place asks the store whether the place is reachable, by the place's own key", () => {
  const asked: string[] = [];
  const ask = (key: string) => { asked.push(key); return false; };
  assert.equal(newChatPlace(store({ board: "b_1" }, { reachable: ask })), null);
  assert.equal(newChatPlace(store({ run: "r_1" }, { reachable: ask })), null);
  assert.equal(newChatPlace(store({ chat: "s_1~c_plain" }, { reachable: ask })), null);
  assert.equal(newChatPlace(store({}, { reachable: ask })), null);
  assert.deepEqual(asked, ["b_1", "r_1", "s_1~g_1", UNGROUPED]);
  // the page hands ⌘N every group it knows, and the rule of logic/sections.ts
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.ok(app.includes("const where = newChatPlace({ sel: s.sel, chats: s.chats, boards: s.boards, runs: s.runs, groups: [...s.groups, ...Object.values(s.sections).flatMap((x) => x.groups)], reachable: (key) => reachable(s, key) });"));
});

test("the place: none in an archived group, or on a board or run the store does not hold", () => {
  assert.equal(newChatPlace(store({ chat: "c_arch" })), null);
  assert.equal(newChatPlace(store({ board: "b_none" })), null);
  assert.equal(newChatPlace(store({ run: "r_none" })), null);
  assert.equal(newChatPlace(store({ board: "s_1~b_none" })), null);
  assert.equal(newChatPlace(store({ run: "s_1~r_none" })), null);
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
