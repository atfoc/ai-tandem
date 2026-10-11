// Proves A6.2: the theme chosen in the picker survives a reload with no flash of another theme. For each of the
// seven choices, picked in the menu, the page is reloaded and sampled from its first frame: in every frame, those
// before React has drawn among them, <html> has the choice's data-theme and data-flavour and, once the stylesheet
// applies, the choice's background. After the reload the picker's button names the choice, its menu marks it, and
// the saved value is the same. System is reloaded under a light and under a dark OS, and a flavour under an OS of
// the other kind (Latte under a dark one, Mocha under a light one): the OS does not show through.
// The sampler's own proof: the same reload of a page whose index.html has lost its inline script, which is what sets
// the theme before the first paint. There the first frames have another theme, and the sampler must see them.
import { check, openPage, sampleFrames, until } from "../shot.mjs";

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
const BTN = ".side-foot .theme-btn", MENU = '.side-foot [role="menu"][aria-label="Theme"]';

/** For sampleFrames: the theme of the frame. css: the stylesheet applies (before that nothing of the page is drawn);
 *  app: React has drawn the window. */
function themeProbe() {
  const d = document.documentElement;
  if (!d) return null;
  const cs = getComputedStyle(d);
  return { theme: d.dataset.theme ?? null, flavour: d.dataset.flavour ?? null, bg: cs.backgroundColor, css: cs.getPropertyValue("--bg").trim() !== "", app: !!document.querySelector(".app") };
}

await check("A6.2 the chosen theme survives a reload, with no frame of another theme", async ({ url, browser, fail, note }) => {
  /** A reload, sampled from the page's first frame until React has drawn and some frames more. */
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
    const { ctx, page } = await openPage({ url, browser, size: [1000, 700] });
    try {
      await page.emulateMedia({ colorScheme: c.os });
      await page.locator(BTN).click();
      await page.locator(`${MENU} [data-theme-pref="${c.pref}"]`).click();
      if (!await until(() => page.evaluate(() => !document.querySelector('[role="menu"][aria-label="Theme"]')), 10000)) fail(`${tag}: the pick did not close the menu`);
      const picked = await page.evaluate(themeProbe);
      if (wrong(c)(picked)) fail(`${tag}: picked, the page has data-theme "${picked.theme}", data-flavour ${JSON.stringify(picked.flavour)} and the background ${picked.bg}`);

      const r = await reload(page);
      const bad = r.values.filter(wrong(c)), early = r.values.filter((v) => !v.app).length, styled = r.values.filter((v) => v.css).length;
      if (r.values.length < 5 || !styled) fail(`${tag}: the reload was sampled in ${r.values.length} frames, ${styled} of them with the stylesheet`);
      if (bad.length) fail(`${tag}: ${bad.length} of the ${r.values.length} frames of the reload had another theme, the ${r.values.indexOf(bad[0]) + 1}. first: data-theme "${bad[0].theme}", data-flavour ${JSON.stringify(bad[0].flavour)}, background ${bad[0].bg}`);
      const after = await page.evaluate(() => ({ saved: localStorage.getItem("aiwb.theme"), title: document.querySelector(".side-foot .theme-btn")?.title }));
      if (after.saved !== c.pref) fail(`${tag}: after the reload localStorage "aiwb.theme" is ${JSON.stringify(after.saved)}`);
      if (after.title !== c.title) fail(`${tag}: after the reload the picker's button says "${after.title}", not "${c.title}"`);
      await page.locator(BTN).click();
      await page.waitForSelector(MENU, { timeout: 10000 });
      const marked = await page.evaluate(() => [...document.querySelectorAll('[role="menu"][aria-label="Theme"] [aria-checked="true"]')].map((e) => e.dataset.themePref));
      if (marked.join() !== c.pref) fail(`${tag}: after the reload the menu marks ${marked.join(", ") || "nothing"}`);
      told.push(`${tag} ${r.values.length} (${early} before React)`);
    } finally { await ctx.close(); }
  }
  note(`frames of each reload, all in the chosen theme: ${told.join("; ")}`);

  // The sampler's proof: index.html without its inline script. The theme is then set only when the page's own code
  // runs, and the frames before that are the stylesheet's default, light with no flavour.
  {
    const c = CASES.find((x) => x.pref === "mocha");
    const { ctx, page } = await openPage({ url, browser, size: [1000, 700], ls: { "aiwb.theme": "mocha" } });
    try {
      let stripped = 0;
      await page.route((u) => new URL(u).pathname === "/", async (route) => {
        const res = await route.fetch(), html = await res.text(), less = html.replace(/<script>[\s\S]*?<\/script>/, "");
        if (less !== html && !/aiwb\.theme/.test(less)) stripped++;
        await route.fulfill({ response: res, body: less });
      });
      const r = await reload(page);
      const bad = r.values.filter(wrong(c)), flash = bad.filter((v) => v.css && v.bg === WHITE && v.theme === null), last = r.values[r.values.length - 1];
      if (!stripped) fail("the sampler's proof: index.html has no inline script that names aiwb.theme, so nothing was taken out of it");
      if (!flash.length) fail(`the sampler's proof: with index.html's script taken out, none of the ${r.values.length} frames of the reload was light with no theme set (${bad.length} had another theme than Mocha): the sampler does not see the frames before the page's code runs`);
      if (wrong(c)(last)) fail(`the sampler's proof: the page's own code did not set Mocha in the end (data-theme "${last.theme}", data-flavour ${JSON.stringify(last.flavour)})`);
      note(`with index.html's script taken out: ${flash.length} of ${r.values.length} frames were light before the page's code set Mocha`);
    } finally { await ctx.close(); }
  }
});
