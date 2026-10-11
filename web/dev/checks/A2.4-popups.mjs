// Proves A2.4: the popups a toolbar control opens, in a chat panel and on a chat page of 300 px. Each of them (a
// picker's list, the folder's browser, the usage popover, the "more" popup, and a list or the browser opened from
// "more") lies inside the window and is the element at its own corners: nothing covers it, and "more" does not cut a
// list opened from it. Esc closes a list opened from "more" and leaves the popup, and the next Esc closes the popup.
// In "more" a chip is as wide as it is in the toolbar, its name under the same cap, whether it was measured in the
// toolbar or, its label changed by a pick, in the popup.
import { act, check, openPage, paneSize, seed, until } from "../shot.mjs";

const SIDE = 264, HEIGHT = 640;
const MORE = ".composer .more-chip", POP = ".composer .more-pop", ROW = ".composer .composer-tools";
// What opens a popup: [name, the chip's selector under the row or the popup, the popup's selector under the composer]
const OPENERS = [
  ["the server's list", ".server-pick > button.tchip", ".server-pick > .menu.up"],
  ["the agent's list", 'button.tchip[title^="Agent"]', '.menu-wrap:has(> button.tchip[title^="Agent"]) > .menu.up'],
  ["the folder's browser", 'button.tchip[title^="Working directory"], button.tchip[title^="Folder on"]', ".menu.up.dirs"],
  ["the model's list", 'button.tchip[title^="Model"]', ".model-pick > .menu.up"],
  ["the effort's list", 'button.tchip[title^="Effort"]', '.menu-wrap:has(> button.tchip[title^="Effort"]) > .menu.up'],
  ["the usage popover", "button.ctx-meter", ".menu.up.usage-pop"],
];

/** In the page: a popup's box against the window, and what is at each of its corners: at the point of the corner's
 *  rounding that lies nearest the box's corner, and 2 px further in (a point outside the rounding is not the popup's). */
function popupInPage(sel) {
  const e = document.querySelector(sel);
  if (!e) return null;
  const r = e.getBoundingClientRect(), at = (x, y) => { const h = document.elementFromPoint(x, y); return !!h && e.contains(h); };
  const cls = (h) => (h ? (typeof h.className === "string" && h.className ? "." + h.className.trim().split(/\s+/).join(".") : h.tagName.toLowerCase()) : "nothing");
  const d = Math.ceil((parseFloat(getComputedStyle(e).borderTopLeftRadius) || 0) * (1 - Math.SQRT1_2)) + 2;
  const corners = [[r.left + d, r.top + d], [r.right - d, r.top + d], [r.left + d, r.bottom - d], [r.right - d, r.bottom - d]];
  return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), w: innerWidth, h: innerHeight,
    inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && r.width > 0 && r.height > 0,
    covered: corners.filter(([x, y]) => !at(x, y)).map(([x, y]) => `${Math.round(x)},${Math.round(y)}: ${cls(document.elementFromPoint(x, y))}`) };
}

