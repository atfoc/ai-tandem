import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkFiles, named } from "./checklist.mjs";

test("a word names a check by its id, or the checks of an item by the dot", () => {
  assert.ok(named("P0.1-overflow.mjs", "P0.1"));
  assert.ok(!named("P0.10-x.mjs", "P0.1"));
  assert.ok(named("A2.2-fits.mjs", "A2"));
  assert.ok(!named("A21.2-x.mjs", "A2"));
  assert.ok(named("L1-primitives.mjs", "L1"));
  assert.ok(!named("L1-primitives.mjs", "L"));
});

test("the files of a folder, in the order of their ids, without the helpers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-checklist-"));
  try {
    for (const f of ["L10-a.mjs", "L2-b.mjs", "L1-c.mjs", "sel.mjs", "README.md", "P0.7-d.mjs"]) fs.writeFileSync(path.join(dir, f), "");
    assert.deepEqual(checkFiles(dir), ["L1-c.mjs", "L2-b.mjs", "L10-a.mjs", "P0.7-d.mjs"]);
    assert.deepEqual(checkFiles(dir, ["L2", "P0.7"]), ["L2-b.mjs", "P0.7-d.mjs"]);
    assert.deepEqual(checkFiles(dir, ["Z9"]), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
