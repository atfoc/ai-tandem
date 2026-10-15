import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_SEL, parseSel, selOf, validSel, type Sel } from "../src/logic/sel.ts";

test("parseSel reads the board and the chat", () => {
  assert.deepEqual(parseSel('{"board":null,"chat":"c1"}'), { board: null, chat: "c1" });
  assert.deepEqual(parseSel('{"board":"b1","chat":"c1"}'), { board: "b1", chat: "c1" });
  assert.deepEqual(parseSel('{"board":"b1","chat":null}'), { board: "b1", chat: null });
});

test("parseSel: garbage is no selection, and a key it does not know is left out", () => {
  for (const bad of [null, "", "nonsense", "null", "7", '"text"', "[]"]) assert.deepEqual(parseSel(bad), NO_SEL, String(bad));
  assert.deepEqual(parseSel('{"board":7,"chat":["c1"]}'), NO_SEL, "ids that are not strings are dropped");
  assert.deepEqual(parseSel('{"board":"","chat":""}'), NO_SEL);
  // what a build that had runs saved
  assert.deepEqual(parseSel('{"board":null,"run":"r1","chat":"c1"}'), { board: null, chat: "c1" });
  assert.deepEqual(parseSel('{"board":"b1","run":null,"chat":null}'), { board: "b1", chat: null });
});

test("what is saved has the board and chat keys the e2e reads", () => {
  const saved = JSON.parse(JSON.stringify(selOf({ id: "c1", board: "b1" })));
  assert.deepEqual(Object.keys(saved).sort(), ["board", "chat"]);
  assert.equal(saved.board, "b1"); assert.equal(saved.chat, "c1");
});

test("selOf: a board chat opens on its board, a plain chat alone", () => {
  assert.deepEqual(selOf({ id: "cb", board: "b1" }), { board: "b1", chat: "cb" });
  assert.deepEqual(selOf({ id: "cp" }), { board: null, chat: "cp" });
});

const s = {
  boards: { b1: {}, b2: {} },
  chats: { cp: {}, cb: { board: "b1" } },
};
const valid = (board: string | null, chat: string | null): Sel => validSel({ board, chat }, s);

test("validSel keeps what exists and belongs together", () => {
  assert.deepEqual(valid(null, null), NO_SEL);
  assert.deepEqual(valid(null, "cp"), { board: null, chat: "cp" });
  assert.deepEqual(valid("b1", "cb"), { board: "b1", chat: "cb" });
  assert.deepEqual(valid("b1", null), { board: "b1", chat: null });
});

test("validSel drops a board that is gone, with the chat that was on it", () => {
  assert.deepEqual(valid("gone", "cb"), NO_SEL);
  assert.deepEqual(valid("gone", "cp"), { board: null, chat: "cp" }, "a plain chat stays, alone");
});

test("validSel drops a chat that is gone or belongs elsewhere", () => {
  assert.deepEqual(valid(null, "gone"), NO_SEL);
  assert.deepEqual(valid("b1", "gone"), { board: "b1", chat: null });
  assert.deepEqual(valid("b2", "cb"), { board: "b2", chat: null }, "another board's chat");
  assert.deepEqual(valid("b1", "cp"), { board: "b1", chat: null }, "a plain chat with a board");
  assert.deepEqual(valid(null, "cb"), NO_SEL, "a board chat without its board");
});
