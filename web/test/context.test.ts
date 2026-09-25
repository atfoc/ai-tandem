import { test } from "node:test";
import assert from "node:assert/strict";
import { contextBlock, boardRef } from "../src/logic/context.ts";

const viewport = { x: -10.4, y: 20.6, width: 1200, height: 800, zoom: 1.256 };

test("boardRef is name (id)", () => {
  assert.equal(boardRef({ name: "arch", id: "b_12345678" }), "arch (b_12345678)");
});

test("block without selection or references", () => {
  assert.equal(
    contextBlock({ board: "arch (b_aaaaaaaa)", referenced: [], selection: [], viewport }),
    [
      "<ui-context>",
      "active_board: arch (b_aaaaaaaa)",
      "selection: none",
      "viewport   (-10,21 1200×800) zoom 1.26",
      "</ui-context>",
    ].join("\n"),
  );
});

test("block with selection and references", () => {
  assert.equal(
    contextBlock({
      board: "arch (b_aaaaaaaa)",
      referenced: ["flows (b_bbbbbbbb)", "flows (b_cccccccc)"],
      selection: ["rectangle  line one", "ellipse  line two"],
      viewport,
    }),
    [
      "<ui-context>",
      "active_board: arch (b_aaaaaaaa)",
      "referenced_boards: flows (b_bbbbbbbb), flows (b_cccccccc)",
      "selection (2):",
      "  rectangle  line one",
      "  ellipse  line two",
      "viewport   (-10,21 1200×800) zoom 1.26",
      "</ui-context>",
    ].join("\n"),
  );
});
