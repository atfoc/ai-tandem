// Proves, on the build that has all six goals, what goals 1 and 6 say together: hiding the sidebar in a flavour, beside what the other
// goals put on the page. In the old check the sidebar is hidden while the theme's menu is open, with an unstarted chat's composer at
// 300 px, a pending move with a typed draft, open tool cards, or a branch send on its way, and the page is in a flavour.
// Hidden by ⌘B and by the head's control, in the flavour the page was in: the page is in the theme it was in, with the same saved
// choice; the rail is on the flavour's Mantle (A-LY-16) from the first frame and in every frame on the way, also after a reload and in
// another flavour; the page saved nothing; Esc, which a menu would have taken, does nothing. Shown again, by the rail's control and by
// ⌘B: the focus is on the head's control and the saved choice of the sidebar says "shown".
// With the theme's menu (`theme-menu`, the button `theme-btn` of the foot, `data-theme-pref` on its items) open while the sidebar is hidden:
// gone from the page, the button not drawn, the focus on the rail's control, Esc does nothing, the choice marked and focused when shown
// again; the keys on another item (hiding picks nothing); a pick by the keys and ⌘B at once; a window so low that the menu scrolls.
// And with what the other goals put on the page: a board chat's composer fitted in every frame of the round (`composerProbe` of composer.mjs,
// on the board chat's panel of 300 px: the desktop layout has no chat page that narrow beside the sidebar, so the box keeps its width through
// the round); a pending move with a typed draft (the box and the banner as they were), open tool cards (still open), a branch send on its way
// (the message, its line, the banner and Send's spinner as they were, which then ends as it would have).
// Ports dev/checks/P7.2-menu.mjs (U3, S1, K3, S6, S8) to the new build, at desktop and tablet. Deviations: the menu is a popover in a layer that a
// press outside closes, so the head's control cannot hide the sidebar with the menu open: that press closes the menu (asked below), and the
// sidebar is hidden with the menu open by the key alone, as the old check did in a low window; the old "unstarted chat at 300 px" is the board
// chat's panel of 300 (a window under 700 px is the phone layout, with no sidebar); the pending move and the open cards are in a chat at the
// device's window (and the move on the board chat's panel), where the old check had a page of 300 px; the pending move is shown again by ⌘B only
// (the round's other way out is the rail's control, which the sections above use).
import { check, colourOf, holds, mockEval, release, sampleFrames, seed, until } from "../shot.mjs";
import { openCards, toolCards } from "./cards.mjs";
import { composerProbe } from "./composer.mjs";
import { startMove, typeAndSend, waitsSeen } from "./fork.mjs";
import { act, byTid, press } from "./sel.mjs";

export const viewports = ["desktop", "tablet"];

