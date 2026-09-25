import { test } from "node:test";
import assert from "node:assert/strict";
import { selectionRef, selectionLabel, pointRef, serializeRef, parseRef, parseRefs, serialize, plainText, MAX_DETAIL } from "../src/logic/refs.ts";
import type { FmtElement } from "../src/format.ts";

const el = (id: string, type: string, label?: string, x = 0, y = 0): FmtElement => ({ id, type, x, y, width: 160, height: 70, label });

test("selection labels", () => {
  assert.equal(selectionLabel([el("a", "rectangle", "API")]), "rectangle “API”");
  assert.equal(selectionLabel([el("a", "ellipse")]), "ellipse");
  assert.equal(selectionLabel([el("a", "text", "a very long label that goes on and on")]), "text “a very long label that…”");
  assert.equal(selectionLabel([el("a", "rectangle"), el("b", "rectangle")]), "2 rectangles");
  assert.equal(selectionLabel([el("a", "rectangle"), el("b", "arrow")]), "2 elements");
});

test("a selection's tag carries ids, label and element lines", () => {
  const r = selectionRef([el("a1", "rectangle", "API", 10, 20), el("b2", "ellipse")])!;
  assert.equal(
    serializeRef(r),
    `<selection ids="a1,b2" label="2 elements">rectangle id=a1 "API" (10,20 160×70); ellipse id=b2 (0,0 160×70)</selection>`,
  );
  assert.deepEqual(parseRef(serializeRef(r)), r);
  assert.equal(selectionRef([]), null);
});

test("big selections are counted past the limit", () => {
  const els = Array.from({ length: MAX_DETAIL + 3 }, (_, i) => el(`e${i}`, "rectangle"));
  const r = selectionRef(els)!;
  assert.equal(r.kind === "selection" && r.ids.length, MAX_DETAIL + 3);
  assert.ok(r.detail.endsWith("… and 3 more"));
});

test("labels with markup, quotes and newlines stay one safe line", () => {
  const r = selectionRef([el("a", "text", 'x < y > "z" & </selection>\nnext')])!;
  const tag = serializeRef(r);
  assert.ok(!tag.includes("\n"));
  assert.equal(parseRefs(`before ${tag} after`).length, 3);
  assert.deepEqual(parseRef(tag), r);
});

test("a point, with and without nearby elements", () => {
  assert.equal(serializeRef(pointRef(120.4, -39.6)), `<point x="120" y="-40"/>`);
  const r = pointRef(0, 0, [el("a1", "rectangle", "API", 20, 0)]);
  assert.equal(r.label, "(0, 0)");
  assert.equal(serializeRef(r), `<point x="0" y="0">near: rectangle id=a1 "API" (20,0 160×70) 20px right</point>`);
  assert.deepEqual(parseRef(serializeRef(r)), r);
});

test("several references interleaved with text round-trip", () => {
  const a = selectionRef([el("a1", "rectangle", "API")])!;
  const p = pointRef(5, 6);
  const segs = ["move ", a, " to ", p, " and keep ", a, "\nthanks"];
  const text = serialize(segs);
  assert.deepEqual(parseRefs(text), segs);
  assert.equal(plainText(text), "move [rectangle “API”] to [(5, 6)] and keep [rectangle “API”]\nthanks");
});

test("text without references is one segment; lookalikes stay text", () => {
  assert.deepEqual(parseRefs("plain"), ["plain"]);
  assert.deepEqual(parseRefs(""), []);
  assert.deepEqual(parseRefs(`<point x="a" y="1"/>`), [`<point x="a" y="1"/>`]);
  assert.equal(parseRef("<b>hi</b>"), null);
});
