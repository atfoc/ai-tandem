// UX.T1-thread (package T1 of ux-improvements, plans/ux-improvements/PLAN.md §3 T1): the chat on the phone — its header, its thread's type, the
// Latest pill, tables, the code head, links, the message sheet, Select text and the Quote sheet's comment — on the chat `c_UXT1_chat` of the
// mock's section UXT1 (dev/mock-ui.js: a long title and folder, three branches one of which waits for approval, and a reply with every block).
// On the phone it asserts:
//   header     `chat-head-name` in at most two lines, `chat-head-sub` with the agent and the folder, `chat-tree` with dataSet `count` 3 and the
//              badge amber (another branch waits for approval; the words of its label say so), `chat-more`; a chat with no branches has no count
//   type       the reply's body is 16 px over 24 px lines, h2 20 px, h3 17 px, a list's text indented 24 pt from the text's edge, an inline code
//              chip, the text's left edge 16 pt from the screen's; no floating ⋯ (`fk-more` is not drawn)
//   table      it bleeds to both edges of the screen, has a pinned first column (`md-table-pin`) and the hint ("Swipe for N more columns"); Open
//              full table (`md-table-open`) pushes `table-screen` titled "Table · 6 columns, 4 rows"; its Copy puts the table as Markdown on the
//              clipboard and toasts; the back returns to the chat
//   code       the head names the language (`md-code-lang`), Wrap (`md-code-wrap`, dataSet `on`) toggles and the long line wraps (the block grows
//              and no longer scrolls sideways), Copy puts the code on the clipboard and toasts
//   link       a link is underlined; a touch hold on it opens `link-sheet` (rows `open`, `copy`; the link's words as title) and not `msg-sheet`
//   message    a touch hold on the reply opens `msg-sheet` with the lifted message `msg-lift` (quick row `copy`, `quote`, `select`); Select text
//              opens the Quote sheet in mode `select`, Copy all puts the message as written on the clipboard; Quote → the words selected →
//              Quote → the comment sheet (`quote-comment-sheet`, "Add to message") → the quote reaches the composer's draft with its comment
//   latest     the Latest pill (`thread-latest`) is not there at the end of the thread; scrolled up while new text arrives it is shown; a tap
//              goes to the end and hides it; at the end new text does not show it
// On the tablet and the desktop only that the phone's parts are absent: no `chat-tree`, `chat-more`, `md-table-open`, `md-table-pin`,
// `md-code-wrap`, no `link-sheet` or `msg-sheet` after a hold (the wide layouts are unchanged).
//
// Run: `cd web && npm run uicheck -- UX.T1-thread`, or alone: node web/dev/checks/UX.T1-thread.mjs (VIEWPORT=phone, DIST=…).
import { check, mockEval, seed, until } from "../shot.mjs";
import { byTid, longPress, press, touchNow } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const CHAT = "c_UXT1_chat", PLAIN = "c_UXT1_plain";
const WAIT = 15000;
const J = JSON.stringify;
const STEP = "copies every font file";

/** In the mock: the chat is writing, and the item at index `at` is this text (user: the person's message). */
const put = (at, text, { user = false, done = false } = {}) => `
  const list = items.${CHAT}, item = ${user ? `{ kind: "user", text: ${J(text)} }` : `{ kind: "text", done: ${done}, text: ${J(text)} }`};
  list[${at}] = item;
  send({ type: "chat_items", chat: ${J(CHAT)}, branch: "main", version: (versions.${CHAT} = (versions.${CHAT} ?? 1) + 1), updates: [{ index: ${at}, item }] });
`;
const setStatus = (status) => `chats.${CHAT}.status = ${J(status)}; send({ type: "chat", chat: chats.${CHAT} });`;

