// Proves A2.4's usage popover on the new build (package S9): the popup the context ring opens lies inside the window and is the element at
// its own corners, in a chat page and in a board's chat panel of 300 px (B-US-04), and it closes: Esc closes it before what stands under it sees
// the key (the composer would stop the agent with it), and a press outside closes it. It has the context as numbers in the old popover's
// words ("Context: N of M tokens (x%)", with "System prompt, tools, board reads and the conversation so far." until the split by category has
// come, or, before a reply, "Context window: N tokens. Usage shows after the first reply."), which no old check read.
// Ports the usage-popover entry of OPENERS in dev/checks/A2.4-popups.mjs at desktop (a pane of 300 px, as the old check), tablet and phone (the
// device's own window: the popup is a bottom sheet there). Same seeded states, same assertions ("is not inside the window", "something else is at
// its corners"). The ring is the one in the composer's toolbar (K3's, `ContextMeter` drawn there). The other popups of the toolbar and the width
// of a chip in "more" are `A2.4-popups.mjs`, which has the usage popover among its openers too; the ring never goes into the "more" popup
// (`composerfit`: the meter stays in the row, cut to its ring), so there is no ring in "more" to reach.
import { check, paneSize, seed, until } from "../shot.mjs";
import { act, byTid, press } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const HEIGHT = 640;
// (a window narrower than 700 pt has the phone layout, and there the popup is the sheet "Context and usage", `usage-sheet`, drawn by
// usage/UsageSheet.tsx: package T3. That is the phone viewport, and the desktop's "page of 300 px" windows (264 + 300 = 564 wide).)
const sheetAt = (viewport, pane) => viewport === "phone" || (!!pane.size && pane.size[0] < 700);
let POPID = "usage-pop";
const POP = () => POPID;

/** In the page: a popup's box against the window, and what is at each of its corners: at the point of the corner's rounding that lies nearest
 *  the box's corner, and 2 px further in (a point outside the rounding is not the popup's). */
function popupInPage(sel) {
  const e = document.querySelector(sel);
  if (!e) return null;
  const r = e.getBoundingClientRect(), at = (x, y) => { const h = document.elementFromPoint(x, y); return !!h && e.contains(h); };
  const name = (h) => (h ? (h.getAttribute("data-testid") ? `[${h.getAttribute("data-testid")}]` : h.tagName.toLowerCase()) : "nothing");
  const d = Math.ceil((parseFloat(getComputedStyle(e).borderTopLeftRadius) || 0) * (1 - Math.SQRT1_2)) + 2;
  const corners = [[r.left + d, r.top + d], [r.right - d, r.top + d], [r.left + d, r.bottom - d], [r.right - d, r.bottom - d]];
  return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), w: innerWidth, h: innerHeight,
    inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5 && r.width > 0 && r.height > 0,
    covered: corners.filter(([x, y]) => !at(x, y)).map(([x, y]) => `${Math.round(x)},${Math.round(y)}: ${name(document.elementFromPoint(x, y))}`) };
}

