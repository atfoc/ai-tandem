import assert from "node:assert/strict";
import { test } from "node:test";

import { ACTION_WIDTH, EDGE, actionsWidth, dragPosition, mayStart, restAt, settle, type Sides } from "../src/ui/swipelogic.ts";

const both: Sides = { rightWidth: actionsWidth(2), leftWidth: actionsWidth(1), rowWidth: 390, rightFull: true, leftFull: true };
const rightOnly: Sides = { ...both, leftWidth: 0, leftFull: false };
const noFull: Sides = { ...both, rightFull: false, leftFull: false };

test("a button is 88 pt, a side is as wide as its buttons", () => {
  assert.equal(ACTION_WIDTH, 88);
  assert.equal(actionsWidth(2), 176);
});

test("a release past half of the buttons' width settles open, short of it closed", () => {
  assert.equal(settle(-89, 0, both), "open-right");
  assert.equal(settle(-87, 0, both), "closed");
  assert.equal(settle(60, 0, both), "open-left");
  assert.equal(settle(40, 0, both), "closed");
});

test("a fling settles the way it moves, whatever the distance", () => {
  assert.equal(settle(-20, -1200, both), "open-right");
  assert.equal(settle(-150, 1200, both), "closed");
  assert.equal(settle(20, 1200, both), "open-left");
  assert.equal(settle(80, -1200, both), "closed");
});

test("a full swipe past 60 % of the row runs the full action, only when the side has one", () => {
  assert.equal(settle(-235, 0, both), "full-right");
  assert.equal(settle(-233, 0, both), "open-right");
  assert.equal(settle(-300, 0, noFull), "open-right");
  assert.equal(settle(240, 0, both), "full-left");
});

test("a side without actions stays closed", () => {
  assert.equal(settle(80, 0, rightOnly), "closed");
  assert.equal(settle(0, 0, both), "closed");
  assert.equal(dragPosition(0, 120, rightOnly), 0);
  assert.equal(dragPosition(0, -999, rightOnly), -390);
  assert.equal(dragPosition(-176, 50, rightOnly), -126);
  assert.equal(dragPosition(-176, 300, rightOnly), 0);
});

test("the resting places", () => {
  assert.equal(restAt("open-right", both), -176);
  assert.equal(restAt("open-left", both), 88);
  assert.equal(restAt("full-right", both), -390);
  assert.equal(restAt("full-left", both), 390);
  assert.equal(restAt("closed", both), 0);
});

test("a touch inside the left 20 pt is the platform's", () => {
  assert.equal(EDGE, 20);
  assert.equal(mayStart(10), false);
  assert.equal(mayStart(19.9), false);
  assert.equal(mayStart(20), true);
});
