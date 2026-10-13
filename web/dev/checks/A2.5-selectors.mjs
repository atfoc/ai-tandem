// Proves A2.5: what the e2e scripts address is where they address it. In a 1400 px window each of the four chip
// selectors (.composer button.tchip[title^="Agent"], and Model, Effort and the folder) matches one chip of
// the toolbar's row, which says what it said and opens its list; so do the fixed chips of a started chat. A chat's
// server is no choice: one on another server names it in the fixed chip .composer .tchip.static.server-chip, and one
// on this computer has no such chip. In a board's
// and a run's 400 px panel Agent and Model do, and the Agent chip opens its list there. innerText of
// .composer .ctx-meter gives the share in percent while only the ring shows, and "Context unavailable", with no
// number and the reason as its title, while only the icon shows. The composer's meter alone is cut so: the run
// head's meters and a subagent's are as they were (the check seeds A5 too, for a thread with a subagent).
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { act, check, openPage, paneSize, seed, until } from "../shot.mjs";

const FIXTURE = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../test/fixtures/composer-widths.json", import.meta.url)), "utf8"));
const ROW = ".composer .composer-tools";
const chip = (title) => `.composer button.tchip[title^="${title}"]`;
const SERVER = '.composer .tchip[title^="Server"]'; // the chip that names a chat's server, which is never a button

