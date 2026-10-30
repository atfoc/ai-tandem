import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanName, resolveName } from "../src/logic/mentions.ts";
import type { Board } from "../src/types.ts";
import { UNGROUPED } from "../src/types.ts";

const board = (id: string, name: string, archived = false): Board =>
  ({ id, name, group: UNGROUPED, created: "2026-09-01T00:00:00Z", ...(archived ? { archived: true, archiveOp: "op1" } : {}) });

const boards: Record<string, Board> = Object.fromEntries([
  board("b_arch0001", "arch"),
  board("b_flow0002", "flows"),
  board("b_flow0001", "flows"),
  board("b_old00001", "old", true),
].map((b) => [b.id, b]));
const ids = (bs: Board[]) => bs.map((b) => b.id);

test("a name loses trailing punctuation and the old .excalidraw suffix", () => {
  assert.equal(cleanName("arch."), "arch");
  assert.equal(cleanName("arch,"), "arch");
  assert.equal(cleanName("arch.excalidraw"), "arch");
});

test("a name gives every non-archived board with it, by id", () => {
  assert.deepEqual(ids(resolveName("arch", boards)), ["b_arch0001"]);
  assert.deepEqual(ids(resolveName("arch.", boards)), ["b_arch0001"]);
  assert.deepEqual(ids(resolveName("flows", boards)), ["b_flow0001", "b_flow0002"]);
  assert.deepEqual(resolveName("nothing", boards), []);
  assert.deepEqual(resolveName("old", boards), []);
});
