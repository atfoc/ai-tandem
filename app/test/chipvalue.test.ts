// The value of the chip input (AD-60, package K1): the message text with each reference as its inline tag. What a box
// holds is built from the value (piecesOf) and the value read back from what it holds (valueOfPieces), and neither may
// change a message: drafts, sending and the thread carry the value as it is. The page's side of it (the caret, the
// keys, the clipboard) is web/dev/checks/L4-chips.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { FmtElement } from "@aiwb/core/format.ts";
import { parseRefs, pointRef, selectionRef, serialize, serializeRef, type Ref } from "@aiwb/core/logic/refs.ts";
import { beforeCaretOf, chipSpacing, chipTitle, piecesOf, valueOfPieces } from "../src/platform/chipinput/chipvalue.ts";

const el = (id: string, type: string, label?: string, x = 0, y = 0): FmtElement => ({ id, type, x, y, width: 160, height: 70, label });

const sel = selectionRef([el("a1", "rectangle", "API", 10, 20), el("b2", "ellipse")])!;
const one = selectionRef([el("c3", "text", 'x < y > "z" & </selection>\nnext')])!;
const near = pointRef(0, 0, [el("a1", "rectangle", "API", 20, 0)]);
const bare = pointRef(120.4, -39.6);

const VALUES = [
  "",
  "plain text",
  "line one\nline two\n",
  serializeRef(sel),
  `look at ${serializeRef(sel)} and ${serializeRef(near)}, then ${serializeRef(bare)}`,
  `${serializeRef(one)}${serializeRef(bare)}`,
  `before ${serializeRef(one)}\nafter on a line of its own`,
  "text with <selection> and <point> lookalikes and a < b > c & d",
  `<selection ids="a" label="x"> not closed ${serializeRef(bare)}`,
];

test("a value round-trips through the pieces of a box", () => {
  for (const v of VALUES) {
    const pieces = piecesOf(v);
    assert.equal(valueOfPieces(pieces), v, `the value ${JSON.stringify(v)}`);
    assert.equal(serialize(parseRefs(v)), v);
  }
});

test("a chip carries the reference's tag, and its tag is read back to the same reference", () => {
  const pieces = piecesOf(`a ${serializeRef(sel)} b ${serializeRef(near)}`);
  assert.deepEqual(pieces.map((p) => ("tag" in p ? p.ref.kind : p.text)), ["a ", "selection", " b ", "point"]);
  for (const p of pieces) if ("tag" in p) assert.deepEqual(parseRefs(p.tag), [p.ref]);
});

test("a tag that is written again is the same tag (a box made of a value and read back does not drift)", () => {
  for (const v of VALUES) {
    const once = valueOfPieces(piecesOf(v));
    assert.equal(valueOfPieces(piecesOf(once)), once);
  }
});

test("a chip's tag stays on one line, whatever its labels hold", () => {
  for (const r of [sel, one, near, bare]) assert.ok(!serializeRef(r).includes("\n"));
  const p = piecesOf(`x ${serializeRef(one)} y`);
  assert.equal(p.length, 3);
  assert.equal(valueOfPieces(p).split("\n").length, 1);
});

test("a message of chips alone has a non-blank value (C-RF-24)", () => {
  assert.ok(valueOfPieces(piecesOf(serializeRef(bare))).trim().length > 0);
  assert.ok(valueOfPieces(piecesOf(serializeRef(sel) + serializeRef(bare))).trim().length > 0);
});

test("a chip's tooltip names the selection or the point, then the detail lines", () => {
  assert.equal(chipTitle(sel), `Selection: 2 elements\nrectangle id=a1 "API" (10,20 160×70)\nellipse id=b2 (0,0 160×70)`);
  assert.equal(chipTitle(selectionRef([el("z", "rectangle")])!), "Selection: 1 element\nrectangle id=z (0,0 160×70)");
  assert.equal(chipTitle(near), `Point (0, 0)\nnear: rectangle id=a1 "API" (20,0 160×70) 20px right`);
  assert.equal(chipTitle(bare), "Point (120, -40)");
  const none: Ref = { kind: "selection", ids: ["a"], label: "x", detail: "" };
  assert.equal(chipTitle(none), "Selection: 1 element");
});

test("a chip put in gets a space before it unless white space is there, and after it unless white space follows (C-RF-12)", () => {
  assert.deepEqual(chipSpacing("", ""), { before: false, after: true });
  assert.deepEqual(chipSpacing("look", ""), { before: true, after: true });
  assert.deepEqual(chipSpacing("look ", ""), { before: false, after: true });
  assert.deepEqual(chipSpacing("look\n", "at it"), { before: false, after: true });
  assert.deepEqual(chipSpacing("look", " at it"), { before: true, after: false });
  assert.deepEqual(chipSpacing("look", "\nat it"), { before: true, after: false });
  assert.deepEqual(chipSpacing("", "\tat it"), { before: false, after: false });
});

test("the text before the caret is the text since the last chip: nothing right after a chip (C-RF-26)", () => {
  const v = `see ${serializeRef(sel)} and @bo`;
  const tag = serializeRef(sel);
  assert.equal(beforeCaretOf(v, v.length), " and @bo");
  assert.equal(beforeCaretOf(v, 4 + tag.length), "", "right after the chip");
  assert.equal(beforeCaretOf(v, 4 + tag.length + 1), " ");
  assert.equal(beforeCaretOf(v, 3), "see");
  assert.equal(beforeCaretOf(v, 4), "see ", "right before the chip");
  assert.equal(beforeCaretOf("a\nb @x", 6), "a\nb @x");
  assert.equal(beforeCaretOf("a < b <selection> c", 19), "a < b <selection> c", "a lookalike is text");
  assert.equal(beforeCaretOf("", 0), "");
});
