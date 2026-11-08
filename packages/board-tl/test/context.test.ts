// The context bar's logic (src/view/ctxModel.ts): which controls a selection gets (goal 3.3), the popovers they go in, the
// shared values ("mixed" = null), bold on rich text, and where the bar and its popovers go.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ARROWHEAD_CHOICES,
  INK_CHOICES,
  STICKY_COLOR_CHOICES,
  STICKY_SIZE_CHOICES,
  arrowLook,
  controlsFor,
  curvedBend,
  groupsFor,
  isAllBold,
  placeBar,
  placePopover,
  readValues,
  withBold,
  type ShapeLike,
} from "../src/view/ctxModel.ts";

const sticky = (props = {}): ShapeLike => ({ type: "aiwb-sticky", props: { color: "light-yellow", fontSize: 0, align: "middle", ...props } });
const geo = (props = {}): ShapeLike => ({
  type: "geo",
  props: { geo: "rectangle", fill: "fill", fillColor: "white", color: "black", size: "m", dash: "solid", labelSize: "m", align: "middle", ...props },
});
const rt = (...paras: { text: string; marks?: { type: string }[] }[][]) => ({
  type: "doc",
  content: paras.map((p) => ({ type: "paragraph", content: p.map((t) => ({ type: "text", ...t })) })),
});
const text = (props = {}): ShapeLike => ({ type: "text", props: { color: "black", size: "m", textAlign: "start", richText: rt([{ text: "hi" }]), ...props } });
const arrow = (props = {}): ShapeLike => ({
  type: "arrow",
  props: { kind: "arc", bend: 0, size: "m", dash: "solid", color: "black", arrowheadStart: "none", arrowheadEnd: "arrow", start: { x: 0, y: 0 }, end: { x: 300, y: 0 }, ...props },
});
const frame = (props = {}): ShapeLike => ({ type: "frame", props: { name: "Sprint", color: "black", ...props } });

test("each kind of element gets goal 3.3's controls", () => {
  assert.deepEqual(controlsFor([sticky()]).keys, ["stickyColor", "stickyFontSize", "align"]);
  assert.deepEqual(controlsFor([geo()]).keys, ["geo", "fillColor", "borderColor", "lineWidth", "dash", "labelSize", "align"]);
  assert.deepEqual(controlsFor([text()]).keys, ["color", "fontSize", "textAlign", "bold"]);
  assert.deepEqual(controlsFor([arrow()]).keys, ["arrowKind", "lineWidth", "dash", "color", "arrowheadStart", "arrowheadEnd"]);
  assert.deepEqual(controlsFor([frame()]).keys, ["frameName", "color"]);
  const one = controlsFor([sticky()]);
  assert.equal(one.align, false);
  assert.equal(one.distribute, false);
  assert.equal(one.locked, false);
});

test("several: what they have in common, plus align (2+) and distribute (3+)", () => {
  const two = controlsFor([geo(), geo()]);
  assert.deepEqual(two.keys, controlsFor([geo()]).keys);
  assert.equal(two.align, true);
  assert.equal(two.distribute, false);
  assert.equal(controlsFor([geo(), geo(), geo()]).distribute, true);
  // a sticky and a shape share the text alignment only (their colours are different style props)
  assert.deepEqual(controlsFor([sticky(), geo()]).keys, ["align"]);
  // a shape and a connector share the line's width and style
  assert.deepEqual(controlsFor([geo(), arrow()]).keys, ["lineWidth", "dash"]);
  // a type without a section (an image) leaves only the "always" group
  assert.deepEqual(controlsFor([geo(), { type: "image", props: {} }]).keys, []);
});

test("a locked selection shows only Unlock; partly locked is not locked", () => {
  const locked = controlsFor([{ ...sticky(), isLocked: true }, { ...geo(), isLocked: true }]);
  assert.deepEqual(locked, { keys: [], locked: true, align: false, distribute: false });
  assert.equal(controlsFor([{ ...sticky(), isLocked: true }, sticky()]).locked, false);
});

test("the controls are grouped into popovers in the bar's order", () => {
  const g = (shapes: ShapeLike[]) => groupsFor(controlsFor(shapes).keys).map((x) => `${x.id}:${x.keys.join("+")}`);
  assert.deepEqual(g([sticky()]), ["color:stickyColor", "text:stickyFontSize+align"]);
  assert.deepEqual(g([geo()]), ["shape:geo", "color:fillColor+borderColor", "text:labelSize+align", "line:lineWidth+dash"]);
  assert.deepEqual(g([text()]), ["color:color", "text:fontSize+textAlign", "bold:bold"]);
  assert.deepEqual(g([arrow()]), ["color:color", "line:arrowKind+lineWidth+dash", "ends:arrowheadStart+arrowheadEnd"]);
  assert.deepEqual(g([frame()]), ["name:frameName", "color:color"]);
});

test("the choices: 16 sticky colours, 12 inks by our names, 6 arrowheads, Auto + 4 sticky sizes", () => {
  assert.equal(STICKY_COLOR_CHOICES.length, 16);
  assert.equal(INK_CHOICES.length, 12);
  assert.deepEqual(INK_CHOICES.find((c) => c.name === "pink"), { name: "pink", stored: "light-red" });
  assert.deepEqual(ARROWHEAD_CHOICES, ["none", "arrow", "triangle", "dot", "diamond", "bar"]);
  assert.deepEqual(STICKY_SIZE_CHOICES.map((c) => c.value), [0, 16, 24, 32, 48]);
});

