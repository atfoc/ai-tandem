// Offsets of what is drawn and of the displayed text (platform/quotealign.ts, AD-64): the web build counts in the characters the DOM has and
// stores the span in the displayed text, as the old page did. The texts are the ones the old page's DOM would have (messageText).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findQuote } from "@aiwb/core/logic/quotes.ts";
import { messageText, shownText } from "../src/screens/markdown/displayed.ts";
import { align, drawnSpan, shownSpan } from "../src/platform/quotealign.ts";

const drawn = (text: string, user = false) => messageText(text, user, false, false);
const pair = (text: string, user = false) => {
  const s = shownText(text, user);
  return { s, d: drawn(text, user), a: align(drawn(text, user), s.text, s.sep) };
};

describe("shownText", () => {
  it("is the displayed text with the separators marked, and without them the drawn text", () => {
    const { s, d } = pair("one\n\ntwo\n\n- a\n- b\n");
    assert.equal(s.text, messageText("one\n\ntwo\n\n- a\n- b\n"));
    assert.equal(s.text.length, s.sep.length);
    assert.equal(s.text.split("").filter((_, i) => !s.sep[i]).join(""), d);
    assert.ok(s.sep.some(Boolean), "a message of several blocks has separators");
  });
});

describe("align", () => {
  it("is the identity for one paragraph", () => {
    const { s, a } = pair("Because of the font copy step. It copies every font file on each build.");
    assert.ok(a);
    assert.deepEqual(shownSpan(a, 15, 29), { start: 15, end: 29 });
    assert.equal(s.text.slice(15, 29), "font copy step");
  });

  it("counts the separators inside a block: a stored position is in the displayed text", () => {
    const text = "First para.\n\nSecond para here.\n\n> a quoted line\n\n- one\n- two";
    const { s, d, a } = pair(text);
    assert.ok(a);
    const at = d.indexOf("quoted line");
    const span = shownSpan(a, at, at + "quoted line".length);
    assert.equal(s.text.slice(span.start, span.end), "quoted line");
    assert.ok(span.start > at, "the separator before it is counted");
    // and back
    assert.deepEqual(drawnSpan(a, span.start, span.end), { start: at, end: at + "quoted line".length });
    // a quote across two blocks keeps the separator inside the span
    const from = d.indexOf("Second"), to = d.indexOf("quoted") + "quoted".length;
    const across = shownSpan(a, from, to);
    assert.match(s.text.slice(across.start, across.end), /^Second para here\.\n/);
    assert.equal(findQuote(s.text, { quote: "Second para here. a quoted", ...across }).how, "exact");
    // the items of a list
    const two = d.indexOf("two"), item = shownSpan(a, two, two + 3);
    assert.equal(s.text.slice(item.start, item.end), "two");
  });

  it("stands a collapsed run of white space for the whole run", () => {
    const { s, a } = pair("a  b   c");
    // the drawn text collapses the runs the way Inlines does
    const collapsed = s.text.replace(/[ \t\r\n]+/g, " ");
    const b = align(collapsed, s.text, s.sep);
    assert.ok(a === null || a);
    assert.ok(b);
    const span = shownSpan(b, 2, 3); // "b"
    assert.equal(s.text.slice(span.start, span.end), "b");
    assert.deepEqual(shownSpan(b, 1, 2), { start: 1, end: 3 }); // the space after "a" is both
  });

  it("passes over what is displayed and not drawn: a code block's final line break", () => {
    const text = "Run:\n\n```js\nconst a = 1;\n```\n\nThen stop.";
    const s = shownText(text);
    const dom = messageText(text, false, false, false).replace(/\n$/, "").replace("const a = 1;\n", "const a = 1;");
    const a = align(dom, s.text, s.sep);
    assert.ok(a);
    const at = dom.indexOf("Then");
    const span = shownSpan(a, at, at + 4);
    assert.equal(s.text.slice(span.start, span.end), "Then");
  });

  it("answers null when the drawn text is not the displayed one, and the offsets are then the same", () => {
    const s = shownText("hello world");
    const a = align("hello there", s.text, s.sep);
    assert.equal(a, null);
    assert.deepEqual(shownSpan(a, 2, 5), { start: 2, end: 5 });
    assert.deepEqual(drawnSpan(a, 2, 5), { start: 2, end: 5 });
  });

  it("turns tabs of code into the four drawn spaces", () => {
    const s = shownText("```\na\tb\n```");
    const dom = "a    b";
    const a = align(dom, s.text.replace(/\n$/, ""), s.sep);
    assert.ok(a);
    const span = shownSpan(a, 5, 6);
    assert.equal(s.text.slice(span.start, span.end), "b");
    assert.deepEqual(shownSpan(a, 1, 5), { start: 1, end: 2 });
  });
});
