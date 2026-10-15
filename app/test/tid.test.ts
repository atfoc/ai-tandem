import assert from "node:assert/strict";
import { test } from "node:test";

import { TID, tid } from "../src/ui/tid.ts";

test("tid gives the testID, and the dataSet only when it has entries", () => {
  assert.deepEqual(tid("side-row"), { testID: "side-row" });
  assert.deepEqual(tid("side-row", {}), { testID: "side-row" });
  assert.deepEqual(tid("side-section", { server: "local", tone: "ok" }), { testID: "side-section", dataSet: { server: "local", tone: "ok" } });
});

test("the testIDs of the primitives are kebab-case and each is used once", () => {
  const ids = Object.values(TID);
  for (const id of ids) assert.match(id, /^[a-z]+(-[a-z]+)*$/, id);
  assert.equal(new Set(ids).size, ids.length);
});
