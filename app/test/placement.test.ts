import assert from "node:assert/strict";
import { test } from "node:test";

import { EDGE, GAP_ABOVE, GAP_BELOW, placePopover } from "../src/ui/placement.ts";

const window = { width: 1000, height: 800 };
const anchor = { x: 100, y: 100, width: 80, height: 28 };

test("a popover hangs below its anchor, its left edge on the anchor's", () => {
  const p = placePopover({ anchor, size: { width: 200, height: 150 }, window });
  assert.deepEqual([p.left, p.top, p.up], [100, 100 + 28 + GAP_BELOW, false]);
  assert.equal(p.maxHeight, 800 - 128 - GAP_BELOW - EDGE);
});

test("align right: its right edge is on the anchor's", () => {
  const p = placePopover({ anchor: { ...anchor, x: 400 }, size: { width: 200, height: 150 }, window, align: "right" });
  assert.equal(p.left + 200, 480);
});

test("up: it hangs above its anchor by the gap above", () => {
  const a = { x: 100, y: 500, width: 80, height: 28 };
  const p = placePopover({ anchor: a, size: { width: 200, height: 150 }, window, up: true });
  assert.deepEqual([p.up, p.top + 150], [true, 500 - GAP_ABOVE]);
});

test("it is pulled back inside the window by the edge space, to the right and to the left", () => {
  const right = placePopover({ anchor: { x: 950, y: 100, width: 40, height: 28 }, size: { width: 200, height: 100 }, window });
  assert.equal(right.left, 1000 - EDGE - 200);
  const left = placePopover({ anchor: { x: -20, y: 100, width: 40, height: 28 }, size: { width: 200, height: 100 }, window, align: "right" });
  assert.equal(left.left, EDGE);
});

test("with too little room below and more above, it goes above; taller than both, it takes the larger side and its room", () => {
  const low = { x: 100, y: 700, width: 80, height: 28 };
  assert.equal(placePopover({ anchor: low, size: { width: 200, height: 300 }, window }).up, true);
  // a window 260 high: the anchor sits in the middle, the popover is taller than either side: the larger side holds it
  const tight = placePopover({ anchor: { x: 10, y: 120, width: 60, height: 28 }, size: { width: 200, height: 500 }, window: { width: 1000, height: 260 } });
  assert.equal(tight.up, true); // 106 above, 100 below
  assert.equal(tight.maxHeight, 120 - GAP_ABOVE - EDGE);
  assert.ok(tight.top >= EDGE, "inside the window");
});

test("up with no room above goes below; the height it may take is never negative", () => {
  const p = placePopover({ anchor: { x: 10, y: 5, width: 60, height: 28 }, size: { width: 100, height: 100 }, window, up: true });
  assert.equal(p.up, false);
  const none = placePopover({ anchor: { x: 10, y: 0, width: 60, height: 28 }, size: { width: 100, height: 100 }, window: { width: 100, height: 30 }, up: true });
  assert.ok(none.maxHeight >= 0);
});

test("with the keyboard up, an `up` popover whose anchor is under the keyboard rises with the keyboard's top", () => {
  // the composer's toolbar at the bottom of a 1000 x 800 window, the keyboard covers the last 300 points
  const toolbar = { x: 100, y: 740, width: 80, height: 28 };
  const p = placePopover({ anchor: toolbar, size: { width: 200, height: 150 }, window, up: true, covered: 300 });
  assert.equal(p.up, true);
  assert.equal(p.top + 150, 800 - 300 - EDGE, "its bottom edge is the keyboard's top less the edge space");
  assert.equal(p.maxHeight, 800 - 300 - EDGE - EDGE);
});

test("with the keyboard up, an anchor above the keyboard keeps its place", () => {
  const a = { x: 100, y: 400, width: 80, height: 28 };
  const p = placePopover({ anchor: a, size: { width: 200, height: 150 }, window, up: true, covered: 300 });
  assert.equal(p.top + 150, 400 - GAP_ABOVE);
});

test("with the keyboard up, one that does not fit gets the height that is left and stays above the keyboard", () => {
  const toolbar = { x: 100, y: 740, width: 80, height: 28 };
  const p = placePopover({ anchor: toolbar, size: { width: 200, height: 900 }, window, up: true, covered: 300 });
  const room = 800 - 300 - 2 * EDGE;
  assert.equal(p.maxHeight, room);
  assert.equal(p.top, EDGE);
  assert.ok(p.top + Math.min(900, p.maxHeight) <= 800 - 300 - EDGE, "its bottom is above the keyboard");
});

test("with the keyboard up, a popover that hangs below an anchor under the keyboard goes above it; one that hangs below in the free part keeps its place and its room shrinks", () => {
  const under = placePopover({ anchor: { x: 10, y: 700, width: 60, height: 28 }, size: { width: 100, height: 100 }, window, covered: 300 });
  assert.equal(under.up, true);
  assert.ok(under.top + 100 <= 800 - 300 - EDGE);
  const free = placePopover({ anchor: { x: 10, y: 100, width: 60, height: 28 }, size: { width: 100, height: 100 }, window, covered: 300 });
  assert.deepEqual([free.up, free.top], [false, 100 + 28 + GAP_BELOW]);
  assert.equal(free.maxHeight, 500 - 128 - GAP_BELOW - EDGE);
});

test("without the keyboard (`covered` 0 or missing) nothing changes", () => {
  const a = { x: 100, y: 500, width: 80, height: 28 };
  const size = { width: 200, height: 150 };
  assert.deepEqual(placePopover({ anchor: a, size, window, up: true, covered: 0 }), placePopover({ anchor: a, size, window, up: true }));
});
