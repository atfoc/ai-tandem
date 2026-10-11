// Proves that the driver's measure of the composer's overflow (G1 §Q2 "Method") finds nothing past the box in the two
// cases G1 measured worst at 300 px (board-new: 5 controls past, +265; plain-started: 2 past, +80), and that it still
// sees a row that does pass its box: with the box made narrower behind the toolbar's back, by a style the toolbar is
// not told of, it finds Send past the box by the px the row lost. A2.2 holds every state at every width.
import { check, measureComposer, openPage, paneSize, seed } from "../shot.mjs";

// [state, the pane's width]
const CASES = [["board-new", 300], ["plain-started", 300]];
const LOST = 50; // px the row is short of, once the box is narrowed

await check("P0.1 the composer's overflow: none where G1 measured it, and the measure still sees one", async ({ url, browser, fail, note }) => {
  const states = await seed(url, "A2");
  for (const [id, width] of CASES) {
    const s = states.find((x) => x.id === id);
    if (!s) { fail(`the seed has no state ${id}`); continue; }
    const { ctx, page } = await openPage({ url, browser, sel: s.sel, ...paneSize(s.pane[0], width), wait: ".composer-box .send" });
    let m = (await measureComposer(page)).find((c) => !c.none);
    note(`${id} at ${width} px: ${m.past} past, +${m.furthest}; Send ${m.send}; the document scrolls ${m.docScroll} px sideways`);
    if (m.past) fail(`${id} at ${width} px: ${m.past} controls past the box: ${m.over.map((o) => `${o.el} +${o.overBox}`).join("; ")}`);
    if (m.boxOverPane > 0) fail(`${id} at ${width} px: the box itself is ${m.boxOverPane} px past its pane`);
    if (m.send !== "ok" || m.docScroll > 0) fail(`${id} at ${width} px: Send is "${m.send}" and the document scrolls ${m.docScroll} px`);
    // The box narrower by its row's spare room and LOST px more: the row's last control, Send, ends that far past the
    // box's content, which is the box's right padding and border less past its border edge.
    const edge = await page.evaluate((lost) => {
      const box = document.querySelector(".composer .composer-box"), cs = getComputedStyle(box), spare = box.querySelector(".composer-tools > .grow").getBoundingClientRect().width;
      box.style.width = `${box.getBoundingClientRect().width - spare - lost}px`;
      box.style.flex = "none"; box.style.alignSelf = "flex-start";
      return parseFloat(cs.paddingRight) + parseFloat(cs.borderRightWidth);
    }, LOST);
    m = (await measureComposer(page)).find((c) => !c.none);
    const send = m.over.find((o) => o.row === "tools" && o.el.startsWith(".send"));
    note(`${id}, its box narrowed by a style: ${m.past} past, Send +${send?.overBox ?? 0}`);
    if (!send || Math.abs(send.overBox - (LOST - edge)) > 1) fail(`${id}, its box narrowed so that the row is ${LOST} px short: the measure finds ${m.past} controls past the box (${m.over.map((o) => `${o.el} +${o.overBox}`).join("; ")}); Send is ${LOST - edge} px past it`);
    await ctx.close();
  }
});
