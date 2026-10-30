import { test } from "node:test";
import assert from "node:assert/strict";
import { contextBlock, boardRef } from "../src/logic/context.ts";

test("boardRef is name (id)", () => {
  assert.equal(boardRef({ name: "arch", id: "b_12345678" }), "arch (b_12345678)");
});

test("boardRef names a section's board by its own id on its server: the page's key is not what the agent reads", () => {
  assert.equal(boardRef({ name: "arch", id: "s_1~b_12345678" }), "arch (b_12345678)");
  assert.equal(boardRef({ name: "arch", id: "s_0123456789ab~3f9a1c2b-77de" }), "arch (3f9a1c2b-77de)");
  assert.equal(boardRef({ name: "a ~ b", id: "s_1~b_1" }), "a ~ b (b_1)", "the name is the board's, whatever is in it");
});

test("the block names only the board", () => {
  assert.equal(
    contextBlock({ board: "arch (b_aaaaaaaa)" }),
    ["<ui-context>", "active_board: arch (b_aaaaaaaa)", "</ui-context>"].join("\n"),
  );
});
