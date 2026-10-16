// The modes of the board bench and the sets of them (dev/bench/modes.ts, modeset.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CANVAS_THEMES, canvasFilter } from "@aiwb/core/logic/canvastheme.ts";
import { resolveTheme } from "@aiwb/core/logic/theme.ts";
import { LAYER_SELECTOR, MODES, MODE_NAMES } from "../dev/bench/modes.ts";
// @ts-expect-error: a plain .mjs of the dev tools, without types
import { MODE_NAMES as SET_MODE_NAMES, MODE_SETS, THEMES, estimateMs, expandModes, formatDuration, parseModes } from "../dev/bench/modeset.mjs";

test("the themes of the modes are the canvas themes of core, and the sets are made of modes that exist", () => {
  assert.deepEqual(THEMES, CANVAS_THEMES);
  for (const [set, names] of Object.entries(MODE_SETS) as [string, string[]][]) {
    for (const n of names) assert.ok(MODES[n], `set ${set}: no mode ${n}`);
    assert.equal(new Set(names).size, names.length, `set ${set}: a mode twice`);
  }
  assert.deepEqual([...MODE_NAMES].sort(), [...SET_MODE_NAMES].sort(), "every mode is in a set (all), and all has no other");
});

test("the sets: experiment is the criterion's modes, replacement is light with every theme both ways, all is both", () => {
  assert.deepEqual(MODE_SETS.experiment, ["light", "dark-today", "dark-css", "dark-none", "dark-matrix"]);
  assert.deepEqual(MODE_SETS.replacement, ["light", ...CANVAS_THEMES, ...CANVAS_THEMES.map((t) => `${t}-today`)]);
  assert.equal(MODE_SETS.replacement.length, 11);
  assert.equal(MODE_SETS.all.length, 14, "dark-today is in both sets, once in all");
  assert.deepEqual(expandModes(["replacement", "dark-css", "light"]), [...MODE_SETS.replacement, "dark-css"]);
  assert.deepEqual(parseModes("light, mocha-today"), ["light", "mocha-today"]);
  assert.deepEqual(parseModes("experiment"), MODE_SETS.experiment);
});

test("<theme> sends the app's theme message; <theme>-today sends the same and takes the page's own filter away", () => {
  for (const t of CANVAS_THEMES) {
    const now = MODES[t], today = MODES[`${t}-today`];
    assert.deepEqual(now.theme, { mode: resolveTheme(t, true), filter: canvasFilter(t), chrome: null }, t);
    assert.deepEqual(today.theme, now.theme, `${t}: the same message`);
    assert.equal(now.css, undefined, `${t}: the replacement runs as the page makes it, with no bench rule`);
    assert.equal(now.svg, undefined);
    // today: the SVG filter of the theme on the canvases over the page's own rule, and the replacement's layers out of the page
    assert.ok(today.css?.includes(`filter: url(#aiwb-canvas-${t}) !important;`), `${t}: ${today.css}`);
    assert.ok(today.css?.includes(`${LAYER_SELECTOR} { display: none !important; }`), `${t}: ${today.css}`);
    assert.equal(today.svg, undefined, "the page has the theme's <filter> in the document already");
  }
  assert.equal(MODES["latte"].theme.mode, "light", "Latte is a light theme");
  assert.equal(MODES["mocha"].theme.mode, "dark");
});

test("the modes of the experiment are as they were", () => {
  assert.deepEqual(MODES["light"].theme, { mode: "light", filter: null, chrome: null });
  for (const n of ["dark-css", "dark-none", "dark-matrix"]) assert.deepEqual(MODES[n].theme, { mode: "dark", filter: null, chrome: null }, n);
  assert.match(MODES["dark-none"].css ?? "", /filter: none !important/);
  assert.match(MODES["dark-matrix"].css ?? "", /filter: url\(#aiwb-bench-matrix\) !important/);
  for (const m of Object.values(MODES)) assert.ok(m.what.length > 10);
});

test("the expected duration counts the loads, the settling, the gestures and the pauses", () => {
  const one = estimateMs({ reps: 1, boards: ["large"], modes: ["light"], gestures: ["pan", "pinch"], gestureMs: 4000, loadMs: 500 });
  assert.equal(one, 1500 + 500 + 1000 + 8000 + 500);
  assert.ok(estimateMs({ reps: 1, boards: ["images"], modes: ["light"], loadMs: 0 }) > estimateMs({ reps: 1, boards: ["large"], modes: ["light"], loadMs: 0 }), "the board with pictures settles longer");
  assert.equal(formatDuration(52_000), "52 s");
  assert.equal(formatDuration(14 * 60_000), "14 min");
});
