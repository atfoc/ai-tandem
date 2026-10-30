// The native box's code-editor editing (chipdoc.ts enterChange, indentChange): an Enter the field has already put in, read from
// the change and answered with core logic/indent.ts newlineEdit; Tab and Shift+Tab from the key row and the hardware keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FmtElement } from "@aiwb/core/format.ts";
import type { EditingSettings } from "@aiwb/core/logic/editing.ts";
import { selectionRef, serializeRef } from "@aiwb/core/logic/refs.ts";
import { chipText, enterChange, indentChange, layout, valueOf, type Doc } from "../src/platform/chipinput/chipdoc.ts";

const el = (id: string, type: string, label?: string): FmtElement => ({ id, type, x: 0, y: 0, width: 160, height: 70, label });
const api = selectionRef([el("a1", "rectangle", "API")])!;
const CH = chipText(api);
const TAB: EditingSettings = { tabInserts: "tab", tabWidth: 4 };
const SPACES: EditingSettings = { tabInserts: "spaces", tabWidth: 2 };
const at = (n: number) => ({ start: n, end: n });

/** The field's text after Enter at `lo`..`hi` of the doc's shown string. */
const typed = (doc: Doc, lo: number, hi = lo) => { const t = layout(doc).text; return t.slice(0, lo) + "\n" + t.slice(hi); };
const enter = (doc: Doc, lo: number, hi = lo, hint = true) => enterChange(doc, typed(doc, lo, hi), hint ? { start: lo, end: hi } : undefined);

test("Enter keeps the line's indent, tab and spaces", () => {
  let r = enter(["\tfoo"], 4)!;
  assert.deepEqual(r.doc, ["\tfoo\n\t"]);
  assert.equal(r.caret, 6);
  r = enter(["    foo"], 7)!;
  assert.deepEqual(r.doc, ["    foo\n    "]);
  assert.equal(r.caret, 12);
});

test("Enter goes on with a list, and an empty item ends it", () => {
  let r = enter(["- a"], 3)!;
  assert.deepEqual(r.doc, ["- a\n- "]);
  assert.equal(r.caret, 6);
  r = enter(["3. x"], 4)!;
  assert.deepEqual(r.doc, ["3. x\n4. "]);
  assert.equal(r.caret, 8);
  r = enter(["- "], 2)!;
  assert.deepEqual(r.doc, []);
  assert.equal(r.caret, 0);
  r = enter(["- a\n- "], 6)!; // the second item empty: the line stays, without its marker
  assert.deepEqual(r.doc, ["- a\n"]);
  assert.equal(r.caret, 4);
});

test("Enter over a selection replaces it", () => {
  const r = enter(["  abcdef"], 4, 6)!;
  assert.deepEqual(r.doc, ["  ab\n  ef"]);
  assert.equal(r.caret, 7);
});

test("a caret inside the indent copies the indent up to the caret", () => {
  const r = enter(["    foo"], 2)!;
  assert.deepEqual(r.doc, ["  \n    foo"]);
  assert.equal(r.caret, 5);
});

test("a chip on the line: the value's tags count, the chip is kept and the caret lands right", () => {
  const doc: Doc = ["  see ", api, " now"];
  const end = layout(doc).text.length;
  const r = enter(doc, end)!;
  assert.deepEqual(r.doc, ["  see ", api, " now\n  "]);
  assert.equal(valueOf(r.doc), `  see ${serializeRef(api)} now\n  `);
  assert.equal(r.caret, 6 + CH.length + 4 + 3);
  // Enter right after the chip
  const after = 6 + CH.length;
  const s = enter(doc, after)!;
  assert.deepEqual(s.doc, ["  see ", api, "\n   now"]);
  assert.equal(s.caret, after + 3);
  // a span whose edge is inside the chip is left alone
  assert.equal(enterChange(doc, typed(doc, 8), at(8)), null);
});

