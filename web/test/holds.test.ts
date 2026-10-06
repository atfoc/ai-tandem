import { test } from "node:test";
import assert from "node:assert/strict";
import { Holds } from "../src/logic/holds.ts";

/** Timers by hand: run(ms) moves the clock and fires what is due. */
function clock() {
  let now = 0, seq = 0;
  const due = new Map<number, { at: number; f: () => void }>();
  return {
    timers: { set: (f: () => void, ms: number) => { due.set(++seq, { at: now + ms, f }); return seq; }, clear: (t: number) => { due.delete(t); } },
    run(ms: number) {
      now += ms;
      for (const [k, v] of [...due]) if (v.at <= now) { due.delete(k); v.f(); }
    },
    waiting: () => due.size,
  };
}
const make = () => {
  const c = clock(), dropped: string[] = [];
  return { c, dropped, h: new Holds<number>(5000, (id) => dropped.push(id), c.timers) };
};

test("the first hold is fresh, a second one is not; the drop comes 5 s after the last release", () => {
  const { c, dropped, h } = make();
  const a = h.hold("ag");
  assert.equal(a.fresh, true);
  const b = h.hold("ag");
  assert.equal(b.fresh, false);
  a.release();
  c.run(60_000);
  assert.deepEqual(dropped, [], "still held by the second view");
  assert.ok(h.has("ag"));
  b.release();
  c.run(4999);
  assert.deepEqual(dropped, []); assert.ok(h.has("ag"), "lingering");
  c.run(1);
  assert.deepEqual(dropped, ["ag"]); assert.ok(!h.has("ag")); assert.deepEqual(h.ids(), []);
});

test("a hold taken during the linger cancels the drop and finds everything kept", () => {
  const { c, dropped, h } = make();
  h.hold("ag").release();
  c.run(3000);
  const again = h.hold("ag");            // an agent ↔ subagent swap, a tab change
  assert.equal(again.fresh, false, "nothing to fetch again");
  assert.equal(c.waiting(), 0);
  c.run(60_000);
  assert.deepEqual(dropped, []);
  again.release();
  c.run(5000);
  assert.deepEqual(dropped, ["ag"]);
  assert.equal(h.hold("ag").fresh, true, "after the drop it starts over");
});

test("a release counts once", () => {
  const { c, dropped, h } = make();
  const a = h.hold("ag"), b = h.hold("ag");
  a.release(); a.release(); a.release();
  c.run(10_000);
  assert.deepEqual(dropped, [], "the other hold still stands");
  b.release();
  c.run(5000);
  assert.deepEqual(dropped, ["ag"]);
  a.release(); b.release();
  c.run(10_000);
  assert.deepEqual(dropped, ["ag"], "late releases do nothing");
});

test("ids are kept apart; ids() lists the held and the lingering", () => {
  const { c, dropped, h } = make();
  const a = h.hold("a");
  h.hold("b").release();
  c.run(1000);
  h.hold("c");
  assert.deepEqual(h.ids().sort(), ["a", "b", "c"]);
  c.run(4000);
  assert.deepEqual(dropped, ["b"]); assert.deepEqual(h.ids().sort(), ["a", "c"]);
  a.release();
  c.run(5000);
  assert.deepEqual(dropped, ["b", "a"]);
});
