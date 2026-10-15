// P0.1 ported (AD-80; package K3): the composer's overflow, as measured by the readers of composer.mjs, finds nothing past the box in the
// two cases G1 measured worst at 300 px (board-new: 5 controls past, +265; plain-started: 2 past, +80), and still sees a row that does pass
// its box: with the box made narrower behind the toolbar's back, by a style, and measured in the same task (the toolbar would fit itself
// again at its next layout pass), it finds Send past the box by the px the row lost. A2.2 holds every state at every width. Ports dev/checks/P0.1-overflow.mjs with the same cases and assertions; the
// measure reads testIDs (composer.mjs) and not the old classes. At the tablet and the phone the device's own width is the pane's (the
// widths the desktop gives are windows), so the cases are the same states at that width.
import { check, seed } from "../shot.mjs";
import { composersInPage, measureComposer, openState } from "./composer.mjs";

export const viewports = ["desktop", "tablet", "phone"];

// [state, the pane's width]
const CASES = [["board-new", 300], ["plain-started", 300]];
const LOST = 50; // px the row is short of, once the box is narrowed

await check("P0.1 the composer's overflow: none where G1 measured it, and the measure still sees one", async ({ url, layout, open, fail, note }) => {
  const states = await seed(url, "A2");
  for (const [id, width] of CASES) {
    const s = states.find((x) => x.id === id);
    if (!s) { fail(`the seed has no state ${id}`); continue; }
    const { ctx, page } = await openState(open, s, layout, width);
    try { // (one page at a time: the mock has one stream for one page)
      let m = (await measureComposer(page)).find((c) => !c.none);
      const at = layout === "desktop" ? `${width} px` : `${page.viewportSize().width} px`;
      note(`${id} at ${at}: ${m.past} past, +${m.furthest}; Send ${m.send}; the document scrolls ${m.docScroll} px sideways`);
      if (m.past) fail(`${id} at ${at}: ${m.past} controls past the box: ${m.over.map((o) => `${o.el} +${o.overBox}`).join("; ")}`);
      if (m.boxOverPane > 0) fail(`${id} at ${at}: the box itself is ${m.boxOverPane} px past its pane`);
      if (m.send !== "ok" || m.docScroll > 0) fail(`${id} at ${at}: Send is "${m.send}" and the document scrolls ${m.docScroll} px`);
      // The box narrower by its row's spare room and LOST px more: the row's last control, Send, ends that far past the box's content, which is
      // the box's right padding and border less past its border edge. The toolbar is told of the new width on its next layout pass (onLayout is
      // a ResizeObserver on web) and fits itself again, so the measure is taken in the same task as the style, before any observer or render
      // can run: what it proves is that the measure sees a row that passes its box, not how the toolbar answers a narrower box (A2.2, P0.6).
      let edge;
      ({ edge, m } = await page.evaluate(`(() => {
        const box = document.querySelector('[data-testid="composer-box"]'), cs = getComputedStyle(box), spare = box.querySelector('[data-testid="tool-grow"]').getBoundingClientRect().width;
        box.style.width = (box.getBoundingClientRect().width - spare - ${LOST}) + "px";
        box.style.flex = "none"; box.style.alignSelf = "flex-start";
        const edge = parseFloat(cs.paddingRight) + parseFloat(cs.borderRightWidth);
        return { edge, m: (${composersInPage})().find((c) => !c.none) };
      })()`));
      const send = m.over.find((o) => o.row === "tools" && o.el.startsWith("part:send"));
      note(`${id}, its box narrowed by a style: ${m.past} past, Send +${send?.overBox ?? 0}`);
      if (!send || Math.abs(send.overBox - (LOST - edge)) > 1) fail(`${id}, its box narrowed so that the row is ${LOST} px short: the measure finds ${m.past} controls past the box (${m.over.map((o) => `${o.el} +${o.overBox}`).join("; ")}); Send is ${LOST - edge} px past it`);
    } finally { await ctx.close(); }
  }
}, { viewports, page: false });
