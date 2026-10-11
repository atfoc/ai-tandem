// Proves A2.6: a long name of a composer's chip is cut with an ellipsis, and is whole in the tooltip and in the menu.
// The seed's 47-character folder and model and its 31-character server, as a choice and as a fixed chip, in a wide
// chat toolbar, in the "more" popup of a 300 px page, and in the goal composer at its least stage (the folder, and
// the models' chip with the long model): the name's element is narrower than its text, ends in an ellipsis and stays
// on one line, inside its chip, and the chip's icon and caret are whole. The whole name is in the chip's tooltip, or
// in the name's own where the chip's says why it is fixed. Where the chip opens a list, the name is an option of it
// that is not cut and lies inside its menu; the folder's browser names the folder whole on its button. A short name
// is not cut.
import { act, check, mockEval, openPage, paneSize, seed, until } from "../shot.mjs";

const HEIGHT = 640;
const MORE = ".composer .more-chip", POP = ".composer .more-pop";
const FOLDER = "storefront-monorepo-with-a-very-long-folder-name", MODEL = "Claude Opus 5.5 (1M context, extended thinking)", SERVER = "lab-gpu-box.tailnet-1234.ts.net";
// What a chip with a long name is known by, under the composer, and what its list is: [the chip, the menu it opens,
// the element of the menu that names it]
const CHIPS = {
  folder: ['button.tchip[title^="Working directory"], button.tchip[title^="Folder on"]', ".menu.up.dirs", ".dir-foot .btn"],
  model: ['button.tchip[title^="Model"]', ".model-pick > .menu.up", '[role="option"] .menu-label'],
  server: [".server-pick > button.tchip", ".server-pick > .menu.up", '[role="option"] .menu-label'],
  tiers: ['button.tchip[title^="Models"]', null, null],
  "folder, fixed": ['.tchip.static[title^="Working directory"], .tchip.static[title^="Folder on"]', null, null],
  "model, fixed": ['.tchip.static[title^="Model and effort"]', null, null],
  "server, fixed": [".tchip.static.server-chip", null, null],
};
// [state, the pane's width, the chips with a long name: kind and name]
const CASES = [
  ["plain-new-long", 1100, [["folder", FOLDER], ["model", MODEL]]],
  ["plain-new-long", 300, [["folder", FOLDER], ["model", MODEL]]],
  ["plain-remote-new", 1100, [["server", SERVER]]],
  ["plain-remote-new", 300, [["server", SERVER]]],
  ["plain-started-long", 1100, [["folder, fixed", FOLDER], ["model, fixed", MODEL]]],
  ["plain-remote-started-long", 300, [["server, fixed", SERVER], ["folder, fixed", FOLDER], ["model, fixed", MODEL]]],
  ["board-long", 300, [["folder, fixed", FOLDER], ["model, fixed", MODEL]]],
  ["goal-draft-long", 320, [["folder", FOLDER], ["tiers", MODEL]]],
];

/** In the page: the chip that `sel` matches under `root`, its name's element and what is drawn beside the name. */
function chipInPage([root, sel]) {
  const chip = document.querySelector(sel.split(", ").map((s) => `${root} ${s}`).join(", "));
  if (!chip) return null;
  const name = chip.querySelector(".tchip-name, .run-tiers-label");
  if (!name) return { none: true, text: chip.textContent };
  const cs = getComputedStyle(name), c = chip.getBoundingClientRect(), n = name.getBoundingClientRect();
  const beside = [...chip.children].filter((e) => e !== name).map((e) => { const r = e.getBoundingClientRect(); return { el: e.tagName.toLowerCase() + (typeof e.className === "string" && e.className ? "." + e.className : ""), whole: r.width > 0 && r.left >= c.left - 0.5 && r.right <= c.right + 0.5 }; });
  return { text: name.textContent, cut: name.scrollWidth > name.clientWidth, ellipsis: cs.textOverflow === "ellipsis" && cs.overflowX === "hidden" && cs.whiteSpace === "nowrap",
    lines: Math.round(n.height / parseFloat(cs.lineHeight) || 1), inChip: n.left >= c.left - 0.5 && n.right <= c.right + 0.5, beside,
    titles: [chip.getAttribute("title") ?? "", name.getAttribute("title") ?? ""], where: chip.closest(".more-pop") ? "popup" : "row" };
}

/** In the page: the elements of an open menu that say `name`, each against its menu and the window. */
function namedInMenu([menu, item, name]) {
  const m = document.querySelector(menu);
  if (!m) return null;
  const box = m.getBoundingClientRect();
  return [...m.querySelectorAll(item)].filter((e) => e.textContent.includes(name)).map((e) => { const r = e.getBoundingClientRect(); return { text: e.textContent, cut: e.scrollWidth > e.clientWidth + 0.5, inside: r.width > 0 && r.left >= box.left - 0.5 && r.right <= Math.min(box.right, innerWidth) + 0.5 }; });
}

