import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FLAVOURS, THEME_LABELS, THEME_PREFS, flavourOf, parseThemePref, resolveTheme, themeMenu, themeTitle } from "../src/logic/theme.ts";
import { PALETTE, luminance } from "../src/logic/flavours.ts";

test("saved theme choice", () => {
  assert.equal(parseThemePref("light"), "light");
  assert.equal(parseThemePref("dark"), "dark");
  assert.equal(parseThemePref("system"), "system");
  assert.equal(parseThemePref(null), "system");
  assert.equal(parseThemePref("purple"), "system");
  for (const f of FLAVOURS) assert.equal(parseThemePref(f), f);
  assert.equal(parseThemePref("Mocha"), "system", "a saved value is the choice's own name");
  assert.equal(parseThemePref("frappé"), "system");
});

test("the theme shown follows the choice, or the system for system", () => {
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
});

test("a flavour is laid over light or dark, whatever the system's theme: Latte over light, the others over dark", () => {
  for (const systemDark of [true, false]) {
    assert.deepEqual(FLAVOURS.map((f) => resolveTheme(f, systemDark)), ["light", "dark", "dark", "dark"]);
  }
  // as its own colours say: the one whose background is lighter than its text is the light one
  for (const f of FLAVOURS) assert.equal(resolveTheme(f, false), luminance(PALETTE[f].base) > luminance(PALETTE[f].text) ? "light" : "dark", f);
  assert.deepEqual(THEME_PREFS.map(flavourOf), [null, null, null, "latte", "frappe", "macchiato", "mocha"]);
});

test("the picker: the three themes, then the four flavours, with the choice marked", () => {
  assert.deepEqual(THEME_PREFS, ["light", "dark", "system", "latte", "frappe", "macchiato", "mocha"]);
  for (const pref of THEME_PREFS) {
    const menu = themeMenu(pref);
    assert.deepEqual(menu.map((g) => g.head), ["Theme", "Catppuccin"]);
    assert.deepEqual(menu.map((g) => g.items.map((i) => i.label)), [["Light", "Dark", "System"], ["Latte", "Frappé", "Macchiato", "Mocha"]]);
    assert.deepEqual(menu.flatMap((g) => g.items.map((i) => i.pref)), THEME_PREFS, "every choice once, in order");
    assert.deepEqual(menu.flatMap((g) => g.items).filter((i) => i.on).map((i) => i.pref), [pref], "one is marked: the choice");
  }
  assert.equal(themeTitle("system"), "Theme: System (follows the OS)");
  assert.equal(themeTitle("light"), "Theme: Light");
  assert.equal(themeTitle("dark"), "Theme: Dark");
  assert.equal(themeTitle("frappe"), "Theme: Catppuccin Frappé");
  assert.deepEqual(Object.keys(THEME_LABELS), THEME_PREFS);
});

// index.html sets the theme before the page's own code runs, with the rule written a second time: its script is run
// here, for every saved value and both system themes, against the functions the page uses afterwards.
test("index.html's script sets what theme.ts sets, for every saved value", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script && script.includes("aiwb.theme"), "the first script of index.html is the theme's");
  assert.ok(html.indexOf("<script>") < html.indexOf('rel="stylesheet"'), "it runs before the stylesheet is applied");
  const run = (saved: string | null, systemDark: boolean, throws = false) => {
    const dataset: Record<string, string> = {};
    const localStorage = { getItem: (k: string) => { if (throws) throw new Error("denied"); return k === "aiwb.theme" ? saved : null; } };
    new Function("localStorage", "matchMedia", "document", script)(localStorage, (q: string) => ({ matches: q === "(prefers-color-scheme: dark)" && systemDark }), { documentElement: { dataset } });
    return dataset;
  };
  for (const systemDark of [true, false]) {
    for (const saved of [...THEME_PREFS, null, "", "purple", "Mocha", "hidden"]) {
      const pref = parseThemePref(saved), flavour = flavourOf(pref);
      assert.deepEqual(run(saved, systemDark), { ...(flavour ? { flavour } : {}), theme: resolveTheme(pref, systemDark) }, `saved ${JSON.stringify(saved)}, the system ${systemDark ? "dark" : "light"}`);
    }
    assert.deepEqual(run("mocha", systemDark, true), {}, "with no localStorage the page is left to the stylesheet's default");
  }
});
