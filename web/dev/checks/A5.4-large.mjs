// Proves A5.4: nothing large enters the page until it is asked for, and no card is wider than the narrowest panel.
// A thread with an output of 3,000 lines, a written file of 4,000, a change of 600 and a card of 30 edits is small
// while its cards are closed, and still small with all of them open: each long part is its first and its last part
// with how much was left out, its last line in sight, and "Show all" brings the whole of it, in a box that scrolls;
// "Show less" takes it back. In a chat page, in the panel beside a board and in the pane of a run's agent of 300 px,
// and in a subagent's drawer in a window that narrow, every card lies inside its thread, closed, open and with all
// shown, nothing in a card ends past it, and nothing scrolls sideways: with the three agents' items, and with names
// and lines that have nowhere to break. The line beside the label is one line, cut with an ellipsis.
import { act, cardsFit, check, openCards, openPage, paneSize, seed, toolCards, until } from "../shot.mjs";

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const BOX = 480; // the most the box of a part shown whole is tall (styles.css): what is over it scrolls in the box

await check("A5.4 a large tool item is cut until asked for, and no card is wider than a 300 px pane", async ({ url, browser, fail, note }) => {
  const states = await seed(url, "A5");
  const state = (id) => states.find((s) => s.id === id) ?? (() => { throw new Error(`the seed has no state ${id}`); })();
  const open = async (sel, size, wait) => {
    const errors = [];
    const { ctx, page } = await openPage({ url, browser, errors, sel, ...size, wait });
    return { ctx, page, errors };
  };
  const close = async ({ ctx, errors }, name) => { for (const e of errors) fail(`${name}: page error: ${e}`); await ctx.close(); };
  const frame = (page) => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok()))));

  // ---- the large items
  {
    const s = state("big"), p = await open(s.sel, paneSize("page", 700, 900)), name = "the large items";
    try {
      await p.page.waitForSelector(s.see, { timeout: 8000 });
      const size = () => p.page.evaluate(() => document.querySelector(".thread").innerHTML.length);
      const card = async (n) => (await toolCards(p.page))[n];
      const part = (c, title) => c.parts.find((x) => x.title === title);
      const all = (n) => p.page.locator(".thread .tool").nth(n).locator(".tool-omit button", { hasText: "Show all" }).first().click();
      const less = (n) => p.page.locator(".thread .tool").nth(n).locator(".tool-omit button", { hasText: "Show less" }).first().click();
      const closed = await size();
      if (closed > 6000) fail(`${name}: with its four cards closed the thread is ${closed} characters of HTML`);
      await openCards(p.page);
      const opened = await size();
      if (opened > 60000) fail(`${name}: with its four cards open the thread is ${opened} characters of HTML: something large was put in unasked`);

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
      if (!same([file.parts[0].path, file.parts[0].lines], ["web/src/rows.ts", "4,000 lines"])) fail(`${name}: the written file is told as ${JSON.stringify(file.parts[0])}`);
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
    } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    await close(p, name);
  }

  // ---- no card is wider than a pane of 300 px
  /** Holds the cards of a thread to their pane: closed, open, and with all of every long part shown. */
  const fits = async (page, root, name, pane) => {
    await page.evaluate(() => document.fonts.ready);
    await frame(page);
    if (pane) { const w = await page.evaluate((sel) => document.querySelector(sel)?.getBoundingClientRect().width, pane[0]); if (Math.abs(w - pane[1]) > 1) fail(`${name}: the pane ${pane[0]} is ${w} px wide, not ${pane[1]}`); }
    let n = 0;
    for (const step of ["closed", "open", "with all shown"]) {
      if (step === "open") await openCards(page, root);
      if (step === "with all shown") { const more = page.locator(`${root} .tool-omit button`, { hasText: "Show all" }); for (let k = await more.count(); k > 0; k--) await more.first().click(); await frame(page); }
      const f = await cardsFit(page, root);
      if (!f?.cards) { fail(`${name}, ${step}: no card under ${root}`); return 0; }
      n = f.cards;
      if (f.bad) fail(`${name}, ${step}, a thread of ${f.width} px: ${[...f.wide.map((x) => `${x} of the thread`), ...f.out.map((x) => `${x} past its card`), ...f.sideways.map((x) => `${x} scrolls sideways`), ...(f.scroll ? [`the thread or the page scrolls ${f.scroll} px sideways`] : [])].slice(0, 6).join("; ")}`);
      if (step === "closed") {
        // the line beside the label: one line, and cut where it is longer than its room
        const hints = await page.evaluate((root) => [...document.querySelectorAll(`${root} .tool-hint`)].filter((h) => h.textContent).map((h) => ({ text: h.textContent.slice(0, 30), lines: Math.round(h.getBoundingClientRect().height / parseFloat(getComputedStyle(h).lineHeight) || 1), cut: h.scrollWidth > h.clientWidth, ellipsis: getComputedStyle(h).textOverflow })), root);
        for (const h of hints) if (h.lines > 1 || h.ellipsis !== "ellipsis") fail(`${name}: the line "${h.text}…" beside a label takes ${h.lines} lines (text-overflow: ${h.ellipsis})`);
      }
    }
    return n;
  };
  let cards = 0;
  for (const id of ["wide", "claude", "cursor", "pi", "gaps", "junk", "big"]) {
    const s = state(id), p = await open(s.sel, paneSize("page", 300, 800)), name = `${id}, a chat page of 300 px`;
    try { await p.page.waitForSelector(s.see, { timeout: 8000 }); cards += await fits(p.page, ".thread", name, [".chat-page", 300]); } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    await close(p, name);
  }
  {
    const s = state("panel"), p = await open(s.sel, paneSize("panel", 300, 800)), name = "beside a board, a panel of 300 px";
    try { await p.page.waitForSelector(s.see, { timeout: 8000 }); cards += await fits(p.page, ".board-panel .thread", name, [".board-panel", 300]); } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    await close(p, name);
  }
  {
    const s = state("sub"), p = await open(s.sel, paneSize("page", 300, 800)), name = "a subagent's drawer, in a window of 564 px";
    try { await act(p.page, s.act); await p.page.waitForSelector(s.see, { timeout: 8000 }); cards += await fits(p.page, ".sub-drawer-body", name); } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    await close(p, name);
  }
  {
    const p = await open({ run: "r_live" }, paneSize("panel", 300, 800), ".tl-row"), name = "a run agent's pane of 300 px";
    try {
      await p.page.locator(".tl-row", { has: p.page.locator(".tl-id", { hasText: /^T27$/ }) }).first().click();
      const link = p.page.locator('button[data-agent$="T27-merge"]').first();
      await link.waitFor({ timeout: 8000 });
      await link.click();
      await p.page.waitForSelector(".thread.read-only .tool", { timeout: 8000 });
      cards += await fits(p.page, ".thread.read-only", name, [".board-panel", 300]);
    } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    await close(p, name);
  }
  note(`${cards} cards in panes of 300 px (a chat page, a panel beside a board, a run agent's pane) and in a subagent's drawer: each inside its thread closed, open and with all shown; nothing scrolls sideways`);
});