await check("A2.4 the usage popover lies inside the window, and closes", async ({ url, viewport, open, fail, note }) => {
  const states = await seed(url, "A2");
  const state = (id) => states.find((s) => s.id === id) ?? (() => { throw new Error(`the seed has no state ${id}`); })();
  const frame = (page) => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok()))));
  const gone = (page) => until(async () => !await byTid(page, POP()).count(), 5000);
  /** The popup's box once it has stopped moving (a sheet rises). */
  const settled = async (page) => {
    let last = "";
    await until(async () => { await frame(page); const p = await page.evaluate(popupInPage, `[data-testid="${POP()}"]`); const now = JSON.stringify(p); const same = p && now === last; last = now; return same; }, 8000);
    return page.evaluate(popupInPage, `[data-testid="${POP()}"]`);
  };

  let seen = 0;
  for (const id of ["plain-new", "plain-remote-new", "plain-new-long", "plain-started", "board-new", "board-started"]) {
    const s = state(id), at = `${id}, a ${s.pane[0]} of 300 px`;
    // (the pane of 300 px is a window of the desktop; the other viewports are the devices' own)
    const pane = viewport === "desktop" ? paneSize(s.pane[0], 300, HEIGHT) : {};
    POPID = sheetAt(viewport, pane) ? "usage-sheet" : "usage-pop";
    const { page, ctx } = await open({ sel: s.sel, wait: '[data-testid="chat-head"]', ...pane });
    try {
      await act(page, s.act);
      await page.evaluate(() => document.fonts.ready);
      const ring = byTid(page, "ctx-meter");
      await ring.first().waitFor({ state: "visible", timeout: 15000 });
      // what the page sees of the key: a listener on the window, in the bubbling phase, where the composer's own keys are taken
      await page.evaluate(() => { window.__keys = []; window.addEventListener("keydown", (e) => window.__keys.push(e.key)); });
      await press(page, ring.first());
      if (!await until(() => byTid(page, POP()).count(), 5000)) { fail(`${at}: the usage popover did not open`); await ctx.close(); continue; }
      const p = await settled(page);
      if (!p) fail(`${at}: the usage popover is not open`);
      else {
        if (!p.inside) fail(`${at}: the usage popover is not inside the window: ${p.left},${p.top} to ${p.right},${p.bottom} of ${p.w} by ${p.h}`);
        if (p.covered.length) fail(`${at}: something else is at its corners: ${p.covered.join("; ")}`);
        seen++;
      }
      // the context as numbers, in the old words
      const said = (await byTid(page, "usage-ctx").first().innerText()).replace(/\s+/g, " ").trim();
      const started = id === "plain-started" || id === "board-started";
      // (the sheet says the numbers as its big share and its words: "21% used · 42.9k of 200k tokens")
      if (started ? !(POPID === "usage-sheet" ? /^\d+% used · [\d.]+k of [\d.]+k tokens$/ : /^Context: [\d,]+ of [\d,]+ tokens \(\d+\.\d%\)( System prompt, tools, board reads and the conversation so far\.)?$/).test(said)
        : !/^Context window: [\d,]+ tokens\. Usage shows after the first reply\.$/.test(said)) fail(`${at}: the popover says "${said}"`);
      // Esc closes it, and the page sees no Esc (the key is taken before what is under the popup)
      await page.keyboard.press("Escape");
      if (!await gone(page)) fail(`${at}: Esc did not close the usage popover`);
      const keys = await page.evaluate(() => window.__keys);
      if (keys.includes("Escape")) fail(`${at}: the Esc that closed the usage popover also reached the page (${keys.join(",")}): the composer would have stopped the agent`);
      await page.keyboard.press("Escape");
      if (!(await page.evaluate(() => window.__keys)).includes("Escape")) fail(`${at}: an Esc with no popup open does not reach the page`);
      // a press outside closes it (the dimmed page of a sheet, the transparent layer of a popover)
      await press(page, ring.first());
      if (!await until(() => byTid(page, POP()).count(), 5000)) fail(`${at}: the usage popover did not open again`);
      await settled(page);
      await press(page, byTid(page, "overlay-backdrop").first(), { position: { x: 4, y: 4 } });
      if (!await gone(page)) fail(`${at}: a press outside did not close the usage popover`);
      // the ring is a button that says whether its popup is open
      if (await ring.first().getAttribute("aria-expanded") !== "false") fail(`${at}: the ring says aria-expanded=${await ring.first().getAttribute("aria-expanded")} with its popup closed`);
    } catch (e) { fail(`${at}: ${e.message.split("\n")[0]}`); }
    await ctx.close();
  }
  note(`${seen} usage popovers at ${viewport}: each inside the window and the element at its own corners; Esc closes it before the page sees it`);
}, { viewports, page: false });
