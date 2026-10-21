// A2.3 ported (AD-80; package K3): where a chat toolbar's controls are. Every choice of a state (the controls the fixture of widths lists
// for it) is a chip in the toolbar or in the open "more" popup, at a narrow width and at a wider one, and never in both. A pick from a chip in
// the popup (each of the four choices) is saved, and the focus is on that chip afterwards, in the popup, also when the pick made its label so
// short that it would fit the toolbar: it returns when the popup closes. A control that changes place has no open list: a list or the folder's
// browser open in the toolbar is gone when the window sends its chip into the popup, and none opens by itself when the chip is back; a control
// that leaves the toolbar for the open popup closes neither the popup nor a list opened from it. The line that says why a chat has no agent is
// a line of the toolbar's row under its controls, also while the agent's chip is in the popup.
// Ports dev/checks/A2.3-places.mjs: its states, widths (a desktop's windows and panel widths; at the tablet and the phone a window of that
// box on the device: the phone layout, whose popup and lists are sheets), picks and assertions; the fixture is app/test/fixtures/composer-widths.json
// (P0.6). Deviations, with the reason: the "⌘B" variants of the lists that go with a chip are not here (a page beside the sidebar is 836 px or more
// wide in the new layout, so ⌘B moves no chip; the window variants hold the same rule, and A2.2 holds ⌘B's frames); "the popup closed by its own chip
// from the keyboard" is not here (the popup is a layer over the page with the focus held in it, as every popup of ui/Overlay: its chip is not
// reached by Shift+Tab, and Esc closes the popup, which A2.4 holds); the states with a pending move are played (`acts.move` of sel.mjs).
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { check, mockEval, seed, until } from "../shot.mjs";
import { MORE, POP, chip, frame, openAt, placesOf, playable, resizeTo } from "./composer.mjs";
import { byTid, press, tidSel } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const FIXTURE = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../../app/test/fixtures/composer-widths.json", import.meta.url)), "utf8"));
const CHOICE = { server: "server", agent: "agent", folder: "folder", model: "model", "model-effort": "model", loading: "model", effort: "effort", subagents: "subagents" };

