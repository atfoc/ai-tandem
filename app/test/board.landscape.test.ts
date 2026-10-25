// Where the landscape controls sit (screens/board/floatlayout.ts, package B1): 8 pt from each edge, or the safe area's inset where
// that is more. (The rule that says when the view is landscape, `isBoardLandscape` of landscape.ts, imports react-native, which Node
// does not load here; the device flow covers it.)
import assert from "node:assert/strict";
import { test } from "node:test";

import { FLOAT_EDGE, floatEdges, topInsetFor } from "../src/screens/board/floatlayout.ts";

test("without insets the controls are 8 pt from every edge", () => {
  const all = { top: FLOAT_EDGE, right: FLOAT_EDGE, bottom: FLOAT_EDGE, left: FLOAT_EDGE };
  assert.deepEqual(floatEdges(null), all);
  assert.deepEqual(floatEdges(undefined), all);
  assert.deepEqual(floatEdges({ top: 0, right: 0, bottom: 0, left: 0 }), all);
});

test("a notch on the left and a home indicator below move the controls clear of them", () => {
  assert.deepEqual(floatEdges({ top: 0, right: 0, bottom: 21, left: 59 }), { top: 8, right: 8, bottom: 21, left: 59 });
  assert.deepEqual(floatEdges({ top: 0, right: 59, bottom: 21, left: 0 }), { top: 8, right: 59, bottom: 21, left: 8 });
});

test("an inset smaller than the gap keeps the gap", () => {
  assert.deepEqual(floatEdges({ top: 3, right: 5, bottom: 7, left: 2 }), { top: 8, right: 8, bottom: 8, left: 8 });
});

test("the top inset is the controls' lowest edge and the 8 pt gap, whole, within the bridge's 0 to 200; none for no controls", () => {
  assert.equal(topInsetFor(44), 52);
  assert.equal(topInsetFor(43.2), 52);
  assert.equal(topInsetFor(0), 0);
  assert.equal(topInsetFor(null), 0);
  assert.equal(topInsetFor(NaN), 0);
  assert.equal(topInsetFor(-5), 0);
  assert.equal(topInsetFor(900), 200);
});
