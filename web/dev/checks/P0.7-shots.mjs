// Ports P0.7 (dev/checks/P0.7-shots.mjs) to the new build, on the gallery (`/?gallery`) at the three viewports: it proves the
// driver's comparison of screenshots. A build against itself differs in no pixel (by more than TOLERANCE levels of a channel) on still pages (the gallery, in the dark
// theme, and with its menu open); a copy of it with one colour token changed (the violet #6965db of the accent, in the
// bundle) differs on all of them; a region left out is not compared (the whole gallery left out: nothing differs; its buttons
// left out: less differs than with nothing left out). The old check changed `--accent` in main.css; the tokens of the new
// build are in its bundle (app/src/ui/tokens.ts), so the copy changes them there.
// At the phone it also shoots the phone kit's gallery (`/?gallery=kit`, package F1): light, dark, with the Cells and bars section at the
// top, and with an ActionSheet open, the same way (the shots wait for the sheet to stop rising). A kit shot need not change with the
// accent (the build against itself is what it proves there); the cases of the gallery of the primitives are what they were at every viewport.
// Pixels are shot again for the new build: nothing is compared with the old page's (AD-80).
import fs from "node:fs";
import path from "node:path";
import { check, compareShots, freePort } from "../shot.mjs";
import { byTid } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const GALLERY = '[data-testid="gallery"]';
const KIT = '[data-testid="kit-gallery"]';
// (a pixel counts as different when a channel is more than 2 levels of 255 off: two rasters of one page draw the rounded border of
// a button one level apart, 22 pixels of the menu's opener; a changed accent is off by a hundred)
const TOLERANCE = 2;

await check("P0.7 screenshots of two builds, compared (the gallery)", async ({ mock, dist, viewport, touch, fail, note }) => {
  if (!mock) return fail("this check starts its own mocks, one per build: run it with DIST, not with MOCK");
  const pages = [
    { name: "gallery", viewport, query: "gallery", wait: GALLERY },
    { name: "dark", viewport, query: "gallery", wait: GALLERY, scheme: "dark" },
    { name: "menu", viewport, query: "gallery", wait: GALLERY, act: async (page) => {
      const opener = byTid(page, "gallery-open-overlay-menu");
      await (touch ? opener.tap() : opener.click());
      await byTid(page, "menu").first().waitFor({ state: "visible", timeout: 15000 });
    } },
    // the phone kit's gallery, at the phone only (tablet and desktop keep the three cases above)
    ...(viewport !== "phone" ? [] : [
      { name: "kit", viewport, query: "gallery=kit", wait: KIT, kit: true },
      { name: "kit-dark", viewport, query: "gallery=kit", wait: KIT, scheme: "dark", kit: true },
      { name: "kit-cells", viewport, query: "gallery=kit", wait: KIT, kit: true, act: async (page) => {
        await byTid(page, "kit-section-cells").first().evaluate((e) => e.scrollIntoView());
        await page.waitForTimeout(300);
      } },
      { name: "kit-action", viewport, query: "gallery=kit", wait: KIT, kit: true, act: async (page) => {
        await byTid(page, "kit-open-action").first().tap();
        await byTid(page, "action-sheet").first().waitFor({ state: "visible", timeout: 15000 });
        // (the sheet rises by Animated.timing, which reads Date.now(): the page's clock is fixed, so it stands at its start. Move the clock
        // past the rise, then shoot it once its box is the same in two frames 100 ms apart)
        await page.clock.setFixedTime(Date.UTC(2026, 0, 15, 12) + 5000);
        await page.evaluate(() => new Promise((done) => {
          const frame = () => new Promise((f) => requestAnimationFrame(f)), box = () => JSON.stringify(document.querySelector('[data-testid="action-sheet"]')?.getBoundingClientRect());
          (async () => { for (let i = 0; i < 100; i++) { await frame(); const a = box(); await new Promise((w) => setTimeout(w, 100)); await frame(); if (a === box()) return done(); } done(); })();
        }));
      } },
    ]),
  ];
  const other = fs.mkdtempSync(path.join(path.dirname(dist), "aiwb-dist-token-"));
  try {
    fs.cpSync(dist, other, { recursive: true });
    const js = path.join(other, "_expo/static/js/web");
    let changed = 0;
    for (const f of fs.readdirSync(js).filter((f) => f.endsWith(".js"))) {
      const code = fs.readFileSync(path.join(js, f), "utf8"), next = code.replace(/#6965db/gi, "#00a000");
      if (next !== code) { fs.writeFileSync(path.join(js, f), next); changed++; }
    }
    if (!changed) return fail("the bundle holds no #6965db (the accent of app/src/ui/tokens.ts) to change");
    const say = (r) => r.map((p) => `${p.name} ${p.differing}`).join(", ");
    const port = await freePort(); // (the comparison's mocks take it in turn)
    const same = await compareShots({ a: dist, b: dist, pages, port, app: true, tolerance: TOLERANCE });
    note(`a build against itself, differing pixels: ${say(same)}`);
    for (const p of same) if (p.differing) fail(`${p.name}: ${p.differing} of ${p.pixels} pixels differ between two screenshots of one build`);
    const diff = await compareShots({ a: dist, b: other, pages, port, app: true, tolerance: TOLERANCE });
    note(`against a copy with the accent changed: ${say(diff)}`);
    for (const p of diff) if (!p.differing && !pages.find((q) => q.name === p.name).kit) fail(`${p.name}: no pixel differs though the accent was changed in the other build`);
    const none = await compareShots({ a: dist, b: other, pages: pages.slice(0, 1), omit: [GALLERY], port, app: true, tolerance: TOLERANCE });
    note(`the same with the whole gallery left out: ${say(none)}`);
    if (none[0].differing) fail(`gallery: ${none[0].differing} pixels differ with the whole gallery left out`);
    const less = await compareShots({ a: dist, b: other, pages: pages.slice(0, 1), omit: ['[data-testid="btn"]'], port, app: true, tolerance: TOLERANCE });
    note(`the same with its buttons left out: ${say(less)}`);
    if (!less[0].differing || less[0].differing >= diff[0].differing) fail(`gallery: ${less[0].differing} pixels differ with the buttons left out, ${diff[0].differing} with nothing left out`);
  } finally { fs.rmSync(other, { recursive: true, force: true }); }
}, { viewports, page: false });
