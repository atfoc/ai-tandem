// The design tokens are the colours of the page the app replaced: test/fixtures/tokens.json holds every variable of that page's
// styles.css and flavours.css with its value, in every theme and flavour (written from the stylesheets by the sweep, while they
// existed), and the tokens the app draws with are held to it. A change of a colour changes the fixture on purpose, in the same commit.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { DARK, targets } from "@aiwb/core/logic/canvastheme.ts";
import { PALETTE } from "@aiwb/core/logic/flavours.ts";
import { FLAVOURS, THEME_PREFS, type Flavour, type Theme } from "@aiwb/core/logic/theme.ts";
import { fontMono, fontSans, radius, resolveTokens, THEME_TOKENS, tokenName, tokensFor, type Tokens } from "../src/ui/tokens.ts";

const fixtureFile = fileURLToPath(new URL("./fixtures/tokens.json", import.meta.url));

type Held = Record<Theme | Flavour, Tokens>;

const fixtureHeld = (): Held => JSON.parse(readFileSync(fixtureFile, "utf8"));
const ours = (): Held => ({
  light: tokensFor("light"), dark: tokensFor("dark"),
  ...Object.fromEntries(FLAVOURS.map((f) => [f, tokensFor(f === "latte" ? "light" : "dark", f)])),
}) as Held;

for (const key of ["light", "dark", ...FLAVOURS] as const) {
  test(`the tokens of ${key} are the fixture's`, () => {
    assert.deepEqual(ours()[key], fixtureHeld()[key]);
  });
}

test("radius and the font stacks are the old page's (--radius, --font and --mono of its styles.css)", () => {
  assert.equal(radius, 8);
  assert.equal(fontSans, 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif');
  assert.equal(fontMono, 'ui-monospace, "SF Mono", Menlo, monospace');
});

test("every name has a value in every theme and flavour", () => {
  const names = Object.keys(THEME_TOKENS.light).sort();
  for (const [key, tokens] of Object.entries(ours())) {
    assert.deepEqual(Object.keys(tokens).sort(), names, key);
    for (const [name, value] of Object.entries(tokens)) assert.ok(value && !value.includes("var("), `${key} ${name}: ${value}`);
  }
});

test("a flavour keeps what it does not set from the theme it is laid over", () => {
  for (const f of FLAVOURS) {
    const theme = f === "latte" ? "light" : "dark", over = THEME_TOKENS[theme];
    for (const name of ["claude", "cursor", "pi", "hover", "backdrop", "shadowMd", "viz1"] as const) {
      assert.equal(tokensFor(theme, f)[name], over[name], `${f} ${name}`);
    }
    assert.notEqual(tokensFor(theme, f).bg, over.bg, f);
  }
});

test("plain dark's ground and ink are the bg and text of the dark theme's tokens (the board's ground and ink: logic/canvastheme.ts)", () => {
  // (the old page's test held them to its styles.css's dark theme; these are the tokens the app draws with)
  assert.equal(THEME_TOKENS.dark.bg, DARK.ground);
  assert.equal(THEME_TOKENS.dark.text, DARK.ink);
  assert.deepEqual(targets("dark"), { ground: THEME_TOKENS.dark.bg, ink: THEME_TOKENS.dark.text });
  for (const f of FLAVOURS) {
    const theme = f === "latte" ? "light" : "dark";
    assert.deepEqual(targets(f), { ground: tokensFor(theme, f).bg, ink: tokensFor(theme, f).text }, f);
    assert.equal(tokensFor(theme, f).bg, PALETTE[f].base, f);
  }
});

test("a token name is the CSS variable's in camelCase", () => {
  assert.equal(tokenName("--bg"), "bg");
  assert.equal(tokenName("--accent-fill"), "accentFill");
  assert.equal(tokenName("--line-2"), "line2");
  assert.equal(tokenName("--viz-8"), "viz8");
  assert.equal(tokenName("--shadow-sm"), "shadowSm");
});

test("a choice resolves to its theme, flavour and tokens", () => {
  assert.deepEqual(resolveTokens("light", true), { theme: "light", flavour: null, tokens: THEME_TOKENS.light });
  assert.deepEqual(resolveTokens("dark", false), { theme: "dark", flavour: null, tokens: THEME_TOKENS.dark });
  assert.equal(resolveTokens("system", true).tokens, THEME_TOKENS.dark);
  assert.equal(resolveTokens("system", false).tokens, THEME_TOKENS.light);
  for (const pref of THEME_PREFS) {
    const r = resolveTokens(pref, false);
    assert.equal(r.tokens, tokensFor(r.theme, r.flavour));
  }
  assert.equal(resolveTokens("latte", true).theme, "light");
  assert.equal(resolveTokens("mocha", false).flavour, "mocha");
  assert.equal(resolveTokens("mocha", false).theme, "dark");
});
