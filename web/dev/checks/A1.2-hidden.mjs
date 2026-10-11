// Proves A1.2: hidden by the control in its head and by ⌘B, the sidebar's pane is not drawn, and the stage (with a
// chat panel: the panel and the stage) is the window less the rail. In each view of G1's table (a board and a run,
// each with the panel and alone, a run agent's transcript in the panel, a draft run, a plain chat, Home, the page
// while it connects, the server choice of a new whiteboard, a view that failed to draw) the rail's
// control is the element at its own centre and lies over no glyph, crumb or bar of the view. Shown again, the pane
// has its saved width. After a reload the sidebar is hidden in the first frame React draws, and in every frame after
// it: the frame sampler runs from the page's first frame. Once, as the sampler's own proof: a sidebar that is saved
// as shown is drawn in the first frame.
// The rail in each of the four flavours is P7.1's.
import { check, mockEval, openPage, sampleFrames, seed, until } from "../shot.mjs";

const SIDE = 300, PANEL = 400, SIZE = [1280, 800];
const VIEWS = [
  { name: "a board with its panel", sel: { board: "b_arch", chat: "c_board" }, see: ".board-panel .chat-head .crow-glyph", panel: true },
  { name: "a board alone", sel: { board: "b_arch" }, see: ".board-stage .board-bar .board-crumb" },
  { name: "a run with its panel", sel: { run: "r_draft", chat: "c_draft_ask" }, see: ".board-panel .chat-head .crow-glyph", panel: true },
  { name: "a run alone", sel: { run: "r_live" }, see: ".run-stage .run-bar .board-crumb" },
  // (the transcript is of the page alone: after a reload the run is there without it)
  { name: "a run agent's transcript", sel: { run: "r_live" }, see: ".board-panel .agent-foot", panel: true, reloaded: ".run-stage .run-bar .board-crumb",
    open: async (page) => { await page.locator(".run-stage .tl-row", { hasText: "T11" }).first().click(); await page.locator('.run-stage button.link[title="Transcript of T11-work"]').first().click(); } },
  { name: "a draft run", sel: { run: "r_draft" }, see: ".run-stage .run-composer" },
  { name: "a plain chat", sel: { chat: "c_plain" }, see: ".chat-page .chat-head .crow-glyph" },
  { name: "Home", sel: {}, see: "main.home h2" },
  // (the stream is cut before the page opens: it has no word of the server, and nothing to show but that it waits)
  { name: "the page while it connects", sel: {}, see: "main.home > .spin", wait: ".app", mock: "flags.streamDown = true; dropStreams();", undo: "delete flags.streamDown;" },
  // (a draft lives in the page alone: after a reload Home is there again)
  { name: "the server choice", sel: {}, see: "main.board-choice .board-choice-box", open: (page) => page.locator("main.home button", { hasText: "New whiteboard" }).click(), reloaded: "main.home h2" },
  // (a message whose text is no text: the thread throws as it is drawn, and the view's guard stands in the stage's place)
  { name: "a view that failed to draw", sel: { chat: "c_A1_broken" }, see: ".app > .guard-fail",
    mock: 'chats.c_A1_broken = chat("c_A1_broken", { name: "Broken" }); items.c_A1_broken = [{ kind: "user", text: { no: "text" } }]; send({ type: "snapshot", ...snapshot() });',
    undo: 'delete chats.c_A1_broken; delete items.c_A1_broken; send({ type: "snapshot", ...snapshot() });' },
];

/** In the page: where the panes are, and what the rail's control lies over. */
function layout() {
  const R = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
  const one = (s) => { const e = document.querySelector(s); return e && e.getClientRects().length ? R(e) : null; };
  const ctl = document.querySelector(".app > .side-rail .side-show"), c = ctl && R(ctl);
  const at = c && document.elementFromPoint(c.l + c.w / 2, c.t + c.h / 2);
  const name = (e) => "." + String(e.className?.baseVal ?? e.className).trim().split(/\s+/).join(".");
  // what a view has at its top-left (G1's table), and the view itself
  const over = c ? [...document.querySelectorAll(".crow-glyph, .board-crumb, .chat-head, .board-bar, .home-glyphs, .board-choice-box, .spin, .app > main, .app > .board-panel, .app > .guard-fail")]
    .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.left < c.r && r.right > c.l && r.top < c.b && r.bottom > c.t; }).map(name) : [];
  return {
    cls: document.querySelector(".app").className.trim(), first: name(document.querySelector(".app").firstElementChild),
    pane: one(".app > .side-pane"), rail: one(".app > .side-rail"), panel: one(".app > .board-panel"), stage: one(".app > main, .app > .guard-fail"), ctl: c,
    hit: !ctl ? "no control" : at === ctl || ctl.contains(at) ? "ok" : at ? "covered by " + name(at) : "outside the window",
    over, w: innerWidth, h: innerHeight, scroll: document.documentElement.scrollWidth - innerWidth,
    saved: localStorage.getItem("aiwb.side"),
  };
}

