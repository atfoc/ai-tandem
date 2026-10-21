// A2.2 ported (AD-80; package K3): the composer fits its box. Every state of seed A2 at the widths G1 measured (the chat panel at 300, 340,
// 400, 480 and 760 px, a chat page at 300 to 560 and at 900) and another branch's alert in the header: no control ends past the box, Send is
// the element at its own centre, and the document does not scroll sideways; a chat toolbar's controls are on one line, also where a reason
// line under them lets the row wrap, and none ends past the row itself (the reader measures against the box's border, 9 px further: its
// padding would hide a toolbar fitted a few px too wide); Stop and Send are as wide as in a row with room for everything. Each state is
// loaded at its narrowest width, where the toolbar measures its controls with the most of them to send away, and brought to the others by
// the window or the panel's resizer. Then the same in every frame, read by the driver's frame sampler after the frame's paint: a drag of the
// panel's resizer down and up, a load from the page's first frame, a chip's arrival (the popup closed and open), a window narrowed and
// widened with "more" open, and ⌘B with "more" closed and open. With "more" open the popup stays open, and no control leaves it for the
// toolbar, in any frame. The box changes width in small steps, which show every width on the way, and in large ones: a fit that came a frame
// late would be past the box by the step, and the box's own padding would hide a small one from the measure. Last, the zoom changes: the
// widths the toolbar kept are of the old zoom, so it measures its controls again (told by the counter of kept widths a build for the checks
// shows on `window`: a resize adds none, a zoom adds one for each control), and every frame is fitted.
// Ports dev/checks/A2.2-fits.mjs with its states, widths and assertions; the readers are composer.mjs'. Deviations:
//  - the widths are windows and saved pane widths: the desktop's. The tablet and the phone have the device's own width, so there each state
//    is read at rest at that width (the toolbar's fit, "more" open and closed), and a load is sampled from the first frame;
//  - the "more" popup is a sheet or a popover over a backdrop (ui/Overlay), where the old one had none: Send is not within reach in a frame
//    in which it is open, as in one in which a picker's list is (the probe's `list` is any overlay);
//  - the states with a pending move (`act` "move") are played with S8's Branch action (`acts.move` of sel.mjs); the other
//    branch's alert is the header's `fk-alert` (S8), and the branch change is made by pressing it.
import { check, dragResizer, mockEval, sampleFrames, seed, until } from "../shot.mjs";
import { HEIGHT, MORE, POP, RAIL, SIDE, SEES, countOf, fitProbe, frame, measureComposer, openState, pageWindow, playable, rowOf } from "./composer.mjs";
import { back as _back, byTid, press, tidSel } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const WIDTHS = { panel: [300, 340, 400, 480, 760], page: [300, 340, 400, 480, 560, 900] };
const SEND = 28; // px: Stop and Send (G1 §Q2), which never shrink

