// Proves, in a real browser, that the canvas follows the theme as a view of the board (logic/canvastheme.ts, the SVG filters of
// board-view's CanvasFilters.tsx): in each of Light, Dark and the four Catppuccin flavours
//   - the empty ground of the canvas, read as a pixel of a screenshot, is the theme's background (the app's root draws it, `app-root`) within
//     3/255 per channel: the filter's table puts the stored white where the page's own ground is, so the canvas and the panels around it are
//     one surface (Light: #ffffff, with no filter);
//   - the stroke quick picks of the properties panel are Excalidraw's own in every theme (#1e1e1e first; Excalidraw has no setting for them and
//     its code is not patched), and each swatch is drawn through the theme's filter: its computed `filter` is url("#aiwb-canvas-<theme>") in
//     Dark and the four flavours, and none in Light;
//   - the same page put in the other theme with no reload takes the ground of each, and the filter of each on the picks.
// The canvas is Excalidraw's own and the filter is the browser's, so what is measured is what a user sees.
// OUT=/tmp/x keeps a screenshot of every theme there (default /tmp/aiwb-canvas-<theme>-<viewport>.png), for a person's look.
// Ports dev/checks/P7.5-canvas.mjs (B4) to the new build, at the three viewports. Deviations:
//   - the ground is compared with the colour `app-root` is drawn in (the old page read it off <html>'s background, which the app's root view draws);
//   - the picks are read where Excalidraw draws its properties panel: on the desktop it is beside the canvas; on the tablet and the phone
//     Excalidraw keeps it behind the bottom bar's Edit button, which the check presses;
//   - the second part puts the one page in each theme by the picker in the sidebar's foot (`theme-btn`, `theme-menu`, as the old check did), the six
//     picks of the old check in its order. The phone shows the foot on the list screen only, so there each pick goes back to the list, picks, and
//     opens the board again (the page is not reloaded: the check keeps a mark on `window`); Excalidraw is then drawn anew in the new theme
//     where the other layouts switch the open canvas.
// From the sweep (D-CT-09), the part the picker had replaced: under the choice "System" the open canvas follows the OS's light or dark with no reload
// (the check emulates the colour scheme of the browser, dark, light, dark, as the old second part did before the picker), and under a flavour it does not:
// the ground stays the flavour's whichever way the OS goes.
// This check imports logic/canvastheme.ts, which node reads as TypeScript (Node 22.18 or newer, no flag).
import { FLAVOURS } from "../../../packages/core/src/logic/theme.ts";
import { check, colourOf, seed, until } from "../shot.mjs";
import { openBoard, press, showList } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const BTN = '[data-testid="theme-btn"]', MENU = '[data-testid="theme-menu"]';
const THEMES = ["light", "dark", ...FLAVOURS];
const LIVE = ".excalidraw:not(.excalidraw--view-mode) canvas.interactive";
const OUT = process.env.OUT;
const TOLERANCE = 3;
const EXCALIDRAW_STROKE = ["#1e1e1e", "#e03131", "#2f9e44", "#1971c2", "#f08c00"]; // Excalidraw's own quick picks, as it passes them
const hex = (c) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
const off = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

