// A2.5 ported (AD-80; package K3): what the e2e scripts address is where they address it. In a 1400 px window each of the four chip
// selectors (the agent's, the model's, the effort's and the folder's chip, by their testID `tchip` and the start of their title) matches one
// chip of the toolbar's row, which says what it said and opens its list; so do the fixed chips of a started chat. A chat's server is no choice:
// one on another server names it in the fixed chip of kind `server`, and one on this computer has no such chip. In a board's 400 px panel Agent
// and Model do, and the Agent chip opens its list there. innerText of the meter (`ctx-meter`) gives the share in percent while only the ring
// shows, and "Context unavailable", with no number and the reason as its title, while only the icon shows. The composer's meter alone is cut so.
// Ports dev/checks/A2.5-selectors.mjs with its states and assertions. The 1400 px window and the panel's widths are the desktop's; at the tablet and
// the phone the same chips are looked for at the device's own width (a 400 px page: Agent and Model in the row, each a chip that opens its list, a
// sheet there). The meter's parts read the composer's real
// meter (S9's `ContextMeter` in the toolbar: its testIDs, the text, the compact state, the title); the last block reads the meters outside the
// composer, a subagent's in its row of the thread (S7: S9's `SubMeter`), which stay uncut.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { check, seed, until } from "../shot.mjs";
import { frame, openAt, openState, playable } from "./composer.mjs";
import { byTid, press, tidSel } from "./sel.mjs";

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
    const at = await all.evaluate((e) => { const r = e.getBoundingClientRect(), h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { row: !!e.closest('[data-testid="composer-tools"]') && !e.closest('[data-testid="more-pop"]'), hit: h === e || e.contains(h), text: e.textContent.replace(/▾/g, "").trim() }; });
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
    if (await one(p.page, name, chipSel("Agent")) !== "Claude Code") fail(`${name}: the agent's chip does not say "Claude Code"`);
    if (await one(p.page, name, chipSel("Model")) !== "Opus 5.5") fail(`${name}: the model's chip does not say "Opus 5.5"`);
    await opens(p.page, name, chipSel("Agent"));
    await opens(p.page, name, chipSel("Model"));
    await close(p);
  }
  note("the chip selectors: all five in a 1400 px window (the desktop), Agent and Model in a 400 px panel, each one chip of the row that opens its list");

  // ---- the meter's text
  /** In the page: the composer's meter, as a script reads it and as it is seen. */
  const meterIn = (page) => page.locator(`${tidSel("composer")} ${tidSel("ctx-meter")}`).evaluate((e) => {
    const t = e.querySelector('[data-testid="ctx-text"]'), r = t?.getBoundingClientRect();
    return { count: document.querySelectorAll('[data-testid="composer"] [data-testid="ctx-meter"]').length, inner: e.innerText, title: e.getAttribute("title") ?? "", w: Math.round(e.getBoundingClientRect().width * 10) / 10, compact: e.dataset.compact === "true", text: r ? `${Math.round(r.width)}x${Math.round(r.height)}` : "" };
  });
  // (beside a board a started chat's row, whole, has room for the meter's text from a panel of 415 px on; but voice's pair, wider than the 16 px
  // that are left at 430, goes into the "more" popup and brings the chip, which needs 32 px, so the text gives its room to the chip: the text is
  // back from a panel of 460 px, where the chip fits beside it. In the default panel, of 400 px, the row has no room for the text anyway.)
  for (const [id, pane, width, ringOnly] of wide ? [["board-started", "panel", 460, false], ["board-started", "panel", 430, true], ["board-started", "panel", 400, true], ["board-started", "panel", 300, true], ["board-busy", "panel", 400, true], ["plain-started", "page", 300, true], ["plain-started-long", "page", 400, true]] : [["plain-started", "page", 300, true], ["plain-started-long", "page", 400, true]]) {
    const p = await openAt(open, state(id), layout, width), name = `${id} in a ${pane} of ${width} px`, m = await meterIn(p.page);
    if (m.count !== 1) fail(`${name}: ${m.count} elements match the composer's meter`);
    if (!/\d+(\.\d+)?%/.test(m.inner)) fail(`${name}: innerText of the meter is "${m.inner}": no share in percent`);
    if (m.compact !== ringOnly) fail(`${name}: the meter shows ${m.compact ? "its ring alone" : "its text"}; the check wants ${ringOnly ? "the ring alone" : "the text"} at this width`);
    if (ringOnly && (Math.abs(m.w - FIXTURE.ring) > 0.5 || m.text !== "1x1")) fail(`${name}: the meter is ${m.w} px wide and its text ${m.text}: more than the ring is seen`);
    if (ringOnly && !/^Context: [\d,]+ of [\d,]+ tokens/.test(m.title)) fail(`${name}: the ring's title is "${m.title}"`);
    await close(p);
  }
  for (const [width, iconOnly] of [[560, false], [300, true]]) {
    const p = await openAt(open, state("plain-ctxerr"), layout, width), name = `the error meter on a page of ${width} px`, m = await meterIn(p.page);
    if (m.count !== 1 || !m.inner.includes("Context unavailable") || /\d/.test(m.inner)) fail(`${name}: innerText of the meter is "${m.inner}"`);
    if (m.title !== "the agent did not report its context") fail(`${name}: the meter's title is "${m.title}", not the reason`);
    if (m.compact !== iconOnly) fail(`${name}: the meter shows ${m.compact ? "its icon alone" : "its text"}`);
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
    if (!subs.length) fail(`${sub}: none on the page of a thread with a subagent`);
    for (const m of subs) if (m.cut || m.clipped || !m.seen || !/\d+%/.test(m.text)) fail(`${sub}: it is not as it was: ${JSON.stringify(m)}`);
    await close(q);
    note(`${subs.length} meters of a subagent: with their text, none cut`);
  }
  void frame;
}, { viewports, page: false });