await check("A2.5 the scripts' chip selectors and the meter's text", async ({ url, browser, fail, note }) => {
  const states = await seed(url, "A2", "A5");
  const state = (id) => states.find((s) => s.id === id) ?? (() => { throw new Error(`the seed has no state ${id}`); })();
  const open = async (s, o) => {
    const errors = [];
    const { ctx, page } = await openPage({ url, browser, errors, sel: s.sel, wait: s.pane?.[0] === "stage" ? ".run-composer .composer-box" : ".composer-box .send", ...o });
    await act(page, s.act);
    await page.evaluate(() => document.fonts.ready);
    return { ctx, page, errors };
  };
  const close = async ({ ctx, errors }, name) => { for (const e of errors) fail(`${name}: page error: ${e}`); await ctx.close(); };
  /** One chip matches the selector, in the toolbar's row, where a click reaches it; answers what it says. */
  const one = async (page, name, sel) => {
    const all = page.locator(sel);
    if (await all.count() !== 1) return fail(`${name}: ${await all.count()} elements match ${sel}`);
    const at = await all.evaluate((e) => { const r = e.getBoundingClientRect(), h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { row: !!e.closest(".composer-tools") && !e.closest(".more-pop"), hit: h === e || e.contains(h), text: e.textContent.replace(/▾/g, "").trim() }; });
    if (!at.row) fail(`${name}: ${sel} is not in the toolbar's row`);
    if (!at.hit) fail(`${name}: ${sel} is not the element at its own centre`);
    return at.text;
  };
  /** A click on the chip opens its list, with options; Esc closes it. */
  const opens = async (page, name, sel) => {
    await page.locator(sel).click();
    if (!await until(() => page.locator(`.composer .menu.up [role="option"]`).count(), 5000)) return fail(`${name}: a click on ${sel} opened no list`);
    await page.keyboard.press("Escape");
    if (!await until(async () => !await page.locator(".composer .menu.up").count(), 5000)) fail(`${name}: Esc did not close the list of ${sel}`);
  };

  { // a 1400 px window: all four, as before
    const p = await open(state("plain-new"), { size: [1400, 800] }), name = "an unstarted chat in a 1400 px window";
    for (const [title, says] of [["Agent", "Claude Code"], ["Working directory", "shop"], ["Model", "Opus 5.5"], ["Effort", "EffortHigh"]]) {
      const text = await one(p.page, name, chip(title));
      if (text !== undefined && text !== says) fail(`${name}: ${chip(title)} says "${text}", not "${says}"`);
      if (title !== "Working directory") await opens(p.page, name, chip(title));
    }
    if (await p.page.locator(`${SERVER}, .composer .server-pick`).count()) fail(`${name}: a chat on this computer names a server in its toolbar`);
    if (await p.page.locator(".composer .more-chip").count()) fail(`${name}: the toolbar has a "more" chip`);
    // the folder's chip opens its browser
    await p.page.locator(chip("Working directory")).click();
    if (!await until(() => p.page.locator(".composer .menu.up.dirs .dir-input").count(), 5000)) fail(`${name}: a click on the folder's chip opened no browser`);
    await close(p, name);
  }
  { // on another server, and with long names: the same selectors
    const p = await open(state("plain-remote-new"), { size: [1400, 800] }), name = "an unstarted chat on another server in a 1400 px window";
    if (!(await one(p.page, name, `${SERVER}.static.server-chip`) ?? "").startsWith("lab-gpu-box")) fail(`${name}: the server's chip does not name the server`);
    if (await p.page.locator(chip("Server")).count() || await p.page.locator(".composer .server-pick").count()) fail(`${name}: the server's chip is a choice`);
    await one(p.page, name, chip("Folder on"));
    await close(p, name);
    const q = await open(state("plain-new-long"), { size: [1400, 800] }), long = "an unstarted chat with long names in a 1400 px window";
    for (const title of ["Agent", "Working directory", "Model", "Effort"]) await one(q.page, long, chip(title));
    if (await q.page.locator(SERVER).count()) fail(`${long}: a chat on this computer names a server in its toolbar`);
    // (the paid script looks the model's chip up by the label it shows)
    if (!await q.page.locator(chip("Model"), { hasText: "Claude Opus 5.5 (1M context, extended thinking)" }).count()) fail(`${long}: the model's chip is not found by its whole label`);
    await close(q, long);
  }
  { // a started chat: the fixed chips, by their titles and by the model's label
    const p = await open(state("plain-started"), { size: [1400, 800] }), name = "a started chat in a 1400 px window";
    for (const sel of ['.composer .tchip.static[title^="Model and effort are fixed"]', '.composer .tchip.static[title^="Working directory"]']) await one(p.page, name, sel);
    if (!await p.page.locator(".composer .tchip.static", { hasText: "Opus 5.5" }).first().isVisible()) fail(`${name}: no fixed chip shows the model's label`);
    for (const title of ["Agent", "Model", "Effort", "Server"]) if (await p.page.locator(chip(title)).count()) fail(`${name}: ${chip(title)} matches a chip`);
    await close(p, name);
  }

  // a 400 px panel: Agent and Model, and the Agent chip opens its list
  for (const id of ["board-new", "run-new"]) {
    const s = state(id), p = await open(s, paneSize("panel", 400)), name = `${id} in a 400 px panel`;
    if (await one(p.page, name, chip("Agent")) !== "Claude Code") fail(`${name}: the agent's chip does not say "Claude Code"`);
    if (await one(p.page, name, chip("Model")) !== "Opus 5.5") fail(`${name}: the model's chip does not say "Opus 5.5"`);
    await opens(p.page, name, chip("Agent"));
    await opens(p.page, name, chip("Model"));
    await close(p, name);
  }
  note("the chip selectors: all five in a 1400 px window, Agent and Model in a 400 px panel, each one chip of the row that opens its list");

  // ---- the meter's text
  /** In the page: the composer's meter, as a script reads it and as it is seen. */
  const meterIn = (page) => page.locator(".composer .ctx-meter").evaluate((e) => {
    const t = e.querySelector(".ctx-text"), r = t?.getBoundingClientRect();
    return { count: document.querySelectorAll(".composer .ctx-meter").length, inner: e.innerText, title: e.getAttribute("title") ?? "", w: Math.round(e.getBoundingClientRect().width * 10) / 10, compact: e.classList.contains("compact"), text: r ? `${Math.round(r.width)}x${Math.round(r.height)}` : "" };
  });
  // (beside a board a started chat's row has room for the meter's text from a panel of 430 px on: in the default one,
  // of 400 px, the attach button takes the 30 px the text would need, and the meter is its ring)
  for (const [id, pane, width, ringOnly] of [["board-started", "panel", 430, false], ["board-started", "panel", 400, true], ["board-started", "panel", 300, true], ["run-busy", "panel", 400, true], ["plain-started", "page", 300, true], ["plain-started-long", "page", 400, true]]) {
    const p = await open(state(id), paneSize(pane, width)), name = `${id} in a ${pane} of ${width} px`, m = await meterIn(p.page);
    if (m.count !== 1) fail(`${name}: ${m.count} elements match .composer .ctx-meter`);
    if (!/\d+(\.\d+)?%/.test(m.inner)) fail(`${name}: innerText of the meter is "${m.inner}": no share in percent`);
    if (m.compact !== ringOnly) fail(`${name}: the meter shows ${m.compact ? "its ring alone" : "its text"}; the check wants ${ringOnly ? "the ring alone" : "the text"} at this width`);
    if (ringOnly && (Math.abs(m.w - FIXTURE.ring) > 0.5 || m.text !== "1x1")) fail(`${name}: the meter is ${m.w} px wide and its text ${m.text}: more than the ring is seen`);
    if (ringOnly && !/^Context: [\d,]+ of [\d,]+ tokens/.test(m.title)) fail(`${name}: the ring's title is "${m.title}"`);
    await close(p, name);
  }
  for (const [width, iconOnly] of [[560, false], [300, true]]) {
    const p = await open(state("plain-ctxerr"), paneSize("page", width)), name = `the error meter on a page of ${width} px`, m = await meterIn(p.page);
    if (m.count !== 1 || !m.inner.includes("Context unavailable") || /\d/.test(m.inner)) fail(`${name}: innerText of the meter is "${m.inner}"`);
    if (m.title !== "the agent did not report its context") fail(`${name}: the meter's title is "${m.title}", not the reason`);
    if (m.compact !== iconOnly) fail(`${name}: the meter shows ${m.compact ? "its icon alone" : "its text"}`);
    if (iconOnly && (Math.abs(m.w - FIXTURE.icon) > 0.5 || m.text !== "1x1")) fail(`${name}: the meter is ${m.w} px wide and its text ${m.text}: more than the icon is seen`);
    await close(p, name);
  }
  note("the meter: innerText has the share in percent with the ring alone, and \"Context unavailable\" with the icon alone");

  // ---- no other meter is cut
  /** In the page: every meter that is not the composer's. */
  const others = (page) => page.evaluate(() => [...document.querySelectorAll(".ctx-meter")].filter((e) => !e.closest(".composer")).map((e) => ({ cls: e.className, text: e.textContent.trim(), cut: e.classList.contains("compact") || !!e.querySelector(".ctx-text"), position: getComputedStyle(e).position, clipped: e.scrollWidth > e.clientWidth + 1, seen: e.getBoundingClientRect().width > 0 })));
  {
    const p = await open({ sel: { run: "r_live" } }, { wait: ".run-meter" }), name = "the run head's meters";
    const all = (await others(p.page)).filter((m) => m.cls.includes("run-meter"));
    if (all.length < 3) fail(`${name}: ${all.length} of them on the run's page`);
    for (const m of all) if (m.cut || m.position !== "static" || m.clipped || !m.seen || !m.text) fail(`${name}: one is not as it was: ${JSON.stringify(m)}`);
    await close(p, name);
    const q = await open(state("sub"), {}), sub = "a subagent's meter";
    const subs = (await others(q.page)).filter((m) => m.cls.includes("sub-meter"));
    if (!subs.length) fail(`${sub}: none on the page of a thread with a subagent`);
    for (const m of subs) if (m.cut || m.clipped || !m.seen || !/\d+%/.test(m.text)) fail(`${sub}: it is not as it was: ${JSON.stringify(m)}`);
    await close(q, sub);
    note(`${all.length} meters of the run's head and ${subs.length} of a subagent: with their text, none cut`);
  }
});
