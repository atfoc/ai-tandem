// Proves A2.3: where a chat toolbar's controls are. Every choice of a state (the controls the fixture of widths lists
// for it) is a chip in the toolbar or in the open "more" popup, at a narrow width and at a wider one, and never in
// both. A pick from a chip in the popup (each of the four choices) is saved, and the focus is on that chip afterwards,
// in the popup, also when the pick made its label so short that it would fit the toolbar: it returns when the popup
// closes. A control that
// changes place has no open list: a list or the folder's browser open in the toolbar is gone when the window, or
// ⌘B, sends its chip into the popup, and none opens by itself when the chip is back; a control that leaves the
// toolbar for the open popup closes neither the popup nor a list opened from it. The line that says why a chat has
// no agent is a line of the toolbar's row under its controls, also while the agent's chip is in the popup.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { act, check, dragResizer, mockEval, openPage, paneSize, seed, until } from "../shot.mjs";

const FIXTURE = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../test/fixtures/composer-widths.json", import.meta.url)), "utf8"));
const SIDE = 264, RAIL = 40, HEIGHT = 640;
const MORE = ".composer .more-chip", POP = ".composer .more-pop", ROW = ".composer .composer-tools";
const CHOICE = { server: "server", agent: "agent", folder: "folder", model: "model", "model-effort": "model", loading: "model", effort: "effort", subagents: "subagents" };

/** In the page: the chips of the chat composer's toolbar, each with the choice it is (by its title, as the scripts
 *  address it), where it is (the row or the popup) and what it says; the lists open in the composer; where the focus is. */
function placesInPage() {
  const tools = document.querySelector(".composer:not(.run-composer) .composer-tools");
  if (!tools) return null;
  const kindOf = (chip) => {
    const t = chip.getAttribute("title") ?? "";
    if (t.startsWith("Server")) return "server";
    if (t.startsWith("Agent")) return "agent";
    if (t.startsWith("Model") || t.startsWith("Starting the agent") || chip.textContent.includes("Loading models")) return "model";
    // (the fixed chip of a chat whose server is not connected says that in its title)
    if (chip.matches(".static:not(.server-chip):not(.sub-chip)") && /is not connected|is no longer on/.test(t)) return "model";
    if (t.startsWith("Effort")) return "effort";
    if (t.startsWith("Subagents")) return "subagents";
    if (/^(Working directory|Folder)/.test(t)) return "folder";
    return "";
  };
  const pop = tools.querySelector(".more-pop"), at = document.activeElement;
  const chips = [...tools.querySelectorAll(".tchip:not(.more-chip)")].filter((c) => !c.closest(".menu.up:not(.more-pop)")).map((c) => ({ kind: kindOf(c), where: pop?.contains(c) ? "popup" : "row", label: c.textContent.replace(/▾/g, "").trim(), focus: c === at }));
  const lists = [...tools.querySelectorAll(".menu.up:not(.more-pop):not(.usage-pop)")].map((m) => ({ head: m.querySelector(".menu-head")?.textContent ?? "", where: pop?.contains(m) ? "popup" : "row" }));
  return { chips, lists, more: !!pop, focus: at?.closest(".more-pop") ? "popup" : at?.matches(".more-chip") ? "more" : at?.closest(".composer-tools") ? "row" : at?.className ?? "" };
}

