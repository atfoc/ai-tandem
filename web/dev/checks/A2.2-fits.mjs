// Proves A2.2: the composer fits its box. Every state of seed A2 at the widths G1 measured (the chat panel at 300,
// 340, 400 and 480 px, a chat page at 300 to 560) and at a wide one (the
// panel at its most, 760 px; a page of 900), and another branch's alert
// in the header: no control ends past the box, Send is the element at its own centre, and the document does not
// scroll sideways; a chat toolbar's controls are on one line, also where a reason line under them lets the row wrap,
// and none ends past the row itself (the driver measures against the box's border, 9 px further: its padding would
// hide a toolbar fitted a few px too wide); Stop and Send are as wide as in a row with room for everything. Each state is loaded at its narrowest width, where the toolbar measures its controls with the
// most of them to send away, and brought to the others by the window or the panel's resizer.
// Then the same in every frame, read by the driver's frame sampler after the frame's paint: a drag of the panel's
// resizer down and up, a load from the page's first frame, a branch change, a chip's arrival (the popup closed and
// open), a window narrowed and widened with "more" open, and ⌘B with "more" closed and
// open. With "more" open the popup stays open, and no control leaves it for the toolbar, in any frame.
// The box changes width in small steps, which show every width on the way, and in large ones: a fit that came a
// frame late would be past the box by the step, and the box's own padding hides a small one from the measure.
// Last, the page's zoom changes: the widths the toolbar kept are of the old zoom, so it measures its controls again
// (told by the styles it reads to measure one, which a mere resize does not read), and every frame is fitted.
// A frame in which a picker's list is open has that list's backdrop over the page, as before this work: Send is not
// held to be within reach in it (the frames of the pick itself, before its list closes), everything else is.
import { act, check, composerProbe, dragResizer, measureComposer, mockEval, openPage, paneSize, sampleFrames, seed, until } from "../shot.mjs";

const WIDTHS = { panel: [300, 340, 400, 480, 760], page: [300, 340, 400, 480, 560, 900] };
const SIDE = 264, RAIL = 40, HEIGHT = 640;
const SEND = 28; // px: Stop and Send (G1 §Q2), which never shrink
const MORE = ".composer .more-chip", POP = ".composer .more-pop";
// The driver's probe of the composer's fit, and beside it what the check asks of a frame: whether the popup is open,
// how many controls it holds, how many chips the row has, whether the meter is cut to its ring, whether a list is
// open, by how many px a control ends past the row itself, and how wide the narrower of Stop and Send is. (The
// sampler sends its probe as text.)
const probe = { toString: () => `() => {
  const v = (${composerProbe})();
  if (!v) return null;
  const t = document.querySelector(".composer .composer-tools");
  return { ...v, more: !!t.querySelector(".more-pop"), held: t.querySelectorAll(".more-pop > .more-row").length, chips: t.querySelectorAll(":scope > .tchip, :scope > .menu-wrap > .tchip:not(.more-chip)").length,
    ring: !!t.querySelector(":scope > .menu-wrap > .ctx-meter.compact, :scope > .ctx-meter.compact"), list: !!t.querySelector(".menu-backdrop"),
    out: Math.round(Math.max(...[...t.children].filter((e) => !e.matches(".grow, .menu-backdrop")).map((e) => e.getBoundingClientRect().right - t.getBoundingClientRect().right)) * 10) / 10,
    send: Math.min(...[...t.querySelectorAll(":scope > .send")].map((e) => e.getBoundingClientRect().width)) };
}` };

