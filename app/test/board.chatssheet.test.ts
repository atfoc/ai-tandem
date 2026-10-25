// The Chats sheet's rows (screens/board/chatsrows.ts, package B1): the head's sub-line, whether "New chat on this board" is offered, a
// chat's second line and the row's accessibility label, and the order and marks of the rows.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Board, ChatView } from "@aiwb/core/types.ts";

import { canStartChat, chatLine, chatsCount, chatsRows, chatsTitle } from "../src/screens/board/chatsrows.ts";

const chat = (id: string, o: Partial<ChatView> = {}): ChatView => ({ id, board: "b", agent: "claude", created: id, status: "ready", ...o }) as unknown as ChatView;
const chats = (...cs: ChatView[]) => Object.fromEntries(cs.map((c) => [c.id, c]));
const named = { last: undefined, open: null, title: (c: ChatView) => c.name ?? "New chat", model: (c: ChatView) => c.model };

test("the head says how many chats the board has", () => {
  assert.equal(chatsCount(0), "No chats yet");
  assert.equal(chatsCount(1), "1 chat");
  assert.equal(chatsCount(2), "2 chats");
  assert.equal(chatsTitle("Checkout flow"), "Chats on “Checkout flow”");
});

test("New chat is offered on a live board whose server is reachable, not on an archived or unreachable one", () => {
  const live = { b: { id: "b" } as Board }, held = { sections: {}, gone: {}, connected: true };
  assert.equal(canStartChat({ boards: live, ...held }, "b"), true);
  assert.equal(canStartChat({ boards: { b: { id: "b", archived: true } as Board }, ...held }, "b"), false);
  assert.equal(canStartChat({ boards: live, ...held, connected: false }, "b"), false);
  assert.equal(canStartChat({ boards: live, ...held, gone: { b: true } }, "b"), false);
  assert.equal(canStartChat({ boards: {}, ...held }, "b"), false);
  // a board of a section: reachable only while that server's tree is held
  const far = { "srv~b": { id: "srv~b" } as Board };
  assert.equal(canStartChat({ boards: far, ...held }, "srv~b"), false);
  assert.equal(canStartChat({ boards: far, ...held, sections: { srv: {} as never } }, "srv~b"), true);
});

test("a chat's second line is the agent and its state word, else its model, else the agent alone", () => {
  assert.equal(chatLine(chat("a", { status: "writing" }), "Opus"), "Claude · Writing…");
  assert.equal(chatLine(chat("a", { approvals: 1 }), "Opus"), "Claude · Needs your approval");
  assert.equal(chatLine(chat("a"), "Opus"), "Claude · Opus");
  assert.equal(chatLine(chat("a", { agent: "cursor" }), ""), "Cursor");
});

test("the rows are the board's chats newest first, the voice chat marked, the open one flagged", () => {
  const cs = chats(chat("old", { name: "Old", model: "m1", created: "2026-01-01" }), chat("new", { name: "New one", model: "m2", created: "2026-02-01" }), chat("other", { board: "x" }));
  const s = { chats: cs, showArchived: false };
  const rows = chatsRows(s, "b", { ...named, last: "old", open: "new" });
  assert.deepEqual(rows.map((r) => r.id), ["new", "old"]);
  assert.deepEqual(rows.map((r) => r.voice), [false, true]);
  assert.deepEqual(rows.map((r) => r.open), [true, false]);
  assert.equal(rows[1]!.label, "Old, Claude · m1, Voice");
  assert.equal(rows[0]!.label, "New one, Claude · m2");
  // no chat used last: voice talks to the newest
  assert.equal(chatsRows(s, "b", named)[0]!.voice, true);
  assert.deepEqual(chatsRows({ chats: {}, showArchived: false }, "b", named), []);
});

test("an archived chat is listed only while archived things are shown, and voice does not talk to it", () => {
  const cs = chats(chat("live", { created: "1" }), chat("gone", { archived: true, created: "2" }));
  assert.deepEqual(chatsRows({ chats: cs, showArchived: false }, "b", { ...named, last: "gone" }).map((r) => [r.id, r.voice]), [["live", true]]);
  assert.deepEqual(chatsRows({ chats: cs, showArchived: true }, "b", { ...named, last: "gone" }).map((r) => [r.id, r.voice]).sort(), [["gone", false], ["live", true]]);
});
