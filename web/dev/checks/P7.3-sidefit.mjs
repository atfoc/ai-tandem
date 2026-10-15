// P7.3 ported (AD-80; package K3): the composer's fit while the sidebar is shown and hidden. A2.2 presses ⌘B beside a few states; here it is every
// state of seed A2.
//   Every chat composer (a chat page of the desktop layout, a window of 1100 px; a chat panel of 300 px beside the board): the sidebar is hidden and
//   shown twice, by ⌘B both ways and by the head's control and the rail's. In every frame, read by the driver's frame sampler after the frame's
//   paint, no control ends past the box or past the toolbar's row, Send is the element at its own centre, the document does not scroll sideways,
//   and Stop and Send have their width. A panel keeps its width, and its toolbar every control, in every frame. Hidden and shown again, each also
//   fits at rest, as A2.2 measures it.
//   Loaded with the sidebar hidden: every chat state fits, and five of them from the first frame that has the composer.
//   With "more" open: the popup stays open through the round and no control leaves it for the toolbar.
//   ⌘B six times in a row, each press as soon as the frame after the one before it was read, with no width waited for: every frame fits, and the
//   sidebar ends shown.
//   A drag of the sidebar's own resizer, which narrows the stage beside a panel and widens it again: every frame fits.
// Ports dev/checks/P7.3-sidefit.mjs with its states and assertions. What changed with the layout (AD-72): a chat page narrower than 700 px is the
// phone layout, which has no sidebar beside the page, and from 700 to 1099 px the sidebar is a pane over the page, so the old "page of 300 px beside
// the sidebar" cannot be made; the pages here are the desktop layout's (836 px with the sidebar, 1060 with the rail), where the column of 780 px keeps
// its width, and the panels are the 300 px ones beside the board, which is where a toolbar is tight. So no page "takes controls back from more"
// here (A2.2's windows hold that); it is that nothing moves, and no frame is unfitted, while the sidebar goes and comes. The "more" popup is a layer
// over the page, shut by a press elsewhere: the keys of the window are heard under it.
// A frame in which an overlay is open has its backdrop over the page: Send is not held to be within reach in it. Desktop only (a keyboard and a mouse).
import { check, dragResizer, sampleFrames, seed, until } from "../shot.mjs";
import { HEIGHT, MORE, POP, RAIL, SIDE, fitProbe, frame, measureComposer, openState, playable, rowOf } from "./composer.mjs";
import { byTid, press, tidSel } from "./sel.mjs";

export const viewports = ["desktop"];

const SEND = 28; // px: Stop and Send, which never shrink
const HOW = { key: "⌘B", control: "the head's control", rail: "the rail's control" };
const PANEL = 300, PAGE = 1100 - SIDE; // (the page beside the sidebar of a window of 1100 px)
const DRAG = 120;

