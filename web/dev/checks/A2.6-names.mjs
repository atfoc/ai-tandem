// A2.6 ported (AD-80; package K3): a long name of a composer's chip is cut with an ellipsis, and is whole in the tooltip and in the menu. The
// seed's 47-character folder and model, as a choice and as a fixed chip, and its 31-character server, whose chip is always a fixed one, in a wide
// chat toolbar and in the "more" popup of a 300 px page: the name's element is narrower than its text, ends in an ellipsis and stays on one line,
// inside its chip, and the chip's icon and caret are whole. The whole name is in the chip's tooltip, or in the name's own where the chip's says why
// it is fixed. Where the chip opens a list, the name is an option of it that is not cut and lies inside its menu; the folder's browser names the
// folder whole on its button. A short name is not cut.
// Ports dev/checks/A2.6-names.mjs with its states, widths and assertions (the wide toolbar is the desktop's 1100 px; the touch viewports run the
// cases at 300 px, where "more" is a sheet). The folder's browser closes with Esc too (every popup of ui/Overlay does).
// At the phone (ux-improvements C1: the phone viewport, a touch viewport's window and the desktop's pages of 300 px, windows under 700 px) the choices
// are the chips of the chip row above the box and there is no "more" popup: the choice chips (the folder's and the model's of a new chat) are held
// there as above, and with the whole name in the chip's tooltip or its accessibility label (the phone's parts have no tooltips); the fixed chips of a
// started chat and the server's chip are not drawn there (a started chat's settings are in Chat info, the server is named in the header), so those cases
// are left out of a phone-layout page and held by the desktop's pages of 1100 px and its panel of 300 px (board-long).
// The phone's menus (ux-improvements C2) are the chip sheets: the folder's chip opens folder-sheet, whose "Use <name>" button (dir-use) names the folder
// whole, and the model's chip model-sheet, whose row (model-menu-row) names the model whole; each opens from its chip with composer.mjs' openChoice and closes
// with closeChoice. The chip says "<model> · <effort>" there, the whole name in the chip's accessibility label. So does the wide toolbar's model chip
// (plans/model-effort-menu/design.md 2.5), whose menu is the model and effort menu (model-menu), its rows model-menu-row.
import { check, seed, until } from "../shot.mjs";
import { MORE, POP, closeChoice, frame, openAt, openChoice, openState, playable } from "./composer.mjs";
import { byTid, press, tidSel } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const FOLDER = "storefront-monorepo-with-a-very-long-folder-name", MODEL = "Claude Opus 5.5 (1M context, extended thinking)", SERVER = "lab-gpu-box.tailnet-1234.ts.net";
// What a chip with a long name is known by, under the composer, and what its list is: [the chip's kind and whether it is fixed, the menu it opens,
// the element of the menu that names it]
const CHIPS = {
  folder: [{ kind: "folder", fixed: false }, "dirs", tidSel("dir-use")],
  model: [{ kind: "model", fixed: false }, "model-menu", tidSel("model-menu-row")], // (the model and effort menu: plans/model-effort-menu/design.md 2.5)
  "folder, fixed": [{ kind: "folder", fixed: true }, null, null],
  "model, fixed": [{ kind: "model", fixed: true }, null, null],
  "server, fixed": [{ kind: "server", fixed: true }, null, null],
};
// [state, the pane's width, the chips with a long name: kind and name]
const CASES = [
  ["plain-new-long", 1100, [["folder", FOLDER], ["model", MODEL]]],
  ["plain-new-long", 300, [["folder", FOLDER], ["model", MODEL]]],
  ["plain-remote-new", 1100, [["server, fixed", SERVER]]],
  ["plain-remote-new", 300, [["server, fixed", SERVER]]],
  ["plain-started-long", 1100, [["folder, fixed", FOLDER], ["model, fixed", MODEL]]],
  ["plain-remote-started-long", 300, [["server, fixed", SERVER], ["folder, fixed", FOLDER], ["model, fixed", MODEL]]],
  ["board-long", 300, [["folder, fixed", FOLDER], ["model, fixed", MODEL]]],
];

