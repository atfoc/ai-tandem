// The mic marks (VC-23): noted at send, matched when the message arrives, capped at 500, pruned, written and read.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MARKS_CAP, PENDING_CAP, emptyMarks, isMarked, matchArrived, noteSent, parseMarks, prune, serialiseMarks } from "../src/voice/logic/marks.ts";

const user = (text: string) => ({ kind: "user", text });
const reply = (text: string) => ({ kind: "text", text });

describe("noteSent and matchArrived", () => {
  it("marks the first user item at or after `before` with the text sent", () => {
    let m = noteSent(emptyMarks(), { chat: "c1", branch: "main", before: 2, text: "hello there" });
    assert.equal(isMarked(m, "c1", "main", 2), false);
    m = matchArrived(m, "c1", "main", [user("hello there"), reply("hi"), user("hello there"), reply("...")]);
    assert.equal(isMarked(m, "c1", "main", 2), true);
    assert.equal(isMarked(m, "c1", "main", 0), false, "an older message with the same text is not marked");
    assert.equal(m.pending.length, 0);
  });
  it("waits while the message has not arrived, and does nothing to the state then", () => {
    const m = noteSent(emptyMarks(), { chat: "c1", branch: "main", before: 0, text: "hi" });
    assert.equal(matchArrived(m, "c1", "main", [reply("x")]), m);
    assert.equal(matchArrived(m, "c1", "main", [user("something else")]), m);
    assert.equal(m.pending.length, 1);
  });
  it("only a user item counts, and the text is compared trimmed", () => {
    let m = noteSent(emptyMarks(), { chat: "c", branch: "main", before: 0, text: " yes please " });
    m = matchArrived(m, "c", "main", [reply("yes please"), user("yes please\n")]);
    assert.equal(isMarked(m, "c", "main", 0), false);
    assert.equal(isMarked(m, "c", "main", 1), true);
  });
  it("a chat and a branch are matched by themselves", () => {
    let m = noteSent(emptyMarks(), { chat: "c1", branch: "b2", before: 0, text: "hi" });
    const other = matchArrived(m, "c1", "main", [user("hi")]);
    assert.equal(other, m);
    assert.equal(isMarked(other, "c1", "main", 0), false);
    m = matchArrived(m, "c1", "b2", [user("hi")]);
    assert.equal(isMarked(m, "c1", "b2", 0), true);
  });
  it("two turns with the same words mark two messages, each once", () => {
    let m = noteSent(emptyMarks(), { chat: "c", branch: "main", before: 0, text: "yes" });
    m = noteSent(m, { chat: "c", branch: "main", before: 0, text: "yes" });
    m = matchArrived(m, "c", "main", [user("yes")]);
    assert.deepEqual(m.marks.map((x) => x.index), [0]);
    assert.equal(m.pending.length, 1);
    m = matchArrived(m, "c", "main", [user("yes"), reply("ok"), user("yes")]);
    assert.deepEqual(m.marks.map((x) => x.index), [0, 2]);
    assert.equal(m.pending.length, 0);
  });
  it("a missing branch is main", () => {
    let m = noteSent(emptyMarks(), { chat: "c", branch: "", before: 0, text: "hi" });
    m = matchArrived(m, "c", "main", [user("hi")]);
    assert.equal(isMarked(m, "c", "", 0), true);
    assert.equal(isMarked(m, "c", "main", 0), true);
  });
  it("forgets the oldest turn that never arrived", () => {
    let m = emptyMarks();
    for (let i = 0; i < PENDING_CAP + 5; i++) m = noteSent(m, { chat: "c", branch: "main", before: i, text: `t${i}` });
    assert.equal(m.pending.length, PENDING_CAP);
    assert.equal(m.pending[0].text, "t5");
  });
  it("does not change the state it was given", () => {
    const m = noteSent(emptyMarks(), { chat: "c", branch: "main", before: 0, text: "hi" });
    const before = JSON.stringify([m.marks, m.pending, [...m.index]]);
    matchArrived(m, "c", "main", [user("hi")]);
    assert.equal(JSON.stringify([m.marks, m.pending, [...m.index]]), before);
  });
});

