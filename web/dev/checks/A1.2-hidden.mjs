// Proves A1.2: hidden by the control in its head and by ⌘B, the sidebar's pane is not drawn, and the stage (with a
// chat panel: the panel and the stage) is the window less the rail. In each view of G1's table that is left (a board
// with the panel and alone, a plain chat, Home, the page while it connects) the rail's control is the element at its own centre and
// lies over no glyph, crumb or bar of the view. Shown again, the pane has its saved width. After a reload the sidebar is
// hidden in the first frame React draws, and in every frame after it: the frame sampler runs from the page's first frame. Once, as
// the sampler's own proof: a sidebar that is saved as shown is drawn in the first frame.
// The rail in each of the four flavours is P7.1's.
// Ports dev/checks/A1.2-hidden.mjs (U3) to the new build, at desktop and tablet (A-LY-08, A-LY-09 are wide only). Deviations: the
// widths are the ones the window holds (SIDE/PANEL: 300 and 400 on the desktop, the least of each, 200 and 300, on the tablet's 834);
// the selectors are the testIDs of the shell (`app`, `side-pane`, `side-rail`, `side-show`, `side-hide`, `board-panel`, `board-stage`,
// `chat-page`, `home`, `guard-fail`). The view "a view that failed to draw" (a message whose text is no text: the chat view's thread throws
// as it is drawn, and the stage's guard stands in its place, `guard-fail`) was left to S4, whose thread is what throws: S4 added it back to
// VIEWS, with the old check's seed and `guard-fail` as the part seen.
// Besides the old check (A-SB-05, A-KY-08): the control that hides the sidebar and the rail's that shows it are titled with the page's platform key.
import { check, mockEval, sampleFrames, seed, until } from "../shot.mjs";
import { IDS, byTid, press } from "./sel.mjs";

export const viewports = ["desktop", "tablet"];

const tid = (id) => `[data-testid="${id}"]`;

/** In the page: where the panes are, and what the rail's control lies over. */
function layout() {
  const R = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
  const T = (id) => `[data-testid="${id}"]`;
  const app = document.querySelector(T("app"));
  const kid = (id) => { const e = app.querySelector(":scope > " + T(id)); return e && e.getClientRects().length ? R(e) : null; };
  const stageOf = () => { for (const id of ["board-stage", "chat-page", "home", "guard-fail"]) { const r = kid(id); if (r) return r; } return null; };
  const ctl = document.querySelector(T("side-rail") + " " + T("side-show")), c = ctl && R(ctl);
  const at = c && document.elementFromPoint(c.l + c.w / 2, c.t + c.h / 2);
  const name = (e) => "[" + (e.dataset?.testid ?? e.tagName.toLowerCase()) + "]";
  const over = c ? [...document.querySelectorAll([T("chat-head"), T("board-crumb"), T("board-bar"), T("home-glyphs"), T("home-spin"), T("board-stage"), T("chat-page"), T("board-panel"), T("guard-fail")].join(", "))]
    .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.left < c.r && r.right > c.l && r.top < c.b && r.bottom > c.t; }).map(name) : [];
  return {
    cls: app.dataset.side, first: name(app.firstElementChild),
    pane: kid("side-pane"), rail: kid("side-rail"), panel: kid("board-panel"), stage: stageOf(), ctl: c,
    hit: !ctl ? "no control" : at === ctl || ctl.contains(at) ? "ok" : at ? "covered by " + name(at) : "outside the window",
    over, w: innerWidth, h: innerHeight, scroll: document.documentElement.scrollWidth - innerWidth,
    saved: localStorage.getItem("aiwb.side"),
  };
}

/** For sampleFrames: null until React has drawn the window; then whether the sidebar's pane is drawn in the frame. */
function sideProbe() {
  const app = document.querySelector('[data-testid="app"]');
  if (!app) return null;
  const pane = app.querySelector(':scope > [data-testid="side-pane"]'), rail = app.firstElementChild;
  const drawn = !!pane && pane.getClientRects().length > 0, railFirst = !!rail?.matches('[data-testid="side-rail"]') && rail.getClientRects().length > 0;
  return { bad: drawn || !railFirst, drawn, rail: railFirst };
}

const near = (a, b) => Math.abs(a - b) <= 0.5;

