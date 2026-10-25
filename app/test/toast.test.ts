import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";

import { getToast, getToastLift, hideToast, setToastLift, showToast, subscribeToast } from "../src/ui/toaststore.ts";

afterEach(() => { hideToast(); mock.timers.reset(); });

test("a toast stays 5 seconds by default and then goes", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  showToast({ text: "Back online", kind: "back-online" });
  assert.equal(getToast()?.text, "Back online");
  assert.equal(getToast()?.kind, "back-online");
  mock.timers.tick(4999);
  assert.ok(getToast());
  mock.timers.tick(1);
  assert.equal(getToast(), null);
});

test("`ms` sets how long it stays", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  showToast({ text: "Short", ms: 1500 });
  mock.timers.tick(1499);
  assert.ok(getToast());
  mock.timers.tick(1);
  assert.equal(getToast(), null);
});

test("a new toast replaces the one shown and restarts the time", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  showToast({ text: "first" });
  mock.timers.tick(4000);
  showToast({ text: "second" });
  assert.equal(getToast()?.text, "second");
  mock.timers.tick(4000); // the first one's time is over, the second one's is not
  assert.equal(getToast()?.text, "second");
  mock.timers.tick(1000);
  assert.equal(getToast(), null);
});

test("the function showToast answers takes away its own toast only", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const hideFirst = showToast({ text: "first" });
  const hideSecond = showToast({ text: "second" });
  hideFirst();
  assert.equal(getToast()?.text, "second");
  hideSecond();
  assert.equal(getToast(), null);
});

test("hideToast takes the toast away and the timer of it does not take away a later one", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  showToast({ text: "first" });
  hideToast();
  assert.equal(getToast(), null);
  mock.timers.tick(3000);
  showToast({ text: "second" });
  mock.timers.tick(4999);
  assert.equal(getToast()?.text, "second");
});

test("listeners hear every change, and only changes", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let n = 0;
  const off = subscribeToast(() => n++);
  showToast({ text: "a" });
  showToast({ text: "b" });
  hideToast();
  hideToast(); // nothing was shown
  assert.equal(n, 3);
  off();
  showToast({ text: "c" });
  assert.equal(n, 3);
});

test("the lift is the last one asked for; taking it back falls to the one before; none is 0", () => {
  const a = {}, b = {};
  assert.equal(getToastLift(), 0);
  setToastLift(a, 120);
  assert.equal(getToastLift(), 120);
  setToastLift(b, 60);
  assert.equal(getToastLift(), 60);
  setToastLift(a, 100); // a asks again: it keeps its place, b is still the last
  assert.equal(getToastLift(), 60);
  setToastLift(b, null);
  assert.equal(getToastLift(), 100);
  setToastLift(a, null);
  assert.equal(getToastLift(), 0);
});

test("a change of the lift is heard, a repeat is not", () => {
  const key = {};
  let n = 0;
  const off = subscribeToast(() => n++);
  setToastLift(key, 50);
  setToastLift(key, 50);
  setToastLift(key, null);
  setToastLift(key, null);
  off();
  assert.equal(n, 2);
});
