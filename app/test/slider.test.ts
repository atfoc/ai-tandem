import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { bigStepOf, fractionOf, keyStep, nudge, shouldCommit, snap, valueAt } from "../src/ui/sliderlogic.ts";

// The delay before send, in milliseconds, and the max chats: the two uses of the slider.
const delay = { min: 100, max: 10000, step: 100 };
const chats = { min: 1, max: 100, step: 1 };
const ds = (v: number) => snap(v, delay.min, delay.max, delay.step);
const cs = (v: number) => snap(v, chats.min, chats.max, chats.step);

test("snap: the nearest step from min, held to the ends", () => {
  assert.equal(ds(4700), 4700);
  assert.equal(ds(4749), 4700);
  assert.equal(ds(4751), 4800);
  assert.equal(ds(4750), 4800); // halfway goes up
  assert.equal(ds(50), 100);
  assert.equal(ds(-300), 100);
  assert.equal(ds(10049), 10000);
  assert.equal(ds(99999), 10000);
  assert.equal(cs(37), 37);
  assert.equal(cs(36.4), 36);
  assert.equal(cs(36.6), 37);
  assert.equal(cs(0), 1);
  assert.equal(cs(1000), 100);
});

test("snap: steps count from min, not from zero", () => {
  assert.equal(snap(1250, 1000, 5000, 500), 1500);
  assert.equal(snap(1240, 1000, 5000, 500), 1000);
});

test("snap: a bad number is the low end, a step that is no step leaves the value held", () => {
  assert.equal(ds(NaN), 100);
  assert.equal(ds(Infinity), 100);
  assert.equal(snap(7, 0, 10, 0), 7);
  assert.equal(snap(70, 0, 10, 0), 10);
});

test("snap: fractional steps do not drift", () => {
  assert.equal(snap(0.3, 0, 1, 0.1), 0.3);
  assert.equal(snap(0.74, 0, 1, 0.1), 0.7);
  assert.equal(snap(0.76, 0, 1, 0.1), 0.8);
  assert.equal(snap(0.1 + 0.2, 0, 1, 0.1), 0.3);
});

test("snap: an end that is not a whole number of steps from min is never passed", () => {
  assert.equal(snap(10, 0, 10, 3), 9);
  assert.equal(snap(12, 0, 10, 3), 9);
  assert.equal(snap(9.4, 0, 10, 3), 9);
});

test("4700 ms and the chats 1, 37 and 100 are all reachable", () => {
  for (const v of [100, 1200, 4700, 10000]) assert.equal(ds(v), v);
  for (const v of [1, 37, 100]) assert.equal(cs(v), v);
});

test("fractionOf: 0 at min to 1 at max, off-step values keep their own place, out-of-range values are held", () => {
  assert.equal(fractionOf(100, 100, 10000), 0);
  assert.equal(fractionOf(10000, 100, 10000), 1);
  assert.equal(fractionOf(5050, 100, 10000), 0.5);
  assert.ok(Math.abs(fractionOf(1234, 100, 10000) - (1234 - 100) / 9900) < 1e-12);
  assert.equal(fractionOf(-5, 100, 10000), 0);
  assert.equal(fractionOf(99999, 100, 10000), 1);
  assert.equal(fractionOf(NaN, 100, 10000), 0);
  assert.equal(fractionOf(5, 5, 5), 0);
});

test("valueAt: a position along the track gives the nearest step, held to the ends", () => {
  assert.equal(valueAt(0, 200, 1, 100, 1), 1);
  assert.equal(valueAt(200, 200, 1, 100, 1), 100);
  assert.equal(valueAt(100, 200, 1, 100, 1), 51); // 1 + 0.5 × 99 = 50.5: halfway goes up
  assert.equal(valueAt(-30, 200, 1, 100, 1), 1);
  assert.equal(valueAt(260, 200, 1, 100, 1), 100);
  assert.equal(valueAt(0, 300, 100, 10000, 100), 100);
  assert.equal(valueAt(300, 300, 100, 10000, 100), 10000);
  assert.equal(valueAt(150, 300, 100, 10000, 100), 5100); // 100 + 4950 = 5050 → 5100
  assert.equal(valueAt(1, 300, 100, 10000, 100), 100); // 33 ms along is still the first step's side
});

