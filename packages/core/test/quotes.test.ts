import { test } from "node:test";
import assert from "node:assert/strict";
import { findQuote, mergeQuotes, nameText, preview, quoteKey, toSend, withComment } from "../src/logic/quotes.ts";
import { toTreeItems } from "../src/logic/forkpoints.ts";

// A message's displayed text: its text nodes joined, with nothing between blocks.
const text = "The planOwn undo in the ShapeStore.Retry 3 times with backoff.";

test("finds a quote at its stored position", () => {
  const start = text.indexOf("ShapeStore");
  assert.deepEqual(findQuote(text, { quote: "ShapeStore", start, end: start + 10 }), { start, end: start + 10, how: "exact" });
});

test("a quote across blocks matches with its line breaks", () => {
  const start = text.indexOf("ShapeStore"), end = text.indexOf(" times");
  assert.equal(findQuote(text, { quote: "ShapeStore.\n\nRetry 3", start, end }).how, "exact");
});

test("searches the message when the position no longer matches", () => {
  const at = text.indexOf("with backoff");
  assert.deepEqual(findQuote(text, { quote: "with backoff", start: 3, end: 15 }), { start: at, end: at + 12, how: "search" });
  assert.deepEqual(findQuote(text, { quote: "with backoff", start: 50, end: 999 }), { start: at, end: at + 12, how: "search" });
});

test("stands for the whole message when the quote is gone", () => {
  assert.deepEqual(findQuote(text, { quote: "retry 5 times", start: 0, end: 13 }), { start: 0, end: text.length, how: "message" });
  assert.deepEqual(findQuote(text, { quote: " \n", start: 0, end: 2 }), { start: 0, end: text.length, how: "message" });
});

test("previews a quote on one line", () => {
  assert.equal(preview("a\n\n  b"), "a b");
  assert.equal(preview("x".repeat(100), 10), "x".repeat(9) + "…");
});

test("a quote is known by its message and position", () => {
  assert.equal(quoteKey({ item: 3, start: 4, end: 9 }), "3:4:9");
});

test("blank comments are left out, and trimmed when sent", () => {
  const r = { quote: "q", item: 1, start: 0, end: 1 };
  assert.deepEqual(withComment(r, "  "), r);
  assert.deepEqual(withComment({ ...r, comment: "old" }, ""), r);
  assert.deepEqual(withComment(r, " five \n"), { ...r, comment: " five \n" });
  assert.deepEqual(toSend([{ ...r, comment: " five \n" }, { ...r, comment: " " }]), [{ ...r, comment: "five" }, r]);
});

test("a failed send's quotes come back before the ones added meanwhile", () => {
  const a = { quote: "apples", item: 1, start: 0, end: 6, comment: "sent" }, b = { quote: "pears", item: 4, start: 2, end: 7 };
  const c = { quote: "plums", item: 4, start: 9, end: 14, comment: "added" };
  assert.deepEqual(mergeQuotes([a, b], [c]), [a, b, c]);
  assert.deepEqual(mergeQuotes([a, b], []), [a, b]);
  assert.deepEqual(mergeQuotes([], [c]), [c]);
});

test("a passage quoted again while its send failed is kept once, as quoted last", () => {
  const a = { quote: "apples", item: 1, start: 0, end: 6, comment: "sent" }, b = { quote: "pears", item: 4, start: 2, end: 7 };
  const again = { ...a, comment: "written since" };
  assert.deepEqual(mergeQuotes([a, b], [again]), [b, again]);
});

// ---- what names a message in a list (C-QT-23): the tree's rows, the move banner

test("nameText: a message that is only quotes is named by the quote mark and its first quote's comment, else the quoted words", () => {
  const a = { quote: "the plan", item: 1, start: 0, end: 8 }, b = { quote: "the rest", item: 1, start: 9, end: 17, comment: "second" };
  assert.equal(nameText({ text: "", references: [a] }), "❝ the plan");
  assert.equal(nameText({ references: [a, b] }), "❝ the plan");
  assert.equal(nameText({ text: "  \n", references: [{ ...a, comment: " why? " }, b] }), "❝ why?");
  assert.equal(nameText({ text: "", references: [{ ...a, comment: "   " }] }), "❝ the plan");
});

test("nameText: words name a message that has them, quotes or not; nothing at all names nothing", () => {
  const a = { quote: "the plan", item: 1, start: 0, end: 8, comment: "why?" };
  assert.equal(nameText({ text: "go on", references: [a] }), "go on");
  assert.equal(nameText({ text: "plain" }), "plain");
  assert.equal(nameText({ text: "", references: [] }), "");
});

test("a message of quotes alone is a row of the tree named by nameText", () => {
  const a = { quote: "the plan", item: 1, start: 0, end: 8, comment: "why?" };
  const rows = toTreeItems("claude", [{ kind: "user", text: "", references: [a] }, { kind: "user", text: "", references: [{ ...a, comment: undefined }] }]);
  assert.deepEqual(rows.map((r) => r.text), ["❝ why?", "❝ the plan"]);
});