await check("A2.4 the toolbar's popups at 300 px, and a chip's width in \"more\"", async ({ url, browser, fail, note }) => {
  const states = await seed(url, "A2");
  const state = (id) => states.find((s) => s.id === id) ?? (() => { throw new Error(`the seed has no state ${id}`); })();
  const frame = (page) => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok()))));
  const open = async (s, width) => {
    const errors = [];
    const { ctx, page } = await openPage({ url, browser, errors, sel: s.sel, ...paneSize(s.pane[0], width, HEIGHT), wait: ".composer-box .send" });
    await act(page, s.act);
    await page.evaluate(() => document.fonts.ready);
    await frame(page);
    return { ctx, page, errors };
  };
  const close = async ({ ctx, errors }, name) => { for (const e of errors) fail(`${name}: page error: ${e}`); await ctx.close(); };
  /** Holds a popup that is open: inside the window, the element at its own corners. */
  const holds = async (page, name, sel) => {
    await frame(page);
    const p = await page.evaluate(popupInPage, sel);
    if (!p) return fail(`${name}: is not open`);
    if (!p.inside) fail(`${name}: is not inside the window: ${p.left},${p.top} to ${p.right},${p.bottom} of ${p.w} by ${p.h}`);
    if (p.covered.length) fail(`${name}: something else is at its corners: ${p.covered.join("; ")}`);
    return p;
  };
  const gone = (page, sel) => until(async () => !await page.locator(sel).count(), 5000);

  let seen = 0;
  for (const id of ["plain-new", "plain-remote-new", "plain-new-long", "plain-started", "board-new", "board-started", "run-new"]) {
    const s = state(id), p = await open(s, 300), at = `${id}, a ${s.pane[0]} of 300 px`;
    try {
      const hasMore = await p.page.locator(MORE).count() > 0;
      if (hasMore) {
        await p.page.locator(MORE).click();
        if (await holds(p.page, `${at}: the "more" popup`, POP)) seen++;
        await p.page.keyboard.press("Escape");
        if (!await gone(p.page, POP)) fail(`${at}: Esc did not close the "more" popup`);
      }
      for (const [what, chip, popup] of OPENERS) {
        const inRow = await p.page.locator(`${ROW} > ${chip.split(", ").join(`, ${ROW} > `)}, ${ROW} > .menu-wrap > ${chip.split(", ").join(`, ${ROW} > .menu-wrap > `)}`).count() > 0;
        if (!inRow && hasMore) await p.page.locator(MORE).click();
        const from = inRow ? ROW : POP, target = p.page.locator(chip.split(", ").map((c) => `${from} ${c}`).join(", "));
        if (!await target.count()) { if (!inRow && hasMore) { await p.page.keyboard.press("Escape"); await gone(p.page, POP); } continue; } // (the state has no such choice)
        const name = `${at}: ${what}${inRow ? "" : ', opened from "more"'}`, sel = `.composer ${popup}`;
        await target.first().click();
        if (!await until(() => p.page.locator(sel).count(), 5000)) { fail(`${name}: did not open`); continue; }
        if (what === "the folder's browser") await p.page.waitForSelector(`${sel} .dir-foot`, { timeout: 8000 }).catch(() => fail(`${name}: the folders did not load`)); // (as tall as it gets)
        if (await holds(p.page, name, sel)) seen++;
        if (!inRow) {
          if (!await p.page.locator(POP).count()) fail(`${name}: the "more" popup closed under it`);
          // Esc closes what was opened from the popup, and then the popup
          await p.page.keyboard.press("Escape");
          if (!await gone(p.page, sel)) fail(`${name}: Esc did not close it`);
          if (!await p.page.locator(POP).count()) fail(`${name}: Esc closed the "more" popup with it`);
          await p.page.keyboard.press("Escape");
          if (!await gone(p.page, POP)) fail(`${name}: the next Esc did not close the "more" popup`);
        } else {
          // (the folder's browser in the toolbar has no Esc of its own, as before: a press outside closes it)
          if (what === "the folder's browser") await p.page.mouse.click(5, 5); else await p.page.keyboard.press("Escape");
          if (!await gone(p.page, sel)) fail(`${name}: did not close`);
        }
      }
    } catch (e) { fail(`${at}: ${e.message.split("\n")[0]}`); }
    await close(p, at);
  }
  note(`${seen} popups at 300 px: each inside the window and the element at its own corners; Esc closes a list opened from "more" before the popup`);

  // ---- a chip in "more" is as wide as in the toolbar
  /** In the page: each chip of the toolbar by its title's first word, with its width, its name's width and the name's cap. */
  const chipsIn = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll(".composer .composer-tools .tchip:not(.more-chip)")].filter((c) => !c.closest(".menu.up:not(.more-pop)")).map((c) => {
    const n = c.querySelector(".tchip-name"), r1 = (x) => Math.round(x * 10) / 10;
    return [(c.getAttribute("title") ?? c.textContent).split(/[ :—]/)[0] + (c.matches(".static") ? "*" : ""), { w: r1(c.getBoundingClientRect().width), name: n ? r1(n.getBoundingClientRect().width) : 0, cap: n ? getComputedStyle(n).maxWidth : "", cut: n ? n.scrollWidth > n.clientWidth : false, where: c.closest(".more-pop") ? "popup" : "row" }];
  })));
  let compared = 0, cut = 0;
  for (const id of ["plain-new-long", "plain-remote-new", "plain-remote-started-long", "plain-started-long", "plain-new"]) {
    const s = state(id), p = await open(s, 1100), name = `${id}`;
    const wide = await chipsIn(p.page);
    if (Object.values(wide).some((c) => c.where !== "row")) fail(`${name}: at 1100 px a chip is not in the row: ${JSON.stringify(wide)}`);
    await p.page.setViewportSize({ width: SIDE + 300, height: HEIGHT });
    await frame(p.page);
    await p.page.locator(MORE).click();
    if (!await until(() => p.page.locator(POP).count(), 5000)) fail(`${name}: at 300 px the "more" chip did not open its popup`);
    const narrow = await chipsIn(p.page);
    for (const [k, c] of Object.entries(narrow)) {
      if (!wide[k]) { fail(`${name}: at 300 px a chip "${k}" that the wide toolbar has not`); continue; }
      if (Math.abs(c.w - wide[k].w) > 0.2 || Math.abs(c.name - wide[k].name) > 0.2 || c.cap !== wide[k].cap) fail(`${name}: the ${k} chip is ${c.w} px wide in the ${c.where} at 300 px (its name ${c.name}, cap ${c.cap}), and ${wide[k].w} in the wide toolbar (name ${wide[k].name}, cap ${wide[k].cap})`);
      if (c.where === "popup") { compared++; if (c.cut) cut++; }
    }
    if (Object.keys(narrow).length !== Object.keys(wide).length) fail(`${name}: ${Object.keys(narrow).length} chips at 300 px with the popup open, ${Object.keys(wide).length} in the wide toolbar`);
    await close(p, name);
  }
  if (!cut) fail("no chip in a popup had its name cut: the long names were not among those compared");
  note(`${compared} chips in "more", ${cut} of them with a name cut by its cap: each as wide as in the toolbar`);
});
