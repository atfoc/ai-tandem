// What the phone's image strip says under its thumbnails (screens/composerimages/phonelines.ts): a reason per refused tile, the limit that was hit with
// what was left out, and what the slot says besides. The strip as the browser draws it is IM3.2's and L18's phone halves.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { RefusedFile } from "@aiwb/core/state/uploads.ts";

import { isTile, stripLines, tileWord } from "../src/screens/composerimages/phonelines.ts";

const r = (key: number, name: string, reason: RefusedFile["reason"], off?: string): RefusedFile => ({ key, name, reason, ...(off ? { off } : {}) });

test("a refused tile says its file and why, in the goal's words, and goes with its tile", () => {
  const lines = stripLines([r(1, "IMG_2041.HEIC", "type"), r(2, "big.png", "size"), r(3, "x.jpg", "read")], "");
  assert.deepEqual(lines.map((l) => [l.refused, l.text]), [
    [1, "IMG_2041.HEIC is not added: send PNG, JPEG, GIF or WebP."],
    [2, "big.png is not added: over 5 MB."],
    [3, "x.jpg is not added: it could not be read."],
  ]);
});

test("the tile's word is the file's type as its name ends, else its name; only a type, a size and a read refusal are tiles", () => {
  assert.equal(tileWord("IMG_2041.heic"), "HEIC");
  assert.equal(tileWord("photo"), "photo");
  assert.equal(tileWord(""), "File");
  assert.deepEqual((["type", "size", "read", "count", "total", "off"] as const).map((x) => isTile({ reason: x })), [true, true, true, false, false, false]);
});

test("a limit is said when it is hit, naming what was left out; one line for all the files it left out", () => {
  assert.deepEqual(stripLines([r(1, "IMG_11.png", "count"), r(2, "IMG_12.png", "count"), r(3, "IMG_13.png", "count")], "").map((l) => [l.refused, l.text]),
    [[undefined, "A message takes 10 images: IMG_11.png and 2 more were left out."]]);
  assert.equal(stripLines([r(1, "IMG_11.png", "count")], "")[0].text, "A message takes 10 images: IMG_11.png was left out.");
  assert.equal(stripLines([r(1, "a.png", "total"), r(2, "b.png", "total")], "")[0].text, "The images of a message can be 20 MB together: a.png and 1 more were left out.");
});

test("a chat that takes no image says why and what was not added; what the slot says besides comes last; nothing refused says nothing", () => {
  assert.equal(stripLines([r(1, "a.png", "off", "Haiku takes no images")], "")[0].text, "Haiku takes no images: a.png was not added.");
  assert.deepEqual(stripLines([r(1, "a.heic", "type")], "b.png was not added: the upload did not reach the server.").map((l) => l.key), ["r1", "said"]);
  assert.deepEqual(stripLines([], ""), []);
});
