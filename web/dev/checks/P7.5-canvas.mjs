// Proves, in a real browser, that the canvas follows the theme as a view of the board (logic/canvastheme.ts, the SVG
// filters of CanvasFilters.tsx and flavours-canvas.css): in each of Light, Dark and the four Catppuccin flavours
//   - the empty ground of the canvas, read as a pixel of a screenshot, is the theme's --bg (computed on <html>) within
//     3/255 per channel: the filter's table puts the stored white where the page's own ground is, so the canvas and
//     the panels around it are one surface (Light: #ffffff, with no filter);
//   - the stroke quick picks of the properties panel are Excalidraw's own in every theme (#1e1e1e first; Excalidraw has
//     no setting for them and its code is not patched), and each swatch is drawn through the theme's filter: its
//     computed `filter` is url("#aiwb-canvas-<theme>") in Dark and the four flavours, and none in Light;
//   - the same page put in the themes one after the other by the picker in the sidebar's foot, with no reload, takes
//     the ground of each, and the filter of each on the picks.
// The canvas is Excalidraw's own and the filter is the browser's, so what is measured is what a user sees.
// OUT=/tmp/x keeps a screenshot of every theme there (default /tmp/aiwb-canvas-<theme>.png), for a person's look.
// This check imports logic/canvastheme.ts, which node reads as TypeScript (Node 22.18 or newer, no flag).
import { FLAVOURS } from "../../src/logic/theme.ts";
import { check, colourOf, openPage, seed, until } from "../shot.mjs";

const THEMES = ["light", "dark", ...FLAVOURS];
const BOARD = { board: "b_ui", chat: "c_A6_sketch" }, EDIT = ".excalidraw:not(.excalidraw--view-mode) .App-toolbar";
const BTN = ".side-foot .theme-btn", MENU = '.side-foot [role="menu"][aria-label="Theme"]';
const OUT = process.env.OUT;
const TOLERANCE = 3;
const EXCALIDRAW_STROKE = ["#1e1e1e", "#e03131", "#2f9e44", "#1971c2", "#f08c00"]; // Excalidraw's own quick picks, as it passes them
const hex = (c) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
const off = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

