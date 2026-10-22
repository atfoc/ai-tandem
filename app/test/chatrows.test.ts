// The rows of a chat's thread (screens/chat/rows.ts): what the thread draws, in order, from the items and the waits (B-TH-01, B-TH-05
// to B-TH-07, B-TH-09, B-TH-12, B-TH-13, B-TH-18), and when it is a plain view and when a list.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Item } from "@aiwb/core/types.ts";

import { drawn, isShort, threadRows, type RowsIn } from "../src/screens/chat/rows.ts";

const user = (text: string): Item => ({ kind: "user", text });
const said = (text: string): Item => ({ kind: "text", text, done: true });
const base: RowsIn = { forked: false, loaded: true, items: [], kept: null, branch: "main", end: 0, sent: null, typing: "", waiting: "", lines: [] };
const kinds = (i: Partial<RowsIn>) => threadRows({ ...base, ...i }).map((r) => r.kind);

test("a thread is its items in order: the end mark, a note with no text and an item the client does not know have no row", () => {
  const items: (Item | null)[] = [user("a"), said("b"), { kind: "end" }, null, { kind: "note", text: "" }, { kind: "note", text: "hi", tone: "muted" }, { kind: "nope" } as unknown as Item, user("c")];
  const rows = threadRows({ ...base, items });
  assert.deepEqual(rows.map((r) => r.kind === "item" ? r.index : r.kind), [0, 1, 5, 7]);
  assert.deepEqual(rows.map((r) => r.key), ["main:0", "main:1", "main:5", "main:7"]);
});

test("the key of a row names its branch, so another branch's thread draws its messages anew", () => {
  const a = threadRows({ ...base, branch: "main", items: [user("a")] })[0];
  const b = threadRows({ ...base, branch: "b_2", items: [user("a")] })[0];
  assert.notEqual(a.key, b.key);
});

test("a thread that is loaded and has nothing says so, unless a message is on its way; one not loaded says nothing", () => {
  assert.deepEqual(kinds({}), ["empty"]);
  assert.deepEqual(kinds({ loaded: false }), []);
  assert.deepEqual(kinds({ sent: { text: "first" } as never }), ["sending"]);
});

test("a fork starts with its note, and the mark of the copied part stands where the copy ends (before the first own item, after the last when there is none)", () => {
  const items = [user("a"), said("b"), user("own")];
  assert.deepEqual(kinds({ forked: true, items, end: 2 }), ["forked", "item", "item", "mark", "item"]);
  assert.deepEqual(kinds({ items: items.slice(0, 2), end: 2 }), ["item", "item", "mark"]);
  assert.deepEqual(kinds({ items, end: 0 }), ["item", "item", "item"]);
  assert.deepEqual(kinds({ loaded: false, items: [], end: 2 }), []);
  const rows = threadRows({ ...base, items, end: 2 });
  assert.deepEqual(rows.map((r) => r.kind === "item" ? r.readOnly : null), [true, true, null, false]); // what lies above the mark is read-only
});

test("the history a branch send keeps stands for the list: read-only, with no mark and no places", () => {
  const rows = threadRows({ ...base, loaded: false, kept: [user("a"), said("b")], end: 1, sent: { text: "new" } as never });
  assert.deepEqual(rows.map((r) => r.kind), ["item", "item", "sending"]);
  assert.ok(rows.slice(0, 2).every((r) => r.kind === "item" && r.readOnly && r.index === undefined));
});

test("the lines at the foot come after the message on its way, in the order: status, waiting, waits", () => {
  const rows = threadRows({ ...base, items: [user("a")], sent: { text: "b" } as never, typing: "Thinking…", waiting: "Waiting on 2 subagents", lines: [{ id: "send", text: "Starting the agent…" }, { id: "fork", text: "Making a fork of this chat…" }] });
  assert.deepEqual(rows.map((r) => r.kind), ["item", "sending", "typing", "waiting", "wait", "wait"]);
  assert.deepEqual(rows.filter((r) => r.kind === "wait").map((r) => r.key), ["wait:send", "wait:fork"]);
});

test("a chat that waits for background work has the waiting row at its foot, not the typing line", () => {
  const rows = threadRows({ ...base, items: [user("a")], waiting: "Waiting for background work" });
  assert.deepEqual(rows.map((r) => r.kind), ["item", "waiting"]);
  assert.equal(rows[1].kind === "waiting" && rows[1].text, "Waiting for background work");
});

test("drawn: what is drawn at all", () => {
  assert.equal(drawn(undefined), false);
  assert.equal(drawn({ kind: "end" }), false);
  assert.equal(drawn({ kind: "note" }), false);
  assert.equal(drawn({ kind: "note", text: "x" }), true);
  assert.equal(drawn({ kind: "subresult", subagent: "s" }), true);
  assert.equal(drawn({ kind: "tool" }), true);
});

test("isShort: the empty state, a fork's note and the lines are a plain view; a message, the mark or a message on its way make a list", () => {
  assert.equal(isShort(threadRows({ ...base })), true);
  assert.equal(isShort(threadRows({ ...base, forked: true, lines: [{ id: "load", text: "Loading…" }] })), true);
  assert.equal(isShort(threadRows({ ...base, items: [user("a")] })), false);
  assert.equal(isShort(threadRows({ ...base, sent: { text: "a" } as never })), false);
});