test("valueAt: a track without a width, or a bad position, gives the low end", () => {
  assert.equal(valueAt(50, 0, 1, 100, 1), 1);
  assert.equal(valueAt(50, -4, 1, 100, 1), 1);
  assert.equal(valueAt(NaN, 200, 1, 100, 1), 1);
});

test("valueAt: moving right never gives a smaller value", () => {
  let last = 0;
  for (let x = -5; x <= 305; x += 0.5) {
    const v = valueAt(x, 300, 1, 100, 1);
    assert.ok(v >= last);
    last = v;
  }
  assert.equal(last, 100);
});

const k = (key: string, v: number, o: Partial<{ bigStep: number; verticalKeys: boolean }> = {}, r = delay) => keyStep(key, v, { ...r, ...o });

test("keys: → and ↑ one step up, ← and ↓ one step down", () => {
  assert.equal(k("ArrowRight", 4700), 4800);
  assert.equal(k("ArrowUp", 4700), 4800);
  assert.equal(k("ArrowLeft", 4700), 4600);
  assert.equal(k("ArrowDown", 4700), 4600);
  assert.equal(keyStep("ArrowRight", 36, chats), 37);
  assert.equal(keyStep("ArrowLeft", 37, chats), 36);
});

test("keys: at an end the value stays", () => {
  assert.equal(k("ArrowRight", 10000), 10000);
  assert.equal(k("ArrowUp", 10000), 10000);
  assert.equal(k("ArrowLeft", 100), 100);
  assert.equal(k("ArrowDown", 100), 100);
  assert.equal(k("PageUp", 9500), 10000);
  assert.equal(k("PageDown", 500), 100);
});

test("keys: verticalKeys false leaves ↑ and ↓ to the page, the others stay the slider's", () => {
  assert.equal(k("ArrowUp", 4700, { verticalKeys: false }), null);
  assert.equal(k("ArrowDown", 4700, { verticalKeys: false }), null);
  assert.equal(k("ArrowRight", 4700, { verticalKeys: false }), 4800);
  assert.equal(k("ArrowLeft", 4700, { verticalKeys: false }), 4600);
  assert.equal(k("Home", 4700, { verticalKeys: false }), 100);
  assert.equal(k("ArrowUp", 4700, { verticalKeys: true }), 4800);
});

test("keys: Page Up and Page Down move by bigStep, by default ten steps", () => {
  assert.equal(bigStepOf(delay), 1000);
  assert.equal(bigStepOf(chats), 10);
  assert.equal(bigStepOf({ ...delay, bigStep: 0 }), 1000);
  assert.equal(bigStepOf({ ...delay, bigStep: 2500 }), 2500);
  assert.equal(k("PageUp", 4700), 5700);
  assert.equal(k("PageDown", 4700), 3700);
  assert.equal(keyStep("PageUp", 37, chats), 47);
  assert.equal(keyStep("PageDown", 37, chats), 27);
  assert.equal(k("PageUp", 4700, { bigStep: 2500 }), 7200);
  assert.equal(k("PageDown", 4700, { bigStep: 2500 }), 2200);
  assert.equal(keyStep("PageUp", 95, chats), 100);
  assert.equal(keyStep("PageDown", 5, chats), 1);
});

test("keys: Home and End are the ends", () => {
  assert.equal(k("Home", 4700), 100);
  assert.equal(k("End", 4700), 10000);
  assert.equal(k("Home", 100), 100);
  assert.equal(keyStep("End", 37, chats), 100);
  assert.equal(keyStep("Home", 37, chats), 1);
});