// The same at the phone: the sheet each chip opens, and the element of it that names the choice
const PHONE_MENUS = { folder: ["folder-sheet", tidSel("dir-use")], model: ["model-sheet", tidSel("model-menu-row")] };

/** In the page: the chip that [kind, fixed] names under `root`, its name's element and what is drawn beside the name. */
function chipInPage([root, kind, fixed]) {
  const scope = document.querySelector(root) ?? document;
  const chip = [...scope.querySelectorAll('[data-testid="tchip"]')].find((c) => c.dataset.kind === kind && (c.dataset.fixed === "true") === fixed && c.dataset.kind !== "more");
  if (!chip) return null;
  const name = chip.querySelector('[data-testid="chip-name"]');
  if (!name) return { none: true, text: chip.textContent };
  const cs = getComputedStyle(name), c = chip.getBoundingClientRect(), n = name.getBoundingClientRect();
  const beside = [...chip.children].filter((e) => e !== name).map((e) => { const r = e.getBoundingClientRect(); return { el: e.tagName.toLowerCase() + (e.dataset.testid ? "." + e.dataset.testid : ""), whole: r.width > 0 && r.left >= c.left - 0.5 && r.right <= c.right + 0.5 }; });
  return { text: name.textContent, cut: name.scrollWidth > name.clientWidth, ellipsis: cs.textOverflow === "ellipsis" && cs.overflowX === "hidden" && cs.whiteSpace === "nowrap",
    lines: Math.round(n.height / parseFloat(cs.lineHeight) || 1), inChip: n.left >= c.left - 0.5 && n.right <= c.right + 0.5, beside,
    titles: [chip.getAttribute("title") ?? "", name.getAttribute("title") ?? "", chip.getAttribute("aria-label") ?? ""], where: chip.closest('[data-testid="more-pop"]') ? "popup" : "row" };
}

/** In the page: the elements of an open menu that say `name`, each against its menu and the window. */
function namedInMenu([menu, item, name]) {
  const m = document.querySelector(menu);
  if (!m) return null;
  const box = m.getBoundingClientRect();
  return [...m.querySelectorAll(item)].filter((e) => e.textContent.includes(name)).map((e) => { const r = e.getBoundingClientRect(); return { text: e.textContent, cut: e.scrollWidth > e.clientWidth + 0.5, inside: r.width > 0 && r.left >= box.left - 0.5 && r.right <= Math.min(box.right, innerWidth) + 0.5 }; });
}

