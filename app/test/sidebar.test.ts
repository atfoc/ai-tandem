// The sidebar's pure parts (S1): the settings line of a chat row, and where a new row may open in rename mode. The screens themselves are the
// browser checks' (web/dev/checks: SEC.*, AAC.*, A6.*, L11).
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Catalog } from "@aiwb/core/types.ts";

import { mayRename } from "../src/screens/sidebar/editguard.ts";
import { subline } from "../src/screens/sidebar/subline.ts";

const catalog = {
  models: [
    { id: "opus", label: "Opus 5.5", efforts: ["low", "high"] },
    { id: "haiku", label: "Haiku 5.5" },
    { id: "composer", label: "Composer", efforts: ["fast"], effortLabels: { fast: "Fast lane" } },
  ],
} as unknown as Catalog;

test("subline: the model's label and the effort's, in the labels of the catalog", () => {
  assert.equal(subline({ model: "opus", effort: "high" }, catalog), "Opus 5.5 · High");
  assert.equal(subline({ model: "composer", effort: "fast" }, catalog), "Composer · Fast lane", "a model's own name for an effort");
});

test("subline: no effort part for a chat with none, or a model that has no efforts", () => {
  assert.equal(subline({ model: "opus", effort: undefined }, catalog), "Opus 5.5");
  assert.equal(subline({ model: "haiku", effort: "high" }, catalog), "Haiku 5.5");
});

test("subline: a model the catalog does not know is its id, with its effort (the catalog may not have come)", () => {
  assert.equal(subline({ model: "mystery", effort: "high" }, catalog), "mystery · High");
  assert.equal(subline({ model: "opus", effort: "xhigh" }, undefined), "opus · Extra high");
  assert.equal(subline({ model: "opus", effort: undefined }, undefined), "opus");
});

test("mayRename: not while the sidebar is hidden", () => {
  for (const layout of ["desktop", "tablet", "phone"] as const) assert.equal(mayRename(true, layout, ["side"]), false, layout);
});

test("mayRename: on the wide layouts the list stays on screen whatever is open", () => {
  assert.equal(mayRename(false, "desktop", ["side", "board", "chat"]), true);
  assert.equal(mayRename(false, "tablet", ["side", "board"]), true);
});

test("mayRename: on the phone only while the list is the screen: a board made from it opens its own screen over it", () => {
  assert.equal(mayRename(false, "phone", ["side"]), true, "a group made from the list");
  assert.equal(mayRename(false, "phone", ["side", "board"]), false, "a board made from the list");
  assert.equal(mayRename(false, "phone", ["side", "chat"]), false);
});