/** For sampleFrames: null until React has drawn the window; then whether the sidebar's pane is drawn in the frame. */
function sideProbe() {
  const app = document.querySelector(".app");
  if (!app) return null;
  const pane = app.querySelector(":scope > .side-pane"), rail = app.firstElementChild;
  const drawn = !!pane && pane.getClientRects().length > 0, railFirst = !!rail?.matches(".side-rail") && rail.getClientRects().length > 0;
  return { bad: drawn || !railFirst, drawn, rail: railFirst };
}

const near = (a, b) => Math.abs(a - b) <= 0.5;

await check("A1.2 the sidebar hidden: the stage has the window less the rail, in every view and from the first frame", async ({ url, browser, fail, note }) => {
  await seed(url, "A1");
  const hidden = (v, how, m) => {
    const say = (line) => fail(`${v.name}, hidden by ${how}: ${line}`);
    if (m.pane) say(`the sidebar's pane is drawn, ${m.pane.w} px wide`);
    if (!m.rail || !m.stage) return say(`the page has ${m.rail ? "a" : "no"} rail and ${m.stage ? "a" : "no"} stage`);
    if (m.first !== ".side-rail") say(`the first child of .app is ${m.first}, not the rail`);
    if (!near(m.rail.l, 0) || !near(m.rail.t, 0) || !near(m.rail.b, m.h)) say(`the rail is at ${m.rail.l}, ${m.rail.t} and ends at ${m.rail.b} of ${m.h} px: not the window's left edge from top to bottom`);
    if (!!m.panel !== !!v.panel) say(`the view has ${m.panel ? "a" : "no"} chat panel`);
    const first = m.panel ?? m.stage, widths = m.rail.w + (m.panel?.w ?? 0) + m.stage.w;
    if (!near(first.l, m.rail.r)) say(`the view starts at ${first.l} px, the rail ends at ${m.rail.r}`);
    if (m.panel && (!near(m.stage.l, m.panel.r) || !near(m.panel.w, PANEL))) say(`the panel is ${m.panel.w} px wide and ends at ${m.panel.r}, the stage starts at ${m.stage.l}`);
    if (!near(m.stage.r, m.w) || !near(widths, m.w)) say(`the rail${m.panel ? ", the panel" : ""} and the stage are ${widths} px together and the stage ends at ${m.stage.r}: the window is ${m.w} px wide`);
    if (m.scroll > 0) say(`the document scrolls ${m.scroll} px sideways`);
    if (m.hit !== "ok") say(`the rail's control is ${m.hit} at its own centre`);
    if (m.ctl && (m.ctl.l < m.rail.l || m.ctl.r > m.rail.r || m.ctl.w < 20 || m.ctl.h < 20)) say(`the rail's control, ${m.ctl.w} by ${m.ctl.h} px from ${m.ctl.l} to ${m.ctl.r}, is not a control inside the rail (${m.rail.l} to ${m.rail.r})`);
    if (m.over.length) say(`the rail's control lies over ${m.over.join(", ")}`);
    if (m.saved !== "hidden") say(`localStorage "aiwb.side" is ${JSON.stringify(m.saved)}`);
    return m.stage.w;
  };
  const shown = (v, m) => {
    const say = (line) => fail(`${v.name}, shown again: ${line}`);
    if (m.rail) say("the rail is still drawn");
    if (!m.pane || !near(m.pane.l, 0) || !near(m.pane.w, SIDE)) say(`the sidebar's pane is ${m.pane ? `${m.pane.w} px wide at ${m.pane.l}` : "not drawn"}: its saved width is ${SIDE}`);
    const first = m.panel ?? m.stage;
    if (m.pane && first && !near(first.l, m.pane.r)) say(`the view starts at ${first.l} px, the sidebar ends at ${m.pane.r}`);
    if (m.stage && !near(m.stage.r, m.w)) say(`the stage ends at ${m.stage.r} of ${m.w} px`);
    if (m.saved !== "shown") say(`localStorage "aiwb.side" is ${JSON.stringify(m.saved)}`);
  };
  /** A reload, sampled from the page's first frame; answers the frames in which React had drawn the window. */
  const reload = async (page, see) => {
    const sampler = await sampleFrames(page, sideProbe, { fromLoad: true });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(see, { timeout: 15000 });
    await page.waitForFunction(() => window.__frames?.values.length > 2, null, { timeout: 15000 });
    return sampler.stop();
  };

  const told = [];
  for (const v of VIEWS) {
    if (v.mock) await mockEval(v.mock, url);
    const { ctx, page } = await openPage({ url, browser, sel: v.sel, size: SIZE, ls: { "aiwb.widths": JSON.stringify({ side: SIDE, panel: PANEL }) }, ...(v.wait ? { wait: v.wait } : {}) });
    try {
      await v.open?.(page);
      await page.waitForSelector(v.see, { timeout: 15000 });
      const before = await page.evaluate(layout);
      if (before.cls !== "app" || before.rail || !before.pane || !near(before.pane.w, SIDE)) fail(`${v.name}: before anything is hidden .app is "${before.cls}", the rail is ${before.rail ? "drawn" : "not drawn"} and the sidebar's pane ${before.pane ? before.pane.w + " px wide" : "not drawn"}`);

      await page.locator(".side-head .side-hide").click();
      await page.waitForSelector(".app > .side-rail .side-show", { timeout: 10000 });
      await page.waitForSelector(v.see, { timeout: 10000 });
      const byControl = hidden(v, "the head's control", await page.evaluate(layout));

      await page.keyboard.press("ControlOrMeta+b");
      if (!await until(() => page.evaluate(() => !document.querySelector(".side-rail")), 10000)) fail(`${v.name}: ⌘B did not show the hidden sidebar`);
      shown(v, await page.evaluate(layout));

      await page.keyboard.press("ControlOrMeta+b");
      if (!await until(() => page.evaluate(() => !!document.querySelector(".side-rail")), 10000)) fail(`${v.name}: ⌘B did not hide the sidebar`);
      const byKey = hidden(v, "⌘B", await page.evaluate(layout));
      if (byControl !== byKey) fail(`${v.name}: the stage is ${byControl} px wide hidden by the control and ${byKey} px by the key`);

      const r = await reload(page, v.reloaded ?? v.see);
      if (!r.values.length) fail(`${v.name}: after a reload the sampler saw no frame with the window drawn`);
      if (r.bad.length) fail(`${v.name}: after a reload ${r.bad.length} of the ${r.values.length} frames React drew had ${r.bad[0].drawn ? "the sidebar's pane drawn" : "no rail"}${r.values[0].bad ? ", the first among them" : ""}`);
      told.push(`${v.name} ${byKey} px (${r.values.length} of ${r.frames} frames)`);

      if (v.name === "a plain chat") { // the sampler's proof: saved as shown, the pane is in the first frame
        await page.keyboard.press("ControlOrMeta+b");
        if (!await until(() => page.evaluate(() => localStorage.getItem("aiwb.side") === "shown"), 10000)) fail("⌘B after the reload did not show the sidebar");
        const s = await reload(page, v.see);
        if (!s.values.length || s.values.some((x) => !x.drawn || x.rail)) fail(`reloaded with the sidebar saved as shown, ${s.values.filter((x) => !x.drawn).length} of ${s.values.length} frames had no sidebar and ${s.values.filter((x) => x.rail).length} a rail`);
        else note(`reloaded with the sidebar shown: its pane is drawn in all ${s.values.length} frames, from the first`);
      }
    } finally { await ctx.close(); if (v.undo) await mockEval(v.undo, url); }
  }
  note(`the stage hidden, and the frames after a reload with no sidebar: ${told.join("; ")}`);
});