await check("A2.6 a long name is cut with an ellipsis, and whole in the tooltip and in the menu", async ({ url, layout, open, fail, note }) => {
  const wide = layout === "desktop";
  const states = (await seed(url, "A2")).filter((s) => playable(s, layout));
  let chips = 0, menus = 0, skipped = 0;
  const ROW = '[data-testid="composer-tools"], [data-testid="composer-chip-row"]'; // (the wide toolbar's row, or the phone's chip row)
  for (const [id, wanted, named] of CASES) {
    const width = wide ? wanted : 300;
    if (!wide && wanted !== 300) continue; // (a touch viewport has no wide toolbar: the wide cases are the desktop's)
    const s = states.find((x) => x.id === id) ?? (() => { throw new Error(`the seed has no state ${id}`); })();
    const { page, ctx } = await openAt(open, s, layout, width);
    try {
      for (const [kind, name] of named) {
        const phone = await page.evaluate(() => !!document.querySelector('[data-testid="composer-phone-tools"]'));
        const at = `${id} at ${width} px, the ${kind} chip`, [match, menu, item] = phone && PHONE_MENUS[kind] ? [CHIPS[kind][0], ...PHONE_MENUS[kind]] : CHIPS[kind], fixed = match.fixed;
        // (a chip the row has no room for is in the "more" popup, which stays open while its chips are looked at)
        if (phone && fixed) { skipped++; continue; } // (a started chat has no chip row at the phone, and the server is named in the header)
        const inRow = () => page.evaluate(chipInPage, [ROW, match.kind, fixed]);
        if (!await inRow() && await page.locator(MORE).count() && !await page.locator(POP).count()) await press(page, page.locator(MORE));
        const c = await until(async () => (await inRow()) ?? (await page.evaluate(chipInPage, ['[data-testid="more-pop"]', match.kind, fixed])), 5000);
        if (!c) { fail(`${at}: is not on the page, in the toolbar or in "more"`); continue; }
        if (c.none) { fail(`${at}: its name has no element of its own ("${c.text}"): an ellipsis does not act on a chip's own text`); continue; }
        chips++;
        if (!c.text.includes(name)) fail(`${at}: says "${c.text}", not the long name "${name}"`);
        if (!c.cut) fail(`${at}: its name is not cut: the check wants a name longer than its room`);
        if (!c.ellipsis) fail(`${at}: its cut name does not end in an ellipsis on one line`);
        if (c.lines !== 1 || !c.inChip) fail(`${at}: its name takes ${c.lines} lines${c.inChip ? "" : " and ends outside its chip"}`);
        for (const b of c.beside) if (!b.whole) fail(`${at}: its ${b.el} is not whole beside the cut name`);
        if (!c.titles.some((t) => t.includes(name))) fail(`${at}: neither its tooltip ("${c.titles[0]}") nor its name's ("${c.titles[1]}") nor its label ("${c.titles[2]}") has the name whole`);
        if (!menu) continue;
        // the menu: opened from the chip where it is
        const from = c.where === "popup" ? byTid(page, "more-pop") : byTid(page, phone ? "composer-chip-row" : "composer-tools");
        if (phone) await openChoice(page, match.kind); else await press(page, from.locator(`${tidSel("tchip")}[data-kind="${match.kind}"]:not([data-fixed="true"])`).first());
        if (kind === "folder") await byTid(page, "dir-use").first().waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
        const rows = await until(async () => { const r = await page.evaluate(namedInMenu, [tidSel(menu), item, name]); return r?.length ? r : null; }, 8000);
        if (!rows) fail(`${at}: its menu has no ${item} that says "${name}"`);
        else {
          menus++;
          for (const r of rows) if (r.cut || !r.inside) fail(`${at}: in its menu "${r.text}" is ${r.cut ? "cut" : "not inside the menu"}`);
        }
        if (phone) await closeChoice(page); else await page.keyboard.press("Escape");
        if (!await until(async () => !await byTid(page, menu).count(), 5000)) fail(`${at}: its menu did not close`);
      }
    } catch (e) { fail(`${id} at ${width} px: ${e.message.split("\n")[0]}`); }
    await ctx.close();
  }

  { // a short name is not cut: the measure tells a cut name from a whole one
    const s = states.find((x) => x.id === "plain-new"), { page, ctx } = wide ? await openState(open, s, layout, 1100) : await openAt(open, s, layout, 560);
    await frame(page);
    for (const kind of ["folder", "model"]) {
      const c = await page.evaluate(chipInPage, [ROW, kind, false]);
      if (!c || c.none || c.cut) fail(`plain-new at ${wide ? "1100" : "560"} px, the ${kind} chip: ${!c ? "is not on the page" : c.none ? "has no name element" : `its short name "${c.text}" is cut`}`);
    }
    await ctx.close();
  }
  note(`${chips} chips with a long name: each cut with an ellipsis, its icon and caret whole, the name whole in a tooltip; ${menus} menus name it whole${skipped ? `; ${skipped} fixed chips not drawn in the phone layout` : ""}`);
}, { viewports, page: false });