await check("P7.5 the canvas takes each theme's ground and filter, on load and when the theme changes", async ({ url, browser, fail, note }) => {
  await seed(url, "A1", "A6");
  // A page of the browser that only decodes screenshots (the pixel of a PNG is read by the browser's own decoder)
  const decoder = await browser.newPage();
  /** The colour of the canvas's empty ground: a pixel in the canvas's lower right, where the seed's three shapes and the
   *  panels are not. The page is shot, so it is the canvas as composited with its filter. */
  const ground = async (page) => {
    const box = await page.locator(".excalidraw canvas.interactive").boundingBox();
    const at = { x: Math.round(box.x + box.width * 0.75), y: Math.round(box.y + box.height * 0.8) };
    const png = (await page.screenshot()).toString("base64");
    return decoder.evaluate(async ([png, at]) => {
      const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
      const c = new OffscreenCanvas(img.width, img.height), g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      return [...g.getImageData(at.x, at.y, 1, 1).data].slice(0, 3);
    }, [png, at]);
  };
  const bgOf = async (page) => (await colourOf(page, "html", "backgroundColor"));
  /** Waits for the ground to be the page's --bg: [what it is, what it should be]. */
  const settles = async (page) => {
    let last = null;
    const bg = await bgOf(page);
    await until(async () => { last = await ground(page); return off(last, bg) <= TOLERANCE; });
    return [last, bg];
  };
  /** The quick picks of the stroke and background pickers, as the panel shows them: select all, which shows the panel.
   *  Per picker: the swatch colours, and the computed filter of the first swatch. */
  const picks = async (page) => {
    const box = await page.locator(".excalidraw canvas.interactive").boundingBox();
    await page.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.8);
    await page.keyboard.press("ControlOrMeta+a");
    await page.waitForSelector(".excalidraw .selected-shape-actions .color-picker__top-picks button");
    return page.evaluate(() => [...document.querySelectorAll(".excalidraw .selected-shape-actions .color-picker__top-picks")]
      .map((row) => ({ colours: [...row.querySelectorAll("button")].map((b) => b.style.getPropertyValue("--swatch-color").trim().toLowerCase()),
        filter: getComputedStyle(row.querySelector("button")).filter })));
  };
  const wantFilter = (theme) => theme === "light" ? "none" : `url("#aiwb-canvas-${theme}")`;
  /** Fails when the stroke picks are not Excalidraw's own, or their swatch is not drawn through the theme's filter. */
  const checkPicks = (p, theme, what, fail) => {
    if (!same(p[0].colours, EXCALIDRAW_STROKE)) fail(`${what}: the stroke quick picks are ${p[0].colours}, not Excalidraw's ${EXCALIDRAW_STROKE}`);
    if (p[0].filter !== wantFilter(theme)) fail(`${what}: the stroke swatch's filter is "${p[0].filter}", not ${wantFilter(theme)}`);
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const shot = (page, theme) => page.screenshot({ path: `${OUT || "/tmp"}/aiwb-canvas-${theme}.png` });
  const grounds = {};

  // each theme on a page of its own
  for (const theme of THEMES) {
    const errors = [];
    const { ctx, page } = await openPage({ url, browser, sel: BOARD, size: [1400, 900], ls: { "aiwb.theme": theme }, wait: EDIT, still: true, errors });
    try {
      const [got, want] = await settles(page);
      grounds[theme] = got;
      note(`${theme}: ground ${hex(got)} (page ${hex(want)})`);
      if (off(got, want) > TOLERANCE) fail(`${theme}: the canvas's ground is ${hex(got)}, not the page's ${hex(want)}`);
      if (theme === "light" && hex(got) !== "#ffffff") fail(`light: the canvas's ground is ${hex(got)}, not #ffffff`);
      const p = await picks(page);
      checkPicks(p, theme, theme, fail);
      if (p[1].colours[0] !== "transparent") fail(`${theme}: the background picks start with ${p[1].colours[0]}, not Excalidraw's transparent`);
      await shot(page, theme);
      for (const e of errors) fail(`${theme}: page error: ${e}`);
    } catch (e) { fail(`${theme}: ${e.message.split("\n")[0]}`); }
    finally { await ctx.close(); }
  }
  if (new Set(THEMES.map((t) => hex(grounds[t] ?? [0, 0, 0]))).size !== THEMES.length) fail(`two themes have the same ground: ${THEMES.map((t) => `${t} ${hex(grounds[t] ?? [0, 0, 0])}`).join(", ")}`);

  // one page put in each theme by the picker, with no reload
  const { ctx, page } = await openPage({ url, browser, sel: BOARD, size: [1400, 900], wait: EDIT, still: true, scheme: "light" });
  try {
    let [was] = await settles(page);
    const pick = async (theme) => {
      await page.locator(BTN).click();
      await page.locator(`${MENU} [data-theme-pref="${theme}"]`).click();
      const took = await until(() => page.evaluate(([t, f]) => { const d = document.documentElement.dataset; return d.theme === t && (d.flavour ?? null) === f && !document.querySelector('[role="menu"][aria-label="Theme"]'); },
        [FLAVOURS.includes(theme) ? (theme === "latte" ? "light" : "dark") : theme, FLAVOURS.includes(theme) ? theme : null]), 10000);
      if (!took) throw new Error(`a pick of ${theme} in the theme's menu did not put the page in it`);
    };
    for (const theme of ["dark", "mocha", "latte", "light", "frappe", "macchiato"]) {
      await pick(theme);
      const [got, want] = await settles(page);
      if (off(got, want) > TOLERANCE) fail(`switching to ${theme}: the canvas's ground is ${hex(got)}, not the page's ${hex(want)}`);
      if (off(got, was) <= TOLERANCE) fail(`switching to ${theme}: the ground did not change, it is ${hex(got)}`);
      if (off(got, grounds[theme] ?? [0, 0, 0]) > TOLERANCE) fail(`switching to ${theme}: the ground is ${hex(got)}, and ${hex(grounds[theme] ?? [0, 0, 0])} on a page loaded in it`);
      checkPicks(await picks(page), theme, `switching to ${theme}`, fail);
      await page.keyboard.press("Escape");
      was = got;
    }
  } catch (e) { fail(`switching: ${e.message.split("\n")[0]}`); }
  finally { await ctx.close(); await decoder.close(); }
});
