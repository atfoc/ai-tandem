// A2.4 ported (AD-80; package K3): the popups a toolbar control opens, in a chat panel and on a chat page of 300 px. Each of them (a picker's
// list, the folder's browser, the "more" popup, and a list or the browser opened from "more") lies inside the window and is the element at
// its own corners: nothing covers it, and "more" does not cut a list opened from it. Esc closes a list opened from "more" and leaves the popup,
// and the next Esc closes the popup. In "more" a chip is as wide as it is in the toolbar, its name under the same cap, whether it was
// measured in the toolbar or, its label changed by a pick, in the popup.
// The usage popover (the context ring's, S9) is one of the openers, as in the old check.
// Ports dev/checks/A2.4-popups.mjs: its states, widths and assertions. Deviations: the folder's
// browser closes with Esc as every popup of ui/Overlay does (the old one had none: a press outside closes it too, and is tried); at the touch
// viewports the popups are sheets (AD-72) and the window is the device's (the pane's 300 px a window of 300), and the width of a chip in "more"
// against the wide toolbar is the desktop's (it needs a window of 1100 and one of 300).
import { check, seed, until } from "../shot.mjs";
import { HEIGHT, MORE, POP, SIDE, chip, frame, openAt, openState, placesOf, playable } from "./composer.mjs";
import { byTid, press, tidSel } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

// What opens a popup: [name, the chip's kind ("meter": the context ring), the popup's testID]
const OPENERS = [
  ["the agent's list", "agent", "picker"],
  ["the folder's browser", "folder", "dirs"],
  ["the model's list", "model", "picker"],
  ["the effort's list", "effort", "picker"],
  ["the usage popover", "meter", "usage-pop"],
];
/** The control of a kind under a row or a popup: a chip, or the context ring. */
const opener = (from, kind) => (kind === "meter" ? byTid(from, "ctx-meter") : chip(from, kind, { fixed: false }));

/** In the page: a popup's box against the window, and what is at each of its corners: at the point of the corner's rounding that lies
 *  nearest the box's corner, and 2 px further in (a point outside the rounding is not the popup's). */
function popupInPage(sel) {
  const e = document.querySelector(sel);
  if (!e) return null;
  const r = e.getBoundingClientRect(), at = (x, y) => { const h = document.elementFromPoint(x, y); return !!h && e.contains(h); };
  const cls = (h) => (h ? (h.dataset?.testid || h.tagName.toLowerCase()) : "nothing");
  const d = Math.ceil((parseFloat(getComputedStyle(e).borderTopLeftRadius) || 0) * (1 - Math.SQRT1_2)) + 2;
  const corners = [[r.left + d, r.top + d], [r.right - d, r.top + d], [r.left + d, r.bottom - d], [r.right - d, r.bottom - d]];
  return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), w: innerWidth, h: innerHeight,
    inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && r.width > 0 && r.height > 0,
    covered: corners.filter(([x, y]) => !at(x, y)).map(([x, y]) => `${Math.round(x)},${Math.round(y)}: ${cls(document.elementFromPoint(x, y))}`) };
}