test("keys: any other key is not the slider's", () => {
  for (const key of ["a", "Enter", " ", "Tab", "Escape", "Shift", "arrowright", ""]) assert.equal(k(key, 4700), null);
});

test("keys: from a value off the steps or out of the ends the first move lands on a step", () => {
  assert.equal(k("ArrowRight", 4730), 4800);
  assert.equal(k("ArrowLeft", 4730), 4700);
  assert.equal(k("ArrowRight", 4799), 4800);
  assert.equal(k("ArrowLeft", 4701), 4700);
  assert.equal(k("ArrowRight", 4750), 4800);
  assert.equal(k("ArrowLeft", 4750), 4700);
  assert.equal(k("ArrowRight", 600.4), 700);
  assert.equal(k("ArrowRight", 50), 200); // below min: held to 100, then a step up
  assert.equal(k("ArrowLeft", 50), 100);
  assert.equal(k("ArrowLeft", 20000), 9900);
  assert.equal(k("ArrowRight", 20000), 10000);
  assert.equal(k("ArrowRight", NaN), 200);
  assert.equal(k("PageUp", 4730), 5700);
  assert.equal(k("PageDown", 4730), 3700);
});

test("nudge: a step from a value on the steps, a given distance, and it never leaves the ends", () => {
  assert.equal(nudge(4700, 1, delay), 4800);
  assert.equal(nudge(4700, -1, delay), 4600);
  assert.equal(nudge(10000, 1, delay), 10000);
  assert.equal(nudge(100, -1, delay), 100);
  assert.equal(nudge(4700, 1, delay, 300), 5000);
  assert.equal(nudge(1, 1, chats), 2);
  assert.equal(nudge(99, 1, chats), 100);
  assert.equal(nudge(100, 1, chats), 100);
  assert.equal(nudge(0.3, 1, { min: 0, max: 1, step: 0.1 }), 0.4);
  assert.equal(nudge(0.3, -1, { min: 0, max: 1, step: 0.1 }), 0.2);
});

test("nudge: every step from one end to the other is one step, both ways", () => {
  let v = chats.min;
  for (let i = 1; i < 100; i++) { v = nudge(v, 1, chats); assert.equal(v, i + 1); }
  for (let i = 99; i >= 1; i--) { v = nudge(v, -1, chats); assert.equal(v, i); }
  let d = delay.min, n = 0;
  while (nudge(d, 1, delay) !== d) { d = nudge(d, 1, delay); n++; }
  assert.equal(d, 10000);
  assert.equal(n, 99);
});

test("shouldCommit: only a different value", () => {
  assert.equal(shouldCommit(4800, 4700), true);
  assert.equal(shouldCommit(4700, 4700), false);
  assert.equal(shouldCommit(4700, 4730), true); // the first move from an off-step value is a change
  assert.equal(shouldCommit(NaN, 4700), false);
  assert.equal(shouldCommit(Infinity, 4700), false);
});

// The component's source: what a screen reader, a keyboard and a modal need of it are in the file (the browser checks prove the rest).
const ui = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "ui");
const source = readFileSync(join(ui, "Slider.tsx"), "utf8");

test("Slider: the track is a slider that a screen reader can adjust, in a root of its own for the gestures", () => {
  assert.match(source, /role="slider"/);
  assert.match(source, /accessibilityActions=\{\[\{ name: "increment" \}, \{ name: "decrement" \}\]\}/);
  assert.match(source, /onAccessibilityAction/);
  assert.match(source, /accessibilityValue=\{\{ min, max, now: shown, text \}\}/);
  assert.match(source, /<GestureHandlerRootView/);
  assert.match(source, /Gesture\.Race\(pan, tap\)/);
  assert.match(source, /touchAction="pan-y"/);
});

test("Slider: the −/+ buttons are named for what they change", () => {
  assert.match(source, /`Decrease \$\{label\}`/);
  assert.match(source, /`Increase \$\{label\}`/);
});