await check("A2.2 the composer fits its box, at rest and in every frame", async ({ url, layout, open, fail, note }) => {
  const wide = layout === "desktop";
  const states = (await seed(url, "A2")).filter((s) => playable(s, layout));
  const state = (id) => states.find((s) => s.id === id) ?? (() => { throw new Error(`the seed has no state ${id}`); })();
  const close = async ({ ctx }) => { await ctx.close(); };
  /** The state is drawn: what its entry names is on the page, in the toolbar or, when it is a chip the toolbar has no room for, in the "more" popup. */
  const drawn = async (page, s, name) => {
    const parts = SEES[s.id] ?? [{ tid: "composer-box" }];
    const here = async () => (await Promise.all(parts.map((p) => countOf(page, p)))).every((n) => n > 0);
    const chips = parts.some((p) => p.tid === "tchip"); // (only a chip can be in the popup)
    if (!await until(async () => await here() || (chips && await page.locator(MORE).count()), 10000)) return fail(`${name}: nothing matches ${JSON.stringify(parts)}${chips ? ', and the toolbar has no "more"' : ""}`);
    if (await here()) return;
    await press(page, page.locator(MORE));
    if (!await until(() => byTid(page, "more-pop").count(), 5000)) return fail(`${name}: the "more" chip did not open its popup`);
    if (!await until(async () => (await Promise.all(parts.map((p) => countOf(byTid(page, "more-pop"), p)))).every((n) => n > 0), 5000)) fail(`${name}: nothing matches ${JSON.stringify(parts)}, in the toolbar or in the open "more" popup`);
    await page.keyboard.press("Escape");
    if (!await until(async () => !await byTid(page, "more-pop").count(), 5000)) fail(`${name}: Esc did not close the "more" popup`);
  };
  /** One measurement, as G1's: nothing past the box, Send where a click reaches it, no sideways scroll. */
  const fits = async (page, name) => {
    await frame(page);
    const all = (await measureComposer(page)).filter((c) => !c.none);
    if (all.length !== 1) return fail(`${name}: ${all.length} composers on the page`);
    const m = all[0];
    if (m.past) fail(`${name}: ${m.past} past the box, the furthest by ${m.furthest} px: ${m.over.map((o) => `${o.el} +${o.overBox}`).join("; ")}`);
    if (m.send !== "ok") fail(`${name}: Send is ${m.send}`);
    if (m.docScroll > 0) fail(`${name}: the document scrolls ${m.docScroll} px sideways`);
    if (m.boxOverPane > 0) fail(`${name}: the box is ${m.boxOverPane} px past its pane`);
    // (the row wraps only for its reason line)
    const row = await rowOf(page);
    if (row && row.lines > 4) fail(`${name}: the toolbar's controls are not on one line: their centres are ${row.lines} px apart`);
    if (row && row.out > 0.5) fail(`${name}: a control of the toolbar ends ${row.out} px past its row`);
    if (row && (!row.send.length || row.send.some((w) => Math.abs(w - SEND) > 0.5))) fail(`${name}: Stop and Send are ${row.send.join(" and ") || "not in the row"} px wide, not ${SEND} each`);
    return m;
  };
  const paneWidth = (page, kind) => page.evaluate((id) => document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect().width, kind === "panel" ? "board-panel" : "chat-page");
  const PANEL_RESIZER = `${tidSel("board-panel")} ${tidSel("resizer")}`;
  /** Brings the pane to a width: the panel by its resizer, a page by the window. */
  const widen = async (page, kind, to, name) => {
    // (the window grows first where the panel's most needs it: a drag leaves the stage its least)
    if (kind === "panel" && page.viewportSize().width < SIDE + to + 500) await page.setViewportSize({ width: SIDE + to + 500, height: HEIGHT });
    if (kind === "panel") await dragResizer(page, PANEL_RESIZER, to - await paneWidth(page, kind), 20);
    else await page.setViewportSize({ width: pageWindow(to), height: HEIGHT });
    if (!await until(async () => Math.abs(await paneWidth(page, kind) - to) < 1, 5000)) fail(`${name}: the ${kind} is ${await paneWidth(page, kind)} px wide, not ${to}`);
  };

  // ---- at rest: every state at G1's widths (the desktop), at the device's own width (the others)
  let measured = 0;
  for (const s of states) {
    const [kind] = s.pane, widths = WIDTHS[kind], at = wide ? `${widths[0]} px` : `${layout}'s own width`;
    const p = await openState(open, s, layout, widths[0]);
    try {
      await drawn(p.page, s, `${s.id} at ${at}`);
      if (!wide) { if (await fits(p.page, `${s.id} at ${at}`)) measured++; } else {
        for (const w of widths) {
          if (w !== widths[0]) await widen(p.page, kind, w, `${s.id} at ${w} px`);
          if (await fits(p.page, `${s.id} at ${w} px`)) measured++;
        }
      }
    } catch (e) { fail(`${s.id}: ${e.message.split("\n")[0]}`); }
    await close(p);
  }
  { // another branch's alert in the header, a state the seed has not
    const s = state("plain-branches"), p = await openState(open, s, layout, WIDTHS.page[0]);
    await mockEval(`setSession(${JSON.stringify(s.sel.chat)}, "alt", { status: "approval" });`, url);
    if (!await until(() => byTid(p.page, "fk-alert", { kind: "asks" }).count(), 10000)) fail("another branch's alert: the header does not show it");
    for (const w of wide ? WIDTHS.page : [0]) {
      const name = `another branch's alert at ${wide ? w + " px" : layout + "'s own width"}`;
      if (wide) await widen(p.page, "page", w, name);
      if (await fits(p.page, name)) measured++;
    }
    await close(p);
    await seed(url, "A2");
  }
  note(`${measured} measurements of ${states.length} states at rest: nothing past the box`);

  // ---- in every frame
  /** Samples the page's frames while body runs, and holds every one of them: nothing past the box, Send at its centre, no sideways scroll, Stop and Send at their width. */
  const sampled = async (page, name, body, o) => {
    const sampler = await sampleFrames(page, fitProbe, o);
    try { await body(); await page.waitForFunction(() => window.__frames?.values.length > 3, null, { timeout: 15000 }); await frame(page); } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    const r = await sampler.stop(), bad = r.values.filter((v) => (v.bad && (v.past > 0 || v.scroll > 0 || !v.list)) || v.out > 0.5 || Math.abs(v.send - SEND) > 0.5);
    if (bad.length) fail(`${name}: ${bad.length} of ${r.values.length} frames are not fitted, the first ${JSON.stringify(bad[0])}`);
    return r;
  };
  const range = (r, k) => [Math.min(...r.values.map((v) => v[k])), Math.max(...r.values.map((v) => v[k]))];
  /** Opens the "more" popup; answers how many controls it holds. */
  const openMore = async (page, name) => {
    await press(page, page.locator(MORE));
    if (!await until(() => page.locator(POP).count(), 5000)) { fail(`${name}: the "more" chip did not open its popup`); return 0; }
    return byTid(page, "more-row").count();
  };
  /** While the popup was open: it never closed, and no control left it. */
  const kept = (r, name) => {
    const closed = r.values.findIndex((v) => !v.more), back = r.values.findIndex((v, i) => i > 0 && v.held < r.values[i - 1].held);
    if (closed >= 0) fail(`${name}: the "more" popup closed, in frame ${closed} of ${r.values.length}`);
    if (back >= 0) fail(`${name}: a control left the open popup, in frame ${back}: it held ${r.values[back - 1].held}, then ${r.values[back].held}`);
  };

  if (wide) {
    // a drag of the panel's resizer, down to the least width and back up: 3 px a frame, then 45
    for (const id of ["board-new", "board-started", "board-busy", "board-move", "board-long"]) {
      const s = state(id), p = await openState(open, s, layout, 480), name = `${id}, a drag of the panel's resizer`;
      await drawn(p.page, s, name);
      const r = await sampled(p.page, name, async () => { for (const step of [3, 45]) { await dragResizer(p.page, PANEL_RESIZER, -180, step); await dragResizer(p.page, PANEL_RESIZER, 180, step); } });
      const [least, most] = range(r, "box"), [fewest, chips] = range(r, "chips"), first = r.values[0], last = r.values.at(-1);
      if (least !== 275 || most < 440) fail(`${name}: the box went from ${most} to ${least} px, not from some 455 to 275`);
      if (new Set(r.values.map((v) => v.box)).size < 40) fail(`${name}: the sampler saw ${new Set(r.values.map((v) => v.box)).size} widths of the box: not every step of the drag`);
      if (!r.values.some((v, i) => i > 0 && Math.abs(v.box - r.values[i - 1].box) >= 40)) fail(`${name}: no frame of the drag had a box 40 px narrower or wider than the frame before it`);
      if (fewest >= chips && !r.values.some((v) => v.ring !== first.ring)) fail(`${name}: the toolbar had ${chips} chips and the same meter at every width: nothing left it on the way`);
      if (last.chips !== first.chips || last.ring !== first.ring) fail(`${name}: back at 480 px the toolbar has ${last.chips} chips${last.ring ? " and the ring alone" : ""}, ${first.chips} before${first.ring ? " and the ring alone" : ""}`);
      await close(p);
    }
    note("a drag of the panel's resizer from 480 to 300 px and back, slowly and fast, five states: every frame fitted");
  }

  // a load, from the page's first frame: the widths are taken before a frame is shown
  for (const [id, width] of [["board-new", 300], ["plain-new", 300], ["plain-remote-started-long", 340], ["plain-noagent", 300], ["board-busy", 400]]) {
    const s = state(id), p = await openState(open, s, layout, width), name = `${id} at ${wide ? width + " px" : layout + "'s own width"}, a load`;
    const r = await sampled(p.page, name, async () => {
      await p.page.reload({ waitUntil: "domcontentloaded" });
      await p.page.waitForFunction(() => window.__frames?.values.length > 3, null, { timeout: 15000 });
    }, { fromLoad: true });
    if (r.frames <= r.values.length) fail(`${name}: the sampler did not run from before the composer was drawn (${r.values.length} values in ${r.frames} frames)`);
    await close(p);
  }
  note("a load, five states: fitted from the first frame that has the composer");

  { // a branch change: the chat gets the composer of the other branch, whose toolbar is another. By the header's alert, which shows the branch that
    // asks (the tree is a dialog over the page, Send under it).
    const s = state("plain-branches"), chat = JSON.stringify(s.sel.chat);
    for (const width of wide ? [300, 400] : [0]) {
      await seed(url, "A2");
      const p = await openState(open, s, layout, width), name = `a branch change at ${wide ? width + " px" : layout + "'s own width"}`;
      const go = async (branch, text) => {
        await mockEval(`setSession(${chat}, ${JSON.stringify(branch)}, { status: "approval" });`, url);
        await press(p.page, byTid(p.page, "chat-head").locator(tidSel("fk-alert", { kind: "asks" })).first());
        if (!await until(() => byTid(p.page, "msg", { role: "user" }).filter({ hasText: text }).count(), 10000)) fail(`${name}: the page did not show the branch with "${text}"`);
        await p.page.waitForTimeout(150); // (frames are sampled while the branch is shown: the change is quick since calls go to the mock over one connection)
        await mockEval(`setSession(${chat}, ${JSON.stringify(branch)}, { status: "ready" });`, url);
      };
      // (the model's chip of the toolbar: the other branch is on another model; with no chip in the row it is read in the "more" popup, which is closed again)
      const model = async () => {
        const inRow = await byTid(p.page, "composer-tools").locator(tidSel("tchip", { kind: "model" })).first().textContent({ timeout: 1000 }).catch(() => null);
        if (inRow !== null) return inRow;
        if (!await p.page.locator(MORE).count()) return "nowhere";
        await press(p.page, p.page.locator(MORE));
        if (!await until(() => p.page.locator(POP).count(), 5000)) return "in more";
        const inMore = await p.page.locator(POP).locator(tidSel("tchip", { kind: "model" })).first().textContent({ timeout: 2000 }).catch(() => null);
        await p.page.keyboard.press("Escape");
        if (!await until(async () => !await p.page.locator(POP).count(), 5000)) fail(`${name}: Esc did not close the "more" popup`);
        return `${inMore ?? "?"} (in more)`;
      };
      const before = await model();
      const r = await sampled(p.page, name, async () => {
        await go("alt", "Is there a faster way?");
        if (await model() === before) fail(`${name}: on the other branch the model's chip says "${before}" as on main`);
        await go("main", "Fix it.");
      });
      if (r.values.length < 10) fail(`${name}: the sampler read ${r.values.length} frames`);
      await close(p);
    }
    await seed(url, "A2");
    note("a branch change, to the branch on the long model and back: every frame fitted");
  }

  // a chip's arrival: the server's Cursor catalog comes, and "Loading models…" becomes the model and effort choices (the chat is the lab
  // box's: its change is made on that machine, and reaches the page as that server's event)
  const arrival = `extra.lists.s_lab.catalogs.cursor = cursor; onServer("s_lab", () => { Object.assign(chats.c_A2_loading, cursor.default); send({ type: "chat", chat: chats.c_A2_loading }); send({ type: "catalog", agent: "cursor", catalog: cursor }); });`;
  for (const [width, more] of wide ? [[300, false], [400, false], [560, false], [300, true], [400, true], [480, true]] : [[0, false], [0, true]]) {
    await seed(url, "A2");
    const s = state("plain-loading"), p = await openState(open, s, layout, width), name = `a chip's arrival at ${wide ? width + " px" : layout + "'s own width"}${more ? ', "more" open' : ""}`;
    await drawn(p.page, s, name);
    const held = more ? await openMore(p.page, name) : 0;
    if (more && !held) { await close(p); continue; }
    const r = await sampled(p.page, name, async () => {
      await mockEval(arrival, url);
      // (the model's chip is in the toolbar, or in the popup: its row is there when the popup is open, and the chip's title names it when not)
      if (!await until(async () => !await byTid(p.page, "tchip", { kind: "model" }).filter({ hasText: "Loading models" }).count()
        && (await byTid(p.page, "tchip", { kind: "model", fixed: false }).count() || /\bmodel\b/.test(await p.page.locator(MORE).getAttribute("title").catch(() => "") ?? "")), 10000)) fail(`${name}: the model's chip did not arrive`);
    });
    if (more) { kept(r, name); if (r.values.at(-1).held < held) fail(`${name}: the popup held ${held} controls, ${r.values.at(-1).held} after the arrival`); }
    await close(p);
  }
  await seed(url, "A2");
  note("a chip's arrival, the popup closed and open: every frame fitted");

  if (wide) {
    { // the window narrowed and widened with "more" open: the toolbar gives to the popup, and gets nothing back until it closes. (A window under
      // 700 px is the phone layout, whose chat screen is as wide as the window and whose popup is a sheet: the box is 24 px less than the window.)
      const s = state("plain-new"), p = await openState(open, s, layout, 560), name = 'the window narrowed with "more" open';
      const size = async (w) => { await p.page.setViewportSize({ width: w + 24, height: HEIGHT }); await p.page.evaluate(() => new Promise((ok) => requestAnimationFrame(ok))); };
      await size(520);
      await drawn(p.page, s, name);
      const held = await openMore(p.page, name), row = () => p.page.locator(`${tidSel("composer-tools")} ${tidSel("tchip")}:not([data-kind="more"])`).count(), before = await row();
      const r = await sampled(p.page, name, async () => {
        for (let w = 520; w >= 260; w -= 4) await size(w);
        for (let w = 260; w <= 520; w += 4) await size(w);
        for (const w of [508, 456, 404, 352, 300, 430, 520]) await size(w); // (and in steps of 52 px and more)
      });
      kept(r, name);
      const [least, most] = range(r, "box"), last = r.values.at(-1);
      if (least !== 260 || most !== 520) fail(`${name}: the box went from ${most} to ${least} px, not from 520 to 260`);
      if (range(r, "held")[1] <= held) fail(`${name}: the popup held ${held} controls at 520 px and no more at 260`);
      if (last.held !== range(r, "held")[1] || last.chips >= before) fail(`${name}: widened again with the popup open, it holds ${last.held} controls and the row ${last.chips} chips: something returned`);
      // closed, what fits returns
      await page_escape(p.page);
      if (!await until(async () => !await byTid(p.page, "more-pop").count() && await row() === before, 5000)) fail(`${name}: after the popup closed the row has not its ${before} chips again`);
      await fits(p.page, `${name}, closed again`);
      await close(p);
      note(`the window narrowed from 520 to 260 px and widened again with "more" open: it held ${held}, then ${last.held} controls, all until it closed; every frame fitted`);
    }

    // ⌘B: the page beside the sidebar gets wider by the sidebar less the rail, and narrower again, and a panel keeps its width. (A chat
    // page under 700 px is the phone layout, which has no sidebar beside it: the pages here are the desktop layout's, a window of 1100 px,
    // whose column of 780 px keeps its width; the panel is the board's, 300 px, where "more" has something to hold.)
    for (const [id, hidden, more] of [["plain-new", false, false], ["plain-new", true, false], ["board-new", false, true], ["board-new", true, true], ["board-new", false, false]]) {
      const s = state(id), kind = s.pane[0], name = `⌘B on a ${kind}${kind === "panel" ? " of 300 px" : " of the desktop layout"}${more ? ', "more" open' : ""}, the sidebar ${hidden ? "hidden" : "shown"} first`;
      const win = kind === "panel" ? SIDE + 300 + 500 : 1100;
      const p = await openState(open, s, layout, kind === "panel" ? 300 : 836, { size: [win, HEIGHT], ...(hidden ? { ls: { "aiwb.widths": JSON.stringify({ side: SIDE, panel: 300 }), "aiwb.side": "hidden" } } : {}) });
      await drawn(p.page, s, name);
      const railed = () => byTid(p.page, "side-rail").count().then((n) => n > 0);
      if (await railed() !== hidden) fail(`${name}: the page opened with the sidebar ${hidden ? "shown" : "hidden"}`);
      const wideNow = (want) => (kind === "panel" ? 300 : win - (want ? RAIL : SIDE)); // (a chat page: the window less the sidebar, or less the rail)
      if (more) await openMore(p.page, name);
      const r = await sampled(p.page, name, async () => {
        for (const want of [!hidden, hidden]) {
          if (more) await page_escape(p.page); // (the popup is a layer over the page: closed, ⌘B is the page's)
          await p.page.keyboard.press("ControlOrMeta+b");
          if (!await until(async () => await railed() === want && Math.abs(await paneWidth(p.page, kind) - wideNow(want)) < 1, 10000)) fail(`${name}: ⌘B did not ${want ? "hide" : "show"} the sidebar`);
          await frame(p.page);
          if (more && !await byTid(p.page, "more-pop").count()) await openMore(p.page, name);
        }
      });
      const [least, most] = range(r, "box");
      // (a plain chat's page is a column of 780 px at most, and the desktop layout's page is wider: the box keeps its width as the page's does)
      if (most !== least) fail(`${name}: the box went from ${least} to ${most} px: it keeps its width`);
      await close(p);
    }
    note('⌘B beside a page and a panel, "more" closed and open, the sidebar shown first and hidden first: every frame fitted');

    { // the page's zoom: a window zoomed to 125 % is a fifth narrower, at a pixel ratio of 1.25. The panel keeps its 400 px, so nothing but
      // the zoom itself tells the toolbar.
      const s = state("board-new"), p = await openState(open, s, layout, 400, { size: [1600, HEIGHT] }), name = "a change of the page's zoom"; // (a window wide enough that the panel still has its 400 px after the zoom)
      const width = p.page.viewportSize().width;
      const kept = () => p.page.evaluate(() => window.__aiwbWidths?.count ?? -1);
      await p.page.setViewportSize({ width: width + 40, height: HEIGHT });
      await frame(p.page);
      const base = await kept();
      await p.page.setViewportSize({ width, height: HEIGHT });
      await frame(p.page);
      const resized = (await kept()) - base;
      const cdp = await p.ctx.newCDPSession(p.page);
      await sampled(p.page, name, async () => {
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: Math.round(width / 1.25), height: Math.round(HEIGHT / 1.25), deviceScaleFactor: 1.25, mobile: false });
        if (!await until(() => p.page.evaluate((w) => devicePixelRatio === 1.25 && innerWidth < w, width), 10000)) fail(`${name}: the page did not take the zoom`);
        await until(async () => (await kept()) - base - resized >= 5, 5000);
      });
      const zoomed = (await kept()) - base - resized;
      if (Math.abs(await paneWidth(p.page, "panel") - 400) > 1) fail(`${name}: the panel is ${await paneWidth(p.page, "panel")} px wide after it, not its 400`);
      if (base < 0) fail(`${name}: the build shows no counter of the kept widths (window.__aiwbWidths): it is not a build for the checks`);
      if (resized > 0) fail(`${name}: a resize of the window with every width kept measured ${resized} controls again: the toolbar measured without need, and the count tells nothing`);
      if (zoomed < 5) fail(`${name}: after it the toolbar measured ${zoomed} controls, ${resized} after a mere resize: it did not measure its controls again`);
      await fits(p.page, `${name}, after it`);
      await close(p);
      note(`a change of the page's zoom beside a panel that keeps its width: the toolbar measured its controls again (${zoomed} widths kept, ${resized} after a resize), every frame fitted`);
    }
  }
}, { viewports, page: false });

async function page_escape(page, closed = true) {
  await page.keyboard.press("Escape");
  if (closed) await until(async () => !await byTid(page, "more-pop").count(), 5000);
}
