// A chip input with `noChips` (the prompt library's text field, types.ts): every function of chipdoc.ts and chipvalue.ts that reads a
// value or an inserted text is given `chips` false, and a reference tag in it stays text, whether it was set, pasted or moved by an
// edit of `editing`. The default (chips true) still makes chips: one assertion each.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FmtElement } from "@aiwb/core/format.ts";
import type { EditingSettings } from "@aiwb/core/logic/editing.ts";
import { selectionRef, serializeRef } from "@aiwb/core/logic/refs.ts";
import {
  applyChange, backspaceChange, chipText, docOf, enterChange, indentChange, insertText, layout, replaceBeforeCaret, valueOf, type Doc,
} from "../src/platform/chipinput/chipdoc.ts";
import { piecesOf, valueOfPieces } from "../src/platform/chipinput/chipvalue.ts";

const el = (id: string, type: string, label?: string): FmtElement => ({ id, type, x: 0, y: 0, width: 160, height: 70, label });
const api = selectionRef([el("a1", "rectangle", "API")])!;
const TAG = serializeRef(api);
const TAB: EditingSettings = { tabInserts: "tab", tabWidth: 4 };
const SPACES: EditingSettings = { tabInserts: "spaces", tabWidth: 2 };
const at = (n: number) => ({ start: n, end: n });
const hasChip = (d: Doc) => d.some((p) => typeof p !== "string");

test("piecesOf with chips false: one text piece, none for an empty value", () => {
  const v = `see ${TAG} now`;
  assert.deepEqual(piecesOf(v, false), [{ text: v }]);
  assert.equal(valueOfPieces(piecesOf(v, false)), v);
  assert.deepEqual(piecesOf("", false), []);
  assert.ok(piecesOf(v).some((p) => "tag" in p)); // the default still makes a chip
});

test("docOf with chips false: one string, the value round-trips, the field shows the value", () => {
  const v = `see ${TAG} now\n  and ${TAG}`;
  const d = docOf(v, false);
  assert.deepEqual(d, [v]);
  assert.equal(valueOf(d), v);
  const l = layout(d);
  assert.equal(l.text, v);
  assert.deepEqual(l.chips, []);
  assert.deepEqual(docOf("", false), []);
  assert.ok(hasChip(docOf(v)));
});

test("applyChange with chips false: a pasted tag, or a chip's display, stays text", () => {
  const next = `a${TAG}b`;
  let c = applyChange(["ab"], next, at(1), [], false);
  assert.deepEqual(c.doc, [next]);
  assert.equal(c.caret, 1 + TAG.length);
  assert.equal(valueOf(c.doc), next);
  // (a chip's label between no-break spaces, as a native copy gives it, is not restored either)
  const shown = `a${chipText(api)}b`;
  c = applyChange(["ab"], shown, at(1), [api], false);
  assert.deepEqual(c.doc, [shown]);
  assert.ok(hasChip(applyChange(["ab"], next, at(1)).doc));
});

test("replaceBeforeCaret and insertText with chips false keep tags as text", () => {
  const r = replaceBeforeCaret(["x @a"], at(4), 2, TAG, false)!;
  assert.deepEqual(r.doc, [`x ${TAG}`]);
  assert.equal(r.caret, 2 + TAG.length);
  const i = insertText(["ab"], at(1), TAG, false);
  assert.deepEqual(i.doc, [`a${TAG}b`]);
  assert.equal(i.caret, 1 + TAG.length);
  assert.ok(hasChip(insertText(["ab"], at(1), TAG).doc));
});

test("enterChange with chips false: the list and the indent go on, the tag stays text", () => {
  let d: Doc = [`- see ${TAG}`];
  let t = layout(d).text;
  let r = enterChange(d, t + "\n", at(t.length), false)!;
  assert.deepEqual(r.doc, [`- see ${TAG}\n- `]);
  assert.equal(r.caret, t.length + 3);
  d = [`  x ${TAG}`];
  t = layout(d).text;
  r = enterChange(d, t + "\n", at(t.length), false)!;
  assert.deepEqual(r.doc, [`  x ${TAG}\n  `]);
  assert.equal(r.caret, t.length + 3);
  assert.ok(hasChip(enterChange(d, t + "\n", at(t.length))!.doc));
});

test("backspaceChange with chips false: back to the previous tab stop, the tag stays text", () => {
  const d: Doc = [`    ${TAG}`];
  const t = layout(d).text, next = t.slice(0, 3) + t.slice(4);
  const r = backspaceChange(d, next, at(4), SPACES, false)!;
  assert.deepEqual(r.doc, [`  ${TAG}`]);
  assert.equal(r.caret, 2);
  assert.ok(hasChip(backspaceChange(d, next, at(4), SPACES)!.doc));
});

test("indentChange with chips false: the tag stays text", () => {
  let r = indentChange([`x ${TAG}`], at(0), TAB, false);
  assert.deepEqual(r.doc, [`\tx ${TAG}`]);
  assert.deepEqual(r.selection, at(1));
  const v = `a ${TAG}\nb`;
  r = indentChange([v], { start: 0, end: v.length }, SPACES, false);
  assert.deepEqual(r.doc, [`  a ${TAG}\n  b`]);
  assert.ok(hasChip(indentChange([`x ${TAG}`], at(0), TAB).doc));
});
