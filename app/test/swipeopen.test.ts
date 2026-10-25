// swipeopen.ts: at most one swipe row is open; opening a row closes the one that was open.
import assert from "node:assert/strict";
import { test } from "node:test";

import { SWIPE_PRESS_MS, clearOpen, closeOpen, closeOthers, nextRowId, pressUnlessSwiped, setOpen, swiped, swipePressBlocked } from "../src/ui/swipeopen.ts";

test("opening a row closes the one that was open", () => {
  const [a, b] = [nextRowId(), nextRowId()];
  const closed: number[] = [];
  setOpen(a, () => closed.push(a));
  setOpen(b, () => closed.push(b));
  assert.deepEqual(closed, [a]);
  closeOpen();
  assert.deepEqual(closed, [a, b]);
  clearOpen(b);
});

test("a swipe that starts on another row closes the open one, not its own", () => {
  const [a, b] = [nextRowId(), nextRowId()];
  const closed: number[] = [];
  setOpen(a, () => closed.push(a));
  closeOthers(a);
  assert.deepEqual(closed, []);
  closeOthers(b);
  assert.deepEqual(closed, [a]);
  clearOpen(a);
});

test("clearing a row that is not the open one leaves the open one", () => {
  const [a, b] = [nextRowId(), nextRowId()];
  const closed: number[] = [];
  setOpen(a, () => closed.push(a));
  clearOpen(b);
  closeOpen();
  assert.deepEqual(closed, [a]);
  clearOpen(a);
});

test("a press right after a swipe moved a row is the end of that swipe, and no press", () => {
  assert.equal(swipePressBlocked(1_000_000), false);
  swiped(1_000_000);
  assert.equal(swipePressBlocked(1_000_000), true);
  assert.equal(swipePressBlocked(1_000_000 + SWIPE_PRESS_MS - 1), true);
  assert.equal(swipePressBlocked(1_000_000 + SWIPE_PRESS_MS), false);
});

test("a row's press waits a moment: a swipe that starts meanwhile takes it, else it runs", async () => {
  const ran: string[] = [];
  pressUnlessSwiped(() => ran.push("tap"), 5);
  await new Promise((r) => setTimeout(r, 20));
  pressUnlessSwiped(() => ran.push("swipe's end"), 5);
  swiped(); // (the pan's start comes after the press)
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(ran, ["tap"]);
});