describe("the cap", () => {
  it("keeps at most 500 marks and drops the oldest", () => {
    let m = emptyMarks();
    const items: { kind: string; text: string }[] = [];
    for (let i = 0; i < MARKS_CAP + 3; i++) {
      items.push(user(`m${i}`));
      m = noteSent(m, { chat: "c", branch: "main", before: i, text: `m${i}` });
      m = matchArrived(m, "c", "main", items);
    }
    assert.equal(m.marks.length, MARKS_CAP);
    assert.equal(isMarked(m, "c", "main", 0), false);
    assert.equal(isMarked(m, "c", "main", 2), false);
    assert.equal(isMarked(m, "c", "main", 3), true);
    assert.equal(isMarked(m, "c", "main", MARKS_CAP + 2), true);
    assert.equal(m.index.size, MARKS_CAP);
  });
  it("applies the cap when reading too", () => {
    const entries = Array.from({ length: MARKS_CAP + 10 }, (_, i) => ["c", "main", i]);
    const m = parseMarks(JSON.stringify(entries));
    assert.equal(m.marks.length, MARKS_CAP);
    assert.equal(m.marks[0].index, 10);
  });
});

describe("prune", () => {
  it("drops the marks and the noted turns of chats that are gone", () => {
    let m = noteSent(emptyMarks(), { chat: "gone", branch: "main", before: 0, text: "a" });
    m = noteSent(m, { chat: "kept", branch: "main", before: 0, text: "b" });
    m = matchArrived(m, "gone", "main", [user("a")]);
    m = matchArrived(m, "kept", "main", [user("b")]);
    m = noteSent(m, { chat: "gone", branch: "main", before: 1, text: "c" });
    const p = prune(m, new Set(["kept"]));
    assert.equal(isMarked(p, "gone", "main", 0), false);
    assert.equal(isMarked(p, "kept", "main", 0), true);
    assert.equal(p.pending.length, 0);
  });
  it("returns the same state when every chat is there", () => {
    const m = matchArrived(noteSent(emptyMarks(), { chat: "c", branch: "main", before: 0, text: "a" }), "c", "main", [user("a")]);
    assert.equal(prune(m, ["c", "d"]), m);
  });
});

describe("serialise and parse", () => {
  it("round-trips the marks and leaves a turn that has not arrived out", () => {
    let m = noteSent(emptyMarks(), { chat: "c", branch: "b", before: 1, text: "a" });
    m = matchArrived(m, "c", "b", [reply("x"), user("a")]);
    m = noteSent(m, { chat: "c", branch: "b", before: 2, text: "later" });
    const text = serialiseMarks(m);
    const back = parseMarks(text);
    assert.deepEqual(back.marks, m.marks);
    assert.equal(back.pending.length, 0);
    assert.equal(isMarked(back, "c", "b", 1), true);
    assert.equal(serialiseMarks(back), text);
  });
  it("text that does not parse is no marks, and entries that are not marks are dropped", () => {
    for (const t of [null, "", "{", "{}", "3", "null"]) assert.equal(parseMarks(t).marks.length, 0);
    const m = parseMarks(JSON.stringify([["c", "main", 1], ["c", "main", -1], ["c", "main", 1.5], ["c", 3, 1], "x", null, ["c", "main", 1], ["d", "", 0]]));
    assert.deepEqual(m.marks, [{ chat: "c", branch: "main", index: 1 }, { chat: "d", branch: "main", index: 0 }]);
  });
  it("holds no message text", () => {
    let m = noteSent(emptyMarks(), { chat: "c", branch: "main", before: 0, text: "my secret sentence" });
    m = matchArrived(m, "c", "main", [user("my secret sentence")]);
    assert.equal(serialiseMarks(m).includes("secret"), false);
  });
});