await check("P7.3 the composer fits its box while the sidebar is shown and hidden", async ({ url, layout, open, fail, note }) => {
  const states = (await seed(url, "A2")).filter((s) => playable(s, layout));
  const state = (id) => states.find((s) => s.id === id) ?? (() => { throw new Error(`the seed has no state ${id}`); })();
  const width = (s) => (s.pane[0] === "panel" ? PANEL : PAGE);
  /** A state's page: beside the sidebar, or beside the rail of a hidden one. */
  const page = async (s, { hidden = false } = {}) => {
    const p = await openState(open, s, layout, width(s), hidden ? { ls: { "aiwb.widths": JSON.stringify({ side: SIDE, panel: PANEL }), "aiwb.side": "hidden" } } : {});
    await frame(p.page);
    return p;
  };
  const close = async ({ ctx }) => { await ctx.close(); };
  const railed = (p) => byTid(p, "side-rail").count().then((n) => n > 0);
  const paneWidth = (p, kind) => p.evaluate((id) => document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect().width, kind === "panel" ? "board-panel" : "chat-page");
  const winWidth = (s) => (s.pane[0] === "panel" ? PANEL : 1100); void winWidth;
  /** Hides the sidebar or shows it, by ⌘B, the head's control or the rail's, and waits for the pane to have its width. */
  const toggle = async (p, name, how, want, s, now) => {
    const kind = s.pane[0];
    if (how === "key") await p.keyboard.press("ControlOrMeta+b"); else await press(p, byTid(p, how === "rail" ? "side-show" : "side-hide").first());
    if (!await until(async () => await railed(p) === want && (kind === "panel" || Math.abs(await paneWidth(p, kind) - now(want)) < 1), 10000)) fail(`${name}: ${HOW[how]} did not ${want ? "hide" : "show"} the sidebar (the ${kind} is ${await paneWidth(p, kind)} px)`);
    await frame(p);
  };
  /** One measurement at rest, as A2.2's. */
  const fits = async (p, name) => {
    await frame(p);
    const all = (await measureComposer(p)).filter((c) => !c.none);
    if (all.length !== 1) return fail(`${name}: ${all.length} composers on the page`);
    const m = all[0];
    if (m.past) fail(`${name}: ${m.past} past the box, the furthest by ${m.furthest} px: ${m.over.map((o) => `${o.el} +${o.overBox}`).join("; ")}`);
    if (m.send !== "ok") fail(`${name}: Send is ${m.send}`);
    if (m.docScroll > 0) fail(`${name}: the document scrolls ${m.docScroll} px sideways`);
    if (m.boxOverPane > 0) fail(`${name}: the box is ${m.boxOverPane} px past its pane`);
    const row = await rowOf(p);
    if (row && row.lines > 4) fail(`${name}: the toolbar's controls are not on one line: their centres are ${row.lines} px apart`);
    if (row && row.out > 0.5) fail(`${name}: a control of the toolbar ends ${row.out} px past its row`);
    if (row && (!row.send.length || row.send.some((w) => Math.abs(w - SEND) > 0.5))) fail(`${name}: Stop and Send are ${row.send.join(" and ") || "not in the row"} px wide, not ${SEND} each`);
    return m;
  };
  /** Samples the page's frames while body runs, and holds every one of them. */
  const sampled = async (p, name, body, o) => {
    const sampler = await sampleFrames(p, fitProbe, o);
    try { await body(); await p.waitForFunction(() => window.__frames?.values.length > 3, null, { timeout: 15000 }); await frame(p); } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    const r = await sampler.stop(), bad = r.values.filter((v) => (v.bad && (v.past > 0 || v.scroll > 0 || !v.list)) || v.out > 0.5 || Math.abs(v.send - SEND) > 0.5);
    if (bad.length) fail(`${name}: ${bad.length} of ${r.values.length} frames are not fitted, the first ${JSON.stringify(bad[0])}`);
    return r;
  };
  const range = (r, k) => [Math.min(...r.values.map((v) => v[k])), Math.max(...r.values.map((v) => v[k]))];
  const toolbar = (v) => `${v.chips} chips${v.ring ? ", the meter as its ring" : ""}${v.held ? `, ${v.held} in "more"` : ""}`;

  // ---- every chat composer: hidden and shown, by the key and by the two controls
  let frames = 0;
  for (const s of states) {
    const kind = s.pane[0], name = `${s.id}, a ${kind === "panel" ? "panel of 300 px" : "chat page of the desktop layout"}`, there = (want) => 1100 - (want ? RAIL : SIDE);
    const p = await page(s);
    try {
      const first = await p.page.evaluate(`(${fitProbe})()`);
      const r = await sampled(p.page, name, async () => {
        for (const [away, back] of [["key", "key"], ["control", "rail"]]) {
          await toggle(p.page, name, away, true, s, there);
          await fits(p.page, `${name}, the sidebar hidden by ${HOW[away]}`);
          await toggle(p.page, name, back, false, s, there);
          await fits(p.page, `${name}, the sidebar shown again by ${HOW[back]}`);
        }
      });
      frames += r.values.length;
      const last = r.values.at(-1), shown = r.values.filter((v) => !v.hidden), away = r.values.filter((v) => v.hidden);
      if (!first || first.hidden || !away.length || !shown.length || last.hidden) fail(`${name}: the sampler read ${r.values.length} frames, ${away.length} of them with the sidebar hidden, after a page that had it ${first?.hidden ? "hidden" : "shown"}: not the way there and back`);
      else {
        // (a panel keeps its width, and so does a page's column: the box does not move, and so does not the toolbar)
        const [least, most] = range(r, "box");
        if (most !== least || first.box !== least) fail(`${name}: the box went from ${least} to ${most} px, ${first.box} before: it keeps its width`);
        const other = r.values.find((v) => toolbar(v) !== toolbar(first));
        if (other) fail(`${name}: beside the sidebar the toolbar had ${toolbar(first)}, and in another frame ${toolbar(other)}`);
      }
    } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    await close(p);
  }
  note(`${states.length} chat composers, the sidebar hidden and shown twice each (⌘B; the head's control and the rail's): ${frames} frames, all fitted, the toolbar as it was`);

  // ---- loaded with the sidebar hidden
  for (const s of states) {
    const kind = s.pane[0], name = `${s.id}, loaded with the sidebar hidden, a ${kind}`, p = await page(s, { hidden: true });
    try {
      if (!await railed(p.page)) fail(`${name}: the page opened with the sidebar shown`);
      await fits(p.page, name);
    } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    await close(p);
  }
  for (const id of ["plain-new", "plain-remote-started-long", "plain-noagent", "board-new", "board-busy"]) {
    const s = state(id), name = `${id}, a load with the sidebar hidden`, p = await page(s, { hidden: true });
    const r = await sampled(p.page, name, async () => {
      await p.page.reload({ waitUntil: "domcontentloaded" });
      await p.page.waitForFunction(() => window.__frames?.values.length > 3, null, { timeout: 15000 });
    }, { fromLoad: true });
    if (r.frames <= r.values.length) fail(`${name}: the sampler did not run from before the composer was drawn (${r.values.length} values in ${r.frames} frames)`);
    if (r.values.some((v) => !v.hidden)) fail(`${name}: ${r.values.filter((v) => !v.hidden).length} of ${r.values.length} frames had no rail`);
    await close(p);
  }
  note(`${states.length} chat composers loaded beside the rail: each fits, five of them from the first frame that has the composer`);

  // ---- with "more" open: the popup stays, and gives nothing back until it closes
  for (const id of ["board-new", "board-long", "board-busy", "board-started"]) {
    const s = state(id), name = `${id}, "more" open`, p = await page(s);
    try {
      await press(p.page, p.page.locator(MORE));
      if (!await until(() => p.page.locator(POP).count(), 5000)) throw new Error('the "more" chip did not open its popup');
      const held = await byTid(p.page, "more-row").count();
      const r = await sampled(p.page, name, async () => {
        await toggle(p.page, name, "key", true, s, () => 0);
        await toggle(p.page, name, "key", false, s, () => 0);
      });
      const shut = r.values.findIndex((v) => !v.more), back = r.values.findIndex((v) => v.held < held);
      if (shut >= 0) fail(`${name}: the popup closed, in frame ${shut} of ${r.values.length}`);
      if (back >= 0) fail(`${name}: a control left the open popup, in frame ${back}: it held ${held}, then ${r.values[back].held}`);
      if (range(r, "box")[1] !== range(r, "box")[0]) fail(`${name}: the box went from ${range(r, "box").join(" to ")} px: a panel keeps its width`);
      await p.page.keyboard.press("Escape");
      if (!await until(async () => !await p.page.locator(POP).count(), 5000)) fail(`${name}: Esc did not close the popup after the round`);
      await fits(p.page, `${name}, closed after the round`);
    } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    await close(p);
  }
  note('four panels with "more" open through the round: the popup stayed open and held every control it had; every frame fitted');

  // ---- ⌘B six times in a row
  for (const id of ["plain-new", "plain-started-long", "board-new"]) {
    const s = state(id), name = `${id}, ⌘B six times in a row`, p = await page(s);
    try {
      const first = toolbar(await p.page.evaluate(`(${fitProbe})()`));
      const r = await sampled(p.page, name, async () => {
        // (the next press is sent once the frame after this one was read: a key that arrives before the sampler's task is heard first, and the
        // frame it changed would be read as the one after it)
        for (let i = 0; i < 6; i++) { await p.page.keyboard.press("ControlOrMeta+b"); await p.page.evaluate(() => new Promise((ok) => { const n = window.__frames.frames, t = () => (window.__frames.frames > n ? ok() : requestAnimationFrame(t)); requestAnimationFrame(t); })); }
        if (!await until(async () => !await railed(p.page), 10000)) fail(`${name}: the sidebar did not end shown`);
      });
      const turns = r.values.filter((v, i) => i > 0 && v.hidden !== r.values[i - 1].hidden).length;
      if (turns < 4) fail(`${name}: the ${r.values.length} frames sampled show the sidebar going or coming ${turns} times: the presses were not drawn one by one`);
      if (toolbar(r.values.at(-1)) !== first) fail(`${name}: after it the toolbar has ${toolbar(r.values.at(-1))}; before, ${first}`);
      await fits(p.page, `${name}, after it`);
    } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    await close(p);
  }
  note("⌘B six times in a row, three states: every frame fitted, the toolbar as it began");

  // ---- the sidebar's own resizer: the stage beside a panel narrowed and widened again, 3 px a frame, then 40
  for (const id of ["board-new", "board-long"]) {
    const s = state(id), name = `${id}, a drag of the sidebar's resizer`, p = await page(s);
    try {
      const first = toolbar(await p.page.evaluate(`(${fitProbe})()`));
      const r = await sampled(p.page, name, async () => { for (const step of [3, 40]) { await dragResizer(p.page, `${tidSel("side-pane")} ${tidSel("resizer")}`, DRAG, step); await dragResizer(p.page, `${tidSel("side-pane")} ${tidSel("resizer")}`, -DRAG, step); } });
      const side = await p.page.evaluate(() => document.querySelector('[data-testid="side-pane"]').getBoundingClientRect().width);
      if (range(r, "box")[1] !== range(r, "box")[0]) fail(`${name}: the box went from ${range(r, "box").join(" to ")} px: a panel keeps its width`);
      if (toolbar(r.values.at(-1)) !== first) fail(`${name}: after it the toolbar has ${toolbar(r.values.at(-1))}; before, ${first}`);
      if (Math.abs(side - SIDE) > 1) fail(`${name}: after it the sidebar is ${side} px wide, not its ${SIDE}`);
      if (r.values.length < 40) fail(`${name}: the sampler saw ${r.values.length} frames of the drag`);
    } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    await close(p);
  }
  note(`a drag of the sidebar's resizer by ${DRAG} px and back, slowly and fast, two states: every frame fitted`);
  void HEIGHT;
}, { viewports, page: false });