await check("A2.3 every choice is a chip in the toolbar or in the open popup, and where the lists and the focus are", async ({ url, browser, fail, note }) => {
  const states = await seed(url, "A2");
  const state = (id) => states.find((s) => s.id === id) ?? (() => { throw new Error(`the seed has no state ${id}`); })();
  const frame = (page) => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok()))));
  const open = async (s, width, o = {}) => {
    const errors = [];
    const { ctx, page } = await openPage({ url, browser, errors, sel: s.sel, ...paneSize(s.pane[0], width, HEIGHT), wait: ".composer-box .send", ...o });
    await act(page, s.act);
    await page.evaluate(() => document.fonts.ready);
    await frame(page);
    return { ctx, page, errors };
  };
  const close = async ({ ctx, errors }, name) => { for (const e of errors) fail(`${name}: page error: ${e}`); await ctx.close(); };
  const places = (page) => page.evaluate(placesInPage);
  const size = async (page, width) => { await page.setViewportSize({ width: SIDE + width, height: HEIGHT }); await frame(page); };
  const openMore = async (page, name) => {
    if (await page.locator(POP).count()) return true;
    if (!await page.locator(MORE).count()) return false;
    await page.locator(MORE).click();
    if (!await until(() => page.locator(POP).count(), 5000)) fail(`${name}: the "more" chip did not open its popup`);
    return true;
  };
  const closeMore = async (page, name) => { await page.keyboard.press("Escape"); if (!await until(async () => !await page.locator(POP).count(), 5000)) fail(`${name}: Esc did not close the "more" popup`); };
  const inRow = (p, kind) => p.chips.some((c) => c.kind === kind && c.where === "row"), inPopup = (p, kind) => p.chips.some((c) => c.kind === kind && c.where === "popup");

  // ---- every choice once, in the toolbar or in the open popup
  let seen = 0;
  for (const s of states) {
    const fixed = FIXTURE.states[s.id];
    if (!fixed) { fail(`${s.id}: not in the fixture of widths`); continue; }
    if (fixed.composer !== "chat") continue;
    // The fixed Subagents chip of a chat on the default settings gives way to the others: it is in the popup when the
    // popup holds another control, in the row when the row has room for it with all the others whole, else not drawn.
    const spare = fixed.controls.some((c) => c.kind === "subagents" && c.fixed && c.label === "Subagents1 level");
    const firm = (kinds) => (spare ? kinds.filter((k) => k !== "subagents") : kinds);
    const want = firm(fixed.controls.map((c) => CHOICE[c.kind]).filter(Boolean).sort());
    const [kind] = s.pane, p = await open(s, 300);
    try {
      for (const width of kind === "panel" ? [300, 400] : [300, 400, 560]) {
        const name = `${s.id} at ${width} px`;
        if (width !== 300) { if (kind === "panel") await dragResizer(p.page, ".board-panel .resizer", width - 300, 20); else await size(p.page, width); }
        const closed = await places(p.page), more = await openMore(p.page, name), all = await places(p.page);
        const got = firm(all.chips.map((c) => c.kind).sort());
        if (got.some((k) => !k)) fail(`${name}: a chip of the toolbar is no choice the check knows: ${JSON.stringify(all.chips.filter((c) => !c.kind))}`);
        if (String(got) !== String(want)) fail(`${name}: the toolbar and the open popup have the chips ${got}; the state's choices are ${want}`);
        if (spare) {
          const subs = all.chips.filter((c) => c.kind === "subagents");
          if (subs.length > 1 || (more ? subs[0]?.where !== "popup" : subs[0] && subs[0].where !== "row")) fail(`${name}: the fixed Subagents chip is ${subs.map((c) => c.where).join(" and ") || "not drawn"}, with${more ? "" : "out"} a "more" popup`);
        }
        // closed, the row has what the open popup does not hold, and nothing of it is drawn
        if (closed.chips.some((c) => c.where === "popup") || String(closed.chips.map((c) => c.kind)) !== String(all.chips.filter((c) => c.where === "row").map((c) => c.kind))) fail(`${name}: opening the popup changed the row's chips: ${closed.chips.map((c) => c.kind)}, then ${all.chips.filter((c) => c.where === "row").map((c) => c.kind)}`);
        if (more !== all.chips.some((c) => c.where === "popup")) fail(`${name}: the "more" chip is ${more ? "there" : "not there"}, and the popup holds ${all.chips.filter((c) => c.where === "popup").length} chips`);
        if (more) await closeMore(p.page, name);
        seen++;
      }
    } catch (e) { fail(`${s.id}: ${e.message.split("\n")[0]}`); }
    await close(p, s.id);
  }
  note(`${seen} toolbars: every choice of the state is one chip, in the row or in the open popup`);

  // ---- a pick from a chip in the popup
  /** Opens the popup, picks from the chip of `kind` in it, and holds what the pick must leave: the mock has it, the
   *  chip says it, is still in the open popup and has the focus. option: the option of the chip's list to press, or
   *  what makes the pick in what the chip opens (the folder's browser has no list of options). */
  const pickInPopup = async (p, name, kind, chipSel, option, saved, says) => {
    await openMore(p.page, name);
    if (!inPopup(await places(p.page), kind)) return fail(`${name}: the ${kind} chip is not in the popup: ${JSON.stringify((await places(p.page)).chips)}`);
    await p.page.locator(`${POP} ${chipSel}`).click();
    if (typeof option === "function") await option(p.page); else await p.page.locator(`${POP} .menu.up [role="option"]`).filter({ hasText: option }).first().click();
    if (!await until(async () => await mockEval(saved, url) && (await places(p.page)).chips.some((c) => c.kind === kind && c.label.includes(says)), 10000)) return fail(`${name}: the pick was not saved, or the chip does not say "${says}": ${JSON.stringify((await places(p.page)).chips)}`);
    await frame(p.page);
    const after = await places(p.page), chip = after.chips.find((c) => c.kind === kind);
    if (!after.more) fail(`${name}: the popup closed with the pick`);
    if (chip.where !== "popup") fail(`${name}: the chip left the open popup for the row`);
    if (!chip.focus) fail(`${name}: the focus is not on the chip the pick was made from, but in ${after.focus || "the page"}`);
    if (after.lists.length) fail(`${name}: a list is still open: ${JSON.stringify(after.lists)}`);
    return after;
  };
  {
    // The long model, in the popup of a 400 px page: "Opus 5.5" is so much shorter that its chip fits the row.
    // (370 px before the row had the attach button, which takes 30)
    const s = state("plain-new-long"), p = await open(s, 400), name = "a model pick in the popup that shortens the label";
    if (await pickInPopup(p, name, "model", 'button.tchip[title^="Model"]', /^Opus 5\.5/, 'return chats.c_A2_new_long.model !== "long";', "Opus 5.5")) {
      await closeMore(p.page, name);
      const closed = await places(p.page);
      if (!inRow(closed, "model")) fail(`${name}: closed, the shorter chip is not back in the row: ${JSON.stringify(closed.chips)}`);
      else note("a model pick in the popup: saved, the focus on its chip, the chip in the popup until it closed and in the row after");
    }
    await close(p, name);
  }
  {
    const s = state("plain-new"), p = await open(s, 300), name = "an effort pick in the popup";
    if (await pickInPopup(p, name, "effort", 'button.tchip[title^="Effort"]', /^Low/, 'return chats.c_A2_new.effort === "low";', "Low")) note("an effort pick in the popup: saved, the focus on its chip");
    await close(p, name);
  }
  await seed(url, "A2");
  {
    // The folder, picked in its browser: the button the pick is made with goes with the browser, and the chip has the focus.
    const s = state("plain-new"), p = await open(s, 300), name = "a folder pick in the popup";
    const use = async (page) => {
      await page.locator(`${POP} .menu.dirs .dir-list .menu-item.dir`, { hasText: "docs" }).click({ timeout: 10000 });
      await page.locator(`${POP} .menu.dirs .dir-foot .btn`, { hasText: "Use docs" }).click({ timeout: 10000 });
    };
    if (await pickInPopup(p, name, "folder", 'button.tchip[title^="Working directory"]', use, 'return chats.c_A2_new.cwd.endsWith("/shop/docs");', "docs")) note("a folder pick in the popup: saved, the focus on its chip");
    await close(p, name);
    // The agent is the last to leave the row: in the popup of a 240 px page, under the least width.
    const q = await open(s, 240), agent = "an agent pick in the popup";
    if (await pickInPopup(q, agent, "agent", 'button.tchip[title^="Agent"]', /^Cursor/, 'return chats.c_A2_new.agent === "cursor";', "Cursor")) note("an agent pick in the popup: saved, the focus on its chip");
    await close(q, agent);
  }
  await seed(url, "A2");

  // ---- a control that changes place has no open list
  const quiet = async (page, name, what) => {
    // (a list that opens by itself would do so with the commit that puts the chip back, or with a later one)
    for (let i = 0; i < 6; i++) { await frame(page); const now = await places(page); if (now.lists.length) return fail(`${name}: ${what}, a list is open: ${JSON.stringify(now.lists)}`); }
  };
  {
    const s = state("plain-new"), p = await open(s, 560), name = "the effort's list open, the window narrowed";
    await p.page.locator(`${ROW} > .menu-wrap > button.tchip[title^="Effort"]`).click();
    if (!(await places(p.page)).lists.some((l) => l.head === "Effort" && l.where === "row")) fail(`${name}: the effort's list did not open in the toolbar`);
    await size(p.page, 480);
    let now = await places(p.page);
    if (inRow(now, "effort")) fail(`${name}: at 480 px the effort's chip is still in the row`);
    await quiet(p.page, name, "its chip gone into the popup");
    await size(p.page, 560);
    now = await places(p.page);
    if (!inRow(now, "effort")) fail(`${name}: at 560 px again the effort's chip is not back in the row`);
    await quiet(p.page, name, "its chip back in the row");
    // the folder's browser, which was a state of its own chip
    await p.page.locator(`${ROW} > .menu-wrap > button.tchip[title^="Working directory"]`).click();
    if (!await until(() => p.page.locator(`${ROW} .menu.dirs`).count(), 5000)) fail(`${name}: the folder's browser did not open`);
    await size(p.page, 400);
    if (inRow(await places(p.page), "folder")) fail(`${name}: at 400 px the folder's chip is still in the row`);
    await quiet(p.page, name, "the folder's chip gone into the popup");
    await size(p.page, 560);
    if (!inRow(await places(p.page), "folder")) fail(`${name}: at 560 px again the folder's chip is not back in the row`);
    await quiet(p.page, name, "the folder's chip back in the row");
    await close(p, name);
    note("a list and the folder's browser open in the toolbar: gone when the window sends the chip into the popup, and not back with it");
  }
  {
    // The sidebar hidden, a window of 720 px: the page is 680 px, where the row has room for the effort's chip, and 456
    // when ⌘B shows the sidebar, where that chip is in the "more" popup.
    const s = state("plain-new"), name = "the effort's list open, ⌘B";
    const p = await open(s, 456, { ls: { ...paneSize("page", 456).ls, "aiwb.side": "hidden" } });
    const railed = () => p.page.evaluate(() => !!document.querySelector(".app > .side-rail"));
    await p.page.locator(`${ROW} > .menu-wrap > button.tchip[title^="Effort"]`).click();
    if (!(await places(p.page)).lists.some((l) => l.head === "Effort" && l.where === "row")) fail(`${name}: the effort's list did not open in the toolbar`);
    await p.page.keyboard.press("ControlOrMeta+b");
    if (!await until(async () => !await railed(), 10000)) fail(`${name}: ⌘B did not show the sidebar`);
    await frame(p.page);
    if (inRow(await places(p.page), "effort")) fail(`${name}: beside the sidebar the effort's chip is still in the row`);
    await quiet(p.page, name, "its chip gone into the popup");
    await p.page.keyboard.press("ControlOrMeta+b");
    if (!await until(async () => await railed(), 10000)) fail(`${name}: ⌘B did not hide the sidebar again`);
    await frame(p.page);
    if (!inRow(await places(p.page), "effort")) fail(`${name}: the sidebar hidden again, the effort's chip is not back in the row`);
    await quiet(p.page, name, "its chip back in the row");
    await close(p, name);
    note("a list open in the toolbar: gone when ⌘B sends its chip into the popup, and not back with it");
  }
  for (const by of ["the window", "⌘B"]) {
    // "more" open with the effort's list open from it (a page of 486 px, or one of 524 beside the rail: the popup has
    // the effort's chip and the Subagents chip); then the toolbar gives more controls to the popup.
    const s = state("plain-new"), name = `a list open from "more", ${by} narrows the page`;
    const p = await open(s, by === "⌘B" ? 300 : 486, by === "⌘B" ? { ls: { ...paneSize("page", 300).ls, "aiwb.side": "hidden" } } : {});
    await openMore(p.page, name);
    const before = await places(p.page);
    await p.page.locator(`${POP} button.tchip[title^="Effort"]`).click();
    if (!(await places(p.page)).lists.some((l) => l.head === "Effort" && l.where === "popup")) fail(`${name}: the effort's list did not open from the popup`);
    if (by === "⌘B") { await p.page.keyboard.press("ControlOrMeta+b"); if (!await until(() => p.page.evaluate(() => !document.querySelector(".app > .side-rail")), 10000)) fail(`${name}: ⌘B did not show the sidebar`); await frame(p.page); }
    else await size(p.page, 430);
    const now = await places(p.page), held = (x) => x.chips.filter((c) => c.where === "popup").length;
    if (held(now) <= held(before)) fail(`${name}: the popup holds ${held(now)} chips, ${held(before)} before: nothing left the toolbar for it`);
    if (!now.more) fail(`${name}: the popup closed`);
    if (now.lists.length !== 1 || now.lists[0].head !== "Effort" || now.lists[0].where !== "popup") fail(`${name}: the lists open are ${JSON.stringify(now.lists)}, not the effort's alone, in the popup`);
    await close(p, name);
  }
  note('a control that leaves the toolbar for the open popup, by the window and by ⌘B: the popup and the list opened from it stay, and it has no list');
  {
    // The popup closed by its own chip, from the keyboard, under a list opened from it: the list does not come back with the popup.
    // (a page of 486 px: the effort's chip is the popup's first; 456 before the row had the attach button, which takes 30)
    const s = state("plain-new"), p = await open(s, 486), name = 'a list open from "more", the popup closed by its chip';
    await openMore(p.page, name);
    await p.page.locator(`${POP} button.tchip[title^="Effort"]`).click();
    if (!(await places(p.page)).lists.some((l) => l.head === "Effort" && l.where === "popup")) fail(`${name}: the effort's list did not open from the popup`);
    await p.page.keyboard.press("Shift+Tab");
    if ((await places(p.page)).focus !== "more") fail(`${name}: Shift+Tab from the popup's first chip did not reach the "more" chip, but ${(await places(p.page)).focus || "the page"}`);
    await p.page.keyboard.press("Enter");
    if (!await until(async () => !await p.page.locator(POP).count(), 5000)) fail(`${name}: Enter on the "more" chip did not close the popup`);
    await p.page.keyboard.press("Enter");
    if (!await until(() => p.page.locator(POP).count(), 5000)) fail(`${name}: Enter on the "more" chip did not open the popup again`);
    await quiet(p.page, name, "the popup opened again");
    await close(p, name);
    note("the popup closed under a list opened from it and opened again: no list comes back with it");
  }

  // ---- the reason line
  for (const [id, width, popup] of [["plain-noagent", 300, false], ["plain-noagent", 220, true], ["plain-off-new", 300, null], ["plain-off-new", 200, null], ["plain-noagent-installed", 200, true]]) { // (null: the chat's server dropped, and its toolbar has no agent chip)
    const s = state(id), p = await open(s, width), name = `${id} at ${width} px`;
    const more = await openMore(p.page, name), now = await places(p.page);
    if (popup !== null && inPopup(now, "agent") !== popup) fail(`${name}: the agent's chip is ${inPopup(now, "agent") ? "in the popup" : "in the row"}: the check wants it ${popup ? "in the popup" : "in the row"} at this width`);
    const line = await p.page.evaluate(() => {
      const tools = document.querySelector(".composer .composer-tools"), lines = [...document.querySelectorAll(".composer .agent-reason")], l = lines[0];
      if (!l) return null;
      const r = l.getBoundingClientRect(), box = tools.closest(".composer-box").getBoundingClientRect(), t = tools.getBoundingClientRect();
      const others = [...tools.children].filter((e) => e !== l && !e.matches(".grow")).map((e) => e.getBoundingClientRect().bottom);
      return { count: lines.length, child: l.parentElement === tools, text: l.textContent, under: r.top - Math.max(...others), wide: Math.round(r.width) === Math.round(t.width), inBox: r.left >= box.left && r.right <= box.right && r.bottom <= box.bottom, seen: r.height > 0 };
    });
    if (!line) fail(`${name}: the toolbar has no reason line`);
    else {
      if (line.count !== 1 || !line.child) fail(`${name}: ${line.count} reason lines, the first ${line.child ? "a line of the row" : "not a child of the toolbar's row"}`);
      if (line.under < 0 || !line.wide || !line.inBox || !line.seen) fail(`${name}: the reason line is not a line of its own under the row's controls: ${JSON.stringify(line)}`);
      if (!line.text.trim()) fail(`${name}: the reason line says nothing`);
    }
    if (more) await closeMore(p.page, name);
    await close(p, name);
  }
  note("the reason line: a line of the row under its controls, with the agent's chip in the row and in the popup");
});
