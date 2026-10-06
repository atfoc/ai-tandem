import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_SEL, parseSel, selOf, validSel, type Sel } from "../src/logic/sel.ts";

test("parseSel reads the old two-key shape and the new one", () => {
  assert.deepEqual(parseSel('{"board":null,"chat":"c1"}'), { board: null, run: null, chat: "c1" });
  assert.deepEqual(parseSel('{"board":"b1","chat":"c1"}'), { board: "b1", run: null, chat: "c1" });
  assert.deepEqual(parseSel('{"board":null,"run":"r1","chat":"c1"}'), { board: null, run: "r1", chat: "c1" });
  assert.deepEqual(parseSel('{"board":null,"run":"r1","chat":null}'), { board: null, run: "r1", chat: null });
});

test("parseSel: a board wins over a run; garbage is no selection", () => {
  assert.deepEqual(parseSel('{"board":"b1","run":"r1","chat":null}'), { board: "b1", run: null, chat: null });
  for (const bad of [null, "", "nonsense", "null", "7", '"text"', "[]"]) assert.deepEqual(parseSel(bad), NO_SEL, String(bad));
  assert.deepEqual(parseSel('{"board":7,"run":{},"chat":["c1"]}'), NO_SEL, "ids that are not strings are dropped");
  assert.deepEqual(parseSel('{"board":"","run":"","chat":""}'), NO_SEL);
});

test("what is saved still has the board and chat keys the e2e reads", () => {
  const saved = JSON.parse(JSON.stringify(selOf({ id: "c1", board: "b1" })));
  assert.deepEqual(Object.keys(saved).sort(), ["board", "chat", "run"]);
  assert.equal(saved.board, "b1"); assert.equal(saved.chat, "c1");
});

test("selOf: a board chat opens on its board, a run chat on its run, a plain chat alone", () => {
  assert.deepEqual(selOf({ id: "cb", board: "b1" }), { board: "b1", run: null, chat: "cb" });
  assert.deepEqual(selOf({ id: "cr", run: "r1" }), { board: null, run: "r1", chat: "cr" });
  assert.deepEqual(selOf({ id: "cp" }), { board: null, run: null, chat: "cp" });
  assert.deepEqual(selOf({ id: "cx", board: "b1", run: "r1" }), { board: "b1", run: null, chat: "cx" });
});

const s = {
  boards: { b1: {}, b2: {} }, runs: { r1: {}, r2: {} },
  chats: { cp: {}, cb: { board: "b1" }, cr: { run: "r1" }, ca: { run: "r1", role: "task" as const } },
};
const valid = (board: string | null, run: string | null, chat: string | null): Sel => validSel({ board, run, chat }, s);

test("validSel keeps what exists and belongs together", () => {
  assert.deepEqual(valid(null, null, null), NO_SEL);
  assert.deepEqual(valid(null, null, "cp"), { board: null, run: null, chat: "cp" });
  assert.deepEqual(valid("b1", null, "cb"), { board: "b1", run: null, chat: "cb" });
  assert.deepEqual(valid("b1", null, null), { board: "b1", run: null, chat: null });
  assert.deepEqual(valid(null, "r1", "cr"), { board: null, run: "r1", chat: "cr" });
  assert.deepEqual(valid(null, "r1", null), { board: null, run: "r1", chat: null });
});

test("validSel drops a board or a run that is gone, with the chat that was on it", () => {
  assert.deepEqual(valid("gone", null, "cb"), NO_SEL);
  assert.deepEqual(valid(null, "gone", "cr"), NO_SEL);
  assert.deepEqual(valid("gone", null, "cp"), { board: null, run: null, chat: "cp" }, "a plain chat stays, alone");
});

test("validSel drops a chat that is gone, is a run's agent, or belongs elsewhere", () => {
  assert.deepEqual(valid(null, null, "gone"), NO_SEL);
  assert.deepEqual(valid("b1", null, "gone"), { board: "b1", run: null, chat: null });
  assert.deepEqual(valid(null, "r1", "ca"), { board: null, run: "r1", chat: null }, "a run agent is never sel.chat");
  assert.deepEqual(valid(null, null, "ca"), NO_SEL);
  assert.deepEqual(valid(null, "r1", "cb"), { board: null, run: "r1", chat: null }, "a board's chat on a run");
  assert.deepEqual(valid(null, "r2", "cr"), { board: null, run: "r2", chat: null }, "another run's chat");
  assert.deepEqual(valid("b2", null, "cb"), { board: "b2", run: null, chat: null }, "another board's chat");
  assert.deepEqual(valid("b1", null, "cr"), { board: "b1", run: null, chat: null }, "a run's chat on a board");
  assert.deepEqual(valid("b1", null, "cp"), { board: "b1", run: null, chat: null }, "a plain chat with a board");
  assert.deepEqual(valid(null, "r1", "cp"), { board: null, run: "r1", chat: null }, "a plain chat with a run");
  assert.deepEqual(valid(null, null, "cb"), NO_SEL, "a board chat without its board");
  assert.deepEqual(valid(null, null, "cr"), NO_SEL, "a run chat without its run");
});

test("validSel: with both set, the board wins and the run is dropped", () => {
  assert.deepEqual(valid("b1", "r1", "cb"), { board: "b1", run: null, chat: "cb" });
  assert.deepEqual(valid("b1", "r1", "cr"), { board: "b1", run: null, chat: null });
  assert.deepEqual(valid("gone", "r1", "cr"), { board: null, run: "r1", chat: "cr" }, "the board is gone: the run shows");
});
