// The pill when the session is paused (voice devices VD-12, D9): the orb is `paused` in every phase but idle, and the pill is the listening bar
// (its words line says why, its foot has Continue) unless it was collapsed to the orb.
import assert from "node:assert/strict";
import { test } from "node:test";

import { orbStateFor, pillSize } from "../src/screens/voice/pill/logic.ts";
import type { Phase } from "../src/voice/index.ts";

const phases: Phase[] = ["idle", "starting", "listening", "countdown", "waiting", "sending", "thinking", "speaking"];

test("a paused session shows the paused orb in every phase but idle, and an unpaused one is as before", () => {
  for (const p of phases) assert.equal(orbStateFor(p, true), p === "idle" ? "idle" : "paused", p);
  assert.deepEqual(phases.map((p) => orbStateFor(p, false)), ["idle", "listening", "listening", "countdown", "waiting", "thinking", "thinking", "speaking"]);
});

test("a paused pill is the listening bar, or the orb alone when it was collapsed", () => {
  for (const p of phases.filter((x) => x !== "idle")) {
    assert.equal(pillSize(p, false, true), "listening", p);
    assert.equal(pillSize(p, true, true), "orb", p);
  }
  assert.equal(pillSize("idle", false, true), "compact");
});
