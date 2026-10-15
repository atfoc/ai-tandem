// When a thread follows its end (screens/chat/scroll.ts; B-SM-06 to B-SM-09): the page's rule of 40 px, over scroll events.
import assert from "node:assert/strict";
import { test } from "node:test";

import { FOLLOW_PX, distanceFromEnd, follows } from "../src/screens/chat/scroll.ts";

const at = (offset: number, content = 2000, view = 500) => ({ offset, content, view });

test("distanceFromEnd: what is left below the window", () => {
  assert.equal(distanceFromEnd(at(1500)), 0);
  assert.equal(distanceFromEnd(at(1000)), 500);
});

test("a thread at its end follows, and one that the user scrolled up from by more than 40 px does not", () => {
  assert.equal(follows(true, 1500, at(1500)), true);
  assert.equal(follows(true, 1500, at(1500 - FOLLOW_PX - 1)), false); // up, past the 40 px
  assert.equal(follows(true, 1500, at(1500 - FOLLOW_PX + 2)), true);  // up, but not far (39 px from the end)
});

test("scrolled up, it follows again from within 40 px of the end, and not before", () => {
  assert.equal(follows(false, 900, at(1000)), false);
  assert.equal(follows(false, 1000, at(1461)), true);  // 39 px left
  assert.equal(follows(false, 1000, at(1460)), false); // 40 px left: not under 40
  assert.equal(follows(false, 1000, at(1440)), false);
});

test("content that grows under a thread that follows does not end it: the event has the offset it had", () => {
  // the answer grew by 300 px before the thread was moved: 300 px from the end now, the offset where it was
  assert.equal(follows(true, 1500, at(1500, 2300)), true);
  // …and a thread that did not follow is not made to by it
  assert.equal(follows(false, 1000, at(1000, 2300)), false);
});

test("a view that got shorter (the composer grew) does not end it either", () => {
  assert.equal(follows(true, 1500, at(1500, 2000, 300)), true);
});
