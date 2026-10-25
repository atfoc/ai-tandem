// A2.5 ported (AD-80; package K3): what the e2e scripts address is where they address it. In a 1400 px window each of the four chip
// selectors (the agent's, the model's, the effort's and the folder's chip, by their testID `tchip` and the start of their title) matches one
// chip of the toolbar's row, which says what it said and opens its list; so do the fixed chips of a started chat. A chat's server is no choice:
// one on another server names it in the fixed chip of kind `server`, and one on this computer has no such chip. In a board's 400 px panel Agent
// and Model do (the Agent chip in the row, the Model chip in the "more" popup, which voice's pair keeps room from), and each opens its list there. innerText of the meter (`ctx-meter`) gives the share in percent while only the ring
// shows, and "Context unavailable", with no number and the reason as its title, while only the icon shows. The composer's meter alone is cut so.
// Ports dev/checks/A2.5-selectors.mjs with its states and assertions. The 1400 px window and the panel's widths are the desktop's; at the tablet and
// the phone the same chips are looked for at the device's own width (a 400 px page: Agent and Model in the row, each a chip that opens its list, a
// sheet there). The meter's parts read the composer's real
// meter (S9's `ContextMeter` in the toolbar: its testIDs, the text, the compact state, the title); the last block reads the meters outside the
// composer, a subagent's in its row of the thread (S7: S9's `SubMeter`), which stay uncut.
// In a window of the phone's width the chips are the phone's (ux-improvements C2): a `tchip` of the chip row (no `title`: a chip is known by its
// accessibility label, "Agent: Claude Code", "Folder: shop", "Model and effort: Opus 5.5 · High", "Subagents: …"), and a press opens its sheet: the
// agent's and the model's rows (the model's also the effort's segments), the folder's path, the subagents' options.
// In a window of the phone's width (any viewport: under 700 px) the composer is the phone's (ux-improvements C1): the chips are in its chip row
// (`composer-chip-row`), the ring is a 44 pt target with no text seen and no hover title (its words are its accessible name), and the error
// meter is its icon alone at every width.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { check, seed, until } from "../shot.mjs";
import { closeChoice, frame, openAt, openChoice, openState, playable } from "./composer.mjs";
import { back, byTid, layoutNow, press, tidSel } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const FIXTURE = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../../app/test/fixtures/composer-widths.json", import.meta.url)), "utf8"));
// A chip of the row by the start of its title (what a script addresses it by), a button (not static)
const chipSel = (title) => `${tidSel("tchip")}[title^="${title}"]:not([data-fixed="true"])`;
const FIXED = (title) => `${tidSel("tchip")}[data-fixed="true"][title^="${title}"]`;
const SERVER = `${tidSel("tchip", { kind: "server" })}`; // the chip that names a chat's server, which is never a button

