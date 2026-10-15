// A sent message's images in the app (screens/images/shown.ts; B-IM-01, B-IM-03, B-IM-04, B-IM-05, D-PC-01): what the thumbnails are made from
// on every way, where the large view puts a picture, and what a swipe does there. The core logic they stand on (showsText, stepImage,
// largeCaption, IMAGE_WORD) is core's own test (messageimages.test.ts).
import assert from "node:assert/strict";
import { test } from "node:test";

import { IMAGE_WORD } from "@aiwb/core/logic/chatimage.ts";
import { largeCaption, showsText, stepImage } from "@aiwb/core/logic/messageimages.ts";

import { fitInside, shownPictures, swipeOf } from "../src/screens/images/shown.ts";

const id = (c: string) => c.repeat(64);
const img = (c: string, name: string) => ({ id: id(c), name, type: "image/png", size: 10 });

test("a message's thumbnails: each image on its chat's own server and id, in the message's order, by its name", () => {
  const got = shownPictures("c_1", [img("a", "one.png"), img("b", "two.png")]);
  assert.deepEqual(got, [
    { id: id("a"), server: "local", chat: "c_1", name: "one.png" },
    { id: id("b"), server: "local", chat: "c_1", name: "two.png" },
  ]);
});

test("the images of a section's chat are asked of that section's server with the chat's own id there", () => {
  const got = shownPictures("s_lab~c_9", [img("a", "one.png")]);
  assert.deepEqual(got, [{ id: id("a"), server: "s_lab", chat: "c_9", name: "one.png" }]);
});

test("an image the message holds twice is shown twice", () => {
  assert.equal(shownPictures("c_1", [img("a", "one.png"), img("a", "one.png")]).length, 2);
});

test("an image without a name is named by the fixed word, so that its plain tile is never blank", () => {
  const got = shownPictures("c_1", [img("a", ""), img("b", "  ")]);
  assert.deepEqual(got.map((x) => x.name), [IMAGE_WORD, IMAGE_WORD]);
  assert.equal(IMAGE_WORD, "Image");
  assert.deepEqual(shownPictures("c_1", undefined), []);
});

test("a message of images alone draws no words, one with words draws them", () => {
  assert.equal(showsText({ text: "", images: [img("a", "x")] }), false);
  assert.equal(showsText({ text: "Look", images: [img("a", "x")] }), true);
});

test("the large view's line and steps (core's rules, as the view uses them)", () => {
  assert.equal(largeCaption("two.png", 1, 3), "two.png · 2 of 3");
  assert.equal(largeCaption("two.png", 0, 1), "two.png");
  assert.equal(stepImage(2, 3, 1), 2); // stops at the end
  assert.equal(stepImage(0, 3, -1), 0); // and at the start
});

test("fitInside: whole, in its own shape, never larger than it is", () => {
  assert.deepEqual(fitInside({ width: 2400, height: 1800 }, { width: 600, height: 600 }), { width: 600, height: 450 });
  assert.deepEqual(fitInside({ width: 2400, height: 1800 }, { width: 2000, height: 400 }), { width: 533, height: 400 });
  assert.deepEqual(fitInside({ width: 120, height: 90 }, { width: 600, height: 600 }), { width: 120, height: 90 });
  assert.deepEqual(fitInside({ width: 1600, height: 200 }, { width: 300, height: 600 }), { width: 300, height: 38 });
  assert.deepEqual(fitInside({ width: 0, height: 90 }, { width: 600, height: 600 }), { width: 0, height: 0 });
  assert.deepEqual(fitInside({ width: 100, height: 100 }, { width: 0, height: 0 }), { width: 0, height: 0 });
});

test("a swipe on the large view: sideways steps, down closes, a short or slanted one does nothing", () => {
  assert.equal(swipeOf(-120, 10), 1);  // to the left: the next image
  assert.equal(swipeOf(120, -10), -1); // to the right: the previous one
  assert.equal(swipeOf(20, 5), 0);
  assert.equal(swipeOf(10, 140), "close");
  assert.equal(swipeOf(10, 40, 1200), "close"); // a short, fast flick down
  assert.equal(swipeOf(100, 80), -1);           // mostly sideways
  assert.equal(swipeOf(0, 50), 0);
});
