// Proves, on the build that has all six goals, what goals 1 and 6 say together: hiding the sidebar while the
// theme's menu is open, beside what the other goals put on the page. A6.1 hides it on Home; here the page has an
// unstarted chat's composer at 300 px, a pending move with a typed draft, open tool cards, or a branch send on its
// way, and the page is in a flavour.
// Hidden by ⌘B and by the head's control, with the menu open and the focus on one of its items: the menu is gone
// from the page and the picker's button is not drawn; the focus is on the rail's control, and stays there; the page
// is in the theme it was in, with the same saved choice, also when the keys had moved to another item (hiding picks
// nothing); the page saved nothing; Esc, which the menu would have taken, does nothing. Shown again, by the rail's
// control and by ⌘B: the focus is on the head's control, the menu is not open, the button says so and names the
// theme, and its menu opens as before, the choice marked and focused.
// In every frame on the way the menu is not in a page whose sidebar is hidden, the page is in its flavour, and the
// composer fits its box (the driver's frame sampler, after the frame's paint).
// What was on the page is as it was: the draft and the banner of the move, the cards open, the message on its way
// with its line, which then ends as it would have. The same in a window so low that the menu scrolls (by ⌘B: there
// the open menu lies over the head's control). A pick by the keys and ⌘B at once: the page is hidden in the theme
// picked, the rail on its ground, also after a reload.
import { check, colourOf, composerProbe, holds, mockEval, openCards, openPage, paneSize, release, sampleFrames, seed, startMove, toolCards, until, waitsSeen } from "../shot.mjs";