await check("A2.5 the scripts' chip selectors and the meter's text", async ({ url, layout, open, fail, note }) => {
  const wide = layout === "desktop";
  const states = (await seed(url, "A2", "A5")).filter((s) => playable(s, layout));
  const state = (id) => states.find((s) => s.id === id) ?? (() => { throw new Error(`the seed has no state ${id}`); })();
  const close = async ({ ctx }) => { await ctx.close(); };
  /** One chip matches the selector, in the toolbar's row, where a click reaches it; answers what it says. */
  const one = async (page, name, sel) => {
    const all = page.locator(sel);
    if (await all.count() !== 1) return fail(`${name}: ${await all.count()} elements match ${sel}`);
    const at = await all.evaluate((e) => { const r = e.getBoundingClientRect(), h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { row: !!e.closest('[data-testid="composer-tools"], [data-testid="composer-chip-row"]') && !e.closest('[data-testid="more-pop"]'), hit: h === e || e.contains(h), text: e.textContent.replace(/[▾⌄]/g, "").trim() }; });
    if (!at.row) fail(`${name}: ${sel} is not in the toolbar's row`);
    if (!at.hit) fail(`${name}: ${sel} is not the element at its own centre`);
    return at.text;
  };
  /** A click on the chip opens its list, with options; Esc closes it. */
  const opens = async (page, name, sel) => {
    await press(page, page.locator(sel));
    if (!await until(() => byTid(page, "pick-row").count(), 5000)) return fail(`${name}: a click on ${sel} opened no list`);
    await page.keyboard.press("Escape");
    if (!await until(async () => !await byTid(page, "picker").count(), 5000)) fail(`${name}: Esc did not close the list of ${sel}`);
  };

  if (wide) { // a 1400 px window: all four, as before
    const p = await openState(open, state("plain-new"), layout, 0, { size: [1400, 800] }), name = "an unstarted chat in a 1400 px window";
    for (const [title, says] of [["Agent", "Claude Code"], ["Working directory", "shop"], ["Model", "Opus 5.5"], ["Effort", "EffortHigh"]]) {
      const text = await one(p.page, name, chipSel(title));
      if (text !== undefined && text !== says) fail(`${name}: ${chipSel(title)} says "${text}", not "${says}"`);
      if (title !== "Working directory") await opens(p.page, name, chipSel(title));
    }
    if (await p.page.locator(SERVER).count()) fail(`${name}: a chat on this computer names a server in its toolbar`);
    if (await p.page.locator(tidSel("more-chip")).count()) fail(`${name}: the toolbar has a "more" chip`);
    // the folder's chip opens its browser
    await press(p.page, p.page.locator(chipSel("Working directory")));
    if (!await until(() => byTid(p.page, "dir-input").count(), 5000)) fail(`${name}: a click on the folder's chip opened no browser`);
    await close(p);
  }
  if (wide) { // on another server, and with long names: the same selectors
    const p = await openState(open, state("plain-remote-new"), layout, 0, { size: [1400, 800] }), name = "an unstarted chat on another server in a 1400 px window";
    if (!(await one(p.page, name, `${SERVER}[data-fixed="true"]`) ?? "").startsWith("lab-gpu-box")) fail(`${name}: the server's chip does not name the server`);
    if (await p.page.locator(chipSel("Server")).count()) fail(`${name}: the server's chip is a choice`);
    await one(p.page, name, chipSel("Folder on"));
    await close(p);
    const q = await openState(open, state("plain-new-long"), layout, 0, { size: [1400, 800] }), long = "an unstarted chat with long names in a 1400 px window";
    for (const title of ["Agent", "Working directory", "Model", "Effort"]) await one(q.page, long, chipSel(title));
    if (await q.page.locator(SERVER).count()) fail(`${long}: a chat on this computer names a server in its toolbar`);
    // (the paid script looks the model's chip up by the label it shows)
    if (!await q.page.locator(chipSel("Model"), { hasText: "Claude Opus 5.5 (1M context, extended thinking)" }).count()) fail(`${long}: the model's chip is not found by its whole label`);
    await close(q);
  }
  if (wide) { // a started chat: the fixed chips, by their titles and by the model's label
    const p = await openState(open, state("plain-started"), layout, 0, { size: [1400, 800] }), name = "a started chat in a 1400 px window";
    for (const sel of [FIXED("Model and effort are fixed"), FIXED("Working directory")]) await one(p.page, name, sel);
    if (!await p.page.locator(`${tidSel("tchip")}[data-fixed="true"]`, { hasText: "Opus 5.5" }).first().isVisible()) fail(`${name}: no fixed chip shows the model's label`);
    for (const title of ["Agent", "Model", "Effort", "Server"]) if (await p.page.locator(chipSel(title)).count()) fail(`${name}: ${chipSel(title)} matches a chip`);
    await close(p);
  }

  // a 400 px panel (the desktop's; the device's own width on the others): Agent and Model, and the Agent chip opens its list
  {
    const id = "board-new", s = state(id), p = await openAt(open, s, layout, 400), name = `${id} in a ${wide ? "400 px panel" : `${layout}, a page of 400 px`}`;
    if (layoutNow(p.page) === "phone") { // the phone's chips: by their accessibility labels; a press opens the sheet with the rows, path or segments it has
      const label = (kind, start) => `${tidSel("tchip", { kind })}[aria-label^=${JSON.stringify(start)}]:not([data-fixed="true"])`;
      const says = { agent: await one(p.page, name, label("agent", "Agent")), model: await one(p.page, name, label("model", "Model and effort")) };
      if (says.agent !== "Claude Code") fail(`${name}: the agent's chip says "${says.agent}", not "Claude Code"`);
      if (!/^Opus 5\.5 · /.test(says.model ?? "")) fail(`${name}: the model's chip says "${says.model}", not "Opus 5.5 · <effort>"`);
      // (the row scrolls sideways: the chips past the window's edge are brought in first)
      for (const [kind, start] of [["folder", "Folder: "], ["subagents", "Subagents"]]) { await p.page.locator(label(kind, start)).scrollIntoViewIfNeeded(); await one(p.page, name, label(kind, start)); }
      if (await p.page.locator(tidSel("tchip", { kind: "effort" })).count() || await p.page.locator(tidSel("more-chip")).count()) fail(`${name}: the phone's row has an effort chip or a "more" chip`);
      const rows = ["picker-row", ["picker-row", "segment"], "dir-path", "sub-opt"];
      for (const [i, kind] of ["agent", "model", "folder", "subagents"].entries()) {
        await openChoice(p.page, kind);
        for (const part of [rows[i]].flat()) if (!await until(() => byTid(p.page, part).count(), 5000)) fail(`${name}: a press on the ${kind} chip opened a sheet with no ${part}`);
        await closeChoice(p.page);
      }
      await close(p);
    } else {
    if (await one(p.page, name, chipSel("Agent")) !== "Claude Code") fail(`${name}: the agent's chip does not say "Claude Code"`);
    // (changed since the old page: its row held Agent and Model at 400 px. The toolbar keeps voice's pair in the row longest, so here the row
    // holds the agent alone, and the model's chip, the same `tchip` with the same title, is in the "more" popup, which the script opens first;
    // the agent stays longest in the row (core's LEAVING), which is what the first line above proves)
    const model = chipSel("Model"), inRow = await p.page.locator(model).count();
    if (!inRow) {
      if (!await p.page.locator(tidSel("more-chip")).count()) fail(`${name}: the model's chip is neither in the toolbar's row nor behind a "more" chip`);
      else await press(p.page, p.page.locator(tidSel("more-chip")));
      if (!await until(() => byTid(p.page, "more-pop").count(), 5000)) fail(`${name}: the "more" chip did not open its popup`);
      const at = await p.page.locator(`${tidSel("more-pop")} ${model}`);
      if (await at.count() !== 1) fail(`${name}: the "more" popup holds ${await at.count()} chips that match ${model}`);
      else if ((await at.evaluate((e) => e.textContent.replace(/[▾⌄]/g, "").trim())) !== "Opus 5.5") fail(`${name}: the model's chip in the popup does not say "Opus 5.5"`);
    } else if (await one(p.page, name, model) !== "Opus 5.5") fail(`${name}: the model's chip does not say "Opus 5.5"`);
    if (!inRow) { await p.page.keyboard.press("Escape"); if (!await until(async () => !await byTid(p.page, "more-pop").count(), 5000)) fail(`${name}: Esc did not close the "more" popup`); }
    await opens(p.page, name, chipSel("Agent"));
    if (!inRow) await press(p.page, p.page.locator(tidSel("more-chip")));
    await opens(p.page, name, model);
    await close(p);
    }
  }
  note("the chip selectors: all five in a 1400 px window (the desktop), Agent and Model in a 400 px panel, each one chip of the row that opens its list (at the phone: the four chips of the row, each opening its sheet)");

  // ---- the meter's text
  /** In the page: the composer's meter, as a script reads it and as it is seen. */
  const meterIn = (page) => page.locator(`${tidSel("composer")} ${tidSel("ctx-meter")}`).evaluate((e) => {
    const t = e.querySelector('[data-testid="ctx-text"]'), r = t?.getBoundingClientRect();
    return { count: document.querySelectorAll('[data-testid="composer"] [data-testid="ctx-meter"]').length, inner: e.innerText, title: e.getAttribute("title") ?? "", label: e.getAttribute("aria-label") ?? "", w: Math.round(e.getBoundingClientRect().width * 10) / 10, compact: e.dataset.compact === "true", text: r ? `${Math.round(r.width)}x${Math.round(r.height)}` : "" };
  });
  // (changed since this was written: core's fit (e59ad9c) keeps voice's pair in the row longest and takes the meter's text after every control but
  // the agent, so a started chat, which has no agent chip, keeps the text while its folder and model go to the "more" popup. In a panel the text is
  // there from 460 down to 340 px (a busy chat's Stop takes 20 px more: down to 380) and the ring alone below that; a page of 300 px has the ring alone.)
  for (const [id, pane, width, ringOnly] of wide ? [["board-started", "panel", 460, false], ["board-started", "panel", 430, false], ["board-started", "panel", 400, false], ["board-started", "panel", 300, true], ["board-busy", "panel", 400, false], ["board-busy", "panel", 300, true], ["plain-started", "page", 300, true], ["plain-started-long", "page", 400, true]] : [["plain-started", "page", 300, true], ["plain-started-long", "page", 400, true]]) {
    const p = await openAt(open, state(id), layout, width), name = `${id} in a ${pane} of ${width} px`, m = await meterIn(p.page);
    if (m.count !== 1) fail(`${name}: ${m.count} elements match the composer's meter`);
    if (layoutNow(p.page) === "phone") { // (the phone's ring: a 44 pt target, its text drawn and not seen, its words its accessible name, no title)
      if (!/\d+(\.\d+)?%/.test(m.inner)) fail(`${name}: innerText of the meter is "${m.inner}": no share in percent`);
      if (Math.round(m.w) !== 44 || m.text !== "1x1") fail(`${name}: the phone's ring is ${m.w} px wide and its text ${m.text}, not a 44 pt target with no text seen`);
      if (m.title) fail(`${name}: the phone's ring has the hover title "${m.title}"`);
      if (!/^Context: [\d,]+ of [\d,]+ tokens/.test(m.label)) fail(`${name}: the phone's ring is named "${m.label}"`);
      await close(p);
      continue;
    }
    if (!/\d+(\.\d+)?%/.test(m.inner)) fail(`${name}: innerText of the meter is "${m.inner}": no share in percent`);
    if (m.compact !== ringOnly) fail(`${name}: the meter shows ${m.compact ? "its ring alone" : "its text"}; the check wants ${ringOnly ? "the ring alone" : "the text"} at this width`);
    if (ringOnly && (Math.abs(m.w - FIXTURE.ring) > 0.5 || m.text !== "1x1")) fail(`${name}: the meter is ${m.w} px wide and its text ${m.text}: more than the ring is seen`);
    if (ringOnly && !/^Context: [\d,]+ of [\d,]+ tokens/.test(m.title)) fail(`${name}: the ring's title is "${m.title}"`);
    await close(p);
  }
  for (const [width, iconOnly] of [[560, false], [300, true]]) {
    const p = await openAt(open, state("plain-ctxerr"), layout, width), name = `the error meter on a page of ${width} px`, m = await meterIn(p.page);
    if (m.count !== 1 || !m.inner.includes("Context unavailable") || /\d/.test(m.inner)) fail(`${name}: innerText of the meter is "${m.inner}"`);
    // (the reason is the hover title; the phone has none (ux-improvements 3.1.3): there it is the meter's accessible name)
    const reason = layoutNow(p.page) === "phone" ? m.label : m.title;
    if (reason !== "the agent did not report its context") fail(`${name}: the meter's ${layoutNow(p.page) === "phone" ? "accessible name" : "title"} is "${reason}", not the reason`);
    if (layoutNow(p.page) === "phone" && m.title) fail(`${name}: the phone's error meter has the hover title "${m.title}"`);
    if (m.compact !== (iconOnly || layoutNow(p.page) === "phone")) fail(`${name}: the meter shows ${m.compact ? "its icon alone" : "its text"}`);
    if (iconOnly && (Math.abs(m.w - FIXTURE.icon) > 0.5 || m.text !== "1x1")) fail(`${name}: the meter is ${m.w} px wide and its text ${m.text}: more than the icon is seen`);
    await close(p);
  }
  note("the meter: innerText has the share in percent with the ring alone, and \"Context unavailable\" with the icon alone");

  // ---- no other meter is cut: a subagent's, in its row in the thread (S7, B-US-12)
  {
    const s = state("sub"), q = await open({ sel: s.sel, wait: tidSel("sub-row") }), sub = "a subagent's meter";
    const others = () => q.page.evaluate(() => [...document.querySelectorAll('[data-testid="ctx-meter"]')].filter((e) => !e.closest('[data-testid="composer"]')).map((e) => ({
      text: e.textContent.trim(), cut: e.dataset.compact === "true", clipped: e.scrollWidth > e.clientWidth + 1, seen: e.getBoundingClientRect().width > 0 })));
    const subs = await others();
    if (layoutNow(q.page) === "phone") {
      // (the phone's subagent rows are the status mark, the task and how it went (goal 3.5); a subagent's context is a pill of its pushed screen: that is
      // where the phone's meter is read, with its text and not cut; goal 4.10)
      if (subs.length) fail(`${sub}: the phone's rows of the thread have ${subs.length} meters: the context is a pill of the subagent's screen`);
      await press(q.page, byTid(q.page, "sub-row").first(), { position: { x: 24, y: 10 } });
      if (!await until(() => byTid(q.page, "sub-drawer").count(), 8000)) fail(`${sub}: a press on a subagent's row opened no screen`);
      else {
        const pill = await q.page.evaluate(() => { const e = document.querySelector('[data-testid="sub-drawer"] [data-testid="ctx-meter"]'); return e ? { text: e.textContent.trim(), cut: e.dataset.compact === "true", clipped: e.scrollWidth > e.clientWidth + 1, seen: e.getBoundingClientRect().width > 0 } : null; });
        if (!pill) fail(`${sub}: the subagent's screen has no context pill`);
        else if (pill.cut || pill.clipped || !pill.seen || !/\d+%/.test(pill.text)) fail(`${sub}: the pill on the subagent's screen is not as it was: ${JSON.stringify(pill)}`);
        else note(`a subagent's context pill on the phone's pushed screen: "${pill.text}", with its text, not cut`);
        await back(q.page);
      }
    } else {
      if (!subs.length) fail(`${sub}: none on the page of a thread with a subagent`);
      for (const m of subs) if (m.cut || m.clipped || !m.seen || !/\d+%/.test(m.text)) fail(`${sub}: it is not as it was: ${JSON.stringify(m)}`);
      note(`${subs.length} meters of a subagent: with their text, none cut`);
    }
    await close(q);
  }
  void frame;
}, { viewports, page: false });

