// Quick add's and type-to-edit's pure helpers (src/view/quickadd-logic.ts): where the "+" handles and the copy go, which keys
// start editing. The behaviour on the editor is checked on the dev page (plans/better-board/win-view.md, "T2c").
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  capturesKeys,
  centredAt,
  copyPosition,
  copyProps,
  copySize,
  freeCopyPosition,
  handlePositions,
  isCtrlYRedo,
  isQuickAddType,
  isTypingKey,
  nearRect,
  QUICK_ADD_GAP,
  type KeyLike,
} from "../src/view/quickadd-logic.ts";

const r = { x: 100, y: 200, w: 200, h: 100 };

test("quick add works on our sticky and the shape (geo) only", () => {
  assert.equal(isQuickAddType("aiwb-sticky"), true);
  assert.equal(isQuickAddType("geo"), true);
  for (const t of ["note", "text", "arrow", "frame", "draw", "image"]) assert.equal(isQuickAddType(t), false, t);
});

test("one handle per side, centred on it, `offset` outside", () => {
  assert.deepEqual(handlePositions(r, 10), [
    { side: "top", x: 200, y: 190 },
    { side: "right", x: 310, y: 250 },
    { side: "bottom", x: 200, y: 310 },
    { side: "left", x: 90, y: 250 },
  ]);
});

test("the hover area is the element plus a margin", () => {
  assert.equal(nearRect({ x: 200, y: 250 }, r, 0), true);
  assert.equal(nearRect({ x: 330, y: 250 }, r, 36), true);
  assert.equal(nearRect({ x: 337, y: 250 }, r, 36), false);
  assert.equal(nearRect({ x: 200, y: 165 }, r, 36), true);
  assert.equal(nearRect({ x: 200, y: 163 }, r, 36), false);
});

test("the copy goes `gap` away on the side, centred across it", () => {
  assert.equal(QUICK_ADD_GAP, 60);
  assert.deepEqual(copyPosition(r, "right"), { x: 360, y: 200 });
  assert.deepEqual(copyPosition(r, "left"), { x: -160, y: 200 });
  assert.deepEqual(copyPosition(r, "bottom"), { x: 100, y: 360 });
  assert.deepEqual(copyPosition(r, "top"), { x: 100, y: 40 });
  // a smaller copy (a shape whose label had grown it): centred on the source's side
  assert.deepEqual(copyPosition({ x: 0, y: 0, w: 200, h: 160 }, "right", 60, { w: 200, h: 100 }), { x: 260, y: 30 });
  assert.deepEqual(copyPosition({ x: 0, y: 0, w: 200, h: 160 }, "top", 60, { w: 200, h: 100 }), { x: 0, y: -160 });
});

test("a taken place moves the copy across the side, alternating, by size plus gap", () => {
  // free: the plain place
  assert.deepEqual(freeCopyPosition(r, "right", []), { x: 360, y: 200 });
  // touching edges are no overlap
  assert.deepEqual(freeCopyPosition(r, "right", [{ x: 560, y: 200, w: 50, h: 50 }]), { x: 360, y: 200 });
  // taken: one step down (h + gap)
  const block = { x: 380, y: 220, w: 10, h: 10 };
  assert.deepEqual(freeCopyPosition(r, "right", [block]), { x: 360, y: 360 });
  // that one taken too: one step up
  assert.deepEqual(freeCopyPosition(r, "right", [block, { x: 380, y: 380, w: 10, h: 10 }]), { x: 360, y: 40 });
  // top/bottom move sideways (w + gap)
  assert.deepEqual(freeCopyPosition(r, "bottom", [{ x: 150, y: 380, w: 10, h: 10 }]), { x: 360, y: 360 });
  // nowhere free within the tries: the plain place
  assert.deepEqual(freeCopyPosition(r, "right", [{ x: -1e5, y: -1e5, w: 2e5, h: 2e5 }]), { x: 360, y: 200 });
});

test("the copy's props are the source's with the text emptied; a shape's growY back to 0", () => {
  const empty = { type: "doc", content: [{ type: "paragraph" }] };
  const geo = { w: 200, h: 100, growY: 40, geo: "ellipse", fill: "fill", fillColor: "yellow", color: "blue", richText: { type: "doc", content: [] } };
  assert.deepEqual(copyProps("geo", geo, empty), { ...geo, growY: 0, richText: empty });
  const sticky = { w: 200, h: 200, color: "light-pink", fontSize: 0, fitted: 18, richText: { type: "doc", content: [] } };
  assert.deepEqual(copyProps("aiwb-sticky", sticky, empty), { ...sticky, richText: empty });
  // the source is not changed
  assert.equal(geo.growY, 40);
  assert.deepEqual(copySize(geo, { w: 1, h: 1 }), { w: 200, h: 100 });
  assert.deepEqual(copySize({}, { w: 1, h: 2 }), { w: 1, h: 2 });
  assert.deepEqual(centredAt({ x: 100, y: 100 }, 200, 100), { x: 0, y: 50 });
});

const key = (k: string, m: Partial<KeyLike> = {}): KeyLike => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...m });

test("typing keys: one printable character, no Ctrl/⌘/Alt, not Space, not Shift+0/1/2", () => {
  for (const k of ["a", "R", "1", "?", "[", "=", "ü", "😀", "/"]) assert.equal(isTypingKey(key(k)), true, k);
  assert.equal(isTypingKey(key("A", { shiftKey: true, code: "KeyA" })), true);
  for (const k of [" ", "Enter", "Escape", "Tab", "Backspace", "Delete", "ArrowLeft", "F1", "Shift", "Dead"]) assert.equal(isTypingKey(key(k)), false, k);
  for (const m of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) assert.equal(isTypingKey(key("a", m)), false, JSON.stringify(m));
  for (const d of ["Digit0", "Digit1", "Digit2"]) assert.equal(isTypingKey(key("!", { shiftKey: true, code: d })), false, d);
  assert.equal(isTypingKey(key("#", { shiftKey: true, code: "Digit3" })), true);
});

test("Ctrl+Y is redo; not with Shift, Alt or ⌘", () => {
  assert.equal(isCtrlYRedo(key("y", { ctrlKey: true })), true);
  assert.equal(isCtrlYRedo(key("Y", { ctrlKey: true })), true);
  assert.equal(isCtrlYRedo(key("y")), false);
  assert.equal(isCtrlYRedo(key("y", { ctrlKey: true, shiftKey: true })), false);
  assert.equal(isCtrlYRedo(key("y", { ctrlKey: true, metaKey: true })), false);
  assert.equal(isCtrlYRedo(key("z", { ctrlKey: true })), false);
});

test("inputs, selects, text areas and editable text take keys; buttons and the board do not", () => {
  for (const t of ["INPUT", "textarea", "SELECT"]) assert.equal(capturesKeys({ tagName: t }), true, t);
  assert.equal(capturesKeys({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(capturesKeys({ tagName: "DIV" }), false);
  assert.equal(capturesKeys({ tagName: "BUTTON" }), false);
  assert.equal(capturesKeys(null), false);
});