await check("P7.5 the canvas takes each theme's ground and filter, on load and when the theme changes", async ({ url, browser, open, fail, note, viewport }) => {
  await seed(url, "A1", "A6");
  // (the board alone: the old check had its chat beside it in a window of 1400 px, which left the canvas wide enough for Excalidraw's own
  // layout of its panels, as the window here does without the chat; the phone shows a board's chat as a screen over it)
  const BOARD = { board: "b_ui", chat: null };
  // A page of the browser that only decodes screenshots (the pixel of a PNG is read by the browser's own decoder)
  const decoder = await browser.newPage();
  /** The colour of the canvas's empty ground: a pixel in the canvas's lower right, where the seed's three shapes and the
   *  panels are not. The page is shot, so it is the canvas as composited with its filter. */
  const ground = async (page) => {
    const box = await page.locator(".excalidraw canvas.interactive").boundingBox();
    const at = { x: Math.round(box.x + box.width * 0.75), y: Math.round(box.y + box.height * 0.7) };
    const png = (await page.screenshot({ scale: "css" })).toString("base64");
    return decoder.evaluate(async ([png, at]) => {
      const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
      const c = new OffscreenCanvas(img.width, img.height), g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      return [...g.getImageData(at.x, at.y, 1, 1).data].slice(0, 3);
    }, [png, at]);
  };
  const bgOf = (page) => colourOf(page, '[data-testid="app-root"]', "backgroundColor");
  /** Waits for the ground to be the page's background: [what it is, what it should be]. */
  const settles = async (page) => {
    let last = null;
    const bg = await bgOf(page);
    await until(async () => { last = await ground(page); return off(last, bg) <= TOLERANCE; });
    return [last, bg];
  };
  /** The quick picks of the stroke and background pickers, as the panel shows them: select all, which shows the panel (Excalidraw's phone and
   *  tablet layouts keep it behind the bottom bar's Edit button, which is pressed, and again to close it). Per picker: the swatch colours,
   *  and the computed filter of the first swatch. */
  const picks = async (page) => {
    const box = await page.locator(".excalidraw canvas.interactive").boundingBox();
    await page.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.7);
    await page.keyboard.press("ControlOrMeta+a");
    const top = ".excalidraw .selected-shape-actions .color-picker__top-picks button";
    let edit = null;
    if (!await page.waitForSelector(top, { timeout: 3000 }).then(() => true, () => false)) {
      edit = page.locator('button[aria-label="Edit"]').first();
      await edit.click({ timeout: 10000 });
      await page.waitForSelector(".color-picker__top-picks button", { timeout: 10000 });
    }
    const rows = await page.evaluate(() => [...document.querySelectorAll(".color-picker__top-picks")]
      .map((row) => ({ colours: [...row.querySelectorAll("button")].map((b) => b.style.getPropertyValue("--swatch-color").trim().toLowerCase()),
        filter: getComputedStyle(row.querySelector("button")).filter })));
    if (edit) await edit.click();
    return rows;
  };
  const wantFilter = (theme) => theme === "light" ? "none" : `url("#aiwb-canvas-${theme}")`;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  /** Fails when the stroke picks are not Excalidraw's own, or their swatch is not drawn through the theme's filter. */
  const checkPicks = (p, theme, what) => {
    if (!same(p[0].colours, EXCALIDRAW_STROKE)) fail(`${what}: the stroke quick picks are ${p[0].colours}, not Excalidraw's ${EXCALIDRAW_STROKE}`);
    if (p[0].filter !== wantFilter(theme)) fail(`${what}: the stroke swatch's filter is "${p[0].filter}", not ${wantFilter(theme)}`);
  };
  const shot = (page, theme) => page.screenshot({ path: `${OUT || "/tmp"}/aiwb-canvas-${theme}-${viewport}.png`, scale: "css" });
  const grounds = {};

  // each theme on a page of its own
  for (const theme of THEMES) {
    const { ctx, page } = await open({ sel: BOARD, ls: { "aiwb.theme": theme }, wait: LIVE, still: true });
    try {
      const [got, want] = await settles(page);
      grounds[theme] = got;
      note(`${theme}: ground ${hex(got)} (page ${hex(want)})`);
      if (off(got, want) > TOLERANCE) fail(`${theme}: the canvas's ground is ${hex(got)}, not the page's ${hex(want)}`);
      if (theme === "light" && hex(got) !== "#ffffff") fail(`light: the canvas's ground is ${hex(got)}, not #ffffff`);
      const p = await picks(page);
      checkPicks(p, theme, theme);
      if (p[1].colours[0] !== "transparent") fail(`${theme}: the background picks start with ${p[1].colours[0]}, not Excalidraw's transparent`);
      await shot(page, theme);
    } catch (e) { fail(`${theme}: ${e.message.split("\n")[0]}`); }
    finally { await ctx.close(); }
  }
  if (new Set(THEMES.map((t) => hex(grounds[t] ?? [0, 0, 0]))).size !== THEMES.length) fail(`two themes have the same ground: ${THEMES.map((t) => `${t} ${hex(grounds[t] ?? [0, 0, 0])}`).join(", ")}`);

  // one page put in each theme by the picker, with no reload
  const { ctx, page } = await open({ sel: BOARD, wait: LIVE, still: true, scheme: "light" });
  try {
    let [was] = await settles(page);
    await page.evaluate(() => { window.__sameLoad = true; });
    const pick = async (theme) => {
      await showList(page); // (the foot is in the list: the wide layouts keep it on screen, the phone goes back to it)
      await press(page, page.locator(BTN).first());
      await press(page, page.locator(`${MENU} [data-theme-pref="${theme}"]`).first());
      const took = await until(() => page.evaluate(([t, f]) => { const d = document.documentElement.dataset; return d.theme === t && (d.flavour ?? null) === f && !document.querySelector('[data-testid="theme-menu"]'); },
        [FLAVOURS.includes(theme) ? (theme === "latte" ? "light" : "dark") : theme, FLAVOURS.includes(theme) ? theme : null]), 10000);
      if (!took) throw new Error(`a pick of ${theme} in the theme's menu did not put the page in it`);
      if (viewport === "phone") await openBoard(page, "b_ui");
      await page.waitForSelector(LIVE, { timeout: 15000 });
    };
    for (const theme of ["dark", "mocha", "latte", "light", "frappe", "macchiato"]) {
      await pick(theme);
      const [got, want] = await settles(page);
      if (off(got, want) > TOLERANCE) fail(`switching to ${theme}: the canvas's ground is ${hex(got)}, not the page's ${hex(want)}`);
      if (off(got, was) <= TOLERANCE) fail(`switching to ${theme}: the ground did not change, it is ${hex(got)}`);
      if (off(got, grounds[theme] ?? [0, 0, 0]) > TOLERANCE) fail(`switching to ${theme}: the ground is ${hex(got)}, and ${hex(grounds[theme] ?? [0, 0, 0])} on a page loaded in it`);
      checkPicks(await picks(page), theme, `switching to ${theme}`);
      await page.keyboard.press("Escape");
      was = got;
    }
    if (!await page.evaluate(() => window.__sameLoad)) fail("switching the theme loaded the page again");
  } catch (e) { fail(`switching: ${e.message.split("\n")[0]}`); }
  finally { await ctx.close(); }

  // the choice is "System" (nothing saved): the open canvas follows the OS's colour scheme
  {
    const { ctx, page } = await open({ sel: BOARD, wait: LIVE, still: true, scheme: "light" });
    try {
      let [was] = await settles(page);
      await page.evaluate(() => { window.__sameLoad = true; });
      if (off(was, grounds.light ?? [0, 0, 0]) > TOLERANCE) fail(`system, the OS light: the ground is ${hex(was)}, and ${hex(grounds.light ?? [0, 0, 0])} on a page loaded in light`);
      for (const scheme of ["dark", "light", "dark"]) {
        await page.emulateMedia({ colorScheme: scheme });
        if (!await until(() => page.evaluate((t) => document.documentElement.dataset.theme === t, scheme), 10000)) { fail(`system: the page did not take the OS's ${scheme}`); continue; }
        const [got, want] = await settles(page);
        if (off(got, want) > TOLERANCE) fail(`system, the OS ${scheme}: the canvas's ground is ${hex(got)}, not the page's ${hex(want)}`);
        if (off(got, was) <= TOLERANCE) fail(`system, the OS ${scheme}: the ground did not change, it is ${hex(got)}`);
        if (off(got, grounds[scheme] ?? [0, 0, 0]) > TOLERANCE) fail(`system, the OS ${scheme}: the ground is ${hex(got)}, and ${hex(grounds[scheme] ?? [0, 0, 0])} on a page loaded in ${scheme}`);
        was = got;
      }
      if (!await page.evaluate(() => window.__sameLoad)) fail("the OS changing its colour scheme loaded the page again");
    } catch (e) { fail(`system: ${e.message.split("\n")[0]}`); }
    finally { await ctx.close(); }
    // a flavour is not the OS's to change: Mocha (dark) under an OS that goes light, Latte (light) under an OS that goes dark
    for (const [flavour, scheme] of [["mocha", "light"], ["latte", "dark"]]) {
      const { ctx, page } = await open({ sel: BOARD, ls: { "aiwb.theme": flavour }, wait: LIVE, still: true, scheme: scheme === "light" ? "dark" : "light" });
      try {
        const [first] = await settles(page);
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(500); // (a moment for the page to do what it would)
        const [after, want] = await settles(page);
        if (off(after, first) > TOLERANCE) fail(`${flavour}: the OS went ${scheme} and the ground changed from ${hex(first)} to ${hex(after)}`);
        if (off(after, grounds[flavour] ?? [0, 0, 0]) > TOLERANCE) fail(`${flavour}: the ground is ${hex(after)}, not the flavour's ${hex(grounds[flavour] ?? [0, 0, 0])}`);
        if (off(after, want) > TOLERANCE) fail(`${flavour}: the canvas's ground is ${hex(after)}, not the page's ${hex(want)}`);
      } catch (e) { fail(`${flavour} under the OS: ${e.message.split("\n")[0]}`); }
      finally { await ctx.close(); }
    }
  }
  await decoder.close();
}, { viewports, page: false });