const BTN = ".side-foot .theme-btn", MENU = '.side-foot [role="menu"][aria-label="Theme"]';
const HOW = { key: "⌘B", control: "the head's control", rail: "the rail's control" };
// the flavour the pages are in, and the one picked by the keys; Mantle of @catppuccin/palette 1.8.0
const FRAPPE = { pref: "frappe", theme: "dark", mantle: "#292c3c", title: "Theme: Catppuccin Frappé" };
const MOCHA = { pref: "mocha", theme: "dark", mantle: "#181825", title: "Theme: Catppuccin Mocha" };
const SEND = "c_A4_turns", SIDE = 264, RAIL = 40;
const hex = (c) => (c ? "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("") : "none");

/** In the page: the sidebar, the picker and the focus as they are now. */
function seen() {
  const d = document.documentElement.dataset, btn = document.querySelector(".side-foot .theme-btn"), a = document.activeElement;
  const rail = document.querySelector(".app > .side-rail"), pane = document.querySelector(".app > .side-pane");
  return {
    hidden: !!rail && !pane?.getClientRects().length, menus: document.querySelectorAll('[role="menu"][aria-label="Theme"]').length,
    btn: !!btn?.getClientRects().length, expanded: btn?.getAttribute("aria-expanded") ?? null, title: btn?.title ?? null,
    marked: [...document.querySelectorAll('[role="menu"][aria-label="Theme"] [aria-checked="true"]')].map((e) => e.dataset.themePref).join(),
    theme: d.theme ?? null, flavour: d.flavour ?? null, saved: localStorage.getItem("aiwb.theme"), side: localStorage.getItem("aiwb.side"),
    focus: !a || a === document.body ? "nothing" : a.matches(".side-rail .side-show") ? "rail" : a.matches(".side-head .side-hide") ? "head" : a.matches(".side-foot .theme-btn") ? "button"
      : a.matches('[role="menuitemradio"]') ? "item " + a.dataset.themePref : a.matches(".composer-input") ? "composer" : a.tagName.toLowerCase() + "." + String(a.className).trim().split(/\s+/).join("."),
  };
}

// For sampleFrames (sent as text): null until React has drawn the window; then whether the sidebar is hidden, whether
// the theme's menu is in the page, the frame's theme, and the composer's fit by the driver's probe (null with no
// composer). bad: the menu in a page whose sidebar is hidden, or a composer that does not fit.
const probe = { toString: () => `() => {
  const app = document.querySelector(".app");
  if (!app) return null;
  const fit = (${composerProbe})(), d = document.documentElement.dataset;
  const hidden = !!app.querySelector(":scope > .side-rail"), menu = !!document.querySelector('[role="menu"][aria-label="Theme"]');
  return { bad: (hidden && menu) || !!fit?.bad, hidden, menu, theme: d.theme ?? null, flavour: d.flavour ?? null, fit };
}` };

await check("P7.2 the sidebar hidden while the theme's menu is open, beside the other goals' controls", async ({ url, browser, fail, note }) => {
  const states = await seed(url, "A2", "A4", "A5");
  const state = (id) => states.find((s) => s.id === id) ?? (() => { throw new Error(`the seed has no state ${id}`); })();
  const read = (page) => page.evaluate(seen);
  const frames = (page) => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok()))));
  /** Every timer the page had set for the next moments has fired (the focus moves in one): a timer set now, with a
   *  later end, fires after them. */
  const timers = (page) => page.evaluate(() => new Promise((ok) => setTimeout(ok, 60)));
  // (a menu hears a press outside from the task after it was drawn: the check waits for that task, as a hand does)
  const openMenu = async (page) => { await page.locator(BTN).click(); await page.waitForSelector(MENU, { timeout: 10000 }); await page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(ok))))); };
  /** Every call the page makes that is not a read, as the page makes it. */
  const spy = (page) => page.evaluate(() => { window.__calls = []; const f = window.fetch; window.fetch = (u, o) => { if (o?.method && o.method !== "GET") window.__calls.push(`${o.method} ${u} ${o.body ?? ""}`); return f(u, o); }; });
  const calls = (page) => page.evaluate(() => window.__calls.splice(0));
  const open = async (o, body) => {
    const errors = [];
    const { ctx, page } = await openPage({ url, browser, errors, ...o, ls: { "aiwb.theme": FRAPPE.pref, ...o.ls } });
    try { await body(page); } catch (e) { fail(`${o.name}: ${e.message.split("\n")[0]}`); }
    finally { for (const e of errors) fail(`${o.name}: page error: ${e}`); await ctx.close(); }
  };
  const focusIs = async (page, name, want) => { if (!await until(async () => (await read(page)).focus === want, 10000)) fail(`${name}: the focus is on ${(await read(page)).focus}, not on ${want === "rail" ? "the rail's control" : want === "head" ? "the head's control" : want}`); };
  const press = (page, how) => (how === "key" ? page.keyboard.press("ControlOrMeta+b") : page.locator(how === "rail" ? ".side-rail .side-show" : ".side-head .side-hide").click());

  /** The round: the menu opened, the sidebar hidden by `how` and shown again by `back`. T: the theme the page is in.
   *  keys: pressed in the open menu before the sidebar is hidden. Answers the frames sampled on the way. */
  const round = async (page, name, how, back, { T = FRAPPE, keys = [], saves = false } = {}) => {
    const tag = `${name}, hidden by ${HOW[how]}`, say = (line) => fail(`${tag}: ${line}`);
    const inTheme = (s, when) => { if (s.theme !== T.theme || s.flavour !== T.pref || s.saved !== T.pref) say(`${when} the page has data-theme "${s.theme}", data-flavour ${JSON.stringify(s.flavour)} and the saved choice ${JSON.stringify(s.saved)}, not ${T.pref}`); };
    await openMenu(page);
    for (const k of keys) await page.keyboard.press(k);
    const was = await read(page);
    if (was.hidden || was.menus !== 1 || was.expanded !== "true" || was.marked !== T.pref) return say(`before it the page has ${was.menus} theme menus, which mark "${was.marked}", and the button says aria-expanded="${was.expanded}"`);
    if (!was.focus.startsWith("item ") || (keys.length > 0) === (was.focus === "item " + T.pref)) say(`before it the focus is on ${was.focus}${keys.length ? ": the keys did not leave the choice" : ", not on the choice"}`);
    if (!saves) await spy(page);
    const sampler = await sampleFrames(page, probe);

    await press(page, how);
    if (!await until(async () => (await read(page)).hidden, 10000)) { await sampler.stop(); return say("the sidebar is not hidden"); }
    const h = await read(page);
    if (h.menus) say("the theme's menu is still in the page");
    if (h.btn) say("the picker's button is still drawn");
    if (h.side !== "hidden") say(`localStorage "aiwb.side" is ${JSON.stringify(h.side)}`);
    inTheme(h, "hidden,");
    const ground = hex(await colourOf(page, ".side-rail", "backgroundColor"));
    if (ground !== T.mantle) say(`the rail is on ${ground}, not on Mantle ${T.mantle}`);
    await focusIs(page, tag, "rail");
    await timers(page); await frames(page);
    await focusIs(page, tag + ", a moment later", "rail");
    // Esc: the menu that would have taken it is gone, and nothing else does
    await page.keyboard.press("Escape");
    await timers(page); await frames(page);
    const esc = await read(page);
    if (!esc.hidden || esc.menus || esc.focus !== "rail") say(`after Esc the sidebar is ${esc.hidden ? "hidden" : "shown"}, the page has ${esc.menus} theme menus and the focus is on ${esc.focus}`);
    inTheme(esc, "after Esc");

    await press(page, back);
    if (!await until(async () => { const s = await read(page); return !s.hidden && s.btn; }, 10000)) { await sampler.stop(); return say(`${HOW[back]} did not show the sidebar again`); }
    await focusIs(page, `${tag}, shown again by ${HOW[back]}`, "head");
    await timers(page); await frames(page);
    const s = await read(page);
    if (s.menus || s.expanded !== "false") say(`shown again, the page has ${s.menus} theme menus and the button says aria-expanded="${s.expanded}"`);
    if (s.title !== T.title) say(`shown again, the button says "${s.title}", not "${T.title}"`);
    if (s.side !== "shown") say(`shown again, localStorage "aiwb.side" is ${JSON.stringify(s.side)}`);
    inTheme(s, "shown again,");

    const r = await sampler.stop();
    if (r.bad.length) say(`${r.bad.length} of ${r.values.length} frames had the menu in a page whose sidebar is hidden, or a composer that does not fit; the first: ${JSON.stringify(r.bad[0])}`);
    const other = r.values.filter((v) => v.theme !== T.theme || v.flavour !== T.pref);
    if (other.length) say(`${other.length} of ${r.values.length} frames were in another theme, the first in data-theme "${other[0].theme}" and data-flavour ${JSON.stringify(other[0].flavour)}`);
    if (!r.values.some((v) => v.hidden) || !r.values.some((v) => !v.hidden)) say(`the sampler read ${r.values.length} frames, ${r.values.filter((v) => v.hidden).length} of them with the sidebar hidden: not the way there and back`);
    if (!saves) { const made = await calls(page); if (made.length) say(`the page saved something: ${made.join("; ")}`); }

    // the menu opens as before
    await openMenu(page);
    const again = await read(page);
    if (again.menus !== 1 || again.marked !== T.pref || again.focus !== "item " + T.pref) say(`opened again, the page has ${again.menus} theme menus, which mark "${again.marked}", and the focus is on ${again.focus}`);
    await page.keyboard.press("Escape");
    if (!await until(async () => !(await read(page)).menus, 10000)) say("opened again, Esc did not close the menu");
    return r;
  };
  const boxes = (r) => { const w = r?.values.filter((v) => v.fit).map((v) => v.fit.box) ?? []; return w.length ? `${Math.min(...w)} to ${Math.max(...w)} px` : "none"; };

  // ---- an unstarted chat's composer at 300 px: every way there and back, and the keys on another item
  {
    const s = state("plain-new"), told = [];
    await open({ name: "an unstarted chat at 300 px", sel: s.sel, ...paneSize("page", 300), wait: ".composer-box .send" }, async (page) => {
      await page.evaluate(() => document.fonts.ready);
      for (const [how, back, keys] of [["key", "rail", []], ["control", "key", []], ["key", "key", ["ArrowDown", "ArrowDown"]], ["control", "rail", ["Home"]]]) {
        const r = await round(page, `an unstarted chat at 300 px${keys.length ? `, the keys on another item (${keys.join(", ")})` : ""}`, how, back, { keys });
        const w = r?.values.filter((v) => v.fit).map((v) => v.fit.box) ?? [];
        // (the page gets the sidebar's width less the rail's, and gives it back)
        if (r && (Math.min(...w) !== 260 || Math.max(...w) !== 260 + SIDE - RAIL)) fail(`an unstarted chat at 300 px, hidden by ${HOW[how]}: the composer's box went from ${boxes(r)}, not from 260 to ${260 + SIDE - RAIL}`);
        told.push(`${HOW[how]} and ${HOW[back]} ${r?.values.length ?? 0}`);
      }
    });
    note(`an unstarted chat at 300 px, the menu open: hidden and shown by ${told.join("; ")} frames, none with the menu beside a rail, each in Frappé with the composer fitted; nothing saved`);
  }

  // ---- a pending move with a typed draft: both are as they were
  {
    const s = state("plain-move"), name = "a pending move with a draft", text = "Half a thought";
    await open({ name, sel: s.sel, ...paneSize("page", 300), wait: ".composer-box .send" }, async (page) => {
      await startMove(page);
      await page.locator(".composer .composer-input").click();
      await page.keyboard.type(text);
      const before = await waitsSeen(page);
      const r = await round(page, name, "control", "key", { saves: true }); // (the draft is saved as it is typed)
      const after = await waitsSeen(page);
      if (after.box !== text || after.banner !== before.banner || !after.banner) fail(`${name}: after the round the box holds "${after.box}" and the banner says "${after.banner}"; before, "${before.box}" and "${before.banner}"`);
      note(`${name}: the box and the banner as they were; ${r?.values.length ?? 0} frames, the composer's box ${boxes(r)}`);
    });
  }

  // ---- open tool cards: they stay open
  {
    const s = state("claude"), name = "a thread with its tool cards open";
    await open({ name, sel: s.sel, ...paneSize("page", 300, 900), wait: s.see }, async (page) => {
      await openCards(page);
      const before = (await toolCards(page)).filter((c) => c.open).length, top = await page.evaluate(() => document.querySelector(".thread").scrollTop);
      await round(page, name, "key", "rail");
      const cards = await toolCards(page), after = cards.filter((c) => c.open).length;
      if (!before || after !== before || cards.length !== before) fail(`${name}: ${after} of ${cards.length} cards are open after the round, ${before} before`);
      note(`${name}: all ${after} still open (the thread scrolled to ${top} px before, ${await page.evaluate(() => document.querySelector(".thread").scrollTop)} after)`);
    });
  }

  // ---- a branch send on its way: the wait is on the page through the round, and ends when the call does
  {
    const name = "a branch send on its way", said = "Try it another way";
    await mockEval(`flags.send = { chat: "${SEND}", hold: true, noReply: true };`, url);
    try {
      await open({ name, sel: { chat: SEND }, ...paneSize("page", 300), wait: ".thread .msg.assistant" }, async (page) => {
        await startMove(page);
        await page.locator(".composer .composer-input").click();
        await page.keyboard.type(said);
        await page.keyboard.press("Enter");
        if (!await until(() => holds(url, "send"))) fail(`${name}: the page's call did not reach the mock`);
        const wait = (w) => ({ msgs: w.msgs.map((m) => `${m.text}${m.sending ? " (sending)" : ""}`), lines: w.lines, banner: w.banner, send: w.send });
        let before;
        if (!await until(async () => { before = wait(await waitsSeen(page)); return before.send?.spin && before.lines.length === 1; })) fail(`${name}: the page does not show the wait: ${JSON.stringify(before)}`);
        const r = await round(page, name, "key", "key", { saves: true });
        const after = wait(await waitsSeen(page));
        if (JSON.stringify(after) !== JSON.stringify(before)) fail(`${name}: after the round the page shows ${JSON.stringify(after)}; before, ${JSON.stringify(before)}`);
        if (await holds(url, "send") !== 1) fail(`${name}: the mock holds ${await holds(url, "send")} sends after the round, not the one`);
        await release(url, "send");
        let ended;
        if (!await until(async () => { ended = await waitsSeen(page); return !ended.banner && ended.msgs.every((m) => m.live) && ended.msgs.at(-1)?.text === said; })) fail(`${name}: let go, the send did not end with the message in the new branch's thread: ${JSON.stringify(ended)}`);
        note(`${name}: the message, its line, the banner and Send's spinner as they were through the round (${r?.values.length ?? 0} frames, the composer's box ${boxes(r)}); let go, it ended`);
      });
    } finally { await mockEval("delete flags.send;", url); }
  }

  // ---- a window so low that the menu scrolls
  await open({ name: "a low window", sel: {}, size: [800, 240] }, async (page) => {
    await openMenu(page);
    const m = await page.evaluate((sel) => { const e = document.querySelector(sel); return { height: e.scrollHeight, client: e.clientHeight }; }, MENU);
    if (m.height <= m.client) fail(`a low window: the menu's ${m.height} px are all in sight: the check has no window too low for it`);
    await page.locator(`${MENU} [data-theme-pref="mocha"]`).scrollIntoViewIfNeeded();
    await page.keyboard.press("Escape");
    // (by the key alone: in a window this low the open menu lies over the sidebar's head, and its control with it)
    await round(page, "a low window, the menu scrolling", "key", "rail");
    await round(page, "a low window, the menu scrolled to its end", "key", "key", { keys: ["End"] });
    note(`a low window: the menu of ${m.height} px scrolled in ${m.client} and went with the sidebar`);
  });

  // ---- a pick by the keys, and ⌘B at once: hidden in the theme picked, also after a reload
  await open({ name: "a pick, then ⌘B", sel: state("plain-new").sel, ...paneSize("page", 300), wait: ".composer-box .send" }, async (page) => {
    const name = "a pick by the keys, then ⌘B";
    await openMenu(page);
    await page.keyboard.press("End"); await page.keyboard.press("Enter"); await page.keyboard.press("ControlOrMeta+b");
    if (!await until(async () => (await read(page)).hidden, 10000)) return fail(`${name}: the sidebar is not hidden`);
    await focusIs(page, name, "rail");
    const inMocha = async (when) => {
      const s = await read(page), ground = hex(await colourOf(page, ".side-rail", "backgroundColor"));
      if (s.menus || s.theme !== MOCHA.theme || s.flavour !== MOCHA.pref || s.saved !== MOCHA.pref || ground !== MOCHA.mantle) fail(`${name}, ${when}: the page has ${s.menus} theme menus, data-theme "${s.theme}", data-flavour ${JSON.stringify(s.flavour)}, the saved choice ${JSON.stringify(s.saved)} and the rail on ${ground}: not hidden in Mocha, on ${MOCHA.mantle}`);
    };
    await inMocha("hidden");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".app > .side-rail .side-show", { timeout: 15000 });
    await page.waitForSelector(".composer-box .send", { timeout: 15000 });
    await inMocha("reloaded");
    await page.locator(".side-rail .side-show").click();
    if (!await until(async () => { const s = await read(page); return !s.hidden && s.btn; }, 10000)) return fail(`${name}: after the reload the rail's control did not show the sidebar`);
    const s = await read(page);
    if (s.menus || s.expanded !== "false" || s.title !== MOCHA.title) fail(`${name}: shown after the reload, the page has ${s.menus} theme menus, the button says aria-expanded="${s.expanded}" and "${s.title}"`);
    await round(page, name + ", and the round in Mocha", "key", "rail", { T: MOCHA });
    note(`${name}: hidden in Mocha with the rail on ${MOCHA.mantle}, before and after a reload; shown, the button names Mocha and its menu is closed`);
  });
});