const SEND = "c_A4_turns"; // the chat whose branch send is held
const tid = (id) => `[data-testid="${id}"]`;
// the flavours the pages are in; Mantle of @catppuccin/palette 1.8.0
const FRAPPE = { pref: "frappe", theme: "dark", mantle: "#292c3c" };
const MOCHA = { pref: "mocha", theme: "dark", mantle: "#181825" };
const hex = (c) => (c ? "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("") : "none");
const HOW = { key: "⌘B", control: "the head's control", rail: "the rail's control" };

/** In the page: the sidebar, the theme and the focus as they are now. */
function seen() {
  const d = document.documentElement.dataset, a = document.activeElement, id = a?.closest?.("[data-testid]")?.dataset.testid;
  return {
    hidden: document.querySelector('[data-testid="app"]')?.dataset.side === "hidden",
    theme: d.theme ?? null, flavour: d.flavour ?? null, saved: localStorage.getItem("aiwb.theme"), side: localStorage.getItem("aiwb.side"),
    focus: !a || a === document.body ? "nothing" : id === "side-show" ? "rail" : id === "side-hide" ? "head" : (id ?? a.tagName.toLowerCase()),
  };
}

// For sampleFrames (sent as text): null until React has drawn the window; then whether the sidebar is hidden, the frame's theme, and
// the colour the rail has when it is there. bad: the page in another theme than its own, or a rail that is not on its ground.
const probe = (mantle, T) => ({ toString: () => `() => {
  const app = document.querySelector('[data-testid="app"]');
  if (!app) return null;
  const d = document.documentElement.dataset, rail = app.querySelector(':scope > [data-testid="side-rail"]');
  const ground = rail ? getComputedStyle(rail).backgroundColor : null;
  const hex = (c) => { const m = /rgba?\\((\\d+), (\\d+), (\\d+)/.exec(c ?? ""); return m ? "#" + [1, 2, 3].map((i) => Number(m[i]).toString(16).padStart(2, "0")).join("") : null; };
  return { bad: d.theme !== ${JSON.stringify(T.theme)} || d.flavour !== ${JSON.stringify(T.pref)} || (!!rail && hex(ground) !== ${JSON.stringify(mantle)}), hidden: !!rail, theme: d.theme ?? null, flavour: d.flavour ?? null, ground: hex(ground) };
}` });

await check("P7.2 the sidebar hidden in a flavour: the rail on its Mantle from the first frame, nothing saved", async ({ url, viewport, open, fail, note }) => {
  const states = await seed(url, "A2", "A4", "A5");
  const state = (id) => states.find((s) => s.id === id) ?? (() => { throw new Error(`the seed has no state ${id}`); })();
  const read = (page) => page.evaluate(seen);
  const frames = (page) => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok()))));
  /** Every timer the page had set for the next moments has fired (the focus moves in one): a timer set now, with a later end, fires after them. */
  const timers = (page) => page.evaluate(() => new Promise((ok) => setTimeout(ok, 60)));
  /** Every call the page makes that is not a read, as the page makes it. */
  const spy = (page) => page.evaluate(() => {
    window.__calls = [];
    const f = window.fetch;
    window.fetch = (u, o) => { // (a call goes to the host as POST /host/call, with the call's own method in the query)
      const q = new URL(u, location.href), m = q.searchParams.get("method");
      if (q.pathname === "/host/call" && m && m !== "GET") window.__calls.push(`${m} ${q.searchParams.get("path")} ${o?.body ?? ""}`);
      return f(u, o);
    };
  });
  const calls = (page) => page.evaluate(() => window.__calls.splice(0));
  const run = async (name, T, o, body) => {
    const { ctx, page } = await open({ wait: tid("app"), ...o, ls: { "aiwb.theme": T.pref, ...o.ls } });
    try { await body(page); } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); } finally { await ctx.close(); }
  };
  const focusIs = async (page, name, want) => { if (!await until(async () => (await read(page)).focus === want, 10000)) fail(`${name}: the focus is on ${(await read(page)).focus}, not on ${want === "rail" ? "the rail's control" : want === "head" ? "the head's control" : want}`); };
  const hide = (page, how) => (how === "key" ? page.keyboard.press("ControlOrMeta+b") : press(page, byTid(page, "side-hide").first()));
  const show = (page, how) => (how === "key" ? page.keyboard.press("ControlOrMeta+b") : press(page, byTid(page, "side-show").first()));
  const ground = async (page) => hex(await colourOf(page, tid("side-rail"), "backgroundColor"));

  /** The round: the sidebar hidden by `how` and shown again by `back`, in the flavour T the page is in. */
  const round = async (page, name, how, back, T) => {
    const tag = `${name}, hidden by ${HOW[how]}`, say = (line) => fail(`${tag}: ${line}`);
    const inTheme = (s, when) => { if (s.theme !== T.theme || s.flavour !== T.pref || s.saved !== T.pref) say(`${when} the page has data-theme "${s.theme}", data-flavour ${JSON.stringify(s.flavour)} and the saved choice ${JSON.stringify(s.saved)}, not ${T.pref}`); };
    const was = await read(page);
    if (was.hidden) return say("the page is hidden before the round");
    await spy(page);
    const sampler = await sampleFrames(page, probe(T.mantle, T));

    await hide(page, how);
    if (!await until(async () => (await read(page)).hidden, 10000)) { await sampler.stop(); return say("the sidebar is not hidden"); }
    const h = await read(page);
    if (h.side !== "hidden") say(`localStorage "aiwb.side" is ${JSON.stringify(h.side)}`);
    inTheme(h, "hidden,");
    const g = await ground(page);
    if (g !== T.mantle) say(`the rail is on ${g}, not on Mantle ${T.mantle}`);
    // the focus is on the rail's control when it was in the sidebar (the head's control had it, or the key found it in the sidebar)
    if (how !== "key") await focusIs(page, tag, "rail");
    await timers(page); await frames(page);
    // Esc: nothing takes it
    await page.keyboard.press("Escape");
    await timers(page); await frames(page);
    const esc = await read(page);
    if (!esc.hidden) say("after Esc the sidebar is shown");
    inTheme(esc, "after Esc");

    await show(page, back);
    if (!await until(async () => !(await read(page)).hidden, 10000)) { await sampler.stop(); return say(`${HOW[back]} did not show the sidebar again`); }
    if (back !== "key") await focusIs(page, `${tag}, shown again by ${HOW[back]}`, "head");
    await timers(page); await frames(page);
    const s = await read(page);
    if (s.side !== "shown") say(`shown again, localStorage "aiwb.side" is ${JSON.stringify(s.side)}`);
    inTheme(s, "shown again,");

    const r = await sampler.stop();
    if (r.bad.length) say(`${r.bad.length} of ${r.values.length} frames were in another theme than the page's, or had a rail that is not on Mantle; the first: ${JSON.stringify(r.bad[0])}`);
    if (!r.values.some((v) => v.hidden) || !r.values.some((v) => !v.hidden)) say(`the sampler read ${r.values.length} frames, ${r.values.filter((v) => v.hidden).length} of them with the sidebar hidden: not the way there and back`);
    const made = await calls(page);
    if (made.length) say(`the page saved something: ${made.join("; ")}`);
    return r;
  };

  const told = [];
  for (const [how, back] of [["key", "rail"], ["control", "key"], ["control", "rail"]]) {
    await run("Home in Frappé", FRAPPE, { sel: {} }, async (page) => {
      await page.waitForSelector(tid("home"));
      const r = await round(page, "Home in Frappé", how, back, FRAPPE);
      told.push(`${HOW[how]} and ${HOW[back]} ${r?.values.length ?? 0}`);
    });
  }
  await run("a plain chat in Frappé", FRAPPE, { sel: { chat: "c_plain" } }, async (page) => {
    await page.waitForSelector(tid("chat-head"));
    await round(page, "a plain chat in Frappé", "key", "rail", FRAPPE);
  });

  // ---- another flavour, and from the first frame of a reload with the sidebar saved as hidden
  await run("hidden, then reloaded, in Mocha", MOCHA, { sel: {}, ls: { "aiwb.side": "hidden" } }, async (page) => {
    await page.waitForSelector(tid("side-rail"));
    const inMocha = async (when) => {
      const s = await read(page), g = await ground(page);
      if (!s.hidden || s.theme !== MOCHA.theme || s.flavour !== MOCHA.pref || s.saved !== MOCHA.pref || g !== MOCHA.mantle) fail(`hidden in Mocha, ${when}: the page is ${s.hidden ? "hidden" : "shown"}, data-theme "${s.theme}", data-flavour ${JSON.stringify(s.flavour)}, the saved choice ${JSON.stringify(s.saved)} and the rail on ${g}: not hidden in Mocha, on ${MOCHA.mantle}`);
    };
    await inMocha("opened");
    const sampler = await sampleFrames(page, probe(MOCHA.mantle, MOCHA), { fromLoad: true });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(tid("side-rail"), { timeout: 15000 });
    await page.waitForFunction(() => window.__frames?.values.length > 2, null, { timeout: 15000 });
    const r = await sampler.stop();
    if (r.bad.length) fail(`reloaded in Mocha, ${r.bad.length} of ${r.values.length} frames were in another theme or had a rail that is not on Mantle; the first: ${JSON.stringify(r.bad[0])}`);
    await inMocha("reloaded");
    await press(page, byTid(page, "side-show").first());
    if (!await until(async () => !(await read(page)).hidden, 10000)) return fail("after the reload the rail's control did not show the sidebar");
    await round(page, "the round in Mocha", "key", "rail", MOCHA);
    note(`hidden in Mocha with the rail on ${MOCHA.mantle}, opened and reloaded (${r.values.length} frames from the first); shown, the round in Mocha`);
  });
  note(`the sidebar hidden and shown in Frappé by ${told.join("; ")} frames, each with the rail on Mantle ${FRAPPE.mantle} and the page in its flavour; nothing saved`);
  // ---- the theme's menu open while the sidebar is hidden (S1)
  const menuSeen = (page) => page.evaluate(() => {
    const d = document.documentElement.dataset, btn = document.querySelector('[data-testid="theme-btn"]'), a = document.activeElement, id = a?.closest?.("[data-testid]")?.dataset.testid;
    const rail = document.querySelector('[data-testid="app"] > [data-testid="side-rail"]'), pane = document.querySelector('[data-testid="side-pane"]');
    return {
      // (a menu that is in the page but not drawn, as the layer's own leaves it for a frame after it closes, is no menu on screen)
      hidden: !!rail && !pane?.getClientRects().length, menus: [...document.querySelectorAll('[data-testid="theme-menu"]')].filter((e) => e.getClientRects().length).length,
      btn: !!btn?.getClientRects().length, expanded: btn?.getAttribute("aria-expanded") ?? null, title: btn?.title ?? null,
      marked: [...document.querySelectorAll('[data-testid="theme-menu"] [aria-checked="true"]')].map((e) => e.dataset.themePref).join(),
      theme: d.theme ?? null, flavour: d.flavour ?? null, saved: localStorage.getItem("aiwb.theme"), side: localStorage.getItem("aiwb.side"),
      focus: !a || a === document.body ? "nothing" : id === "side-show" ? "rail" : id === "side-hide" ? "head" : id === "theme-btn" ? "button" : a.matches('[role="menuitemradio"]') ? "item " + a.dataset.themePref : (id ?? a.tagName.toLowerCase()),
    };
  });
  // For sampleFrames (sent as text): null until the app has drawn the window; then whether the sidebar is hidden, whether the theme's menu is in the page,
  // and the frame's theme. bad: the menu in a page whose sidebar is hidden.
  // (the composer's fit, where one is on the page: no control past the box and no sideways scroll; Send is not held to be within reach while
  // the menu's layer is over the page)
  const menuProbe = { toString: () => `() => {
    const app = document.querySelector('[data-testid="app"]');
    if (!app) return null;
    const d = document.documentElement.dataset;
    const hidden = !!app.querySelector(':scope > [data-testid="side-rail"]'), menu = [...document.querySelectorAll('[data-testid="theme-menu"]')].some((e) => e.getClientRects().length > 0);
    const fit = (${composerProbe})();
    return { bad: (hidden && menu) || !!(fit && (fit.past > 0 || fit.scroll > 0)), hidden, menu, theme: d.theme ?? null, flavour: d.flavour ?? null, fit };
  }` };
  const boxes = (r) => { const w = r?.values.filter((v) => v.fit).map((v) => v.fit.box) ?? []; return w.length ? [Math.min(...w), Math.max(...w)] : null; };
  const TITLES = { frappe: "Theme: Catppuccin Frappé", mocha: "Theme: Catppuccin Mocha" };
  const settled = (page) => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(ok)))));
  const openMenu = async (page) => { await press(page, byTid(page, "theme-btn").first()); await page.waitForSelector(tid("theme-menu"), { timeout: 10000 }); await settled(page); };
  const focusIsM = async (page, name, want) => { if (!await until(async () => (await menuSeen(page)).focus === want, 10000)) fail(`${name}: the focus is on ${(await menuSeen(page)).focus}, not on ${want === "rail" ? "the rail's control" : want === "head" ? "the head's control" : want}`); };
  const keyOrRail = (page, how) => (how === "key" ? page.keyboard.press("ControlOrMeta+b") : press(page, byTid(page, "side-show").first()));

  /** The round: the menu opened (keys pressed in it), the sidebar hidden by ⌘B with it open and shown again by `back`. T: the theme the page is in. */
  const menuRound = async (page, name, back, { T = FRAPPE, keys = [], saves = false } = {}) => {
    const tag = `${name}, hidden by ⌘B`, say = (line) => fail(`${tag}: ${line}`);
    const inTheme = (s, when) => { if (s.theme !== T.theme || s.flavour !== T.pref || s.saved !== T.pref) say(`${when} the page has data-theme "${s.theme}", data-flavour ${JSON.stringify(s.flavour)} and the saved choice ${JSON.stringify(s.saved)}, not ${T.pref}`); };
    await openMenu(page);
    for (const k of keys) await page.keyboard.press(k);
    const was = await menuSeen(page);
    if (was.hidden || was.menus !== 1 || was.expanded !== "true" || was.marked !== T.pref) return say(`before it the page has ${was.menus} theme menus, which mark "${was.marked}", and the button says aria-expanded="${was.expanded}"`);
    if (!was.focus.startsWith("item ") || (keys.length > 0) === (was.focus === "item " + T.pref)) say(`before it the focus is on ${was.focus}${keys.length ? ": the keys did not leave the choice" : ", not on the choice"}`);
    await spy(page);
    const sampler = await sampleFrames(page, menuProbe);

    await page.keyboard.press("ControlOrMeta+b");
    if (!await until(async () => (await menuSeen(page)).hidden, 10000)) { await sampler.stop(); return say("the sidebar is not hidden"); }
    if (!await until(async () => !(await menuSeen(page)).menus, 5000)) say("the theme's menu is still in the page");
    const h = await menuSeen(page);
    if (h.btn) say("the picker's button is still drawn");
    if (h.side !== "hidden") say(`the kv key "aiwb.side" is ${JSON.stringify(h.side)}`);
    inTheme(h, "hidden,");
    const ground = hex(await colourOf(page, tid("side-rail"), "backgroundColor"));
    if (ground !== T.mantle) say(`the rail is on ${ground}, not on Mantle ${T.mantle}`);
    await focusIsM(page, tag, "rail");
    await timers(page); await frames(page);
    await focusIsM(page, tag + ", a moment later", "rail");
    // Esc: the menu that would have taken it is gone, and nothing else does
    await page.keyboard.press("Escape");
    await timers(page); await frames(page);
    const esc = await menuSeen(page);
    if (!esc.hidden || esc.menus || esc.focus !== "rail") say(`after Esc the sidebar is ${esc.hidden ? "hidden" : "shown"}, the page has ${esc.menus} theme menus and the focus is on ${esc.focus}`);
    inTheme(esc, "after Esc");

    await keyOrRail(page, back);
    if (!await until(async () => { const s = await menuSeen(page); return !s.hidden && s.btn; }, 10000)) { await sampler.stop(); return say(`${HOW[back]} did not show the sidebar again`); }
    if (back !== "key") await focusIsM(page, `${tag}, shown again by ${HOW[back]}`, "head");
    await timers(page); await frames(page);
    const s = await menuSeen(page);
    if (s.menus || s.expanded !== "false") say(`shown again, the page has ${s.menus} theme menus and the button says aria-expanded="${s.expanded}"`);
    if (s.title !== TITLES[T.pref]) say(`shown again, the button says "${s.title}", not "${TITLES[T.pref]}"`);
    if (s.side !== "shown") say(`shown again, the kv key "aiwb.side" is ${JSON.stringify(s.side)}`);
    inTheme(s, "shown again,");

    const r = await sampler.stop();
    if (r.bad.length) say(`${r.bad.length} of ${r.values.length} frames had the menu in a page whose sidebar is hidden; the first: ${JSON.stringify(r.bad[0])}`);
    const other = r.values.filter((v) => v.theme !== T.theme || v.flavour !== T.pref);
    if (other.length) say(`${other.length} of ${r.values.length} frames were in another theme, the first in data-theme "${other[0].theme}" and data-flavour ${JSON.stringify(other[0].flavour)}`);
    if (!r.values.some((v) => v.hidden) || !r.values.some((v) => !v.hidden)) say(`the sampler read ${r.values.length} frames, ${r.values.filter((v) => v.hidden).length} of them with the sidebar hidden: not the way there and back`);
    const made = await calls(page);
    if (made.length) say(`the page saved something: ${made.join("; ")}`);

    // the menu opens as before
    await openMenu(page);
    const again = await menuSeen(page);
    if (again.menus !== 1 || again.marked !== T.pref || again.focus !== "item " + T.pref) say(`opened again, the page has ${again.menus} theme menus, which mark "${again.marked}", and the focus is on ${again.focus}`);
    await page.keyboard.press("Escape");
    if (!await until(async () => !(await menuSeen(page)).menus, 10000)) say("opened again, Esc did not close the menu");
    return r;
  };

  const toldMenu = [];
  await run("Home in Frappé, the theme's menu open", FRAPPE, { sel: {} }, async (page) => {
    await page.waitForSelector(tid("home"));
    for (const [back, keys] of [["rail", []], ["key", ["ArrowDown", "ArrowDown"]], ["rail", ["Home"]]]) {
      const r = await menuRound(page, `Home in Frappé${keys.length ? `, the keys on another item (${keys.join(", ")})` : ""}`, back, { keys });
      toldMenu.push(`${back} ${r?.values.length ?? 0}`);
    }
    // the head's control with the menu open: the press is the layer's, which closes the menu; the sidebar stays
    await openMenu(page);
    const hb = await byTid(page, "side-hide").first().boundingBox();
    if (await page.evaluate(() => navigator.maxTouchPoints > 0)) await page.touchscreen.tap(hb.x + hb.width / 2, hb.y + hb.height / 2); else await page.mouse.click(hb.x + hb.width / 2, hb.y + hb.height / 2);
    if (!await until(async () => !(await menuSeen(page)).menus, 5000)) fail("a press on the head's control did not close the theme's menu");
    if ((await menuSeen(page)).hidden) fail("the press on the head's control that closed the theme's menu hid the sidebar as well");
  });
  note(`the sidebar hidden by ⌘B with the theme's menu open, in Frappé, shown by ${toldMenu.join("; ")} frames, none with the menu beside a rail; the keys on another item picked nothing; nothing saved`);

  // ---- a board chat's composer at 300 px: every way there and back, the composer fitted in every frame, its box kept
  {
    const s = state("board-new"), seen = [];
    await run("a board chat's composer in Frappé, the theme's menu open", FRAPPE, { sel: s.sel, ...(viewport === "desktop" ? { size: [1100, 640], ls: { "aiwb.widths": JSON.stringify({ side: 264, panel: 300 }) } } : {}) }, async (page) => {
      await page.waitForSelector(tid("send"), { timeout: 30000 });
      await page.evaluate(() => document.fonts.ready);
      for (const [back, keys] of [["rail", []], ["key", ["ArrowDown", "ArrowDown"]], ["rail", ["Home"]]]) {
        const r = await menuRound(page, `a board chat's composer at 300 px${keys.length ? `, the keys on another item (${keys.join(", ")})` : ""}`, back, { keys });
        const w = boxes(r);
        // (the desktop's panel keeps its width as the sidebar goes and comes: so does the composer's box; the tablet's panel shares the room with the stage)
        if (viewport === "desktop" && r && (!w || w[0] !== w[1])) fail(`a board chat's composer, hidden by ⌘B: the box went from ${w ? w.join(" to ") : "none"} px: a panel keeps its width`);
        seen.push(`${back} ${r?.values.length ?? 0}`);
      }
    });
    note(`a board chat's composer, the theme's menu open: hidden by ⌘B and shown by ${seen.join("; ")} frames, each in Frappé with the composer fitted and its box kept`);
  }

  // ---- a pending move with a typed draft: both are as they were (the draft is saved as it is typed)
  {
    const s = state("board-move"), name = "a pending move with a draft", text = "Half a thought";
    await run(name, FRAPPE, { sel: s.sel, ...(viewport === "desktop" ? { size: [1100, 640], ls: { "aiwb.widths": JSON.stringify({ side: 264, panel: 300 }) } } : {}) }, async (page) => {
      await page.waitForSelector(tid("send"), { timeout: 30000 });
      await act(page, s.act);
      await byTid(page, "composer-input").first().click();
      await page.keyboard.type(text);
      const before = await waitsSeen(page, { composer: true });
      const r = await menuRound(page, name, "key", { saves: true });
      const after = await waitsSeen(page, { composer: true });
      if (after.box !== text || after.banner !== before.banner || !after.banner) fail(`${name}: after the round the box holds "${after.box}" and the banner says "${after.banner}"; before, "${before.box}" and "${before.banner}"`);
      note(`${name}: the box and the banner as they were; ${r?.values.length ?? 0} frames, the composer's box ${(w => (w ? w.join(" to ") + " px" : "none"))(boxes(r))}`);
    });
  }

  // ---- open tool cards: they stay open
  {
    const s = state("claude"), name = "a thread with its tool cards open";
    await run(name, FRAPPE, { sel: s.sel, wait: tid("chat-head") }, async (page) => {
      await byTid(page, "tool-card").first().waitFor({ state: "visible", timeout: 15000 });
      await openCards(page);
      const before = (await toolCards(page)).filter((c) => c.open).length, top = () => page.evaluate(() => document.querySelector('[data-testid="thread-scroll"]')?.scrollTop ?? -1), was = await top();
      await menuRound(page, name, "rail");
      const cards = await toolCards(page), after = cards.filter((c) => c.open).length;
      if (!before || after !== before || cards.length !== before) fail(`${name}: ${after} of ${cards.length} cards are open after the round, ${before} before`);
      note(`${name}: all ${after} still open (the thread scrolled to ${was} px before, ${await top()} after)`);
    });
  }

  // ---- a branch send on its way: the wait is on the page through the round, and ends when the call does
  {
    const name = "a branch send on its way", said = "Try it another way";
    await seed(url, "A4");
    await mockEval(`flags.send = { chat: "${SEND}", hold: true, noReply: true };`, url);
    try {
      await run(name, FRAPPE, { sel: { chat: SEND }, wait: tid("chat-head") }, async (page) => {
        await page.waitForSelector(tid("send"), { timeout: 30000 });
        await startMove(page);
        await typeAndSend(page, said);
        if (!await until(() => holds(url, "send"))) fail(`${name}: the page's call did not reach the mock`);
        const wait = (w) => ({ msgs: w.msgs.map((m) => `${m.text}${m.sending ? " (sending)" : ""}`), lines: w.lines, banner: w.banner, send: w.send });
        let before;
        if (!await until(async () => { before = wait(await waitsSeen(page, { composer: true })); return before.send?.spin && before.lines.length === 1 && before.banner; })) fail(`${name}: the page does not show the wait: ${JSON.stringify(before)}`);
        const r = await menuRound(page, name, "key", { saves: true });
        const after = wait(await waitsSeen(page, { composer: true }));
        if (JSON.stringify(after) !== JSON.stringify(before)) fail(`${name}: after the round the page shows ${JSON.stringify(after)}; before, ${JSON.stringify(before)}`);
        if (await holds(url, "send") !== 1) fail(`${name}: the mock holds ${await holds(url, "send")} sends after the round, not the one`);
        await release(url, "send");
        let ended;
        if (!await until(async () => { ended = await waitsSeen(page); return !ended.banner && ended.msgs.every((m) => m.live) && ended.msgs.at(-1)?.text === said; })) fail(`${name}: let go, the send did not end with the message in the new branch's thread: ${JSON.stringify(ended)}`);
        const w = boxes(r);
        note(`${name}: the message, its line, the banner and Send's spinner as they were through the round (${r?.values.length ?? 0} frames, the composer's box ${w ? w.join(" to ") + " px" : "none"}); let go, it ended`);
      });
    } finally { await mockEval("delete flags.send;", url); }
  }

  // ---- a window so low that the menu scrolls (the desktop's window: a window made another size is the desktop viewport's)
  if (viewport === "desktop") await run("a low window", FRAPPE, { sel: {}, size: [1000, 240] }, async (page) => {
    await openMenu(page);
    const m = await page.evaluate(() => { let e = document.querySelector('[data-testid="theme-menu"]').parentElement; while (e && !/auto|scroll/.test(getComputedStyle(e).overflowY)) e = e.parentElement; return { height: e.scrollHeight, client: e.clientHeight }; });
    if (m.height <= m.client) fail(`a low window: the menu's ${m.height} px are all in sight: the check has no window too low for it`);
    await page.locator(`${tid("theme-menu")} [data-theme-pref="mocha"]`).scrollIntoViewIfNeeded();
    await page.keyboard.press("Escape");
    // (by the key alone: in a window this low the open menu lies over the sidebar's head, and its control with it)
    await menuRound(page, "a low window, the menu scrolling", "rail");
    await menuRound(page, "a low window, the menu scrolled to its end", "key", { keys: ["End"] });
    note(`a low window: the menu of ${m.height} px scrolled in ${m.client} and went with the sidebar`);
  });

  // ---- a pick by the keys, and ⌘B at once: hidden in the theme picked, also after a reload
  await run("a pick, then ⌘B", FRAPPE, { sel: {} }, async (page) => {
    const name = "a pick by the keys, then ⌘B";
    await page.waitForSelector(tid("home"));
    await openMenu(page);
    if (await page.evaluate(() => navigator.maxTouchPoints > 0 && !document.activeElement?.matches('[role="menuitemradio"]'))) await page.locator(`${tid("theme-menu")} [role="menuitemradio"]`).first().focus();
    await page.keyboard.press("End"); await page.keyboard.press("Enter"); await page.keyboard.press("ControlOrMeta+b");
    if (!await until(async () => (await menuSeen(page)).hidden, 10000)) return fail(`${name}: the sidebar is not hidden`);
    await focusIsM(page, name, "rail");
    const inMocha = async (when) => {
      const s = await menuSeen(page), ground = hex(await colourOf(page, tid("side-rail"), "backgroundColor"));
      if (s.menus || s.theme !== MOCHA.theme || s.flavour !== MOCHA.pref || s.saved !== MOCHA.pref || ground !== MOCHA.mantle) fail(`${name}, ${when}: the page has ${s.menus} theme menus, data-theme "${s.theme}", data-flavour ${JSON.stringify(s.flavour)}, the saved choice ${JSON.stringify(s.saved)} and the rail on ${ground}: not hidden in Mocha, on ${MOCHA.mantle}`);
    };
    await inMocha("hidden");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(tid("side-rail"), { timeout: 15000 });
    await inMocha("reloaded");
    await press(page, byTid(page, "side-show").first());
    if (!await until(async () => { const s = await menuSeen(page); return !s.hidden && s.btn; }, 10000)) return fail(`${name}: after the reload the rail's control did not show the sidebar`);
    const s = await menuSeen(page);
    if (s.menus || s.expanded !== "false" || s.title !== TITLES.mocha) fail(`${name}: shown after the reload, the page has ${s.menus} theme menus, the button says aria-expanded="${s.expanded}" and "${s.title}"`);
    await menuRound(page, name + ", and the round in Mocha", "rail", { T: MOCHA });
    note(`${name}: hidden in Mocha with the rail on ${MOCHA.mantle}, before and after a reload; shown, the button names Mocha and its menu is closed`);
  });
}, { viewports, page: false });
