// The "Back online" toast's transition (T3-5, goal 3.1.3): when it shows and when it does not.
import assert from "node:assert/strict";
import { test } from "node:test";

import { backOnlineStep, backOnlineText, type Seen } from "../src/screens/chat/backonline.ts";

const STUDIO = "s_studio";

test("the first look shows nothing, connected or not", () => {
  assert.deepEqual(backOnlineStep(null, STUDIO, true), { seen: { server: STUDIO, connected: true }, show: false });
  assert.deepEqual(backOnlineStep(null, STUDIO, false), { seen: { server: STUDIO, connected: false }, show: false });
});

test("not connected, then connected: shows once", () => {
  let seen: Seen = null;
  const run = (connected: boolean) => { const s = backOnlineStep(seen, STUDIO, connected); seen = s.seen; return s.show; };
  assert.deepEqual([run(true), run(false), run(false), run(true), run(true)], [false, false, false, true, false]);
  assert.deepEqual([run(false), run(true)], [false, true]); // and again for a second return
});

test("a chat of another server comes into view: its state is a first look, not a return", () => {
  const away: Seen = { server: "s_other", connected: false };
  assert.equal(backOnlineStep(away, STUDIO, true).show, false);
});

test("the words", () => {
  assert.equal(backOnlineText("Studio Mac"), "Studio Mac is back online");
});
