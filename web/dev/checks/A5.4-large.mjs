// Proves A5.4: nothing large enters the page until it is asked for, and no card is wider than the narrowest panel.
// A thread with an output of 3,000 lines, a written file of 4,000, a change of 600 and a card of 30 edits is small
// while its cards are closed, and still small with all of them open: each long part is its first and its last part
// with how much was left out, its last line in sight, and "Show all" brings the whole of it, in a box that scrolls;
// "Show less" takes it back. In a chat page and in the panel beside a board of 300 px,
// and in a subagent's drawer in a window that narrow, every card lies inside its thread, closed, open and with all
// shown, nothing in a card ends past it, and nothing scrolls sideways: with the three agents' items, and with names
// and lines that have nowhere to break. The line beside the label is one line, cut with an ellipsis.
// Ports dev/checks/A5.4-large.mjs (package S6) at desktop, tablet and phone: the same seed (A5), items, assertions and words; the cards are read
// over testIDs (`cards.mjs`). The panes of 300 px are windows, so they are the desktop's (`paneSize`); at the tablet and the phone the same cards
// lie in the device's own width, which is narrower than 564 px at the phone (B-TC-31: "all (phone width)"). The old check measured the page's
// HTML (`innerHTML.length` of the thread); the new page's markup is react-native-web's, which spells every view's atomic classes: the bounds
// are the old ones in characters of the TEXT the thread holds plus the number of elements it draws (what "nothing large" means), see SIZE below.
// The subagent's drawer in a narrow window is S7's, the real one (`sub-drawer-body`).
// On the phone (package T2) the cards are steps (screens/tools/StepCard.tsx), which cut what is long differently: an output shows its last six
// lines ("last 6 of 3000 lines") and Show all output brings the rest in a box of at most 480 px that scrolls; a change or a written file shows ten
// rows under a fade, and "Show full diff · 3,990 more lines" takes the rest to the full diff screen (where the whole change is read: the first
// and last row of it are asserted here); the one line beside the title is `step-line`, one line cut with an ellipsis, and what it clips is not
// "past the card" (the elements inside it are left out of that count). A step's markup is a larger than the wide card's (two lines, a chevron and
// the buttons), so the closed bound is its own.
import { check, paneSize, seed, until } from "../shot.mjs";
import { cardAt, cardsFit, frame, openCards, openSubSteps, toolCards } from "./cards.mjs";
import { act, back, byTid, layoutNow, press } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const DRAWER_ROOT = "sub-drawer-body";

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const BOX = 480; // the most the box of a part shown whole is tall (Parts.tsx): what is over it scrolls in the box
// The size of the thread's markup, closed and open (B-TC-28). The old page's were 6,000 and 60,000 characters; react-native-web spells the
// atomic classes of every view (a closed card is three or four times the old page's markup), so the closed bound is that much more, and the open
// one, which is mostly the text and the rows of the long parts, stays.
const SIZE = { closed: 12000, open: 60000 };
// (the phone's step measures about 3,600 characters of markup closed: four of them are 14,500; what the bound keeps out is the 3,000 lines of
// the output, 270,000 characters, and the 4,000 of the written file)
const PHONE_SIZE = { closed: 18000, open: 60000 };
// The narrow panes of the old check were windows of the sidebar's width and 300 px (`paneSize`). The new build lays out by the window's width:
// a window of 300 px is the phone layout, whose chat is the whole window; the panel beside a board keeps its minimum, 300, at a wide window.
const NARROW = { page: { size: [300, 800] }, panel: { size: [1280, 800], ls: { "aiwb.widths": JSON.stringify({ side: 264, panel: 300 }) } } };