await check("A2.4 the toolbar's popups at 300 px, and a chip's width in \"more\"", async ({ url, layout, open, fail, note }) => {
  const states = (await seed(url, "A2")).filter((s) => playable(s, layout));
  const state = (id) => states.find((s) => s.id === id) ?? (() => { throw new Error(`the seed has no state ${id}`); })();
  const close = async ({ ctx }) => { await ctx.close(); };
  /** Holds a popup that is open: inside the window, the element at its own corners. */
  const holds = async (page, name, id) => {
    await frame(page);
    // (a sheet rises into the window: it is read once it has come to rest)
    let last = "";
    await until(async () => { const r = await page.locator(tidSel(id)).first().boundingBox().catch(() => null); const now = JSON.stringify(r); const still = now === last && !!r; last = now; return still; }, 4000);
    const p = await page.evaluate(popupInPage, tidSel(id));
    if (!p) return fail(`${name}: is not open`);
    if (!p.inside) fail(`${name}: is not inside the window: ${p.left},${p.top} to ${p.right},${p.bottom} of ${p.w} by ${p.h}`);
    if (p.covered.length) fail(`${name}: something else is at its corners: ${p.covered.join("; ")}`);
    return p;
  };
  const gone = (page, id) => until(async () => !await byTid(page, id).count(), 5000);

  let seen = 0;
  for (const id of ["plain-new", "plain-remote-new", "plain-new-long", "plain-started", "board-new", "board-started"]) {
    const s = state(id), p = await openAt(open, s, layout, 300), at = `${id}, a ${s.pane[0]} of 300 px`;
    try {
      const hasMore = await p.page.locator(MORE).count() > 0;
      if (hasMore) {
        await press(p.page, p.page.locator(MORE));
        if (await holds(p.page, `${at}: the "more" popup`, "more-pop")) seen++;
        await p.page.keyboard.press("Escape");
        if (!await gone(p.page, "more-pop")) fail(`${at}: Esc did not close the "more" popup`);
      }
      for (const [what, kind, popup] of OPENERS) {
        const inRow = await (kind === "meter" ? byTid(byTid(p.page, "composer-tools"), "ctx-meter") : chip(byTid(p.page, "composer-tools"), kind)).count() > 0;
        if (!inRow && hasMore) await press(p.page, p.page.locator(MORE));
        const from = inRow ? byTid(p.page, "composer-tools") : byTid(p.page, "more-pop"), target = opener(from, kind);
        if (!await target.count()) { if (!inRow && hasMore) { await p.page.keyboard.press("Escape"); await gone(p.page, "more-pop"); } continue; } // (the state has no such choice)
        const name = `${at}: ${what}${inRow ? "" : ', opened from "more"'}`;
        await press(p.page, target.first());
        if (!await until(() => byTid(p.page, popup).count(), 5000)) { fail(`${name}: did not open`); continue; }
        if (what === "the folder's browser") await byTid(p.page, "dir-use").first().waitFor({ state: "visible", timeout: 8000 }).catch(() => fail(`${name}: the folders did not load`)); // (as tall as it gets)
        if (await holds(p.page, name, popup)) seen++;
        if (!inRow) {
          if (!await p.page.locator(POP).count()) fail(`${name}: the "more" popup closed under it`);
          // Esc closes what was opened from the popup, and then the popup
          await p.page.keyboard.press("Escape");
          if (!await gone(p.page, popup)) fail(`${name}: Esc did not close it`);
          if (!await p.page.locator(POP).count()) fail(`${name}: Esc closed the "more" popup with it`);
          await p.page.keyboard.press("Escape");
          if (!await gone(p.page, "more-pop")) fail(`${name}: the next Esc did not close the "more" popup`);
        } else {
          // (a press outside closes the folder's browser, as before; the others close with Esc)
          if (what === "the folder's browser") await press(p.page, byTid(p.page, "overlay-backdrop").last(), { position: { x: 5, y: 5 } }); else await p.page.keyboard.press("Escape");
          if (!await gone(p.page, popup)) fail(`${name}: did not close`);
        }
      }
    } catch (e) { fail(`${at}: ${e.message.split("\n")[0]}`); }
    await close(p);
  }
  note(`${seen} popups at 300 px: each inside the window and the element at its own corners; Esc closes a list opened from "more" before the popup`);

  if (layout !== "desktop") return;
  // ---- a chip in "more" is as wide as in the toolbar
  /** In the page: each chip of the toolbar by its title's first word, with its width, its name's width and the name's cap. */
  const chipsIn = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-testid="composer-tools"] [data-testid="tchip"], [data-testid="more-pop"] [data-testid="tchip"]')].filter((c) => c.dataset.kind !== "more").map((c) => {
    const n = c.querySelector('[data-testid="chip-name"]'), r1 = (x) => Math.round(x * 10) / 10;
    return [(c.getAttribute("title") ?? c.textContent).split(/[ :—]/)[0] + (c.dataset.fixed === "true" ? "*" : ""), { w: r1(c.getBoundingClientRect().width), name: n ? r1(n.getBoundingClientRect().width) : 0, cap: n ? getComputedStyle(n).maxWidth : "", cut: n ? n.scrollWidth > n.clientWidth : false, where: c.closest('[data-testid="more-pop"]') ? "popup" : "row" }];
  })));
  let compared = 0, cut = 0;
  for (const id of ["plain-new-long", "plain-remote-new", "plain-remote-started-long", "plain-started-long", "plain-new"]) {
    const s = state(id), p = await openState(open, s, layout, 1100), name = `${id}`;
    // (a plain chat's column is 780 px at most, which the long names with the Subagents chip pass: it is let as wide as its page while the
    // row is measured)
    await p.page.addStyleTag({ content: `${tidSel("chat")} { max-width: none !important }` });
    await frame(p.page);
    const wide = await chipsIn(p.page);
    if (Object.values(wide).some((c) => c.where !== "row")) fail(`${name}: at 1100 px a chip is not in the row: ${JSON.stringify(wide)}`);
    await p.page.setViewportSize({ width: 300, height: HEIGHT });
    await frame(p.page);
    await press(p.page, p.page.locator(MORE));
    if (!await until(() => p.page.locator(POP).count(), 5000)) fail(`${name}: at 300 px the "more" chip did not open its popup`);
    await frame(p.page);
    const narrow = await chipsIn(p.page);
    for (const [k, c] of Object.entries(narrow)) {
      if (!wide[k]) { fail(`${name}: at 300 px a chip "${k}" that the wide toolbar has not`); continue; }
      if (Math.abs(c.w - wide[k].w) > 0.2 || Math.abs(c.name - wide[k].name) > 0.2 || c.cap !== wide[k].cap) fail(`${name}: the ${k} chip is ${c.w} px wide in the ${c.where} at 300 px (its name ${c.name}, cap ${c.cap}), and ${wide[k].w} in the wide toolbar (name ${wide[k].name}, cap ${wide[k].cap})`);
      if (c.where === "popup") { compared++; if (c.cut) cut++; }
    }
    if (Object.keys(narrow).length !== Object.keys(wide).length) fail(`${name}: ${Object.keys(narrow).length} chips at 300 px with the popup open, ${Object.keys(wide).length} in the wide toolbar`);
    await close(p);
  }
  if (!cut) fail("no chip in a popup had its name cut: the long names were not among those compared");
  note(`${compared} chips in "more", ${cut} of them with a name cut by its cap: each as wide as in the toolbar`);
  void SIDE;
}, { viewports, page: false });
