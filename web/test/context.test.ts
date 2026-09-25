import { test } from "node:test";
import assert from "node:assert/strict";
import { contextBlock, boardRef } from "../src/logic/context.ts";

test("boardRef is name (id)", () => {
  assert.equal(boardRef({ name: "arch", id: "b_12345678" }), "arch (b_12345678)");
});

test("block without references names only the board", () => {
  assert.equal(
    contextBlock({ board: "arch (b_aaaaaaaa)", referenced: [] }),
    ["<ui-context>", "active_board: arch (b_aaaaaaaa)", "</ui-context>"].join("\n"),
  );
});

test("block with references", () => {
  assert.equal(
    contextBlock({ board: "arch (b_aaaaaaaa)", referenced: ["flows (b_bbbbbbbb)", "flows (b_cccccccc)"] }),
    [
      "<ui-context>",
      "active_board: arch (b_aaaaaaaa)",
      "referenced_boards: flows (b_bbbbbbbb), flows (b_cccccccc)",
      "</ui-context>",
    ].join("\n"),
  );
});