await check("A5.4 a large tool item is cut until asked for, and no card is wider than a 300 px pane", async ({ url, viewport, open, fail, note }) => {
  const states = await seed(url, "A5");
  const state = (id) => states.find((s) => s.id === id) ?? (() => { throw new Error(`the seed has no state ${id}`); })();
  const desktop = viewport === "desktop", phone = viewport === "phone";
  const bound = phone ? PHONE_SIZE : SIZE;
  const show = async (sel, size = {}) => open({ sel, wait: '[data-testid="chat-head"]', ...size });

  // ---- the large items
  {
    const s = state("big"), p = await show(s.sel, desktop ? paneSize("page", 700, 900) : {}), name = "the large items";
    try {
      await byTid(p.page, "tool-card").first().waitFor({ state: "visible", timeout: 15000 });
      await until(async () => (await toolCards(p.page))?.length === 4, 15000);
      const size = () => p.page.evaluate(() => document.querySelector('[data-testid="thread"]').innerHTML.length);
      const card = async (n) => (await toolCards(p.page))[n];
      const part = (c, title) => c.parts.find((x) => x.title === title);
      const all = async (n) => press(p.page, byTid(await cardAt(p.page, n), "tool-show-all").first());
      const less = async (n) => press(p.page, byTid(await cardAt(p.page, n), "tool-show-less").first());
      const closed = await size();
      if (closed > bound.closed) fail(`${name}: with its four cards closed the thread is ${closed} characters of HTML`);
      await openCards(p.page);
      const opened = await size();
      if (opened > bound.open) fail(`${name}: with its four cards open the thread is ${opened} characters of HTML: something large was put in unasked`);

      if (phone) {
        // ---- the phone's step: the last lines, ten rows, and where the rest is
        const okLine = (i) => `ok      ai-whiteboard/internal/pkg${String(i).padStart(4, "0")}    0.`; // (a tab is four columns)
        const spot = async (n) => { const c = await card(n); return { c, counts: c.parts[0].counts, rows: c.parts.filter((x) => x.part === "change"), bar: c.parts.at(-1) }; };
        let out = part(await card(0), "Output");
        const lines = out?.text[0]?.split("\n") ?? [];
        if (out?.text.length !== 1 || lines.length !== 6 || !lines[0].startsWith(okLine(2995)) || !lines[5].startsWith(okLine(3000))) fail(`${name}: the long output is drawn as ${JSON.stringify(out?.text.map((t) => t.split("\n").length))} lines: its last 6 were expected (2995 to 3000)`);
        if (out?.left !== "last 6 of 3000 lines" || !out.more) fail(`${name}: the output says "${out?.left}" and ${out?.more ? "has" : "has no"} Show all output`);
        if (out && out.box[1] > out.box[0]) fail(`${name}: the cut output scrolls in its box (${out.box[0]} px for ${out.box[1]}): its last lines are not in sight`);
        await press(p.page, byTid(await cardAt(p.page, 0), "step-output-all").first());
        if (!await until(async () => part(await card(0), "Output")?.text[0]?.split("\n").length === 3000, 8000)) fail(`${name}: "Show all output" did not bring the output's 3,000 lines: ${part(await card(0), "Output")?.text[0]?.split("\n").length} are drawn`);
        out = part(await card(0), "Output");
        if (out.text.length !== 1 || out.left !== "all 3000 lines") fail(`${name}: with all shown the output is ${out.text.length} blocks, and says "${out.left}"`);
        if (out.box[0] > BOX || out.box[1] <= out.box[0]) fail(`${name}: with all shown the output's box is ${out.box[0]} px tall for ${out.box[1]} px of text: it was to scroll in at most ${BOX} px`);
        await press(p.page, byTid(await cardAt(p.page, 0), "step-output-all").first());
        if (!await until(async () => part(await card(0), "Output")?.text[0]?.split("\n").length === 6, 8000)) fail(`${name}: "Show less" did not cut the output again`);

        // the written file of 4,000 lines: ten rows, the rest said on Show full diff
        const file = await spot(1);
        if (!same([file.c.parts[0].path, file.counts, file.rows.length, file.rows[0]?.rows.length], ["site/rows.ts", "+4000", 1, 10])) fail(`${name}: the written file is told as ${JSON.stringify(file.c.parts[0])} with ${file.rows.map((r) => r.rows.length)} rows`);
        if (file.rows[0]?.rows[0] !== '+export const row0 = { id: 0, name: "row 0", tags: ["a", "b"] };' || file.bar.full !== "Show full diff · 3,990 more lines") fail(`${name}: the large content begins "${file.rows[0]?.rows[0]}" and its button says "${file.bar.full}"`);

        // the change of 600 lines
        const change = await spot(2);
        if (!same([change.counts, change.rows.map((r) => r.rows.length), change.rows[0]?.rows[0], change.bar.full], ["+300 −300", [10], "-  oldRow0: 0,", "Show full diff · 590 more lines"])) fail(`${name}: the long change is ${change.counts}, ${JSON.stringify(change.rows.map((r) => r.rows.length))} rows from "${change.rows[0]?.rows[0]}", its button says "${change.bar.full}"`);
        if (change.rows[0] && change.rows[0].box[1] > change.rows[0].box[0]) fail(`${name}: the change's rows scroll in their box (${change.rows[0].box[0]} px for ${change.rows[0].box[1]})`);
        // (what the card leaves out is in the full diff: its summary tells the change whole)
        await press(p.page, byTid(await cardAt(p.page, 2), "step-diff-full").first());
        const summary = byTid(p.page, "diff-summary").first();
        await summary.waitFor({ state: "visible", timeout: 8000 });
        // (the summary's counts are spans: their text has no spaces between them)
        if (!(await summary.textContent()).replace(/\s/g, "").includes("+300−300")) fail(`${name}: the full diff of the long change says "${await summary.textContent()}", not "+300 −300"`);
        await back(p.page);
        await byTid(p.page, "tool-card").first().waitFor({ state: "visible", timeout: 8000 });

        // the card of 30 edits: ten rows in all, five blocks of two
        const edits = await spot(3), kinds = edits.c.parts.map((x) => x.part);
        if (!same([kinds, edits.counts, edits.bar.full], [["path", ...Array(5).fill("change"), "diffbar"], "+30 −30", "Show full diff · 50 more lines"])) fail(`${name}: the card of 30 edits shows ${JSON.stringify(kinds)}, ${edits.counts} and "${edits.bar.full}"`);
        note(`a thread of ${closed} characters closed and ${opened} with its four cards open; an output shows its last 6 lines and all of them in ${BOX} px, a change its first 10 rows and a button to the full diff`);
      } else {
      // the output of 3,000 lines
      let out = part(await card(0), "Output");
      const ok = (i) => `ok  \tai-whiteboard/internal/pkg${String(i).padStart(4, "0")}\t0.`;
      if (out?.text.length !== 2 || out.text[0].split("\n").length !== 8 || out.text[1].split("\n").length !== 12 || !out.text[0].startsWith(ok(1)) || !out.text[1].split("\n")[11].startsWith(ok(3000))) fail(`${name}: the long output is drawn as ${JSON.stringify(out?.text.map((t) => t.split("\n").length))} lines: its first 8 and its last 12 were expected`);
      if (out?.left !== "⋯ 2,980 lines left out") fail(`${name}: between the output's parts stands "${out?.left}"`);
      if (out && out.box[1] > out.box[0]) fail(`${name}: the cut output scrolls in its box (${out.box[0]} px for ${out.box[1]}): its last lines are not in sight`);
      await all(0);
      if (!await until(async () => part(await card(0), "Output")?.text[0]?.split("\n").length === 3000, 8000)) fail(`${name}: "Show all" did not bring the output's 3,000 lines`);
      out = part(await card(0), "Output");
      if (out.text.length !== 1 || out.left) fail(`${name}: with all shown the output is ${out.text.length} blocks, and says "${out.left}"`);
      if (out.box[0] > BOX || out.box[1] <= out.box[0]) fail(`${name}: with all shown the output's box is ${out.box[0]} px tall for ${out.box[1]} px of text: it was to scroll in at most ${BOX} px`);
      await less(0);
      if (!await until(async () => part(await card(0), "Output")?.text.length === 2, 8000)) fail(`${name}: "Show less" did not cut the output again`);

      // the written file of 4,000 lines
      const file = await card(1), content = part(file, "Content");
      if (!same([file.parts[0].path, file.parts[0].lines], ["site/rows.ts", "4,000 lines"])) fail(`${name}: the written file is told as ${JSON.stringify(file.parts[0])}`);
      if (content?.text.length !== 2 || content.left !== "⋯ 3,980 lines left out" || !content.text[1].endsWith('"row 3999", tags: ["a", "b"] };')) fail(`${name}: the large content is drawn as ${content?.text.length} blocks with "${content?.left}" between them`);
      await all(1);
      if (!await until(async () => part(await card(1), "Content")?.text[0]?.split("\n").length === 4000, 8000)) fail(`${name}: "Show all" did not bring the content's 4,000 lines`);
      await less(1);

      // the change of 600 lines
      let change = (await card(2)).parts[1];
      if (!same([(await card(2)).parts[0].counts, change?.rows.length, change?.left, change?.rows[0], change?.rows.at(-1)], ["+300 −300", 26, "⋯ 574 lines left out", "-\toldRow0: 0,", "+\tnewRow299: 299,"])) fail(`${name}: the long change is ${change?.rows.length} rows with "${change?.left}", from "${change?.rows[0]}" to "${change?.rows.at(-1)}"`);
      await all(2);
      if (!await until(async () => (await card(2)).parts[1]?.rows.length === 600, 8000)) fail(`${name}: "Show all" did not bring the change's 600 lines`);
      change = (await card(2)).parts[1];
      if (change.box[0] > BOX || change.box[1] <= change.box[0]) fail(`${name}: with all shown the change's box is ${change.box[0]} px tall for ${change.box[1]} px of lines`);
      await less(2);
      if (!await until(async () => (await card(2)).parts[1]?.rows.length === 26, 8000)) fail(`${name}: "Show less" did not cut the change again`);

      // the card of 30 edits
      const kinds = async () => (await card(3)).parts.map((x) => x.part);
      const first = await card(3);
      if (!same([await kinds(), first.parts.at(-1).text, first.parts[0].counts], [["path", ...Array(12).fill("change"), "more"], "⋯ 18 more edits", "+30 −30"])) fail(`${name}: the card of 30 edits shows ${JSON.stringify(await kinds())} and "${first.parts.at(-1).text}"`);
      await all(3);
      if (!await until(async () => same(await kinds(), ["path", ...Array(30).fill("change")]), 8000)) fail(`${name}: "Show all" did not bring the 30 edits: ${JSON.stringify(await kinds())}`);
      note(`a thread of ${closed} characters closed and ${opened} with its four cards open; each long part comes whole when asked, and scrolls in ${BOX} px`);
      }
    } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    await p.ctx.close();
  }

  // ---- no card is wider than a pane of 300 px
  /** Holds the cards of a thread to their pane: closed, open, and with all of every long part shown. */
  const fits = async (page, root, name, pane) => {
    await page.evaluate(() => document.fonts.ready);
    await frame(page);
    if (pane) { const w = await page.evaluate((id) => document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect().width, pane[0]); if (Math.abs(w - pane[1]) > 1) fail(`${name}: the pane ${pane[0]} is ${w} px wide, not ${pane[1]}`); }
    let n = 0;
    for (const step of ["closed", "open", "with all shown"]) {
      if (step === "open") await openCards(page, root);
      if (step === "with all shown") { const more = byTid(page, root).locator('[data-testid="tool-show-all"]'); for (let k = await more.count(); k > 0; k--) await press(page, more.first()); await frame(page); }
      const f = await cardsFit(page, root);
      if (!f?.cards) { fail(`${name}, ${step}: no card under ${root}`); return 0; }
      n = f.cards;
      if (f.bad) fail(`${name}, ${step}, a thread of ${f.width} px: ${[...f.wide.map((x) => `${x} of the thread`), ...f.out.map((x) => `${x} past its card`), ...f.sideways.map((x) => `${x} scrolls sideways`), ...(f.scroll ? [`the thread or the page scrolls ${f.scroll} px sideways`] : [])].slice(0, 6).join("; ")}`);
      if (step === "closed") {
        // the line beside the label: one line, and cut where it is longer than its room
        // (on the phone the one line is the step's `step-line`, which holds the hint and carries the ellipsis)
        const hints = await page.evaluate((root) => [...document.querySelector(`[data-testid="${root}"]`).querySelectorAll('[data-testid="tool-hint"]')].filter((h) => h.textContent).map((h) => h.closest('[data-testid="step-line"]') ?? h).map((h) => ({ text: h.textContent.slice(0, 30), lines: Math.round(h.getBoundingClientRect().height / parseFloat(getComputedStyle(h).lineHeight) || 1), cut: h.scrollWidth > h.clientWidth, ellipsis: getComputedStyle(h).textOverflow })), root);
        for (const h of hints) if (h.lines > 1 || h.ellipsis !== "ellipsis") fail(`${name}: the line "${h.text}…" beside a label takes ${h.lines} lines (text-overflow: ${h.ellipsis})`);
      }
    }
    return n;
  };
  let cards = 0;
  for (const id of ["wide", "claude", "cursor", "pi", "gaps", "junk", "big"]) {
    const s = state(id), p = await show(s.sel, desktop ? NARROW.page : {}), name = `${id}, a chat page of 300 px`;
    try { await byTid(p.page, "tool-card").first().waitFor({ state: "visible", timeout: 15000 }); cards += await fits(p.page, "thread", name, desktop ? ["chat", 300] : undefined); } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    await p.ctx.close();
  }
  {
    const s = state("panel"), p = await show(s.sel, desktop ? NARROW.panel : {}), name = "beside a board, a panel of 300 px";
    try { await byTid(p.page, "tool-card").first().waitFor({ state: "visible", timeout: 15000 }); cards += await fits(p.page, "thread", name, desktop ? ["chat", 300] : undefined); } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    await p.ctx.close();
  }
  {
    const s = state("sub"), p = await show(s.sel, desktop ? NARROW.page : {}), name = "a subagent's drawer, in a window of 564 px";
    try { await act(p.page, s.act); if (layoutNow(p.page) === "phone") await openSubSteps(p.page); await byTid(p.page, "tool-card").first().waitFor({ state: "visible", timeout: 15000 }); cards += await fits(p.page, DRAWER_ROOT, name); } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    await p.ctx.close();
  }
  note(`${cards} cards in panes of 300 px (a chat page, a panel beside a board) and in a subagent's drawer: each inside its thread closed, open and with all shown; nothing scrolls sideways`);
}, { viewports, page: false });
