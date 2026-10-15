import { test } from "node:test";
import assert from "node:assert/strict";
import type { CanvasFilterMsg } from "@aiwb/board-bridge/messages.ts";
import { CHROME_VARS, type ChromeMsg } from "@aiwb/board-bridge/chrome.ts";
import { chromeCss, matrixValues, tableValues, themeCss } from "../src/theme.ts";
import { withoutCdn } from "../src/fonts.ts";

const filter: CanvasFilterMsg = {
  id: "aiwb-canvas-mocha",
  matrix: [0.5, 0, 0, 0, 0.25, 0, 0.5, 0, 0, 0.25, 0, 0, 0.5, 0, 0.25, 0, 0, 0, 1, 0],
  tables: { r: [0, 0.5, 1], g: [0, 0.25, 1], b: [0.1, 0.5, 0.9] },
};

test("themeCss: no filter, no rules; a filter is pointed at by --theme-filter and worn by the canvases", () => {
  assert.equal(themeCss(null), "");
  const css = themeCss(filter);
  assert.match(css, /--theme-filter: url\(#aiwb-canvas-mocha\);/);
  assert.match(css, /canvas \{ filter: var\(--theme-filter\); \}/);
  // Excalidraw's own `.excalidraw.theme--dark` sets --theme-filter with the weight of two classes: ours has three
  for (const rule of css.split("\n")) assert.match(rule, /^:root \.excalidraw\.excalidraw/);
});

test("chromeCss: no map, no rules; a map is written as custom properties of the weight of three classes, and nothing but allowed names and colours", () => {
  assert.equal(chromeCss(null), "");
  assert.equal(chromeCss(undefined), "");
  assert.equal(chromeCss({}), "");
  const mocha: ChromeMsg = Object.fromEntries(CHROME_VARS.map((n) => [n, n === "--island-bg-color" ? "#1e1e2e" : "#313244"]));
  const css = chromeCss(mocha);
  for (const rule of css.split("\n")) assert.match(rule, /^:root \.excalidraw\.excalidraw/);
  for (const name of CHROME_VARS) assert.match(css, new RegExp(`[ {]${name}: #[0-9a-f]{6};`), name);
  assert.match(css, /--island-bg-color: #1e1e2e;/);
  assert.match(css, /--shadow-island: 0 0 0 1px var\(--aiwb-line\)/);
  assert.match(css, /box-shadow: 0 0 0 1px var\(--aiwb-line\)/);
  // (the view validates what it is sent; the stylesheet is careful on its own as well)
  const hostile = chromeCss({ "--island-bg-color": "#112233; background: url(https://x/y)", "--evil": "#000000", "--color-primary": "#abcdef" } as never);
  assert.match(hostile, /--color-primary: #abcdef;/);
  assert.doesNotMatch(hostile, /url\(https|--evil|--island-bg-color/);
});

test("the numbers of the SVG filter are the message's, in order", () => {
  assert.equal(matrixValues(filter), "0.5 0 0 0 0.25 0 0.5 0 0 0.25 0 0 0.5 0 0.25 0 0 0 1 0");
  assert.equal(tableValues(filter.tables.b), "0.1 0.5 0.9");
});

test("withoutCdn: the sources on the CDN are taken out of a FontFace's source list, the page's own stay", () => {
  const own = "url(file:///app/board/fonts/Nunito/Nunito.woff2) format('woff2')";
  const cdn = "url(https://esm.sh/@excalidraw/excalidraw@0.18.1/dist/prod/fonts/Nunito/Nunito.woff2) format('woff2')";
  assert.equal(withoutCdn(`${own}, ${cdn}`), own);
  assert.equal(withoutCdn(own), own);
  assert.equal(withoutCdn(`${cdn}, ${own}`), own);
  assert.equal(withoutCdn("url(data:font/woff2;base64,AAAA)"), "url(data:font/woff2;base64,AAAA)");
  assert.equal(withoutCdn(cdn), "url(data:font/woff2;base64,)", "nothing of the page's own left: one source that fails quietly");
  assert.equal(withoutCdn("local(Nunito)"), "local(Nunito)", "a source that is not on the CDN is left as it is");
  assert.equal(withoutCdn(`${own}, url(https://example.com/x.woff2)`), `${own}, url(https://example.com/x.woff2)`, "only the CDN of Excalidraw is Excalidraw's business");
});
