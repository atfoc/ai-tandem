// The phone's image viewer (screens/images/viewer.ts; goal 3.5 "Images", mockup `ch-09b`): its second line, the page dots, which actions its bottom row
// has on which platform, why "Ask about it" is off, and the limits of the pinch and of the pan of a zoomed picture.
import assert from "node:assert/strict";
import { test } from "node:test";

import { askWhy, clampPan, clampScale, MAX_ZOOM, pageDots, PHONE_THUMB, viewerActions, viewerSub, zoomed } from "../src/screens/images/viewer.ts";

test("the thumbnails of a sent message on the phone are 116 x 140 pt with an 8 pt gap", () => {
  assert.deepEqual(PHONE_THUMB, { width: 116, height: 140, gap: 8 });
});

test("the line under the name says which of the images it is and whose message it came with", () => {
  assert.equal(viewerSub(0, 2), "Image 1 of 2 · your message");
  assert.equal(viewerSub(1, 2, "agent"), "Image 2 of 2 · Claude's reply");
  assert.equal(viewerSub(0, 1), "Image · your message");
});

test("the page dots: one per image with the shown one on, none for a single image", () => {
  assert.deepEqual(pageDots(1, 3).map((d) => d.on), [false, true, false]);
  assert.deepEqual(pageDots(0, 2).map((d) => d.on), [true, false]);
  assert.deepEqual(pageDots(0, 1), []);
  assert.deepEqual(pageDots(0, 0), []);
});

test("the bottom row: web shares only where the browser shares files, iOS has all three, Android only what it can do", () => {
  assert.deepEqual(viewerActions({ os: "web", canShareFiles: true, canAsk: true }), ["share", "save", "ask"]);
  assert.deepEqual(viewerActions({ os: "web", canShareFiles: false, canAsk: true }), ["save", "ask"]);
  assert.deepEqual(viewerActions({ os: "ios", canShareFiles: true, canAsk: true }), ["share", "save", "ask"]);
  assert.deepEqual(viewerActions({ os: "android", canShareFiles: true, canAsk: true }), ["ask"]);
  assert.deepEqual(viewerActions({ os: "ios", canShareFiles: true, canAsk: false }), ["share", "save"]);
});

test("Ask about it is off with its reason when the chat takes no change", () => {
  const on = { server: "Work Mac", connected: true, gone: false, archived: false };
  assert.equal(askWhy(on), "");
  assert.equal(askWhy({ ...on, connected: false }), "Work Mac is not connected");
  assert.equal(askWhy({ ...on, gone: true }), "This chat is no longer on Work Mac.");
  assert.equal(askWhy({ ...on, archived: true }), "This chat is archived");
  assert.equal(askWhy({ ...on, model: "Haiku" }), "Haiku takes no images");
  assert.equal(askWhy({ ...on, gone: true, connected: false }), "This chat is no longer on Work Mac.");
});

test("the pinch stays between rest and the most it zooms to", () => {
  assert.equal(clampScale(0.3), 1);
  assert.equal(clampScale(2.5), 2.5);
  assert.equal(clampScale(40), MAX_ZOOM);
  assert.equal(clampScale(NaN), 1);
  assert.equal(zoomed(1), false);
  assert.equal(zoomed(1.005), false);
  assert.equal(zoomed(1.5), true);
});

test("a zoomed picture is panned only as far as its edges reach the box's", () => {
  const box = { width: 400, height: 600 }, fit = { width: 400, height: 300 };
  // twice as large: 800 x 600 in a 400 x 600 box: 200 to each side, and no room up or down
  assert.deepEqual(clampPan({ x: 500, y: 90 }, 2, fit, box), { x: 200, y: 0 });
  assert.deepEqual(clampPan({ x: -500, y: -90 }, 2, fit, box), { x: -200, y: 0 });
  assert.deepEqual(clampPan({ x: 50, y: 0 }, 2, fit, box), { x: 50, y: 0 });
  // at rest the picture does not move
  assert.deepEqual(clampPan({ x: 30, y: 30 }, 1, fit, box), { x: 0, y: 0 });
  // a small picture zoomed but still inside the box stays centred
  assert.deepEqual(clampPan({ x: 30, y: 30 }, 2, { width: 100, height: 100 }, box), { x: 0, y: 0 });
});
