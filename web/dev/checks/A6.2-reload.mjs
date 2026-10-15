// Proves A6.2: the theme chosen in the picker survives a reload with no flash of another theme. For each of the
// seven choices, picked in the menu, the page is reloaded and sampled from its first frame: in every frame, those
// before the app has drawn among them, <html> has the choice's data-theme and data-flavour and the choice's
// background. After the reload the picker's button names the choice, its menu marks it, and the saved value is the same.
// System is reloaded under a light and under a dark OS, and a flavour under an OS of the other kind (Latte under a dark one,
// Mocha under a light one): the OS does not show through.
// The sampler's own proof: the same reload of a page whose theme script (public/theme-init.js, which sets data-theme and data-flavour
// before the first paint) comes back empty. There the first frames have another theme, and the sampler must see them.
// Ports dev/checks/A6.2-reload.mjs (S1) to the new build, at the three viewports (A-TH-04, A-TH-06, A-TH-08, A-TH-09). Deviations: the ground of the
// window before the app draws is a style of the page's own (`theme-ground` in public/index.html, held to the tokens by test/export-web.test.ts),
// there being no stylesheet whose arrival the old probe waited for, and the app has drawn when `app-root` is there; the page's script is a file
// (`theme-init.js`) where it was inline, so the sampler's proof empties that file.
import { check, sampleFrames, until } from "../shot.mjs";
import { byTid, press } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const WHITE = "rgb(255, 255, 255)", DARK = "rgb(28, 28, 33)";
const CASES = [
  { pref: "light", os: "dark", theme: "light", bg: WHITE, title: "Theme: Light" },
  { pref: "dark", os: "light", theme: "dark", bg: DARK, title: "Theme: Dark" },
  { pref: "system", os: "light", theme: "light", bg: WHITE, title: "Theme: System (follows the OS)" },
  { pref: "system", os: "dark", theme: "dark", bg: DARK, title: "Theme: System (follows the OS)" },
  { pref: "latte", os: "dark", theme: "light", flavour: "latte", bg: "rgb(239, 241, 245)", title: "Theme: Catppuccin Latte" },
  { pref: "frappe", os: "light", theme: "dark", flavour: "frappe", bg: "rgb(48, 52, 70)", title: "Theme: Catppuccin Frappé" },
  { pref: "macchiato", os: "light", theme: "dark", flavour: "macchiato", bg: "rgb(36, 39, 58)", title: "Theme: Catppuccin Macchiato" },
  { pref: "mocha", os: "light", theme: "dark", flavour: "mocha", bg: "rgb(30, 30, 46)", title: "Theme: Catppuccin Mocha" },
];
const BTN = '[data-testid="theme-btn"]', MENU = '[data-testid="theme-menu"]';

/** For sampleFrames: the theme of the frame. css: the page's own style applies (before the head is parsed nothing of the page is drawn);
 *  app: the app has drawn the window. */
function themeProbe() {
  const d = document.documentElement;
  if (!d) return null;
  const cs = getComputedStyle(d);
  return { theme: d.dataset.theme ?? null, flavour: d.dataset.flavour ?? null, bg: cs.backgroundColor, css: !!document.getElementById("theme-ground"), app: !!document.querySelector('[data-testid="app-root"]') };
}

