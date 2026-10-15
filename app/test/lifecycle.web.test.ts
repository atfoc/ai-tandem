// What the web build does when the page goes away or hides (A-DK-08, AD-76; the app's half of closing is desktop/test/closeflush.test.js): the
// boards are written on pagehide and when the tab hides, a page with saves still pending is kept from unloading while they are written, and the
// desktop window's `window.aiwbFlush` answers true only once nothing is pending. On a fake window and document.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { installLifecycle } from "../src/platform/lifecycle.web.ts";

type Fake = { window: EventTarget & { aiwbFlush?: () => Promise<boolean> }; document: EventTarget & { visibilityState: string } };
let fake: Fake;
const g = globalThis as unknown as Record<string, unknown>;
beforeEach(() => {
  fake = { window: new EventTarget(), document: Object.assign(new EventTarget(), { visibilityState: "visible" }) };
  g.window = fake.window;
  g.document = fake.document;
});
afterEach(() => { delete g.window; delete g.document; });

/** A page whose boards take `pending` saves that stay until `settle()`. */
function page(pending = 0) {
  const log: string[] = [];
  const s = { pending };
  const life = installLifecycle({
    flushAll: async () => { log.push("flush"); },
    hasPendingSaves: () => s.pending > 0,
    endSent: () => { log.push("endSent"); },
  });
  return { log, s, life };
}
const fire = (target: EventTarget, type: string) => { const e = new Event(type, { cancelable: true }); target.dispatchEvent(e); return e; };

test("window.aiwbFlush answers true once every board is written, false while a save is pending", async () => {
  const p = page();
  assert.equal(typeof fake.window.aiwbFlush, "function");
  assert.equal(await fake.window.aiwbFlush!(), true);
  p.s.pending = 1;
  assert.equal(await fake.window.aiwbFlush!(), false, "a save still pending after the boards were written: the window must not close");
  assert.deepEqual(p.log, ["flush", "flush"]);
});

test("pagehide ends the sends that wait, then writes the boards", () => {
  const p = page();
  fire(fake.window, "pagehide");
  assert.deepEqual(p.log, ["endSent", "flush"]);
});

test("the tab hiding writes the boards; being shown again writes nothing", () => {
  const p = page();
  fake.document.visibilityState = "visible";
  fire(fake.document, "visibilitychange");
  assert.deepEqual(p.log, []);
  fake.document.visibilityState = "hidden";
  fire(fake.document, "visibilitychange");
  assert.deepEqual(p.log, ["flush"]);
});

test("beforeunload with saves pending is prevented and writes the boards; with none it lets the page go", () => {
  const p = page(2);
  assert.equal(fire(fake.window, "beforeunload").defaultPrevented, true);
  assert.deepEqual(p.log, ["flush"]);
  p.s.pending = 0;
  assert.equal(fire(fake.window, "beforeunload").defaultPrevented, false);
  assert.deepEqual(p.log, ["flush"], "nothing pending: no flush, no prompt");
});

test("the function that removes the hooks removes every one", async () => {
  const p = page(1);
  p.life();
  assert.equal(fake.window.aiwbFlush, undefined);
  fire(fake.window, "pagehide");
  fake.document.visibilityState = "hidden";
  fire(fake.document, "visibilitychange");
  assert.equal(fire(fake.window, "beforeunload").defaultPrevented, false);
  assert.deepEqual(p.log, []);
});
