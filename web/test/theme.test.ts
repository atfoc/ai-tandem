import { test } from "node:test";
import assert from "node:assert/strict";
import { parseThemePref, resolveTheme } from "../src/logic/theme.ts";

test("saved theme choice", () => {
  assert.equal(parseThemePref("light"), "light");
  assert.equal(parseThemePref("dark"), "dark");
  assert.equal(parseThemePref("system"), "system");
  assert.equal(parseThemePref(null), "system");
  assert.equal(parseThemePref("purple"), "system");
});

test("the theme shown follows the choice, or the system for system", () => {
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
});