test("next to another line break the place is ambiguous without a hint that fits", () => {
  const doc: Doc = ["  a\n\n  b"];
  // pressed at 4 (start of the empty line) or 5: the same string
  assert.equal(enter(doc, 4, 4, false), null);
  assert.equal(enterChange(doc, typed(doc, 4), at(0)), null); // a hint that does not fit
  // pressed at the end of "  a" (before the run): the prefix stops there, but the "\n" sits next to the run too
  assert.equal(enter(doc, 3, 3, false), null);
  // with a fitting hint it is handled: the end of "  a" keeps "  "
  const r = enter(doc, 3)!;
  assert.deepEqual(r.doc, ["  a\n  \n\n  b"]);
  assert.equal(r.caret, 6);
  // at the start of "  b" (after the run) the empty line's indent is none: nothing to add
  assert.equal(enter(doc, 5), null);
});

test("a stale hint that does not fit, with a unique insertion, is placed by the prefix", () => {
  const r = enterChange(["\tfoo bar"], typed(["\tfoo bar"], 4), at(1))!;
  assert.deepEqual(r.doc, ["\tfoo\n\t bar"]);
  assert.equal(r.caret, 6);
});

test("a paste, an autocorrect or a plain line is not touched", () => {
  const doc: Doc = ["\tfoo"];
  assert.equal(enterChange(doc, "\tfoo" + "a\nb", at(4)), null);
  assert.equal(enterChange(doc, "\tfoo" + "\n\n", at(4)), null);
  assert.equal(enterChange(["\tteh"], "\tthe\n", at(4)), null); // a word corrected and the "\n" in one event
  assert.equal(enter(["plain"], 5), null); // no indent, no list: the bare line break stays
  assert.equal(enterChange(doc, "\tfoo", at(4)), null); // no change
  assert.equal(enterChange(doc, "\tfo", at(4)), null); // a deletion
});

test("indentChange: Tab at a caret, a tab or spaces to the next stop", () => {
  let r = indentChange(["ab"], at(1), TAB, false)!;
  assert.deepEqual(r.doc, ["a\tb"]);
  assert.deepEqual(r.selection, at(2));
  r = indentChange(["abc"], at(1), SPACES, false)!;
  assert.deepEqual(r.doc, ["a bc"]);
  assert.deepEqual(r.selection, at(2));
  r = indentChange(["ab"], at(0), SPACES, false)!;
  assert.deepEqual(r.doc, ["  ab"]);
  assert.deepEqual(r.selection, at(2));
});

test("indentChange: a selection over several lines indents each and covers the same text", () => {
  const doc: Doc = ["one\ntwo\nthree"];
  let r = indentChange(doc, { start: 1, end: 6 }, TAB, false)!;
  assert.deepEqual(r.doc, ["\tone\n\ttwo\nthree"]);
  assert.equal(layout(r.doc).text.slice(r.selection.start, r.selection.end), "ne\n\ttw");
  r = indentChange(r.doc, r.selection, TAB, true)!;
  assert.deepEqual(r.doc, doc);
  assert.equal(layout(r.doc).text.slice(r.selection.start, r.selection.end), "ne\ntw");
  // a chip on a line: the tag stays whole, the selection keeps it
  const withChip: Doc = ["a ", api, "\nb"];
  const t = layout(withChip).text;
  r = indentChange(withChip, { start: 0, end: t.length }, SPACES, false)!;
  assert.deepEqual(r.doc, ["  a ", api, "\n  b"]);
  assert.deepEqual(r.selection, { start: 0, end: layout(r.doc).text.length });
});

test("indentChange: Shift+Tab with no indent is null", () => {
  assert.equal(indentChange(["one\ntwo"], { start: 0, end: 5 }, TAB, true), null);
  const r = indentChange(["   x"], at(4), SPACES, true)!;
  assert.deepEqual(r.doc, [" x"]);
  assert.deepEqual(r.selection, at(2));
});