test("values: shared, or null when mixed", () => {
  const keys = controlsFor([geo()]).keys;
  const v = readValues(keys, [geo({ color: "blue" }), geo({ color: "blue", size: "l" })]);
  assert.equal(v.borderColor, "blue");
  assert.equal(v.lineWidth, null);
  assert.equal(v.geo, "rectangle");
  // fill: "none" when the fill style is none, else the fill colour
  assert.equal(readValues(["fillColor"], [geo({ fill: "none", fillColor: "red" })]).fillColor, "none");
  assert.equal(readValues(["fillColor"], [geo({ fillColor: "red" })]).fillColor, "red");
  assert.equal(readValues(["fillColor"], [geo({ fill: "none" }), geo()]).fillColor, null);
  assert.equal(readValues(["stickyFontSize"], [sticky({ fontSize: 24 })]).stickyFontSize, 24);
  assert.equal(readValues(["stickyFontSize"], [sticky({ fontSize: 24 }), sticky()]).stickyFontSize, null);
  assert.equal(readValues(["frameName"], [frame()]).frameName, "Sprint");
  assert.equal(readValues(["arrowKind"], [arrow({ bend: 40 })]).arrowKind, "curved");
  assert.equal(readValues(["arrowKind"], [arrow(), arrow({ kind: "elbow" })]).arrowKind, null);
});

test("arrow look: straight / curved / elbow, and the bend a curve gets", () => {
  assert.equal(arrowLook({ kind: "arc", bend: 0 }), "straight");
  assert.equal(arrowLook({ kind: "arc", bend: 0.3 }), "straight");
  assert.equal(arrowLook({ kind: "arc", bend: -30 }), "curved");
  assert.equal(arrowLook({ kind: "elbow", bend: 30 }), "elbow");
  assert.equal(curvedBend({ kind: "arc", bend: 0, start: { x: 0, y: 0 }, end: { x: 300, y: 0 } }), 60);
  assert.equal(curvedBend({ kind: "arc", bend: 0, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } }), 20);
  assert.equal(curvedBend({ kind: "arc", bend: -45, start: { x: 0, y: 0 }, end: { x: 300, y: 0 } }), -45);
});

test("bold: on when every text node is bold; toggling keeps other marks and the text", () => {
  const plain = rt([{ text: "a" }, { text: "b", marks: [{ type: "italic" }] }], [{ text: "c" }]);
  assert.equal(isAllBold(plain), false);
  assert.equal(isAllBold(rt([])), false); // no text: not bold
  assert.equal(isAllBold(rt([{ text: "a", marks: [{ type: "bold" }] }], [{ text: "c" }])), false); // partly
  const bold = withBold(plain, true);
  assert.equal(isAllBold(bold), true);
  assert.deepEqual(bold.content[0].content[1].marks, [{ type: "italic" }, { type: "bold" }]);
  assert.equal(bold.content[1].content[0].text, "c");
  assert.equal(isAllBold(withBold(bold, true)), true); // twice: one bold mark, not two
  assert.equal(withBold(bold, true).content[0].content[0].marks!.length, 1);
  const back = withBold(bold, false);
  assert.deepEqual(back, plain); // unbold restores the original (no empty marks arrays)
  assert.equal(readValues(["bold"], [text({ richText: bold }), text()]).bold, false);
  assert.equal(readValues(["bold"], [text({ richText: bold })]).bold, true);
});

test("the bar: centred above, clamped to the viewport, flipped below when no room above", () => {
  const view = { w: 1280, h: 800 };
  const bar = { w: 300, h: 36 };
  // room above: centred, 12 px above
  assert.deepEqual(placeBar({ minX: 500, minY: 400, maxX: 700, maxY: 500 }, bar, view), { left: 450, top: 352, below: false });
  // at the right edge: clamped 8 px in
  assert.equal(placeBar({ minX: 1200, minY: 400, maxX: 1300, maxY: 500 }, bar, view).left, 1280 - 8 - 300);
  // at the left edge
  assert.equal(placeBar({ minX: -100, minY: 400, maxX: 20, maxY: 500 }, bar, view).left, 8);
  // near the top: below the selection
  assert.deepEqual(placeBar({ minX: 500, minY: 20, maxX: 700, maxY: 120 }, bar, view), { left: 450, top: 132, below: true });
  // the selection fills the viewport: inside it, at the bottom
  const full = placeBar({ minX: -50, minY: -50, maxX: 1400, maxY: 900 }, bar, view);
  assert.deepEqual(full, { left: 525, top: 800 - 8 - 36, below: true });
  // a bar wider than the viewport sticks to the left margin
  assert.equal(placeBar({ minX: 100, minY: 400, maxX: 200, maxY: 500 }, { w: 400, h: 36 }, { w: 390, h: 844 }).left, 8);
});

test("a popover: under its button, above it when no room below, clamped", () => {
  const view = { w: 1280, h: 800 };
  const pop = { w: 240, h: 120 };
  assert.deepEqual(placePopover({ minX: 100, minY: 100, maxX: 130, maxY: 130 }, pop, view), { left: 100, top: 136, up: false });
  assert.deepEqual(placePopover({ minX: 100, minY: 700, maxX: 130, maxY: 730 }, pop, view), { left: 100, top: 574, up: true });
  assert.equal(placePopover({ minX: 1200, minY: 100, maxX: 1230, maxY: 130 }, pop, view).left, 1280 - 8 - 240);
  // neither fits: clamped into the viewport
  const tiny = placePopover({ minX: 10, minY: 50, maxX: 40, maxY: 80 }, pop, { w: 300, h: 150 });
  assert.equal(tiny.top, 150 - 8 - 120);
});
