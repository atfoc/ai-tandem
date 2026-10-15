// L9 (new in the app, AD-80; package S5): the Markdown of a message (app/src/screens/markdown, AD-75) on the gallery (`/?gallery`,
// section "Markdown"), at desktop (mouse), tablet and phone (touch). It has no old check to port: the page's Markdown was proved
// only through A6.3/A6.4/P7.1 (colours) and test/markdown.test.ts (the logic); these are the B-MD rows with no check today.
//   Blocks (B-MD-01): headings (sizes 16, 15, 14 over a 13 px body), tight and nested lists, a numbered list that starts at 3, task
//   lists with their boxes (checked or not), strikethrough, a quote with its bar, a table in a box that scrolls sideways on its own
//   (the page does not: a window of the phone's width), a rule.
//   Raw HTML and links (B-MD-02, 03, 04): raw HTML is its source as text, never an element; a link with an unsafe protocol is its
//   text, an anchor with no address is plain text; a link is an anchor that opens a new tab with no opener (a finger's tap too); an image is
//   a link showing its alt text and nothing is fetched.
//   Code (B-MD-05, 06, 07): a fence naming a known language is coloured with the theme's tokens (a comment in the faint colour), an
//   unknown or no language is one colour; the header names the language (as typed) and Copy puts the code only on the clipboard and says
//   "Copied" for a moment; the header is not selectable (a selection of the whole message holds none of its words).
//   (a code block's header and a list's markers are drawn as text and are no part of the displayed text: NOT_DISPLAYED of displayed.ts)
//   Quotes (AD-75): the message's text nodes, a code block's header left out, are the displayed text (displayed.ts) the quotes count in
//   (white space left out: the page draws no "\n" nodes between blocks; the offsets of a platform that measures what it drew align with
//   `messageText(…, separators: false)`).
//   Chips and mentions (B-MD-08, 10): a reference tag is a chip where it stands, the punctuation right after it going with it, and a
//   press shows the reference; an @name of a board is a link that opens it, one that names no board stays text.
//   Streaming (B-MD-11, goal 4.8): while an answer arrives in chunks every block is parsed once and a finished block is not drawn again
//   (the gallery counts both); the caret follows the text while it streams and goes when it ends.
//
// Run: `cd web && npm run uicheck -- L9`, or alone: node web/dev/checks/L9-markdown.mjs (VIEWPORT=phone, DIST=/tmp/x/dist).
import { check, until } from "../shot.mjs";
import { byTid, press } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const FEATURES = '[data-testid="md-sample-features"]', USER = '[data-testid="md-sample-user"]', STREAM = '[data-testid="md-sample-stream"]';
const strip = (s) => (s ?? "").replace(/\s+/g, "");

