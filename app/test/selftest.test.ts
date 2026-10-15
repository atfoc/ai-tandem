import assert from "node:assert/strict";
import { test } from "node:test";

import { runConnSelfTest } from "../src/dev/connSelfTest.ts";
import { line } from "../src/dev/selftest.ts";

// The cases the device runs inside Hermes (flow conn-on-hermes) pass under Node too: they are the same code.
test("conn self-test: every case passes", async () => {
  const r = await runConnSelfTest();
  assert.deepEqual(r.failed.map(line), []);
  assert.ok(r.ok, JSON.stringify({ pass: r.pass, skip: r.skip }));
  assert.equal(r.skip, 0, "no case of the fake-backed contract is skipped");
});
