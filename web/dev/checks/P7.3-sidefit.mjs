// Proves, on the build that has all six goals, what goals 1 and 2 say together: the composer's fit while the
// sidebar is shown and hidden. A2.2 presses ⌘B beside one state; here it is every state of seed A2.
//   Every chat composer, at its least width (a chat page and a chat panel of 300 px beside the sidebar): the sidebar
//   is hidden and shown twice, by ⌘B both ways and by the head's control and the rail's. In every frame, read by the
//   driver's frame sampler after the frame's paint, no control ends past the box or past the toolbar's row, Send is
//   the element at its own centre, the document does not scroll sideways, and Stop and Send have their width. A page
//   gets the sidebar's width less the rail's and gives it back: what the wider toolbar took from "more" leaves it
//   again, and the toolbar ends as it began. A panel keeps its width, and its toolbar every control, in every frame.
//   Hidden and shown again, each also fits at rest, as A2.2 measures it.
//   The least width beside the rail: every chat state is loaded with the sidebar hidden in a window that leaves its
//   pane 300 px, and fits; five of them from the first frame that has the composer.
//   With "more" open: the popup stays open through the round and no control leaves it for the toolbar.
//   ⌘B six times in a row, each press as soon as the frame after the one before it was read, with no width waited
//   for: every frame fits, and the sidebar ends shown.
//   A drag of the sidebar's own resizer, which narrows a chat page to 320 px, the least it leaves one, and widens it
//   again: every frame fits.
// A frame in which a picker's list is open has that list's backdrop over the page: none is opened here, so Send is
// held to be within reach in every frame.
import { act, check, composerProbe, dragResizer, measureComposer, openPage, paneSize, sampleFrames, seed, until } from "../shot.mjs";

const SIDE = 264, RAIL = 40, HEIGHT = 640, LEAST = 300, FREED = SIDE - RAIL;
const SEND = 28; // px: Stop and Send, which never shrink
const STAGE = 320, DRAG = 160; // px: what a pane's resizer leaves the page beside it (logic/layout.ts), and how far the sidebar's is dragged
const MORE = ".composer .more-chip", POP = ".composer .more-pop";
const HOW = { key: "⌘B", control: "the head's control", rail: "the rail's control" };
// The driver's probe of the composer's fit, and beside it what the check asks of a frame (as A2.2's): whether the
// sidebar is hidden, whether the popup is open and how many controls it holds, how many chips the row has, whether
// the meter is cut to its ring, by how many px a control ends past the row itself, and how wide the narrower of Stop
// and Send is. (The sampler sends its probe as text.)
const probe = { toString: () => `() => {
  const v = (${composerProbe})();
  if (!v) return null;
  const t = document.querySelector(".composer .composer-tools");
  return { ...v, hidden: !!document.querySelector(".app > .side-rail"), more: !!t.querySelector(".more-pop"), held: t.querySelectorAll(".more-pop > .more-row").length,
    chips: t.querySelectorAll(":scope > .tchip, :scope > .menu-wrap > .tchip:not(.more-chip)").length, ring: !!t.querySelector(":scope > .menu-wrap > .ctx-meter.compact, :scope > .ctx-meter.compact"),
    out: Math.round(Math.max(...[...t.children].filter((e) => !e.matches(".grow, .menu-backdrop")).map((e) => e.getBoundingClientRect().right - t.getBoundingClientRect().right)) * 10) / 10,
    send: Math.min(...[...t.querySelectorAll(":scope > .send")].map((e) => e.getBoundingClientRect().width)) };
}` };

