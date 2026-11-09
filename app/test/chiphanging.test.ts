// The hanging indent of the web chip input, as far as it needs no DOM (hanging.ts): rects grouped into visual lines, the band of a wrapped
// indented line, the float's shape for a staircase of bands, and when two measures count as settled. hangingdom.ts measures the page.
import assert from "node:assert/strict";
import { test } from "node:test";

import { bandOf, hangOf, sameBands, visualLines } from "../src/platform/chipinput/hanging.ts";

const ORIGIN = { left: 10, top: 100 };

test("visualLines: a text rect and a taller chip starting 2 px higher are one line", () => {
  assert.deepEqual(visualLines([{ top: 102, bottom: 120, left: 20 }, { top: 100, bottom: 122, left: 60 }]), [{ top: 100, bottom: 122 }]);
});

test("visualLines: consecutive lines stay apart, sorted by top, rects with no height left out", () => {
  const rects = [
    { top: 138, bottom: 157, left: 10 },
    { top: 100, bottom: 119, left: 40 },
    { top: 119, bottom: 138, left: 10 },
    { top: 130, bottom: 130, left: 99 },
  ];
  assert.deepEqual(visualLines(rects), [{ top: 100, bottom: 119 }, { top: 119, bottom: 138 }, { top: 138, bottom: 157 }]);
});

test("bandOf: one visual line, or an indent under 1 px, has no band", () => {
  assert.equal(bandOf([{ top: 100, bottom: 119, left: 40 }, { top: 100, bottom: 119, left: 80 }], ORIGIN, 200), null);
  assert.equal(bandOf([{ top: 100, bottom: 119, left: 10.5 }, { top: 119, bottom: 138, left: 10 }], ORIGIN, 200), null);
  assert.equal(bandOf([], ORIGIN, 200), null);
});

test("bandOf: two and three visual lines, from the second's top to the last's bottom, 0.5 px inside", () => {
  assert.deepEqual(bandOf([{ top: 103, bottom: 122, left: 42 }, { top: 122, bottom: 141, left: 10 }], ORIGIN, 200), { y0: 22.5, y1: 40.5, w: 32 });
  const three = [{ top: 103, bottom: 122, left: 42 }, { top: 122, bottom: 141, left: 10 }, { top: 141, bottom: 160, left: 10 }];
  assert.deepEqual(bandOf(three, ORIGIN, 200), { y0: 22.5, y1: 59.5, w: 32 });
});

test("bandOf: the indent is capped at maxIndent", () => {
  assert.equal(bandOf([{ top: 103, bottom: 122, left: 300 }, { top: 122, bottom: 141, left: 10 }], ORIGIN, 120)!.w, 120);
});

test("bandOf: a first line made taller by a chip", () => {
  // (the chip first, 2 px above the text after it, then the text on the next visual line)
  const rects = [{ top: 101, bottom: 123, left: 50 }, { top: 103, bottom: 122, left: 120 }, { top: 123, bottom: 142, left: 10 }];
  assert.deepEqual(bandOf(rects, ORIGIN, 200), { y0: 23.5, y1: 41.5, w: 40 });
});

test("hangOf: none for no bands", () => {
  assert.equal(hangOf([]), null);
});

test("hangOf: two bands make a staircase as wide as the widest and as high as the last", () => {
  const hang = hangOf([{ y0: 22.5, y1: 40.5, w: 32 }, { y0: 79.5, y1: 116.25, w: 64.333 }]);
  assert.deepEqual(hang, {
    width: 64.333,
    height: 116.25,
    shape: "polygon(0 0, 0 22.50px, 32.00px 22.50px, 32.00px 40.50px, 0 40.50px, 0 79.50px, 64.33px 79.50px, 64.33px 116.25px, 0 116.25px, 0 116.25px)",
  });
});

test("sameBands: within 0.5 px is the same, more or another count is not", () => {
  const a = [{ y0: 22.5, y1: 40.5, w: 32 }];
  assert.ok(sameBands(a, [{ y0: 22.9, y1: 40.1, w: 32.5 }]));
  assert.ok(!sameBands(a, [{ y0: 22.5, y1: 41.5, w: 32 }]));
  assert.ok(!sameBands(a, []));
  assert.ok(sameBands([], []));
});
