// What the chat's header says under the title on the phone (T1-1, goal 3.5): the order of the lines and their words.
import assert from "node:assert/strict";
import { test } from "node:test";

import { folderOf, headline, treeLabel, type HeadlineIn } from "../src/screens/chat/headline.ts";

const base: HeadlineIn = {
  chat: { agent: "claude", archived: false, cwd: "/Users/a/projects/checkout-service", board: undefined, status: "ready" },
  off: false, server: "This computer", legacy: false,
};
const with_ = (o: Partial<Omit<HeadlineIn, "chat">> & { chat?: Partial<HeadlineIn["chat"]> }): HeadlineIn => ({ ...base, ...o, chat: { ...base.chat, ...o.chat } });

test("folderOf is the last segment of a path", () => {
  assert.equal(folderOf("/Users/a/projects/checkout-service"), "checkout-service");
  assert.equal(folderOf("/Users/a/projects/checkout-service/"), "checkout-service");
  assert.equal(folderOf("C:\\work\\shop"), "shop");
  assert.equal(folderOf("/"), "");
  assert.equal(folderOf(""), "");
});

test("an idle chat says its agent and its folder", () => {
  assert.deepEqual(headline(base), { text: "Claude Code · checkout-service" });
});

test("a chat that waits for its background work does not say it is writing", () => {
  assert.deepEqual(headline(with_({ chat: { status: "waiting" } })), { text: "Waiting for background work", tone: "wait" });
  assert.deepEqual(headline(with_({ chat: { status: "waiting", subsRunning: 2 } })), { text: "Waiting on 2 subagents", tone: "ok" });
});

test("a chat on a board says the board", () => {
  assert.deepEqual(headline(with_({ chat: { board: "b1" }, boardName: "Launch plan" })), { text: "Claude Code · on Launch plan" });
});

test("a state word of the chat, with its tone", () => {
  assert.deepEqual(headline(with_({ chat: { status: "approval" } })), { text: "Needs your approval", tone: "warn" });
  assert.deepEqual(headline(with_({ chat: { status: "writing" } })), { text: "Writing…", tone: "ok" });
  assert.deepEqual(headline(with_({ chat: { status: "stopped" } })), { text: "Stopped", tone: "bad" });
});

test("a chat whose agent is retried says when the next attempt is, as the wide header does", () => {
  const retry = { attempt: 2, of: 4, at: 1_000_040_000, kind: "login" };
  assert.deepEqual(headline(with_({ chat: { status: "retrying", retry }, now: 1_000_000_000 })), { text: "Retrying in 40 s · 2 of 4", tone: "wait" });
  assert.deepEqual(headline(with_({ chat: { status: "retrying", retry }, now: 1_000_050_000 })), { text: "Retrying · 2 of 4", tone: "wait" });
  assert.deepEqual(headline(with_({ chat: { status: "retrying" } })), { text: "Retrying", tone: "wait" });
  assert.deepEqual(headline(with_({ chat: { status: "retrying", retry }, off: true })), { text: "● This computer · offline", tone: "bad" });
});

test("an archived chat says so, before any state", () => {
  assert.deepEqual(headline(with_({ chat: { archived: true, status: "writing" } })), { text: "Archived · checkout-service" });
});

test("a chat whose server is off says offline, in red, before anything", () => {
  const off = with_({ off: true, server: "Studio Mac", chat: { archived: true, status: "writing" } });
  assert.deepEqual(headline(off), { text: "● Studio Mac · offline", tone: "bad" });
});

test("a chat that is gone from a server that is connected is not offline: the header gives its place as it was", () => {
  // (PhoneHeader passes `off` = sendOff(where) only; `gone` freezes the chat but is no reason to say the server is offline)
  assert.deepEqual(headline(with_({ off: false, server: "Studio Mac" })), { text: "Claude Code · checkout-service" });
  // (and no state word: a request it shows cannot be answered there any more)
  assert.deepEqual(headline(with_({ off: false, gone: true, server: "Studio Mac", chat: { status: "approval" } })), { text: "Claude Code · checkout-service" });
});

test("a legacy chat keeps the old word after the agent", () => {
  assert.deepEqual(headline(with_({ legacy: true, chat: { status: "writing" } })), { text: "Claude Code · checkout-service · Disabled" });
});

test("the Tree button's words", () => {
  const none = { asks: null, failed: null };
  assert.equal(treeLabel(1, none), "Chat tree");
  assert.equal(treeLabel(3, none), "Chat tree, 3 branches");
  assert.equal(treeLabel(3, { asks: "b2", failed: null }), "Chat tree, 3 branches, a branch needs your approval");
  assert.equal(treeLabel(2, { asks: null, failed: "b2" }), "Chat tree, 2 branches, a branch failed");
});