await check("A2.6 a long name is cut with an ellipsis, and whole in the tooltip and in the menu", async ({ url, browser, fail, note }) => {
  const states = await seed(url, "A2");
  // the goal composer's three tiers on the long model: its models' chip names it
  await mockEval(`const L = { model: "long", effort: "max" }; runs.r_A2_long.meta.tiers = { orchestrator: L, deep: L, standard: L, light: L }; send({ type: "snapshot", ...snapshot() });`, url);
  const frame = (page) => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok()))));
  let chips = 0, menus = 0;
  for (const [id, width, named] of CASES) {
    const s = states.find((x) => x.id === id) ?? (() => { throw new Error(`the seed has no state ${id}`); })();
    const goal = s.pane[0] === "stage", root = goal ? ".run-composer" : ".composer:not(.run-composer)", errors = [];
    const { ctx, page } = await openPage({ url, browser, errors, sel: s.sel, ...paneSize(s.pane[0], width, HEIGHT), wait: ".composer-box .send" });
    try {
      await act(page, s.act);
      await page.evaluate(() => document.fonts.ready);
      await frame(page);
      for (const [kind, name] of named) {
        const at = `${id} at ${width} px, the ${kind} chip`, [sel, menu, item] = CHIPS[kind];
        // (a chip the row has no room for is in the "more" popup, which stays open while its chips are looked at)
        if (!await page.locator(sel.split(", ").map((x) => `${root} ${x}`).join(", ")).count() && await page.locator(MORE).count() && !await page.locator(POP).count()) await page.locator(MORE).click();
        const c = await until(() => page.evaluate(chipInPage, [root, sel]), 5000);
        if (!c) { fail(`${at}: is not on the page, in the toolbar or in "more"`); continue; }
        if (c.none) { fail(`${at}: its name has no element of its own ("${c.text}"): an ellipsis does not act on a chip's own text`); continue; }
        chips++;
        if (!c.text.includes(name)) fail(`${at}: says "${c.text}", not the long name "${name}"`);
        if (!c.cut) fail(`${at}: its name is not cut: the check wants a name longer than its room`);
        if (!c.ellipsis) fail(`${at}: its cut name does not end in an ellipsis on one line`);
        if (c.lines !== 1 || !c.inChip) fail(`${at}: its name takes ${c.lines} lines${c.inChip ? "" : " and ends outside its chip"}`);
        for (const b of c.beside) if (!b.whole) fail(`${at}: its ${b.el} is not whole beside the cut name`);
        if (!c.titles.some((t) => t.includes(name))) fail(`${at}: neither its tooltip ("${c.titles[0]}") nor its name's ("${c.titles[1]}") has the name whole`);
        if (!menu) continue;
        // the menu: opened from the chip where it is
        const from = c.where === "popup" ? POP : root, list = `${from} ${menu}`;
        await page.locator(sel.split(", ").map((x) => `${from} ${x}`).join(", ")).first().click();
        if (kind === "folder") await page.waitForSelector(`${list} .dir-foot`, { timeout: 8000 }).catch(() => {});
        const rows = await until(async () => { const r = await page.evaluate(namedInMenu, [list, item, name]); return r?.length ? r : null; }, 8000);
        if (!rows) fail(`${at}: its menu has no ${item} that says "${name}"`);
        else {
          menus++;
          for (const r of rows) if (r.cut || !r.inside) fail(`${at}: in its menu "${r.text}" is ${r.cut ? "cut" : "not inside the menu"}`);
        }
        // (the folder's browser has no Esc of its own: a press outside closes it; in "more" Esc closes what was opened from it)
        if (c.where === "row" && kind === "folder") await page.mouse.click(5, 5); else await page.keyboard.press("Escape");
        if (!await until(async () => !await page.locator(list).count(), 5000)) fail(`${at}: its menu did not close`);
      }
    } catch (e) { fail(`${id} at ${width} px: ${e.message.split("\n")[0]}`); }
    for (const e of errors) fail(`${id} at ${width} px: page error: ${e}`);
    await ctx.close();
  }

  { // a short name is not cut: the measure tells a cut name from a whole one
    const s = states.find((x) => x.id === "plain-new"), { ctx, page } = await openPage({ url, browser, sel: s.sel, ...paneSize("page", 1100, HEIGHT), wait: ".composer-box .send" });
    await page.evaluate(() => document.fonts.ready);
    await frame(page);
    for (const kind of ["server", "folder", "model"]) {
      const c = await page.evaluate(chipInPage, [".composer:not(.run-composer)", CHIPS[kind][0]]);
      if (!c || c.none || c.cut) fail(`plain-new at 1100 px, the ${kind} chip: ${!c ? "is not on the page" : c.none ? "has no name element" : `its short name "${c.text}" is cut`}`);
    }
    await ctx.close();
  }
  note(`${chips} chips with a long name: each cut with an ellipsis, its icon and caret whole, the name whole in a tooltip; ${menus} menus name it whole`);
});