await check("A1.2 the sidebar hidden: the stage has the window less the rail, in every view and from the first frame", async ({ url, viewport, open, fail, note }) => {
  await seed(url, "A1");
  const tablet = viewport === "tablet";
  const SIDE = tablet ? 200 : 300, PANEL = tablet ? 300 : 400;
  const VIEWS = [
    { name: "a board with its panel", sel: { board: "b_arch", chat: "c_board" }, see: [tid("board-panel"), tid("chat-head")], panel: true },
    { name: "a board alone", sel: { board: "b_arch" }, see: [tid("board-stage"), tid("board-crumb")] },
    { name: "a plain chat", sel: { chat: "c_plain" }, see: [tid("chat-page"), tid("chat-head")] },
    { name: "Home", sel: {}, see: [tid("home"), tid("home-glyphs")] },
    // (the stream is cut before the page opens: it has no word of the server, and nothing to show but that it waits)
    { name: "the page while it connects", sel: {}, see: [tid("home"), tid("home-spin")], mock: "flags.streamDown = true; dropStreams();", undo: "delete flags.streamDown;" },
    // (a message whose text is no text: the thread throws as it is drawn, and the view's guard stands in the stage's place)
    { name: "a view that failed to draw", sel: { chat: "c_A1_broken" }, see: [tid("guard-fail")],
      mock: 'chats.c_A1_broken = chat("c_A1_broken", { name: "Broken" }); items.c_A1_broken = [{ kind: "user", text: { no: "text" } }]; send({ type: "snapshot", ...snapshot() });',
      undo: 'delete chats.c_A1_broken; delete items.c_A1_broken; send({ type: "snapshot", ...snapshot() });' },
  ];
  const seen = (page, v) => page.waitForSelector(v.see.join(" "), { timeout: 15000, state: "attached" });
  const hidden = (v, how, m) => {
    const say = (line) => fail(`${v.name}, hidden by ${how}: ${line}`);
    if (m.pane) say(`the sidebar's pane is drawn, ${m.pane.w} px wide`);
    if (!m.rail || !m.stage) return say(`the page has ${m.rail ? "a" : "no"} rail and ${m.stage ? "a" : "no"} stage`);
    if (m.first !== "[side-rail]") say(`the first child of the window is ${m.first}, not the rail`);
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
  const reload = async (page, v) => {
    const sampler = await sampleFrames(page, sideProbe, { fromLoad: true });
    await page.reload({ waitUntil: "domcontentloaded" });
    await seen(page, v);
    await page.waitForFunction(() => window.__frames?.values.length > 2, null, { timeout: 15000 });
    return sampler.stop();
  };
  const isHidden = (page) => page.evaluate(() => document.querySelector('[data-testid="app"]').dataset.side === "hidden");

  const told = [];
  for (const v of VIEWS) {
    if (v.mock) await mockEval(v.mock, url);
    const { ctx, page } = await open({ sel: v.sel, ls: { "aiwb.widths": JSON.stringify({ side: SIDE, panel: PANEL }) }, wait: tid("app") });
    try {
      await seen(page, v);
      const before = await page.evaluate(layout);
      if (before.cls !== "shown" || before.rail || !before.pane || !near(before.pane.w, SIDE)) fail(`${v.name}: before anything is hidden the window says "${before.cls}", the rail is ${before.rail ? "drawn" : "not drawn"} and the sidebar's pane ${before.pane ? before.pane.w + " px wide" : "not drawn"}`);

      // (A-SB-05, A-KY-08) the control's title carries the platform's key, and so does the rail's after it
      const key = await page.evaluate(() => (/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘B" : "Ctrl+B"));
      const hideTitle = await byTid(page, "side-hide").first().getAttribute("title");
      if (hideTitle !== `Hide sidebar (${key})`) fail(`${v.name}: the control that hides the sidebar is titled "${hideTitle}", not "Hide sidebar (${key})"`);
      await press(page, byTid(page, "side-hide").first());
      await page.waitForSelector(tid("side-rail") + " " + tid("side-show"), { timeout: 10000 });
      const showTitle = await byTid(page, "side-show").first().getAttribute("title");
      if (showTitle !== `Show sidebar (${key})`) fail(`${v.name}: the rail's control is titled "${showTitle}", not "Show sidebar (${key})"`);
      await seen(page, v);
      const byControl = hidden(v, "the head's control", await page.evaluate(layout));

      await page.keyboard.press("ControlOrMeta+b");
      if (!await until(async () => !(await isHidden(page)), 10000)) fail(`${v.name}: ⌘B did not show the hidden sidebar`);
      shown(v, await page.evaluate(layout));

      await page.keyboard.press("ControlOrMeta+b");
      if (!await until(() => isHidden(page), 10000)) fail(`${v.name}: ⌘B did not hide the sidebar`);
      const byKey = hidden(v, "⌘B", await page.evaluate(layout));
      if (byControl !== byKey) fail(`${v.name}: the stage is ${byControl} px wide hidden by the control and ${byKey} px by the key`);

      const r = await reload(page, v);
      if (!r.values.length) fail(`${v.name}: after a reload the sampler saw no frame with the window drawn`);
      if (r.bad.length) fail(`${v.name}: after a reload ${r.bad.length} of the ${r.values.length} frames React drew had ${r.bad[0].drawn ? "the sidebar's pane drawn" : "no rail"}${r.values[0].bad ? ", the first among them" : ""}`);
      told.push(`${v.name} ${byKey} px (${r.values.length} of ${r.frames} frames)`);

      if (v.name === "a plain chat") { // the sampler's proof: saved as shown, the pane is in the first frame
        await page.keyboard.press("ControlOrMeta+b");
        if (!await until(() => page.evaluate(() => localStorage.getItem("aiwb.side") === "shown"), 10000)) fail("⌘B after the reload did not show the sidebar");
        const s = await reload(page, v);
        if (!s.values.length || s.values.some((x) => !x.drawn || x.rail)) fail(`reloaded with the sidebar saved as shown, ${s.values.filter((x) => !x.drawn).length} of ${s.values.length} frames had no sidebar and ${s.values.filter((x) => x.rail).length} a rail`);
        else note(`reloaded with the sidebar shown: its pane is drawn in all ${s.values.length} frames, from the first`);
      }
    } finally { await ctx.close(); if (v.undo) await mockEval(v.undo, url); }
  }
  note(`the stage hidden, and the frames after a reload with no sidebar: ${told.join("; ")}`);
}, { viewports, page: false, allowConsole: [/this page could not be shown/, /\.trim is not a function/] }); // (the view that failed to draw says so in the console, on purpose)