async function body({ page, context, viewport, touch, fail, errors }) {
  const T = (id, root = page) => byTid(root, id);
  const expect = (ok, what) => { if (!ok) fail(`${what}`); return ok; };
  const step = async (name, fn) => { try { await fn(); } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); } };
  const requests = [];
  page.on("request", (r) => requests.push(r.url()));
  await context.route("https://example.com/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<title>example</title>" }));
  await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
  const f = page.locator(FEATURES);
  await f.scrollIntoViewIfNeeded();
  const style = (loc, prop) => loc.evaluate((e, p) => getComputedStyle(e)[p], prop);

  await step("blocks", async () => {
    const sizes = [];
    for (const d of [1, 2, 3]) sizes.push(parseFloat(await style(f.locator(`[data-testid="md-h"][data-depth="${d}"]`).first(), "fontSize")));
    const body = parseFloat(await style(T("md-p", f).first(), "fontSize"));
    expect(sizes.join() === "16,15,14" && body === 13, `${viewport}: the headings are ${sizes.join(", ")} px over a ${body} px body, not 16, 15, 14 over 13`);
    expect(await T("md-h", f).count() === 4, `${viewport}: the sample has ${await T("md-h", f).count()} headings, not 4 (three and the footnotes' own)`);
    const lists = f.locator('[data-testid="md-list"]');
    expect(await lists.count() >= 5, `${viewport}: ${await lists.count()} lists drawn, not the 5 of the sample (two bulleted, one nested, a numbered one, a task list)`);
    const numbers = await f.locator('[data-ordered="true"]').first().locator('[data-testid="md-li"]').allTextContents();
    expect(numbers.join("|").replace(/\s+/g, "") === "3.third|4.fourth", `${viewport}: the numbered list reads ${JSON.stringify(numbers)}, not 3. third, 4. fourth`);
    const boxes = await T("md-check", f).evaluateAll((els) => els.map((e) => e.getAttribute("aria-checked")));
    expect(boxes.join() === "true,false", `${viewport}: the task boxes are ${boxes.join()}, not true,false`);
    const del = await f.locator("text=struck").first().evaluate((e) => getComputedStyle(e).textDecorationLine);
    expect(/line-through/.test(del), `${viewport}: ~~struck~~ is not struck through (${del})`);
    expect(parseFloat(await style(T("md-quote", f), "borderLeftWidth")) === 3, `${viewport}: the quote has no bar`);
    expect(await T("md-hr", f).count() === 1, `${viewport}: the rule is not drawn`);
    // the table is in a box that scrolls sideways on its own, and the page does not
    const table = T("md-table", f);
    expect(await style(table, "overflowX") === "auto" || await style(table, "overflowX") === "scroll", `${viewport}: the table's box does not scroll sideways (${await style(table, "overflowX")})`);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(wide <= 1, `${viewport}: the page scrolls sideways by ${wide} px with a wide table in it`);
    if (viewport === "phone") {
      const m = await table.evaluate((e) => ({ scroll: e.scrollWidth, client: e.clientWidth }));
      expect(m.scroll > m.client, `${viewport}: the table fits (${m.scroll} in ${m.client}): it has nothing to scroll`);
    }
    const cells = await T("md-th", f).allTextContents();
    expect(cells.join("|") === "Name|Count|Notes", `${viewport}: the table's header is ${cells.join("|")}`);
  });

  await step("raw html and links", async () => {
    expect(await f.locator("b").count() === 0, `${viewport}: raw <b> became an element`);
    expect(((await f.textContent()) ?? "").includes("Raw <b>html</b> is text."), `${viewport}: raw HTML is not shown as its source text`);
    expect(await page.locator('a[href^="javascript"], [data-href^="javascript"]').count() === 0, `${viewport}: a link with the javascript: protocol is drawn`);
    expect(((await f.textContent()) ?? "").includes("bad is dropped, nothing is plain"), `${viewport}: a dropped link or an empty anchor is not its plain text`);
    const hrefs = await T("md-link", f).evaluateAll((els) => els.map((e) => e.getAttribute("data-href")));
    expect(hrefs.includes("https://example.com/a?b=1") && hrefs.includes("https://auto.example") && hrefs.includes("https://example.com/p.png"), `${viewport}: the links are ${JSON.stringify(hrefs)}`);
    const a = T("md-link", f).filter({ hasText: "link" }).first();
    expect(await a.evaluate((e) => e.tagName === "A" && e.target === "_blank" && /noopener/.test(e.rel)), `${viewport}: a link is not an anchor for a new tab with no opener`);
    // an image is a link showing its alt text; nothing is fetched
    expect(await f.locator("img").count() === 0, `${viewport}: an image of Markdown became an img`);
    expect(await T("md-link", f).filter({ hasText: "alt text" }).count() === 1, `${viewport}: the image is not a link showing its alt text`);
    await press(page, a);
    // (the tap or click opened the address in a new tab)
    const opened = await until(async () => context.pages().some((p) => p !== page && /example\.com/.test(p.url())), 8000);
    expect(opened, `${viewport}: pressing a link opened no new tab at its address`);
    for (const p of context.pages()) if (p !== page) await p.close().catch(() => {});
    expect(!requests.some((u) => u.endsWith("/p.png")), `${viewport}: the image's address was fetched`);
  });

  await step("code", async () => {
    const blocks = T("md-code", f);
    expect(await blocks.count() === 3, `${viewport}: ${await blocks.count()} code blocks, not 3`);
    const bash = blocks.nth(0), none = blocks.nth(1), bare = blocks.nth(2);
    expect(((await T("md-code-lang", bash).textContent()) ?? "") === "bash", `${viewport}: the header names "${await T("md-code-lang", bash).textContent()}", not bash`);
    expect(((await T("md-code-lang", none).textContent()) ?? "") === "nosuch" && ((await T("md-code-lang", bare).textContent()) ?? "") === "", `${viewport}: the headers of the two other blocks do not name their fences' words`);
    const colours = (blk) => T("md-code-body", blk).evaluate((e) => [...new Set([getComputedStyle(e).color, ...[...e.querySelectorAll("*")].map((x) => getComputedStyle(x).color)])]);
    expect((await colours(bash)).length >= 3, `${viewport}: a bash block is drawn in ${(await colours(bash)).length} colours: it is not highlighted`);
    expect((await colours(none)).length === 1 && (await colours(bare)).length === 1, `${viewport}: a block of an unknown or no language is coloured`);
    const comment = await T("md-code-body", bash).locator("text=# a comment").first().evaluate((e) => getComputedStyle(e).color);
    const faint = await T("md-code-lang", bash).evaluate((e) => getComputedStyle(e).color);
    expect(comment === faint, `${viewport}: a comment is ${comment}, not the theme's faint colour ${faint}`);
    // Copy: the code only, then "Copied" for a moment
    const copy = T("md-copy", bash);
    await press(page, copy);
    expect(await until(async () => ((await copy.textContent()) ?? "").trim() === "Copied", 8000), `${viewport}: Copy did not say "Copied"`);
    const clip = await page.evaluate(() => navigator.clipboard.readText()).catch((e) => `error: ${e.message}`);
    expect(clip === 'echo "hi"   # a comment\nls -la | grep \'x\'\n', `${viewport}: Copy put ${JSON.stringify(clip)} on the clipboard, not the code only`);
    expect(await until(async () => ((await copy.textContent()) ?? "").trim() === "Copy", 8000), `${viewport}: the button did not say "Copy" again`);
    // the header is not selectable, and no part of what a selection of the message holds
    for (const id of ["md-code-lang", "md-copy"]) {
      const us = await style(T(id, bash).locator("xpath=descendant-or-self::*[normalize-space(text())][1]"), "userSelect");
      expect(us === "none", `${viewport}: ${id} has user-select ${us}`);
    }
    const selected = await f.evaluate((root) => { const r = document.createRange(); r.selectNodeContents(root); const s = getSelection(); s.removeAllRanges(); s.addRange(r); const t = s.toString(); s.removeAllRanges(); return t; });
    expect(!/\bCopy\b/.test(selected) && !selected.includes("nosuch"), `${viewport}: a selection of the whole message holds a code header's words`);
  });

  await step("displayed text", async () => {
    const dom = await f.evaluate((root) => {
      const out = [], w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest('[data-testid="md-code-head"], [data-testid="md-marker"]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
      for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n.data);
      return out.join("");
    });
    const drawn = (await T("md-displayed-drawn").textContent()) ?? "", full = (await T("md-displayed").textContent()) ?? "";
    expect(strip(dom) === strip(drawn), `${viewport}: the text the sample draws differs from its displayed text:\n  drawn      ${JSON.stringify(strip(dom)).slice(0, 200)}\n  displayed  ${JSON.stringify(strip(drawn)).slice(0, 200)}`);
    expect(strip(full) === strip(drawn) && full.length > drawn.length, `${viewport}: the displayed text without separators is not the displayed text less its "\\n" nodes`);
  });

  await step("chips and mentions", async () => {
    const u = page.locator(USER);
    await u.scrollIntoViewIfNeeded();
    const chips = T("ref-chip", u);
    expect(await chips.count() === 2, `${viewport}: ${await chips.count()} chips in the user's message, not 2`);
    const kinds = await chips.evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")));
    expect(kinds.join() === "selection,point", `${viewport}: the chips are ${kinds.join()}, not selection,point`);
    const withPunctuation = await chips.evaluateAll((els) => els.map((e) => e.parentElement?.textContent ?? ""));
    expect(/,$/.test(withPunctuation[0]) && /\.$/.test(withPunctuation[1]), `${viewport}: the punctuation after a chip does not go with it (${JSON.stringify(withPunctuation)})`);
    await press(page, chips.first());
    expect(await until(async () => /^show selection .* on b_demo \(claude\)$/.test(((await T("md-said").textContent()) ?? "").trim()), 8000), `${viewport}: a press on a chip says "${await T("md-said").textContent()}"`);
    const mention = T("md-mention", u);
    expect(await mention.count() === 1 && ((await mention.textContent()) ?? "") === "@Plan", `${viewport}: the mention of a board is ${await mention.count()} links, "${await mention.first().textContent().catch(() => "")}"`);
    expect(((await u.textContent()) ?? "").includes("@Nothing please"), `${viewport}: an @name that names no board is not text`);
    await press(page, mention);
    expect(await until(async () => ((await T("md-said").textContent()) ?? "").trim() === "open board b_plan", 8000), `${viewport}: a press on a mention says "${await T("md-said").textContent()}"`);
  });

  await step("streaming", async () => {
    await T("md-stream-reset").scrollIntoViewIfNeeded();
    await press(page, T("md-stream-reset"));
    for (let i = 0; i < 3; i++) await press(page, T("md-stream-next"));
    expect(await until(async () => await T("md-caret", page.locator(STREAM)).count() === 1, 8000), `${viewport}: no caret follows an answer that is being written`);
    await press(page, T("md-stream-reset"));
    await press(page, T("md-stream-run"));
    const stats = () => T("md-stats").evaluate((e) => ({ chunks: +e.dataset.chunks, of: +e.dataset.of, done: e.dataset.done === "true", parses: +e.dataset.parses, renders: +e.dataset.renders }));
    expect(await until(async () => (await stats()).done, 30000), `${viewport}: the answer did not arrive in full`);
    const s = await stats();
    // each chunk changes the last block alone: a block is parsed once for each text it has had, never again with the others
    // (and once more for a block that a chunk ends and starts the next with: its last text is new. Parsing every block at every chunk would be ~3 times the chunks)
    expect(s.parses <= s.of + 8, `${viewport}: ${s.parses} blocks parsed for ${s.of} chunks of one growing answer: finished blocks are parsed again`);
    expect(s.renders <= s.parses + 8, `${viewport}: ${s.renders} block renders for ${s.parses} parsed texts: finished blocks are drawn again`);
    expect(await T("md-caret", page.locator(STREAM)).count() === 0, `${viewport}: the caret stays when the answer is over`);
    const text = (await page.locator(STREAM).textContent()) ?? "";
    expect(text.includes("That is all of it.") && await T("md-code", page.locator(STREAM)).count() === 1, `${viewport}: the streamed answer is not complete`);
  });

  expect(errors.length === 0, `${viewport}: console errors: ${errors.join(" | ")}`);
}

await check("L9 the Markdown of a message on the gallery", body, { viewports, page: { query: "gallery", wait: '[data-testid="gallery"]' } });
