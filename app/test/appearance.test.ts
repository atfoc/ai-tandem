// The words and rows of the Appearance screen (screens/settings/appearance.ts).
import assert from "node:assert/strict";
import { test } from "node:test";

import { PALETTE } from "@aiwb/core/logic/flavours.ts";
import { FLAVOURS, THEME_PREFS } from "@aiwb/core/logic/theme.ts";

import { flavourFooter, flavourOptions, flavourValue, swatchOf, systemFooter, themeRows } from "../src/screens/settings/appearance.ts";

test("the theme list is Light, Dark, System, and only the chosen one is checked", () => {
  for (const pref of ["light", "dark", "system"] as const) {
    const rows = themeRows(pref);
    assert.deepEqual(rows.map((r) => r.label), ["Light", "Dark", "System"]);
    assert.deepEqual(rows.map((r) => r.pref), ["light", "dark", "system"]);
    assert.deepEqual(rows.filter((r) => r.checked).map((r) => r.pref), [pref]);
  }
});

test("with a flavour on, none of the three is checked", () => {
  for (const f of FLAVOURS) assert.equal(themeRows(f).some((r) => r.checked), false, f);
});

test("the flavour row says Off, or the flavour's name", () => {
  for (const p of ["light", "dark", "system"] as const) assert.equal(flavourValue(p), "Off");
  assert.equal(flavourValue("mocha"), "Mocha");
  assert.equal(flavourValue("frappe"), "Frappé");
});

test("the flavour footer says whether the flavour is light or dark", () => {
  assert.equal(flavourFooter("system"), "Off: the app's own colours.");
  assert.equal(flavourFooter("light"), "Off: the app's own colours.");
  assert.equal(flavourFooter("latte"), "Latte is light. Choosing a theme above turns it off.");
  for (const f of ["frappe", "macchiato", "mocha"] as const) assert.match(flavourFooter(f), /is dark\. Choosing a theme above turns it off\.$/);
});

test("the system footer names the phone or the device", () => {
  assert.equal(systemFooter(false), "System follows the phone's light or dark setting.");
  assert.equal(systemFooter(true), "System follows this device's light or dark setting.");
});

test("the flavour options are the four, in order, Latte light and the rest dark", () => {
  const o = flavourOptions();
  assert.deepEqual(o.map((x) => x.value), [...FLAVOURS]);
  assert.deepEqual(o.map((x) => x.label), ["Latte", "Frappé", "Macchiato", "Mocha"]);
  assert.deepEqual(o.map((x) => x.note), ["Light", "Dark", "Dark", "Dark"]);
});

test("a swatch is the flavour's base and mauve", () => {
  for (const f of FLAVOURS) assert.deepEqual(swatchOf(f), [PALETTE[f].base, PALETTE[f].mauve]);
  assert.notEqual(swatchOf("latte")[0], swatchOf("mocha")[0]);
});

test("every stored choice has a row or a flavour: nothing is left over", () => {
  const rows = themeRows("light").map((r) => r.pref as string), flavours = flavourOptions().map((o) => o.value as string);
  assert.deepEqual([...rows, ...flavours].sort(), [...THEME_PREFS].sort());
});