async function body({ page, context, url, viewport, fail, note }) {
  const phone = viewport === "phone";
  const T = (id, data, root = page) => byTid(root, id, data);
  const expect = (ok, what) => { if (!ok) fail(what); return ok; };
  const step = async (name, fn) => { try { await fn(); } catch (e) { fail(`${name}: ${String(e.message ?? e).split("\n")[0]}`); } };
  await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
  await context.route("https://example.com/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<title>example</title>" }));

  const clip = () => page.evaluate(() => navigator.clipboard.readText()).catch((e) => `error: ${e.message}`);
  const clearClip = () => page.evaluate(() => navigator.clipboard.writeText("")).catch(() => {});
  const style = (loc, prop) => loc.evaluate((e, p) => getComputedStyle(e)[p], prop);
  const rect = (loc) => loc.evaluate((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; });
  const seen = (loc) => loc.first().isVisible().catch(() => false);
  const shows = (id, data) => until(async () => seen(T(id, data)), WAIT);
  const gone = (id, data) => until(async () => (await T(id, data).count()) === 0 || !(await seen(T(id, data))), WAIT);
  const toastSays = (re) => until(async () => re.test(((await T("toast").first().textContent().catch(() => "")) ?? "")), 6000);
  const scroller = T("thread-scroll").first();
  const reply = () => T("msg", { role: "assistant" }).first();
  /** The reply's text, as the mock holds it. */
  const replyText = () => mockEval(`return items.${CHAT}[1].text;`, url);
  /** Brings a block of the reply into the window (the thread is a virtual list: scrolling is by the scroller). */
  const bring = async (loc) => { await loc.first().scrollIntoViewIfNeeded(); await page.waitForTimeout(250); };
  /** A finger held on the first line of text of `loc` (not the middle of a block, which may be a link or a table). */
  const holdOn = async (loc) => {
    await bring(loc);
    const at = await loc.first().evaluate((e) => { const rs = [...e.getClientRects()].filter((r) => r.width > 8 && r.height > 8); const r = rs[0] ?? e.getBoundingClientRect(); return { x: r.x + Math.min(r.width / 2, 60), y: r.y + Math.min(r.height / 2, 10) }; });
    await longPress(page, at);
  };

  await step("open", async () => {
    await T("md-p").first().waitFor({ state: "attached", timeout: WAIT });
    await T("msg", { role: "assistant" }).first().waitFor({ state: "visible", timeout: WAIT });
  });

  if (!phone) {
    // ---- the wide layouts: nothing of the phone's chat is drawn, and a hold opens none of the phone's sheets
    for (const id of ["chat-tree", "chat-more", "md-table-open", "md-table-pin", "md-code-wrap", "link-sheet", "msg-sheet", "msg-lift"]) {
      expect(await T(id).count() === 0, `${id} is drawn on the ${viewport} layout`);
    }
    await step("hold", async () => {
      const link = T("md-link").first();
      if (await link.count()) {
        await holdOn(link);
        await page.waitForTimeout(800);
        expect(await T("link-sheet").count() === 0, "a hold on a link opened the link sheet");
      }
      await holdOn(T("md-p").first());
      await page.waitForTimeout(800);
      expect(await T("msg-sheet").count() === 0 && await T("msg-lift").count() === 0, "a hold on a reply opened the message sheet");
    });
    return;
  }

  // ---- the header
  await step("header", async () => {
    const name = T("chat-head-name").first(), sub = T("chat-head-sub").first();
    expect(await seen(name) && await seen(sub), "the header has no chat-head-name or chat-head-sub");
    const n = await rect(name), lh = parseFloat(await style(name, "lineHeight"));
    expect(n.h <= 2 * lh + 2, `the long title is ${Math.round(n.h)} px high: more than two lines of ${lh}`);
    const words = ((await sub.textContent()) ?? "").trim();
    expect(/Claude Code/.test(words) && /storefront-monorepo/.test(words), `the sub-line says ${J(words)}, not the agent and the folder`);
    const tree = T("chat-tree").first();
    expect(await seen(tree) && await seen(T("chat-more")), "the header has no Tree or ⋯");
    expect(await tree.getAttribute("data-count") === "3", `the Tree's count is ${await tree.getAttribute("data-count")}, not 3`);
    expect(/needs your approval/.test((await tree.getAttribute("aria-label")) ?? ""), `the Tree's label is ${J(await tree.getAttribute("aria-label"))}: it does not say a branch waits`);
    // (the badge is the button's one child with a border of its own; amber is warm and strong in its border: red well over blue)
    const badge = await tree.evaluate((b) => {
      for (const e of b.querySelectorAll("*")) { if (parseFloat(getComputedStyle(e).borderTopWidth) >= 1 && e.textContent === "3") return { c: getComputedStyle(e).borderTopColor, text: e.textContent }; }
      return null;
    });
    const rgb = badge?.c.match(/\d+(\.\d+)?/g)?.slice(0, 3).map(Number);
    expect(!!badge && rgb[0] > rgb[2] + 80 && rgb[1] > rgb[2] + 40, `the Tree's badge is ${J(badge)}: not amber while a branch waits for approval`);
  });

  // ---- the thread's type
  await step("type", async () => {
    await bring(T("md-h", { depth: 2 }));
    const msg = reply(), left = (await rect(msg)).x;
    const first = T("md-p", undefined, msg).first();
    expect(parseFloat(await style(first, "fontSize")) === 16 && parseFloat(await style(first, "lineHeight")) === 24, `the body is ${await style(first, "fontSize")} over ${await style(first, "lineHeight")}, not 16 over 24`);
    expect(Math.round((await rect(first)).x) === 16 && Math.round(left) === 16, `the text's left edge is ${(await rect(first)).x} (the message ${left}) from the screen's, not 16`);
    expect(parseFloat(await style(T("md-h", { depth: 2 }).first(), "fontSize")) === 20, `h2 is ${await style(T("md-h", { depth: 2 }).first(), "fontSize")}, not 20`);
    expect(parseFloat(await style(T("md-h", { depth: 3 }).first(), "fontSize")) === 17, `h3 is ${await style(T("md-h", { depth: 3 }).first(), "fontSize")}, not 17`);
    expect(await T("md-list", undefined, msg).count() === 2, `${await T("md-list", undefined, msg).count()} lists in the reply, not 2 (a bulleted and a numbered)`);
    for (const list of [T("md-list", undefined, msg).nth(0), T("md-list", undefined, msg).nth(1)]) {
      const indent = (await rect(T("md-p", undefined, list).first())).x - (await rect(list)).x;
      expect(Math.abs(indent - 24) <= 1, `a list's text is ${indent} pt in from the list, not 24`);
    }
    expect(await T("md-list", { ordered: "true" }, msg).count() === 1, "the numbered list is not drawn as one");
    const chip = T("md-code-inline", undefined, msg).first();
    const chipBg = await style(chip, "backgroundColor");
    expect(await seen(chip) && !/rgba\(0, 0, 0, 0\)|transparent/.test(chipBg), `inline code has no chip (background ${chipBg})`);
    expect(await T("fk-more").evaluateAll((els) => els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; }).length) === 0, "a floating ⋯ (fk-more) is drawn on a message");
  });

  // ---- the table
  await step("table", async () => {
    const table = T("md-table").first();
    await bring(table);
    const win = await page.evaluate(() => innerWidth), r = await rect(table);
    expect(r.x <= 1 && r.right >= win - 1, `the table spans ${Math.round(r.x)} to ${Math.round(r.right)} of a ${win} px screen: it does not bleed to both edges`);
    expect(await seen(T("md-table-pin")), "the table has no pinned first column");
    const pin = await T("md-table-pin").first().evaluate((e) => e.textContent);
    expect(/Step/.test(pin) && /fonts/.test(pin) && !/Before/.test(pin), `the pinned column holds ${J(pin)}, not the first column alone`);
    const hint = ((await T("md-table-hint").first().textContent().catch(() => "")) ?? "").trim();
    expect(/^Swipe for \d+ more columns?/.test(hint), `the hint reads ${J(hint)}`);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(wide <= 1, `the page scrolls sideways by ${wide} px with the table in it`);
    await press(page, T("md-table-open").first());
    expect(await shows("table-screen"), "Open full table did not push the table screen");
    const title = ((await T("table-screen").first().textContent()) ?? "");
    expect(/6 columns, 4 rows/.test(title), `the table screen says ${J(title.slice(0, 80))}, not "6 columns, 4 rows"`);
    await clearClip();
    await press(page, T("table-copy").first());
    expect(await toastSays(/copied/i), "Copy on the table screen did not toast");
    const md = await clip();
    expect(/^\| Step \| Before \| After \| Saved \| Share \| Notes \|\n\| ---/.test(md) && md.split("\n").length === 6, `Copy put ${J(md.slice(0, 120))} on the clipboard, not the table as Markdown`);
    await press(page, T("nav-back").last());
    expect(await gone("table-screen") && await shows("chat-head"), "the back from the table screen did not return to the chat");
  });

  // ---- the code block
  await step("code", async () => {
    const block = T("md-code").first();
    await bring(block);
    expect(((await T("md-code-lang", undefined, block).textContent()) ?? "").trim() === "js", "the code head does not name the language js");
    const wrap = T("md-code-wrap", undefined, block).first();
    if (!await seen(wrap)) return fail("the code head has no Wrap (md-code-wrap)");
    const body = T("md-code-body", undefined, block).first();
    // (how far the code reaches past the block's box: the long line scrolls sideways when it does)
    const scrolls = async () => (await rect(body)).right - (await rect(block)).right;
    expect(await wrap.getAttribute("data-on") === "false", `Wrap starts as on=${await wrap.getAttribute("data-on")}`);
    const before = await rect(block), over = await scrolls();
    expect(over > 8, `the long line does not scroll sideways (${over} px over): the seed has no line longer than the screen`);
    await press(page, wrap);
    expect(await until(async () => (await wrap.getAttribute("data-on")) === "true", 5000), "Wrap did not turn on");
    await page.waitForTimeout(300);
    const after = await rect(block);
    expect(after.h > before.h + 10, `the block is ${Math.round(after.h)} px high wrapped, ${Math.round(before.h)} before: the long line did not wrap`);
    expect(await scrolls() <= 1, `the wrapped block still scrolls sideways by ${await scrolls()} px`);
    await press(page, wrap);
    expect(await until(async () => (await wrap.getAttribute("data-on")) === "false", 5000), "Wrap did not turn off");
    await clearClip();
    await press(page, T("md-copy", undefined, block).first());
    expect(await toastSays(/copied/i), "Copy on the code head did not toast");
    const code = await clip();
    expect(code.startsWith("// copies the fonts once") && code.includes("fs.cpSync"), `Copy put ${J(code.slice(0, 60))} on the clipboard, not the code`);
  });

  // ---- a link: underlined; held, its sheet and not the message's
  await step("link", async () => {
    const link = T("md-link").first();
    await bring(link);
    expect(/underline/.test(await style(link, "textDecorationLine")), `a link is not underlined (${await style(link, "textDecorationLine")})`);
    await holdOn(link);
    expect(await shows("link-sheet"), "a hold on a link did not open the link sheet");
    await page.waitForTimeout(500);
    expect(await T("msg-sheet").count() === 0, "a hold on a link also opened the message sheet");
    const sheet = T("link-sheet").last();
    const text = ((await sheet.textContent()) ?? "");
    expect(/the font copy notes/.test(text) && /https:\/\/example\.com\/fonts/.test(text), `the link sheet says ${J(text.slice(0, 100))}, not the link's words and address`);
    expect(await T("action-row", { action: "open" }, sheet).count() === 1 && await T("action-row", { action: "copy" }, sheet).count() === 1, "the link sheet has no open and copy rows");
    await clearClip();
    await press(page, T("action-row", { action: "copy" }, sheet).first());
    expect(await gone("link-sheet"), "Copy link did not close the link sheet");
    expect(await until(async () => (await clip()) === "https://example.com/fonts", 5000), `Copy link put ${J(await clip())} on the clipboard`);
  });

  // ---- a hold on the reply: the message sheet and the lifted message; Select text
  const text = await replyText();
  await step("message sheet", async () => {
    await holdOn(T("md-p", undefined, reply()).first());
    expect(await shows("msg-sheet"), "a hold on a reply did not open the message sheet");
    expect(await seen(T("msg-lift")), "the message sheet has no lifted message (msg-lift)");
    expect(await T("link-sheet").count() === 0, "a hold on a reply opened the link sheet");
    for (const id of ["copy", "quote", "select"]) expect(await T("action-row", { action: id }, T("msg-sheet").last()).count() === 1, `the message sheet has no ${id} in its quick row`);
    await clearClip();
    await press(page, T("action-row", { action: "select" }, T("msg-sheet").last()).first());
    expect(await shows("quote-sheet"), "Select text did not open the Quote sheet");
    expect(await T("quote-sheet-body").first().getAttribute("data-mode") === "select", `the sheet's mode is ${await T("quote-sheet-body").first().getAttribute("data-mode")}, not select`);
    expect(await seen(T("select-copy")) && await seen(T("select-copy-all")), "the Select text sheet has no Copy selection and Copy all");
    await press(page, T("select-copy-all").first());
    expect(await toastSays(/copied/i), "Copy all did not toast");
    expect(await clip() === text, `Copy all put ${J((await clip()).slice(0, 60))} on the clipboard, not the message as written`);
    expect(await gone("quote-sheet"), "Copy all did not close the sheet");
  });

  // ---- Quote → the words → the comment sheet → the composer
  await step("quote", async () => {
    await holdOn(T("md-p", undefined, reply()).first());
    await shows("msg-sheet");
    await press(page, T("action-row", { action: "quote" }, T("msg-sheet").last()).first());
    expect(await shows("quote-sheet"), "Quote did not open the Quote sheet");
    expect(await T("quote-sheet-body").first().getAttribute("data-mode") === "quote", "the Quote sheet's mode is not quote");
    const box = T("quote-text").first();
    const shown = await box.inputValue();
    const a = shown.indexOf(STEP);
    expect(a >= 0, `the Quote sheet's text does not hold ${J(STEP)}`);
    await box.evaluate((el, [x, y]) => { el.focus(); el.setSelectionRange(x, y); }, [a, a + STEP.length]);
    await page.keyboard.press("Shift"); // (a key up in the box: the browser tells React the selection changed, as a finger's handles do)
    expect(await until(async () => !(await T("quote-selection").first().isDisabled()), 5000), `"Quote" stays off with ${J(STEP)} selected`);
    await press(page, T("quote-selection").first());
    expect(await shows("quote-comment-sheet"), "Quote did not open the comment sheet");
    const save = T("qfloat-save").first();
    expect(((await save.textContent()) ?? "").trim() === "Add to message", `the comment sheet's button says ${J(await save.textContent())}, not "Add to message"`);
    expect(((await T("qfloat-quote").first().textContent()) ?? "").includes(STEP), "the comment sheet does not show the quoted words");
    await T("qfloat-comment").first().fill("which files?");
    await press(page, save);
    expect(await gone("quote-comment-sheet"), "Add to message did not close the comment sheet");
    expect(await until(async () => /^❝ 1\b/.test(((await T("qcount").first().textContent().catch(() => "")) ?? "").trim()), 8000), `the composer's count says ${J(await T("qcount").first().textContent().catch(() => null))}, not ❝ 1`);
    let refs = [];
    await until(async () => (refs = await mockEval(`return chats.${CHAT}.draft?.references ?? [];`, url)).length > 0, 10000);
    expect(refs.length === 1 && refs[0].quote === STEP && refs[0].comment === "which files?", `the draft holds ${J(refs)}, not the quote with its comment`);
  });

  // ---- Open link, last of the sheets: a new tab takes the focus, and the first touch on the page after it is not always delivered
  await step("open link", async () => {
    const link = T("md-link").first();
    await holdOn(link);
    expect(await shows("link-sheet"), "a hold on a link did not open the link sheet again");
    await page.waitForTimeout(400);
    await press(page, T("action-row", { action: "open" }, T("link-sheet").last()).first());
    expect(await until(async () => context.pages().some((p) => p !== page && /example\.com/.test(p.url())), 8000), "Open link opened no new tab at the address");
    for (const p of context.pages()) if (p !== page) await p.close().catch(() => {});
    await page.bringToFront();
    expect(await gone("link-sheet"), "Open link did not close the link sheet");
  });

  // ---- the Latest pill (last: it adds to the chat)
  await step("latest", async () => {
    const read = () => scroller.evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight, view: el.clientHeight }));
    const gap = async () => { const s = await read(); return s.height - s.top - s.view; };
    const atEnd = async (bound = WAIT) => !!await until(async () => (await gap()) < 40, bound);
    const touch = await touchNow(page);
    const scrollBy = async (dy) => {
      const before = (await read()).top, b = await scroller.boundingBox(), x = b.x + b.width / 2, y = b.y + b.height / 2;
      if (touch) {
        const c = await page.context().newCDPSession(page);
        await c.send("Input.synthesizeScrollGesture", { x, y, yDistance: -dy, speed: 1500, gestureSourceType: "touch" }).catch(() => {});
        await c.detach();
      } else { await page.mouse.move(x, y); await page.mouse.wheel(0, dy); }
      if (!await until(async () => Math.abs((await read()).top - before) > 1, 1500)) await scroller.evaluate((el, d) => { el.scrollTop += d; }, dy);
      await until(async () => { const a = (await read()).top; await page.waitForTimeout(60); return a === (await read()).top; }, 3000);
    };
    // at the end, new text does not show the pill
    await scrollBy(100000);
    expect(await atEnd(), "the thread is not at its end before the stream");
    expect(await T("thread-latest").count() === 0, "the Latest pill is shown at the end of the thread");
    await mockEval(put(3, "Now stream an answer, please.", { user: true }), url);
    await mockEval(setStatus("writing") + put(4, "First paragraph of the answer.", {}), url);
    await atEnd();
    await mockEval(put(4, "First paragraph of the answer.\n\nSecond paragraph, still at the end."), url);
    await page.waitForTimeout(500);
    expect(await T("thread-latest").count() === 0, "new text at the end of the thread showed the Latest pill");
    // scrolled up while new text arrives: shown
    await scrollBy(-500);
    expect((await gap()) > 120, `the scroll up left the thread ${await gap()} px from its end`);
    await mockEval(put(4, Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1} arrives while the person reads above.`).join("\n\n")), url);
    expect(await shows("thread-latest"), "scrolled up while new text arrived, the Latest pill is not shown");
    // a tap goes to the end and hides it
    await press(page, T("thread-latest").first());
    expect(await atEnd(), `the Latest pill's tap left the thread ${await gap()} px from its end`);
    expect(await gone("thread-latest"), "the Latest pill is still shown at the end");
    await mockEval(put(4, Array.from({ length: 18 }, (_, i) => `Paragraph ${i + 1} arrives while the person reads above.`).join("\n\n"), { done: true }) + setStatus("ready") + `items.${CHAT}[5] = { kind: "end" };`, url);
    await page.waitForTimeout(500);
    expect(await T("thread-latest").count() === 0, "the pill came back for text that arrived while the thread was at its end");
  });
}

await check("UX.T1-thread the chat on the phone: header, type, tables, code, links, the message sheet, quotes, the Latest pill", async (c) => {
  await seed(c.url, "UXT1");
  const { page, ctx } = await c.open({ sel: { chat: CHAT }, wait: '[data-testid="chat-head"]' });
  await body({ ...c, page, context: ctx });
  if (c.viewport === "phone") {
    // a chat with no branches: its Tree has no count and does not say a branch waits
    await ctx.close().catch(() => {});
    const o = await c.open({ sel: { chat: PLAIN }, wait: '[data-testid="chat-head"]' });
    const tree = byTid(o.page, "chat-tree").first();
    await tree.waitFor({ state: "visible", timeout: WAIT }).catch(() => {});
    if (await tree.count()) {
      if ((await tree.getAttribute("data-count")) !== null) c.fail(`phone: a chat with no branches has a Tree count (${await tree.getAttribute("data-count")})`);
      if (/needs your approval/.test((await tree.getAttribute("aria-label")) ?? "")) c.fail("phone: a chat with no branches says a branch waits for approval");
    } else c.fail("phone: the chat with no branches has no Tree");
  }
}, { viewports, page: false });
