import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

import { FLAVOURS, THEME_PREFS, flavourOf, parseThemePref, resolveTheme } from "@aiwb/core/logic/theme.ts";

import { cacheVersion } from "../metro-cache-key.js";
import { absolutePaths, absolutePathsInBundle, checkRelative, csp, cspFor, noticeText, transformIndex } from "../scripts/export-web.mjs";
import { resolveTokens } from "../src/ui/tokens.ts";

const template = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("the post-export step adds the CSP and the bundle to the page", () => {
  const html = transformIndex(template, ["_expo/static/js/web/index-abc.js"]);
  assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="${csp}">`));
  assert.ok(html.includes('<script src="./_expo/static/js/web/index-abc.js" defer></script>'));
  assert.ok(html.indexOf("Content-Security-Policy") < html.indexOf("<script"), "the CSP comes before every script");
  assert.ok(html.indexOf('<div id="root">') < html.indexOf("index-abc.js"));
});

test("the CSP forbids eval, inline script and the network", () => {
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, /connect-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-eval/);
});

test("the default export keeps connect-src 'none'; the test build adds connect-src 'self' and nothing else (U3)", () => {
  const bundle = ["_expo/static/js/web/index-abc.js"];
  const shipped = transformIndex(template, bundle);
  assert.ok(shipped.includes("connect-src 'none'") && !shipped.includes("connect-src 'self'"), "the shipped page has connect-src 'none'");
  assert.equal(csp, cspFor());
  const test = transformIndex(template, bundle, { connectSelf: true });
  assert.ok(test.includes("connect-src 'self'") && !test.includes("connect-src 'none'"), "the test build has connect-src 'self'");
  assert.equal(cspFor({ connectSelf: true }), csp.replace("connect-src 'none'", "connect-src 'self'"), "no other directive differs");
});

test("the export carries the palette's licence notice as a file of its own (A-TH-17)", async () => {
  const text = await noticeText();
  assert.match(text, /Copyright \(c\) 2021 Catppuccin/);
  assert.match(text, /The above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software\./);
  assert.match(text, /@catppuccin\/palette 1\.8\.0/);
  assert.doesNotMatch(text, /\/\*|\*\//, "the file is text, not a comment");
});

test("anything but one bundle is an error", () => {
  assert.throws(() => transformIndex(template, []));
  assert.throws(() => transformIndex(template, ["a.js", "b.js"]));
});

test("the page template links nothing absolute and has no inline script (the CSP allows none)", () => {
  assert.doesNotMatch(template, /(src|href)="\//);
  assert.doesNotMatch(template, /<script(?![^>]*\bsrc=)/);
  assert.ok(template.includes('<script src="./theme-init.js"></script>'));
});

const themeScript = fs.readFileSync(new URL("../public/theme-init.js", import.meta.url), "utf8");

function themeFor(saved: string | null, dark: boolean) {
  const dataset: Record<string, string> = {};
  vm.runInNewContext(themeScript, {
    localStorage: { getItem: () => saved },
    matchMedia: () => ({ matches: dark }),
    document: { documentElement: { dataset } },
  });
  return dataset;
}

test("the theme script sets the saved theme, or the system's, before the first paint", () => {
  assert.deepEqual({ ...themeFor("light", true) }, { theme: "light" });
  assert.deepEqual({ ...themeFor("dark", false) }, { theme: "dark" });
  assert.deepEqual({ ...themeFor("latte", true) }, { flavour: "latte", theme: "light" });
  assert.deepEqual({ ...themeFor("mocha", false) }, { flavour: "mocha", theme: "dark" });
  assert.deepEqual({ ...themeFor(null, true) }, { theme: "dark" });
  assert.deepEqual({ ...themeFor("nonsense", false) }, { theme: "light" });
});

test("the theme script sets what logic/theme.ts sets, for every saved value", () => {
  // (web/test/theme.test.ts's test of the old page's script, on this one: the same saved values, the junk a storage may hold, the system's two answers)
  const run = (saved: string | null, systemDark: boolean, throws = false) => {
    const dataset: Record<string, string> = {};
    vm.runInNewContext(themeScript, {
      localStorage: { getItem: (k: string) => { if (throws) throw new Error("denied"); return k === "aiwb.theme" ? saved : null; } },
      matchMedia: (q: string) => ({ matches: q === "(prefers-color-scheme: dark)" && systemDark }),
      document: { documentElement: { dataset } },
    });
    return { ...dataset };
  };
  assert.ok(themeScript.includes("aiwb.theme"), "the script is the theme's");
  for (const systemDark of [true, false]) {
    for (const saved of [...THEME_PREFS, null, "", "purple", "Mocha", "hidden"]) {
      const pref = parseThemePref(saved), flavour = flavourOf(pref);
      assert.deepEqual(run(saved, systemDark), { ...(flavour ? { flavour } : {}), theme: resolveTheme(pref, systemDark) }, `saved ${JSON.stringify(saved)}, the system ${systemDark ? "dark" : "light"}`);
    }
    assert.deepEqual(run("mocha", systemDark, true), {}, "with no localStorage the page is left to the stylesheet's default");
  }
});

test("the window's ground before the app draws is the theme's `bg`, in light, dark and the four flavours", () => {
  const ground = (selector: string) => new RegExp(`${selector.replace(/[[\]"]/g, "\\$&")}\\s*\\{[^}]*background:\\s*(#[0-9a-f]{6})`, "i").exec(template)?.[1];
  assert.equal(ground("html, body"), resolveTokens("light", false).tokens.bg);
  assert.equal(ground('html[data-theme="dark"], html[data-theme="dark"] body'), resolveTokens("dark", false).tokens.bg);
  for (const f of FLAVOURS) assert.equal(ground(`html[data-flavour="${f}"], html[data-flavour="${f}"] body`), resolveTokens(f, false).tokens.bg, f);
});

test("the page loads the board's web build from ./board/ before the app's bundle, and the CSP allows it ('self')", () => {
  const html = transformIndex(template, ["_expo/static/js/web/index-abc.js"]);
  const board = html.indexOf('<script src="./board/board.js" defer></script>');
  assert.ok(board > 0 && board < html.indexOf("index-abc.js"), "board.js is before the bundle (deferred scripts run in order)");
  assert.ok(html.includes('<link rel="stylesheet" href="./board/board.css">'));
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /style-src 'self'/);
  assert.match(csp, /font-src 'self' data:/);
  assert.throws(() => transformIndex(template.replace('<script src="./board/board.js" defer></script>', ""), ["a.js"]), /board/);
});

test("Excalidraw's fonts are not copied by the export step any more (they are in board/fonts/)", async () => {
  const mod = await import("../scripts/export-web.mjs");
  assert.equal("copyExcalidrawFonts" in mod, false);
});

test("a page or a bundle that names a file by an absolute path is found (it would be blank under file://)", () => {
  assert.deepEqual(absolutePaths('<script src="/_expo/static/js/web/a.js" defer></script><link href="./b.css"><img src="/x.png">'), ["/_expo/static/js/web/a.js", "/x.png"]);
  assert.deepEqual(absolutePaths(transformIndex(template, ["_expo/static/js/web/index-abc.js"])), []);
  assert.deepEqual(absolutePathsInBundle('a("./_expo/static/js/web/c.js");b("/_expo/static/js/web/d.js");c(`/assets/x.png`);d("/api/state")'), ["/_expo/static/js/web/d.js", "/assets/x.png"]);
});

// The built export, when there is one (`npm run build:web`; no test builds it): the window loads it from file://.
test("the built export names nothing by an absolute path", { skip: !fs.existsSync(new URL("../dist-web/index.html", import.meta.url)) }, () => {
  checkRelative(new URL("../dist-web", import.meta.url).pathname);
});

test("Metro's cache is keyed by every EXPO_PUBLIC_* value (a build with other values must not reuse the code of an earlier one)", () => {
  const key = cacheVersion;
  const base = { EXPO_PUBLIC_AIWB_VERSION: "e2e-7", EXPO_PUBLIC_AIWB_SELFTEST: "1", PATH: "/bin" };
  assert.match(key(base), /^e2e-7-[0-9a-f]{12}$/);
  assert.match(key({}), /^dev-[0-9a-f]{12}$/);
  assert.equal(key({ ...base }), key(base), "the same environment, the same key");
  assert.notEqual(key({ ...base, EXPO_PUBLIC_AIWB_VERSION: "uicheck" }), key(base), "the version");
  assert.notEqual(key({ ...base, EXPO_PUBLIC_AIWB_SELFTEST: "0" }), key(base), "another value of any variable");
  assert.notEqual(key({ ...base, EXPO_PUBLIC_AIWB_GALLERY: "chipdoc" }), key(base), "one more variable");
  assert.notEqual(key({ ...base, EXPO_PUBLIC_AIWB_GALLERY: "" }), key(base), "a variable set to nothing is not one that is unset");
  assert.notEqual(key({ EXPO_PUBLIC_A: "b=c" }), key({ EXPO_PUBLIC_A: "b", EXPO_PUBLIC_C: "" }), "name and value are not run together");
  assert.equal(key({ ...base, PATH: "/usr/bin", AIWB_IOS_TEAM_ID: "x" }), key(base), "a variable that is not EXPO_PUBLIC_* does not count");
  assert.equal(key({ PATH: "/bin", EXPO_PUBLIC_AIWB_SELFTEST: "1", EXPO_PUBLIC_AIWB_VERSION: "e2e-7" }), key(base), "the order of the entries does not matter");
  const config = createRequire(import.meta.url)("../metro.config.js");
  assert.equal(config.cacheVersion, key(process.env), "the config uses it");
});
