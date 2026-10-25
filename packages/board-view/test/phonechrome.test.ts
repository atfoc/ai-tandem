import { test } from "node:test";
import assert from "node:assert/strict";
import { BAND_HEIGHT, type PhoneChromeMsg } from "@aiwb/board-bridge/messages.ts";
import { fitView, phoneCss, PHONE_CLASS, type Box } from "../src/phonechrome.ts";

const chrome: PhoneChromeMsg = { title: "Checkout flow", inset: 64, band: "#eff1f5", line: "#ccd0da", share: true };

test("phoneCss: no message, no rules; a message gives the band its height, ground, line and inset, under the phone's class alone", () => {
  assert.equal(phoneCss(null), "");
  assert.equal(phoneCss(undefined), "");
  const css = phoneCss(chrome);
  for (const rule of css.split("\n")) assert.match(rule, new RegExp(`^\\.${PHONE_CLASS} \\.excalidraw\\.excalidraw `));
  assert.match(css, new RegExp(`\\.App-toolbar \\{[^}]*height: ${BAND_HEIGHT}px;[^}]*padding: 0 64px 0 0; background: #eff1f5; border-top: 1px solid #ccd0da;`));
  assert.match(css, /\.App-bottom-bar \{ margin: 0 !important; padding: 0; \}/); // (Excalidraw's margins are inline styles)
  assert.match(css, /\.App-bottom-bar > \.Island \{ border-radius: 0; box-shadow: none; \}/);
  assert.match(css, new RegExp(`\\.dropdown-menu--mobile \\{[^}]*bottom: ${BAND_HEIGHT + 8}px;`)); // (the menu opens above the band)
});

test("phoneCss: only colours are written, the inset is a whole number of px from 0 to 400", () => {
  assert.equal(phoneCss({ ...chrome, band: "red; } body { display: none" }), "");
  assert.equal(phoneCss({ ...chrome, line: "url(https://example.com/x)" }), "");
  assert.match(phoneCss({ ...chrome, inset: 0 }), /padding: 0 0px 0 0;/);
  assert.match(phoneCss({ ...chrome, inset: 123.6 }), /padding: 0 124px 0 0;/);
  assert.match(phoneCss({ ...chrome, inset: 9999 }), /padding: 0 400px 0 0;/);
  assert.match(phoneCss({ ...chrome, inset: NaN }), /padding: 0 0px 0 0;/);
  assert.doesNotMatch(phoneCss({ ...chrome, title: "</style><script>" }), /script|title/);
});

/** Where a scene box lands on the screen under a view: `(scene + scroll) * zoom`. */
const onScreen = (b: Box, v: { scrollX: number; scrollY: number; zoom: number }) =>
  ({ left: (b.x + v.scrollX) * v.zoom, top: (b.y + v.scrollY) * v.zoom, right: (b.x + b.width + v.scrollX) * v.zoom, bottom: (b.y + b.height + v.scrollY) * v.zoom });

test("fitView: a big board is scaled to the visible rect and centred, with the margin on every side", () => {
  const view = { width: 393, height: 760 }, top = 56, margin = 16;
  const bounds = { x: -500, y: 200, width: 2000, height: 900 };
  const v = fitView(bounds, view, top, BAND_HEIGHT, margin);
  assert.ok(v.zoom < 1);
  const s = onScreen(bounds, v);
  const room = { left: margin, right: view.width - margin, top: top + margin, bottom: view.height - BAND_HEIGHT - margin };
  assert.ok(s.left >= room.left - 1e-6 && s.right <= room.right + 1e-6 && s.top >= room.top - 1e-6 && s.bottom <= room.bottom + 1e-6, JSON.stringify(s));
  assert.ok(Math.abs(s.left - room.left) < 1e-3 && Math.abs(s.right - room.right) < 1e-3, "the width is the limit here: it touches both margins");
  assert.ok(Math.abs((s.top + s.bottom) / 2 - (room.top + room.bottom) / 2) < 1e-3, "centred in the visible rect");
});

test("fitView: the height can be the limit, and a small board stays at 100 % and is centred", () => {
  const view = { width: 393, height: 760 };
  const tall = fitView({ x: 0, y: 0, width: 100, height: 3000 }, view, 0, BAND_HEIGHT, 16);
  const s = onScreen({ x: 0, y: 0, width: 100, height: 3000 }, tall);
  assert.ok(Math.abs(s.top - 16) < 1e-3 && Math.abs(s.bottom - (760 - BAND_HEIGHT - 16)) < 1e-3);
  assert.ok(Math.abs((s.left + s.right) / 2 - 393 / 2) < 1e-3);
  const small = { x: 40, y: 40, width: 100, height: 60 };
  const v = fitView(small, view, 56, BAND_HEIGHT, 16);
  assert.equal(v.zoom, 1);
  const t = onScreen(small, v);
  assert.ok(Math.abs((t.left + t.right) / 2 - 393 / 2) < 1e-6 && Math.abs((t.top + t.bottom) / 2 - (56 + (760 - 56 - BAND_HEIGHT) / 2)) < 1e-6);
});

test("fitView: a point or a line has no size to limit the zoom, a huge board stops at Excalidraw's least zoom, a view too small still gives numbers", () => {
  assert.equal(fitView({ x: 5, y: 5, width: 0, height: 0 }, { width: 393, height: 760 }, 0, BAND_HEIGHT, 16).zoom, 1);
  assert.equal(fitView({ x: 0, y: 0, width: 1000, height: 0 }, { width: 393, height: 760 }, 0, BAND_HEIGHT, 16).zoom, Math.floor(361 / 1000 * 1e6) / 1e6);
  assert.equal(fitView({ x: 0, y: 0, width: 1e6, height: 1e6 }, { width: 393, height: 760 }, 0, BAND_HEIGHT, 16).zoom, 0.1);
  const tiny = fitView({ x: 0, y: 0, width: 500, height: 500 }, { width: 20, height: 40 }, 30, BAND_HEIGHT, 16);
  assert.ok(Number.isFinite(tiny.scrollX) && Number.isFinite(tiny.scrollY) && tiny.zoom >= 0.1);
});

test("topInsetCss: a rule for the top layer only with an inset above 0", async () => {
  const { topInsetCss, TOP_INSET_VAR } = await import("../src/phonechrome.ts");
  for (const px of [0, -3, NaN, undefined]) assert.equal(topInsetCss(px), "", String(px));
  const css = topInsetCss(52);
  assert.match(css, /FixedSideContainer_side_top/);
  assert.ok(css.includes(`var(${TOP_INSET_VAR})`));
});