await check("A6.2 the chosen theme survives a reload, with no frame of another theme", async ({ url, open, fail, note }) => {
  const wait = '[data-testid="side-tree"]';
  /** A reload, sampled from the page's first frame until the app has drawn and some frames more. */
  const reload = async (page) => {
    const sampler = await sampleFrames(page, themeProbe, { fromLoad: true });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(BTN, { timeout: 15000 });
    await page.waitForFunction(() => window.__frames?.values.filter((v) => v.app).length > 4, null, { timeout: 15000 });
    return sampler.stop();
  };
  const wrong = (c) => (v) => v.theme !== c.theme || v.flavour !== (c.flavour ?? null) || (v.css && v.bg !== c.bg);
  const told = [];
  for (const c of CASES) {
    const tag = `${c.pref} under a ${c.os} OS`;
    const { ctx, page } = await open({ wait });
    try {
      await page.emulateMedia({ colorScheme: c.os });
      await press(page, page.locator(BTN).first());
      await press(page, page.locator(`${MENU} [data-theme-pref="${c.pref}"]`).first());
      if (!await until(() => page.evaluate(() => !document.querySelector('[data-testid="theme-menu"]')), 10000)) fail(`${tag}: the pick did not close the menu`);
      const picked = await page.evaluate(themeProbe);
      if (wrong(c)(picked)) fail(`${tag}: picked, the page has data-theme "${picked.theme}", data-flavour ${JSON.stringify(picked.flavour)} and the background ${picked.bg}`);

      const r = await reload(page);
      const bad = r.values.filter(wrong(c)), early = r.values.filter((v) => !v.app).length, styled = r.values.filter((v) => v.css).length;
      if (r.values.length < 5 || !styled) fail(`${tag}: the reload was sampled in ${r.values.length} frames, ${styled} of them with the page's style`);
      if (bad.length) fail(`${tag}: ${bad.length} of the ${r.values.length} frames of the reload had another theme, the ${r.values.indexOf(bad[0]) + 1}. first: data-theme "${bad[0].theme}", data-flavour ${JSON.stringify(bad[0].flavour)}, background ${bad[0].bg}`);
      const after = await page.evaluate(() => ({ saved: localStorage.getItem("aiwb.theme"), title: document.querySelector('[data-testid="theme-btn"]')?.title }));
      if (after.saved !== c.pref) fail(`${tag}: after the reload the kv key "aiwb.theme" is ${JSON.stringify(after.saved)}`);
      if (after.title !== c.title) fail(`${tag}: after the reload the picker's button says "${after.title}", not "${c.title}"`);
      await press(page, page.locator(BTN).first());
      await page.waitForSelector(MENU, { timeout: 10000 });
      const marked = await page.evaluate(() => [...document.querySelectorAll('[data-testid="theme-menu"] [aria-checked="true"]')].map((e) => e.dataset.themePref));
      if (marked.join() !== c.pref) fail(`${tag}: after the reload the menu marks ${marked.join(", ") || "nothing"}`);
      told.push(`${tag} ${r.values.length} (${early} before the app)`);
    } finally { await ctx.close(); }
  }
  note(`frames of each reload, all in the chosen theme: ${told.join("; ")}`);

  // The sampler's proof: the theme script comes back empty. The theme is then set only when the app's own code
  // runs, and the frames before that are the page's default ground, light with no flavour.
  {
    const c = CASES.find((x) => x.pref === "mocha");
    const { ctx, page } = await open({ wait, ls: { "aiwb.theme": "mocha" } });
    try {
      let stripped = 0;
      await page.route((u) => new URL(u).pathname.endsWith("/theme-init.js"), async (route) => { stripped++; await route.fulfill({ status: 200, contentType: "text/javascript", body: "" }); });
      const r = await reload(page);
      const bad = r.values.filter(wrong(c)), flash = bad.filter((v) => v.css && v.bg === WHITE && v.theme === null), last = r.values[r.values.length - 1];
      if (!stripped) fail("the sampler's proof: the page did not ask for theme-init.js, so nothing was taken out of it");
      if (!flash.length) fail(`the sampler's proof: with the theme script emptied, none of the ${r.values.length} frames of the reload was light with no theme set (${bad.length} had another theme than Mocha): the sampler does not see the frames before the app's code runs`);
      if (wrong(c)(last)) fail(`the sampler's proof: the app's own code did not set Mocha in the end (data-theme "${last.theme}", data-flavour ${JSON.stringify(last.flavour)})`);
      note(`with the theme script emptied: ${flash.length} of ${r.values.length} frames were light before the app's code set Mocha`);
    } finally { await ctx.close(); }
  }
}, { viewports, page: false });