await check("P7.3 the composer fits its box while the sidebar is shown and hidden", async ({ url, browser, fail, note }) => {
  const states = await seed(url, "A2");
  const state = (id) => states.find((s) => s.id === id) ?? (() => { throw new Error(`the seed has no state ${id}`); })();
  const frame = (page) => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok()))));
  /** A state's page, its pane `width` px wide: beside the sidebar, or beside the rail of a hidden one. */
  const open = async (s, width, { hidden = false } = {}) => {
    const errors = [], size = paneSize(s.pane[0], width, HEIGHT);
    const { ctx, page } = await openPage({ url, browser, errors, sel: s.sel, size: [size.size[0] - (hidden ? FREED : 0), HEIGHT], ls: { ...size.ls, ...(hidden ? { "aiwb.side": "hidden" } : {}) }, wait: ".composer-box .send" });
    await act(page, s.act);
    await page.evaluate(() => document.fonts.ready);
    await frame(page);
    return { ctx, page, errors };
  };
  const close = async ({ ctx, errors }, name) => { for (const e of errors) fail(`${name}: page error: ${e}`); await ctx.close(); };
  const hidden = (page) => page.evaluate(() => !!document.querySelector(".app > .side-rail") && !document.querySelector(".app > .side-pane").getClientRects().length);
  const paneWidth = (page, kind) => page.evaluate((sel) => document.querySelector(sel)?.getBoundingClientRect().width, kind === "panel" ? ".board-panel" : ".chat-page");
  /** Hides the sidebar or shows it, by ⌘B, the head's control or the rail's, and waits for the pane to have its width. */
  const toggle = async (page, name, how, want, kind, width) => {
    if (how === "key") await page.keyboard.press("ControlOrMeta+b"); else await page.locator(how === "rail" ? ".side-rail .side-show" : ".side-head .side-hide").click();
    if (!await until(async () => await hidden(page) === want && Math.abs(await paneWidth(page, kind) - width) < 1, 10000)) fail(`${name}: ${HOW[how]} did not ${want ? "hide" : "show"} the sidebar with the ${kind} at ${width} px (it is ${await paneWidth(page, kind)})`);
    await frame(page);
  };
  /** One measurement at rest, as A2.2's: nothing past the box, Send where a click reaches it, no sideways scroll; a
   *  chat toolbar's controls on one line, none past the row, Stop and Send at their width. */
  const fits = async (page, name) => {
    await frame(page);
    const all = (await measureComposer(page)).filter((c) => !c.none);
    if (all.length !== 1) return fail(`${name}: ${all.length} composers on the page`);
    const m = all[0];
    if (m.past) fail(`${name}: ${m.past} past the box, the furthest by ${m.furthest} px: ${m.over.map((o) => `${o.el} +${o.overBox}`).join("; ")}`);
    if (m.send !== "ok") fail(`${name}: Send is ${m.send}`);
    if (m.docScroll > 0) fail(`${name}: the document scrolls ${m.docScroll} px sideways`);
    if (m.boxOverPane > 0) fail(`${name}: the box is ${m.boxOverPane} px past its pane`);
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
  /** Samples the page's frames while body runs, and holds every one of them. */
  const sampled = async (page, name, body, o) => {
    const sampler = await sampleFrames(page, probe, o);
    try { await body(); await page.waitForFunction(() => window.__frames?.values.length > 3, null, { timeout: 15000 }); await frame(page); } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    const r = await sampler.stop(), bad = r.values.filter((v) => v.bad || v.out > 0.5 || Math.abs(v.send - SEND) > 0.5);
    if (bad.length) fail(`${name}: ${bad.length} of ${r.values.length} frames are not fitted, the first ${JSON.stringify(bad[0])}`);
    return r;
  };
  const range = (r, k) => [Math.min(...r.values.map((v) => v[k])), Math.max(...r.values.map((v) => v[k]))];
  const toolbar = (v) => `${v.chips} chips${v.ring ? ", the meter as its ring" : ""}${v.held ? `, ${v.held} in "more"` : ""}`;

  // ---- every chat composer at its least width: hidden and shown, by the key and by the two controls
  let frames = 0, moved = 0;
  for (const s of states) {
    const kind = s.pane[0], page = kind === "page", name = `${s.id}, a ${kind} of ${LEAST} px`, wide = LEAST + (page ? FREED : 0);
    const p = await open(s, LEAST);
    try {
      // (the sampler's first frame is after the first press: the toolbar beside the sidebar is read before it)
      const first = await p.page.evaluate(`(${probe})()`);
      const r = await sampled(p.page, name, async () => {
        for (const [there, back] of [["key", "key"], ["control", "rail"]]) {
          await toggle(p.page, name, there, true, kind, wide);
          await fits(p.page, `${name}, the sidebar hidden by ${HOW[there]}`);
          await toggle(p.page, name, back, false, kind, LEAST);
          await fits(p.page, `${name}, the sidebar shown again by ${HOW[back]}`);
        }
      });
      frames += r.values.length;
      const [least, most] = range(r, "box"), last = r.values.at(-1), shown = r.values.filter((v) => !v.hidden), away = r.values.filter((v) => v.hidden);
      if (!first || first.hidden || !away.length || !shown.length || last.hidden) fail(`${name}: the sampler read ${r.values.length} frames, ${away.length} of them with the sidebar hidden, after a page that had it ${first?.hidden ? "hidden" : "shown"}: not the way there and back`);
      else if (page) {
        if (first.box !== least || most - least !== FREED) fail(`${name}: the box went from ${least} to ${most} px, not from its ${first.box} by the sidebar less the rail (${FREED})`);
        if (toolbar(last) !== toolbar(first)) fail(`${name}: shown again the toolbar has ${toolbar(last)}; before, ${toolbar(first)}`);
        // (every frame of a width has that width's toolbar: beside the sidebar the one the page began with, beside the rail one that is no poorer)
        const other = shown.find((v) => toolbar(v) !== toolbar(first)), rich = away.at(-1), poor = away.find((v) => v.chips < first.chips || toolbar(v) !== toolbar(rich));
        if (other) fail(`${name}: beside the sidebar the toolbar had ${toolbar(first)}, and in another frame ${toolbar(other)}`);
        if (poor) fail(`${name}: beside the rail the toolbar had ${toolbar(rich)}, and in another frame ${toolbar(poor)}; beside the sidebar, ${toolbar(first)}`);
        if (toolbar(rich) !== toolbar(first)) moved++;
      } else {
        if (most !== least || first.box !== least) fail(`${name}: the panel's box went from ${least} to ${most} px, ${first.box} before: a panel keeps its width`);
        const other = r.values.find((v) => toolbar(v) !== toolbar(first));
        if (other) fail(`${name}: beside a panel that kept its width the toolbar had ${toolbar(first)}, then ${toolbar(other)}`);
      }
    } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    await close(p, name);
  }
  if (moved < 5) fail(`only ${moved} chat pages had a richer toolbar beside the rail than beside the sidebar: the round moved too little to prove anything`);
  note(`${states.length} chat composers at ${LEAST} px, the sidebar hidden and shown twice each (⌘B; the head's control and the rail's): ${frames} frames, all fitted; ${moved} pages took controls back from "more" and gave them again`);

  // ---- the least width beside the rail: loaded with the sidebar hidden
  for (const s of states) {
    const name = `${s.id}, loaded with the sidebar hidden, a ${s.pane[0]} of ${LEAST} px`, p = await open(s, LEAST, { hidden: true });
    try {
      if (!await hidden(p.page) || Math.abs(await paneWidth(p.page, s.pane[0]) - LEAST) > 1) fail(`${name}: the page opened with the sidebar ${await hidden(p.page) ? "hidden" : "shown"} and the ${s.pane[0]} at ${await paneWidth(p.page, s.pane[0])} px`);
      await fits(p.page, name);
    } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    await close(p, name);
  }
  for (const id of ["plain-new", "plain-remote-started-long", "plain-noagent", "board-new", "board-busy"]) {
    const s = state(id), name = `${id}, a load with the sidebar hidden`, p = await open(s, LEAST, { hidden: true });
    const r = await sampled(p.page, name, async () => {
      await p.page.reload({ waitUntil: "domcontentloaded" });
      await p.page.waitForFunction(() => window.__frames?.values.length > 3, null, { timeout: 15000 });
    }, { fromLoad: true });
    if (r.frames <= r.values.length) fail(`${name}: the sampler did not run from before the composer was drawn (${r.values.length} values in ${r.frames} frames)`);
    if (r.values.some((v) => !v.hidden)) fail(`${name}: ${r.values.filter((v) => !v.hidden).length} of ${r.values.length} frames had no rail`);
    await close(p, name);
  }
  note(`${states.length} chat composers loaded beside the rail in a window that leaves them ${LEAST} px: each fits, five of them from the first frame that has the composer`);

  // ---- with "more" open: the popup stays, and gives nothing back until it closes
  for (const id of ["plain-new", "plain-remote-new", "plain-move-long", "plain-started-long"]) {
    const s = state(id), name = `${id}, "more" open`, p = await open(s, LEAST);
    try {
      await p.page.locator(MORE).click();
      if (!await until(() => p.page.locator(POP).count(), 5000)) throw new Error('the "more" chip did not open its popup');
      const held = await p.page.locator(`${POP} > .more-row`).count();
      const r = await sampled(p.page, name, async () => {
        await toggle(p.page, name, "key", true, "page", LEAST + FREED);
        await toggle(p.page, name, "key", false, "page", LEAST);
      });
      const shut = r.values.findIndex((v) => !v.more), back = r.values.findIndex((v) => v.held < held);
      if (shut >= 0) fail(`${name}: the popup closed, in frame ${shut} of ${r.values.length}`);
      if (back >= 0) fail(`${name}: a control left the open popup, in frame ${back}: it held ${held}, then ${r.values[back].held}`);
      if (range(r, "box")[1] - range(r, "box")[0] !== FREED) fail(`${name}: the box went from ${range(r, "box").join(" to ")} px, not by ${FREED}`);
      await p.page.keyboard.press("Escape");
      if (!await until(async () => !await p.page.locator(POP).count(), 5000)) fail(`${name}: Esc did not close the popup after the round`);
      await fits(p.page, `${name}, closed after the round`);
    } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    await close(p, name);
  }
  note('four states with "more" open through the round: the popup stayed open and held every control it had; every frame fitted');

  // ---- ⌘B six times in a row
  for (const id of ["plain-new", "plain-started-long", "plain-move"]) {
    const s = state(id), name = `${id}, ⌘B six times in a row`, p = await open(s, LEAST);
    try {
      const first = toolbar(await p.page.evaluate(`(${probe})()`));
      const r = await sampled(p.page, name, async () => {
        // (the next press is sent once the frame after this one was read: a key that arrives before the sampler's
        // task is heard first, and the frame it changed would be read as the one after it)
        for (let i = 0; i < 6; i++) { await p.page.keyboard.press("ControlOrMeta+b"); await p.page.evaluate(() => new Promise((ok) => { const n = window.__frames.frames, t = () => (window.__frames.frames > n ? ok() : requestAnimationFrame(t)); requestAnimationFrame(t); })); }
        if (!await until(async () => !await hidden(p.page) && Math.abs(await paneWidth(p.page, "page") - LEAST) < 1, 10000)) fail(`${name}: the sidebar did not end shown, the page at ${LEAST} px`);
      });
      const turns = r.values.filter((v, i) => i > 0 && v.hidden !== r.values[i - 1].hidden).length;
      if (turns < 4) fail(`${name}: the ${r.values.length} frames sampled show the sidebar going or coming ${turns} times: the presses were not drawn one by one`);
      if (toolbar(r.values.at(-1)) !== first) fail(`${name}: after it the toolbar has ${toolbar(r.values.at(-1))}; before, ${first}`);
      await fits(p.page, `${name}, after it`);
    } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    await close(p, name);
  }
  note("⌘B six times in a row, three states: every frame fitted, the toolbar as it began");

  // ---- the sidebar's own resizer: a chat page narrowed to the least it leaves one and widened again, 3 px a frame, then 40
  for (const id of ["plain-new", "plain-remote-started-long"]) {
    const s = state(id), name = `${id}, a drag of the sidebar's resizer`, p = await open(s, STAGE + DRAG);
    try {
      const first = toolbar(await p.page.evaluate(`(${probe})()`));
      const r = await sampled(p.page, name, async () => { for (const step of [3, 40]) { await dragResizer(p.page, ".side-pane .resizer", DRAG, step); await dragResizer(p.page, ".side-pane .resizer", -DRAG, step); } });
      const [least, most] = range(r, "box"), side = await p.page.evaluate(() => document.querySelector(".app > .side-pane").getBoundingClientRect().width);
      if (most - least !== DRAG) fail(`${name}: the box went from ${most} to ${least} px, not by the ${DRAG} px of the drag`);
      if (new Set(r.values.map((v) => v.box)).size < 40) fail(`${name}: the sampler saw ${new Set(r.values.map((v) => v.box)).size} widths of the box: not every step of the drag`);
      if (toolbar(r.values.at(-1)) !== first) fail(`${name}: after it the toolbar has ${toolbar(r.values.at(-1))}; before, ${first}`);
      if (!r.values.some((v) => toolbar(v) !== first)) fail(`${name}: the toolbar had ${first} at every width: nothing left it on the way`);
      if (Math.abs(side - SIDE) > 1) fail(`${name}: after it the sidebar is ${side} px wide, not its ${SIDE}`);
    } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    await close(p, name);
  }
  note(`a drag of the sidebar's resizer that takes ${DRAG} px from a chat page, down to ${STAGE}, and gives them back, slowly and fast, two states: every frame fitted`);
});