await check("A2.2 the composer fits its box, at rest and in every frame", async ({ url, browser, fail, note }) => {
  const states = await seed(url, "A2");
  const state = (id) => states.find((s) => s.id === id) ?? (() => { throw new Error(`the seed has no state ${id}`); })();
  const frame = (page) => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok()))));
  const open = async (s, width, o = {}) => {
    const errors = [];
    const { ctx, page } = await openPage({ url, browser, errors, sel: s.sel, ...paneSize(s.pane[0], width, HEIGHT), wait: ".composer-box .send", ...o });
    await act(page, s.act);
    await page.evaluate(() => document.fonts.ready);
    return { ctx, page, errors };
  };
  const close = async ({ ctx, errors }, name) => { for (const e of errors) fail(`${name}: page error: ${e}`); await ctx.close(); };
  /** The state is drawn: what its entry names is on the page, in the toolbar or, when it is a chip the toolbar has no room for, in the "more" popup. */
  const drawn = async (page, s, name) => {
    if (!await until(async () => await page.locator(s.see).count() || await page.locator(MORE).count(), 10000)) return fail(`${name}: nothing matches ${s.see}, and the toolbar has no "more"`);
    if (await page.locator(s.see).count()) return;
    await page.locator(MORE).click();
    if (!await until(() => page.locator(`${POP} >> ${s.see.replace(/^\.composer /, "")}`).count(), 5000)) fail(`${name}: nothing matches ${s.see}, in the toolbar or in the open "more" popup`);
    await page.keyboard.press("Escape");
    if (!await until(async () => !await page.locator(POP).count(), 5000)) fail(`${name}: Esc did not close the "more" popup`);
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
    const row = await page.evaluate(() => {
      const tools = document.querySelector(".composer .composer-tools");
      if (!tools) return null;
      const kids = [...tools.children].filter((e) => !e.matches(".grow")), mid = kids.filter((e) => !e.matches(".agent-reason")).map((e) => { const r = e.getBoundingClientRect(); return r.top + r.height / 2; });
      return { lines: Math.round(Math.max(...mid) - Math.min(...mid)), out: Math.round(Math.max(...kids.map((e) => e.getBoundingClientRect().right - tools.getBoundingClientRect().right)) * 10) / 10,
        send: [...tools.querySelectorAll(":scope > .send")].map((e) => e.getBoundingClientRect().width) };
    });
    if (row && row.lines > 4) fail(`${name}: the toolbar's controls are not on one line: their centres are ${row.lines} px apart`);
    if (row && row.out > 0.5) fail(`${name}: a control of the toolbar ends ${row.out} px past its row`);
    if (row && (!row.send.length || row.send.some((w) => Math.abs(w - SEND) > 0.5))) fail(`${name}: Stop and Send are ${row.send.join(" and ") || "not in the row"} px wide, not ${SEND} each`);
    return m;
  };
  const paneWidth = (page, kind) => page.evaluate((sel) => document.querySelector(sel)?.getBoundingClientRect().width, kind === "panel" ? ".board-panel" : ".chat-page");
  /** Brings the pane to a width: the panel by its resizer, a page by the window. */
  const widen = async (page, kind, to, name) => {
    // (the window grows first where the panel's most needs it: a drag leaves the stage its least)
    if (kind === "panel" && page.viewportSize().width < SIDE + to + 500) await page.setViewportSize({ width: SIDE + to + 500, height: HEIGHT });
    if (kind === "panel") await dragResizer(page, ".board-panel .resizer", to - await paneWidth(page, kind), 20);
    else await page.setViewportSize({ width: SIDE + to, height: HEIGHT });
    if (!await until(async () => Math.abs(await paneWidth(page, kind) - to) < 1, 5000)) fail(`${name}: the ${kind} is ${await paneWidth(page, kind)} px wide, not ${to}`);
  };

  // ---- at rest: every state at G1's widths
  let measured = 0;
  for (const s of states) {
    const [kind] = s.pane, widths = WIDTHS[kind];
    const p = await open(s, widths[0]);
    try {
      await drawn(p.page, s, `${s.id} at ${widths[0]} px`);
      for (const w of widths) {
        if (w !== widths[0]) await widen(p.page, kind, w, `${s.id} at ${w} px`);
        if (await fits(p.page, `${s.id} at ${w} px`)) measured++;
      }
    } catch (e) { fail(`${s.id}: ${e.message.split("\n")[0]}`); }
    await close(p, s.id);
  }
  { // another branch's alert in the header, a state the seed has not
    const s = state("plain-branches"), p = await open(s, 300);
    await mockEval(`setSession(${JSON.stringify(s.sel.chat)}, "alt", { status: "approval" });`, url);
    if (!await until(() => p.page.locator(".fk-alert.asks").count(), 10000)) fail("another branch's alert: the header does not show it");
    for (const w of WIDTHS.page) { await widen(p.page, "page", w, `another branch's alert at ${w} px`); if (await fits(p.page, `another branch's alert at ${w} px`)) measured++; }
    await close(p, "another branch's alert");
    await seed(url, "A2");
  }
  note(`${measured} measurements of ${states.length} states at rest: nothing past the box`);

  // ---- in every frame
  /** Samples the page's frames while body runs, and holds every one of them: nothing past the box, Send at its centre, no sideways scroll, Stop and Send at their width. */
  const sampled = async (page, name, body, o) => {
    const sampler = await sampleFrames(page, probe, o);
    try { await body(); await page.waitForFunction(() => window.__frames?.values.length > 3, null, { timeout: 15000 }); await frame(page); } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    const r = await sampler.stop(), bad = r.values.filter((v) => (v.bad && (v.past > 0 || v.scroll > 0 || !v.list)) || v.out > 0.5 || Math.abs(v.send - SEND) > 0.5);
    if (bad.length) fail(`${name}: ${bad.length} of ${r.values.length} frames are not fitted, the first ${JSON.stringify(bad[0])}`);
    return r;
  };
  const range = (r, k) => [Math.min(...r.values.map((v) => v[k])), Math.max(...r.values.map((v) => v[k]))];
  /** Opens the "more" popup; answers how many controls it holds. */
  const openMore = async (page, name) => {
    await page.locator(MORE).click();
    if (!await until(() => page.locator(POP).count(), 5000)) { fail(`${name}: the "more" chip did not open its popup`); return 0; }
    return page.locator(`${POP} > .more-row`).count();
  };
  /** While the popup was open: it never closed, and no control left it. */
  const kept = (r, name) => {
    const closed = r.values.findIndex((v) => !v.more), back = r.values.findIndex((v, i) => i > 0 && v.held < r.values[i - 1].held);
    if (closed >= 0) fail(`${name}: the "more" popup closed, in frame ${closed} of ${r.values.length}`);
    if (back >= 0) fail(`${name}: a control left the open popup, in frame ${back}: it held ${r.values[back - 1].held}, then ${r.values[back].held}`);
  };

  // a drag of the panel's resizer, down to the least width and back up: 3 px a frame, then 45
  for (const id of ["board-new", "board-started", "board-busy", "board-move", "board-long"]) {
    const s = state(id), p = await open(s, 480), name = `${id}, a drag of the panel's resizer`;
    await drawn(p.page, s, name);
    const r = await sampled(p.page, name, async () => { for (const step of [3, 45]) { await dragResizer(p.page, ".board-panel .resizer", -180, step); await dragResizer(p.page, ".board-panel .resizer", 180, step); } });
    const [least, most] = range(r, "box"), [fewest, chips] = range(r, "chips"), first = r.values[0], last = r.values.at(-1);
    if (least !== 275 || most < 440) fail(`${name}: the box went from ${most} to ${least} px, not from some 455 to 275`);
    if (new Set(r.values.map((v) => v.box)).size < 40) fail(`${name}: the sampler saw ${new Set(r.values.map((v) => v.box)).size} widths of the box: not every step of the drag`);
    if (!r.values.some((v, i) => i > 0 && Math.abs(v.box - r.values[i - 1].box) >= 40)) fail(`${name}: no frame of the drag had a box 40 px narrower or wider than the frame before it`);
    if (fewest >= chips && !r.values.some((v) => v.ring !== first.ring)) fail(`${name}: the toolbar had ${chips} chips and the same meter at every width: nothing left it on the way`);
    if (last.chips !== first.chips || last.ring !== first.ring) fail(`${name}: back at 480 px the toolbar has ${last.chips} chips${last.ring ? " and the ring alone" : ""}, ${first.chips} before${first.ring ? " and the ring alone" : ""}`);
    await close(p, name);
  }
  note("a drag of the panel's resizer from 480 to 300 px and back, slowly and fast, five states: every frame fitted");

  // a load, from the page's first frame: the widths are taken before a frame is shown
  for (const [id, width] of [["board-new", 300], ["plain-new", 300], ["plain-remote-started-long", 340], ["plain-noagent", 300], ["board-busy", 400]]) {
    const s = state(id), p = await open(s, width), name = `${id} at ${width} px, a load`;
    const r = await sampled(p.page, name, async () => {
      await p.page.reload({ waitUntil: "domcontentloaded" });
      await p.page.waitForFunction(() => window.__frames?.values.length > 3, null, { timeout: 15000 });
    }, { fromLoad: true });
    if (r.frames <= r.values.length) fail(`${name}: the sampler did not run from before the composer was drawn (${r.values.length} values in ${r.frames} frames)`);
    await close(p, name);
  }
  note("a load at a narrow width, five states: fitted from the first frame that has the composer");

  { // a branch change: the chat gets the composer of the other branch, whose toolbar is another. By the header's
    // alert, which shows the branch that asks (the tree is a dialog over the page, Send under it).
    const s = state("plain-branches"), chat = JSON.stringify(s.sel.chat);
    for (const width of [300, 400]) {
      await seed(url, "A2");
      const p = await open(s, width), name = `a branch change at ${width} px`;
      const go = async (branch, text) => {
        await mockEval(`setSession(${chat}, ${JSON.stringify(branch)}, { status: "approval" });`, url);
        await p.page.locator(".chat-head .fk-alert.asks").click({ timeout: 10000 });
        if (!await until(() => p.page.locator(".thread .msg.user", { hasText: text }).count(), 10000)) fail(`${name}: the page did not show the branch with "${text}"`);
        await mockEval(`setSession(${chat}, ${JSON.stringify(branch)}, { status: "ready" });`, url);
      };
      const model = () => p.page.locator(".composer .tchip.static[title^='Model and effort'], .composer .more-chip").first().evaluate((e) => e.closest(".composer").querySelector(".tchip.static[title^='Model and effort']")?.textContent ?? "in more");
      const before = await model();
      const r = await sampled(p.page, name, async () => {
        await go("alt", "Is there a faster way?");
        if (await model() === before) fail(`${name}: on the other branch the model's chip says "${before}" as on main`);
        await go("main", "Fix it.");
      });
      if (r.values.length < 10) fail(`${name}: the sampler read ${r.values.length} frames`);
      await close(p, name);
    }
    await seed(url, "A2");
    note("a branch change, to the branch on the long model and back: every frame fitted");
  }

  // a chip's arrival: the server's Cursor catalog comes, and "Loading models…" becomes the model and effort choices
  // (the chat is the lab box's: its change is made on that machine, and reaches the page as that server's event)
  const arrival = `extra.lists.s_lab.catalogs.cursor = cursor; onServer("s_lab", () => { Object.assign(chats.c_A2_loading, cursor.default); send({ type: "chat", chat: chats.c_A2_loading }); }); send({ type: "server_lists", server: "s_lab", lists: extra.lists.s_lab });`;
  for (const [width, more] of [[300, false], [400, false], [560, false], [300, true], [400, true], [480, true]]) {
    await seed(url, "A2");
    const s = state("plain-loading"), p = await open(s, width), name = `a chip's arrival at ${width} px${more ? ', "more" open' : ""}`;
    await drawn(p.page, s, name);
    const held = more ? await openMore(p.page, name) : 0;
    const r = await sampled(p.page, name, async () => {
      await mockEval(arrival, url);
      // (the model's chip is in the toolbar, or in the popup: its row is there when the popup is open, and the chip's title names it when not)
      if (!await until(async () => !await p.page.locator(".composer .tchip", { hasText: "Loading models" }).count()
        && (await p.page.locator('.composer button.tchip[title^="Model"]').count() || /\bmodel\b/.test(await p.page.locator(MORE).getAttribute("title").catch(() => "") ?? "")), 10000)) fail(`${name}: the model's chip did not arrive`);
    });
    if (more) { kept(r, name); if (r.values.at(-1).held < held) fail(`${name}: the popup held ${held} controls, ${r.values.at(-1).held} after the arrival`); }
    await close(p, name);
  }
  await seed(url, "A2");
  note(`a chip's arrival, the popup closed and open: every frame fitted`);

  { // the window narrowed and widened with "more" open: the toolbar gives to the popup, and gets nothing back until it closes
    const s = state("plain-new"), p = await open(s, 560), name = 'the window narrowed with "more" open';
    await drawn(p.page, s, name);
    const held = await openMore(p.page, name), before = await p.page.locator(".composer .composer-tools > .menu-wrap > .tchip:not(.more-chip)").count();
    const size = async (w) => { await p.page.setViewportSize({ width: SIDE + w, height: HEIGHT }); await p.page.evaluate(() => new Promise((ok) => requestAnimationFrame(ok))); };
    const r = await sampled(p.page, name, async () => {
      for (let w = 560; w >= 300; w -= 4) await size(w);
      for (let w = 300; w <= 560; w += 4) await size(w);
      for (const w of [508, 456, 404, 352, 300, 430, 560]) await size(w); // (and in steps of 52 px and more)
    });
    kept(r, name);
    const [least, most] = range(r, "box"), last = r.values.at(-1);
    if (least !== 260 || most !== 520) fail(`${name}: the box went from ${most} to ${least} px, not from 520 to 260`);
    if (range(r, "held")[1] <= held) fail(`${name}: the popup held ${held} controls at 560 px and no more at 300`);
    if (last.held !== range(r, "held")[1] || last.chips >= before) fail(`${name}: widened again with the popup open, it holds ${last.held} controls and the row ${last.chips} chips: something returned`);
    // closed, what fits returns
    await p.page.keyboard.press("Escape");
    if (!await until(async () => !await p.page.locator(POP).count() && await p.page.locator(".composer .composer-tools > .menu-wrap > .tchip:not(.more-chip)").count() === before, 5000)) fail(`${name}: after the popup closed the row has not its ${before} chips again`);
    await fits(p.page, `${name}, closed again`);
    await close(p, name);
    note(`the window narrowed from 560 to 300 px and widened again with "more" open: it held ${held}, then ${last.held} controls, all until it closed; every frame fitted`);
  }

  // ⌘B: the page gets wider by the sidebar less the rail, and narrower again
  for (const [width, hidden, more] of [[400, false, false], [400, false, true], [300, true, true], [300, true, false]]) {
    const s = state("plain-new"), name = `⌘B on a page of ${width} px beside the sidebar${more ? ', "more" open' : ""}, the sidebar ${hidden ? "hidden" : "shown"} first`;
    const p = await open(s, width, hidden ? { ls: { ...paneSize("page", width).ls, "aiwb.side": "hidden" } } : {});
    await drawn(p.page, s, name);
    const railed = () => p.page.evaluate(() => !!document.querySelector(".app > .side-rail"));
    if (await railed() !== hidden) fail(`${name}: the page opened with the sidebar ${hidden ? "shown" : "hidden"}`);
    if (more) await openMore(p.page, name);
    const r = await sampled(p.page, name, async () => {
      for (const want of [!hidden, hidden]) {
        await p.page.keyboard.press("ControlOrMeta+b");
        if (!await until(async () => await railed() === want && Math.abs(await paneWidth(p.page, "page") - (width + (want ? SIDE - RAIL : 0))) < 1, 10000)) fail(`${name}: ⌘B did not ${want ? "hide" : "show"} the sidebar`);
        await frame(p.page);
      }
    });
    const [least, most] = range(r, "box");
    if (most - least !== SIDE - RAIL) fail(`${name}: the box went from ${least} to ${most} px, not by the sidebar less the rail`);
    if (more) kept(r, name);
    else if (range(r, "chips")[0] === range(r, "chips")[1]) fail(`${name}: the toolbar had ${r.values[0].chips} chips at both widths: nothing moved`);
    await close(p, name);
  }
  note('⌘B with "more" closed and open, the sidebar shown first and hidden first: every frame fitted');

  { // the page's zoom: a window zoomed to 125 % is a fifth narrower, at a pixel ratio of 1.25. The panel keeps its
    // 400 px, so nothing but the zoom itself tells the toolbar.
    const s = state("board-new"), p = await open(s, 400), name = "a change of the page's zoom";
    const width = p.page.viewportSize().width;
    await p.page.evaluate(() => { window.__styles = 0; const read = window.getComputedStyle; window.getComputedStyle = function (...a) { window.__styles++; return read.apply(this, a); }; });
    const read = () => p.page.evaluate(() => { const n = window.__styles; window.__styles = 0; return n; });
    await p.page.setViewportSize({ width: width + 40, height: HEIGHT });
    await frame(p.page);
    const resized = await read();
    const cdp = await p.ctx.newCDPSession(p.page);
    await sampled(p.page, name, async () => {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: Math.round(width / 1.25), height: Math.round(HEIGHT / 1.25), deviceScaleFactor: 1.25, mobile: false });
      if (!await until(() => p.page.evaluate((w) => devicePixelRatio === 1.25 && innerWidth < w, width), 10000)) fail(`${name}: the page did not take the zoom`);
    });
    const zoomed = await read();
    if (Math.abs(await paneWidth(p.page, "panel") - 400) > 1) fail(`${name}: the panel is ${await paneWidth(p.page, "panel")} px wide after it, not its 400`);
    if (resized > 3) fail(`${name}: a resize of the window with every width kept read ${resized} styles: the toolbar measured again without need, and the count tells nothing`);
    if (zoomed < resized + 5) fail(`${name}: after it the toolbar read ${zoomed} styles, ${resized} after a mere resize: it did not measure its controls again`);
    await fits(p.page, `${name}, after it`);
    await close(p, name);
    note(`a change of the page's zoom beside a panel that keeps its width: the toolbar measured its controls again (${zoomed} styles read, ${resized} after a resize), every frame fitted`);
  }
});