await check("A2.3 every choice is a chip in the toolbar or in the open popup, and where the lists and the focus are", async ({ url, layout, open, fail, note }) => {
  const states = (await seed(url, "A2")).filter((s) => playable(s, layout));
  const state = (id) => states.find((s) => s.id === id) ?? (() => { throw new Error(`the seed has no state ${id}`); })();
  const close = async ({ ctx }) => { await ctx.close(); };
  const openMore = async (page, name) => {
    if (await page.locator(POP).count()) return true;
    if (!await page.locator(MORE).count()) return false;
    await press(page, page.locator(MORE));
    if (!await until(() => page.locator(POP).count(), 5000)) fail(`${name}: the "more" chip did not open its popup`);
    return true;
  };
  const closeMore = async (page, name) => { await page.keyboard.press("Escape"); if (!await until(async () => !await page.locator(POP).count(), 5000)) fail(`${name}: Esc did not close the "more" popup`); };
  const inRow = (p, kind) => p.chips.some((c) => c.kind === kind && c.where === "row"), inPopup = (p, kind) => p.chips.some((c) => c.kind === kind && c.where === "popup");
  const places = placesOf;

  // ---- every choice once, in the toolbar or in the open popup
  let seen = 0;
  for (const s of states) {
    const fixed = FIXTURE.states[s.id];
    if (!fixed) { fail(`${s.id}: not in the fixture of widths`); continue; }
    // The fixed Subagents chip of a chat on the default settings gives way to the others: it is in the popup when the popup holds another
    // control, in the row when the row has room for it with all the others whole, else not drawn.
    // (A state whose fixture row has no Subagents chip is one where voice's pair took its room at the widest pane there is: the page has the chip
    // all the same, as the spare one, where the popup is.)
    const spare = fixed.controls.some((c) => c.kind === "subagents" && c.fixed && c.label === "Subagents1 level") || !fixed.controls.some((c) => c.kind === "subagents");
    const firm = (kinds) => (spare ? kinds.filter((k) => k !== "subagents") : kinds);
    const want = firm(fixed.controls.map((c) => CHOICE[c.kind]).filter(Boolean).sort());
    const [kind] = s.pane, p = await openAt(open, s, layout, 300);
    try {
      for (const width of kind === "panel" ? [300, 400] : [300, 400, 560]) {
        const name = `${s.id} at ${width} px`;
        if (width !== 300) await resizeTo(p.page, s, layout, width);
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
    await close(p);
  }
  note(`${seen} toolbars: every choice of the state is one chip, in the row or in the open popup`);

  // ---- a pick from a chip in the popup
  /** Opens the popup, picks from the chip of `kind` in it, and holds what the pick must leave: the mock has it, the chip says it, is still in
   *  the open popup and has the focus. option: the option of the chip's list to press, or what makes the pick in what the chip opens (the
   *  folder's browser has no list of options). */
  const pickInPopup = async (p, name, kind, option, saved, says) => {
    await openMore(p.page, name);
    if (!inPopup(await places(p.page), kind)) return fail(`${name}: the ${kind} chip is not in the popup: ${JSON.stringify((await places(p.page)).chips)}`);
    await press(p.page, chip(byTid(p.page, "more-pop"), kind).first());
    if (typeof option === "function") await option(p.page); else await press(p.page, byTid(p.page, "pick-row").filter({ hasText: option }).first());
    if (!await until(async () => await mockEval(saved, url) && (await places(p.page)).chips.some((c) => c.kind === kind && c.label.includes(says)), 10000)) return fail(`${name}: the pick was not saved, or the chip does not say "${says}": ${JSON.stringify((await places(p.page)).chips)}`);
    if (layout === "desktop") await until(async () => (await places(p.page)).chips.some((c) => c.kind === kind && c.focus), 3000); // (the list gives the focus back as it goes)
    await frame(p.page);
    const after = await places(p.page), chosen = after.chips.find((c) => c.kind === kind);
    if (!after.more) fail(`${name}: the popup closed with the pick`);
    if (chosen.where !== "popup") fail(`${name}: the chip left the open popup for the row`);
    if (!chosen.focus && layout === "desktop") fail(`${name}: the focus is not on the chip the pick was made from, but in ${after.focus || "the page"}`); // (a touch has no focus to keep)
    if (after.lists.length) fail(`${name}: a list is still open: ${JSON.stringify(after.lists)}`);
    return after;
  };
  {
    // The long model, in the popup of a 380 px page (the old page's 400: this toolbar's widths differ by a few px): "Opus 5.5" is so much
    // shorter that its chip fits the row.
    const s = state("plain-new-long"), p = await openAt(open, s, layout, 380), name = "a model pick in the popup that shortens the label";
    if (await pickInPopup(p, name, "model", /^Opus 5\.5/, 'return chats.c_A2_new_long.model !== "long";', "Opus 5.5")) {
      await closeMore(p.page, name);
      const closed = await places(p.page);
      if (!inRow(closed, "model")) fail(`${name}: closed, the shorter chip is not back in the row: ${JSON.stringify(closed.chips)}`);
      else note("a model pick in the popup: saved, the focus on its chip, the chip in the popup until it closed and in the row after");
    }
    await close(p);
  }
  {
    const s = state("plain-new"), p = await openAt(open, s, layout, 300), name = "an effort pick in the popup";
    if (await pickInPopup(p, name, "effort", /^Low/, 'return chats.c_A2_new.effort === "low";', "Low")) note("an effort pick in the popup: saved, the focus on its chip");
    await close(p);
  }
  await seed(url, "A2");
  {
    // The folder, picked in its browser: the button the pick is made with goes with the browser, and the chip has the focus.
    const s = state("plain-new"), p = await openAt(open, s, layout, 300), name = "a folder pick in the popup";
    const use = async (page) => {
      await press(page, byTid(page, "dir-item", {}).filter({ hasText: "docs" }).first());
      await press(page, byTid(page, "dir-use").filter({ hasText: "Use docs" }).first());
    };
    if (await pickInPopup(p, name, "folder", use, 'return chats.c_A2_new.cwd.endsWith("/shop/docs");', "docs")) note("a folder pick in the popup: saved, the focus on its chip");
    await close(p);
    // The agent is the last to leave the row: in the popup of a 240 px page, under the least width.
    const q = await openAt(open, s, layout, 240), agent = "an agent pick in the popup";
    if (await pickInPopup(q, agent, "agent", /^Cursor/, 'return chats.c_A2_new.agent === "cursor";', "Cursor")) note("an agent pick in the popup: saved, the focus on its chip");
    await close(q);
  }
  await seed(url, "A2");

  // ---- a control that changes place has no open list
  const quiet = async (page, name, what) => {
    // (a list that opens by itself would do so with the commit that puts the chip back, or with a later one)
    for (let i = 0; i < 6; i++) { await frame(page); const now = await places(page); if (now.lists.length) return fail(`${name}: ${what}, a list is open: ${JSON.stringify(now.lists)}`); }
  };
  {
    const s = state("plain-new"), p = await openAt(open, s, layout, 560), name = "the effort's list open, the window narrowed";
    await press(p.page, chip(p.page, "effort").first());
    if (!(await places(p.page)).lists.some((l) => l.head === "Effort" && l.where === "row")) fail(`${name}: the effort's list did not open in the toolbar`);
    await resizeTo(p.page, s, layout, 480);
    let now = await places(p.page);
    if (inRow(now, "effort")) fail(`${name}: at 480 px the effort's chip is still in the row`);
    await quiet(p.page, name, "its chip gone into the popup");
    await resizeTo(p.page, s, layout, 560);
    now = await places(p.page);
    if (!inRow(now, "effort")) fail(`${name}: at 560 px again the effort's chip is not back in the row`);
    await quiet(p.page, name, "its chip back in the row");
    // the folder's browser, which was a state of its own chip
    await press(p.page, chip(p.page, "folder").first());
    if (!await until(() => byTid(p.page, "dirs").count(), 5000)) fail(`${name}: the folder's browser did not open`);
    await resizeTo(p.page, s, layout, 400);
    if (inRow(await places(p.page), "folder")) fail(`${name}: at 400 px the folder's chip is still in the row`);
    await quiet(p.page, name, "the folder's chip gone into the popup");
    await resizeTo(p.page, s, layout, 560);
    if (!inRow(await places(p.page), "folder")) fail(`${name}: at 560 px again the folder's chip is not back in the row`);
    await quiet(p.page, name, "the folder's chip back in the row");
    await close(p);
    note("a list and the folder's browser open in the toolbar: gone when the window sends the chip into the popup, and not back with it");
  }
  {
    // "more" open with the effort's list open from it (a page of 486 px: the popup has the effort's chip and the Subagents chip); then the
    // toolbar gives more controls to the popup: the page is narrowed by steps until it does.
    const s = state("plain-new"), name = 'a list open from "more", the window narrows the page';
    const p = await openAt(open, s, layout, 486);
    await openMore(p.page, name);
    const before = await places(p.page), held = (x) => x.chips.filter((c) => c.where === "popup").length;
    await press(p.page, chip(byTid(p.page, "more-pop"), "effort").first());
    if (!(await places(p.page)).lists.some((l) => l.head === "Effort" && l.where === "popup")) fail(`${name}: the effort's list did not open from the popup`);
    let now = before;
    for (const w of [440, 400, 370, 340, 310]) { await resizeTo(p.page, s, layout, w); now = await places(p.page); if (held(now) > held(before)) break; }
    if (held(now) <= held(before)) fail(`${name}: the popup holds ${held(now)} chips, ${held(before)} before: nothing left the toolbar for it`);
    if (!now.more) fail(`${name}: the popup closed`);
    if (now.lists.length !== 1 || now.lists[0].head !== "Effort" || now.lists[0].where !== "popup") fail(`${name}: the lists open are ${JSON.stringify(now.lists)}, not the effort's alone, in the popup`);
    await close(p);
    note("a control that leaves the toolbar for the open popup: the popup and the list opened from it stay, and it has no list");
  }

  // ---- the reason line
  for (const [id, width, popup] of [["plain-noagent", 300, false], ["plain-noagent", 220, true], ["plain-off-new", 300, null], ["plain-off-new", 200, null], ["plain-noagent-installed", 200, true]]) { // (null: the chat's server dropped, and its toolbar has no agent chip)
    const s = state(id), p = await openAt(open, s, layout, width), name = `${id} at ${width} px`;
    const more = await openMore(p.page, name), now = await places(p.page);
    if (popup !== null && inPopup(now, "agent") !== popup) fail(`${name}: the agent's chip is ${inPopup(now, "agent") ? "in the popup" : "in the row"}: the check wants it ${popup ? "in the popup" : "in the row"} at this width`);
    const line = await p.page.evaluate(() => {
      const q = (id, root = document) => [...root.querySelectorAll(`[data-testid="${id}"]`)];
      const tools = q("composer-tools")[0], lines = q("agent-reason"), l = lines[0];
      if (!l) return null;
      const r = l.getBoundingClientRect(), box = tools.closest('[data-testid="composer-box"]').getBoundingClientRect(), t = tools.getBoundingClientRect();
      const others = [...tools.children].filter((e) => e !== l && e.dataset.testid !== "tool-grow").map((e) => e.getBoundingClientRect().bottom);
      return { count: lines.length, child: l.parentElement === tools, text: l.textContent, under: r.top - Math.max(...others), wide: Math.round(r.width) === Math.round(t.width), inBox: r.left >= box.left && r.right <= box.right && r.bottom <= box.bottom, seen: r.height > 0 };
    });
    if (!line) fail(`${name}: the toolbar has no reason line`);
    else {
      if (line.count !== 1 || !line.child) fail(`${name}: ${line.count} reason lines, the first ${line.child ? "a line of the row" : "not a child of the toolbar's row"}`);
      if (line.under < 0 || !line.wide || !line.inBox || !line.seen) fail(`${name}: the reason line is not a line of its own under the row's controls: ${JSON.stringify(line)}`);
      if (!line.text.trim()) fail(`${name}: the reason line says nothing`);
    }
    if (more) await closeMore(p.page, name);
    await close(p);
  }
  note("the reason line: a line of the row under its controls, with the agent's chip in the row and in the popup");
}, { viewports, page: false });
