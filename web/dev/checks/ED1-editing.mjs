// ED1 (new; the composer's code-editor editing): Tab, Shift+Tab and Enter in the web chip input (app/src/platform/chipinput/ChipInput.web.tsx,
// the contract's `editing` in types.ts; the edits are core logic/indent.ts, cut into replaces by chipinput/edits.ts). It has no old check
// to port. On the gallery (`/?gallery`, section "Chip input": "Tab", "2 spaces" and "Enter: line" switch the box's editing on and leave a
// plain Enter to it), whose readout is the box's exact value:
//   Tab puts in a tab character ("Tab") or the spaces to the next stop ("2 spaces"); the focus stays in the box; ⌘Z (Ctrl+Z) undoes it
//   as one step. Shift+Tab takes one level off, and with nothing to take off still keeps the focus. A selection over several lines:
//   Tab and Shift+Tab indent and outdent every line, one ⌘Z undoes it. Enter (and Shift+Enter) keep the line's indent; on "- item" the
//   next line starts "- ", and Enter on an empty "- " ends the list. A chip in the lines stays the same node, its tag whole.
//   Line breaks round-trip: the value read back is the edit's, with a line break at the very end of the box (the browser's extra break
//   that draws the empty last line is no part of it), right after a chip, and after `set` of a value that ends in one; typing goes on
//   on the new line. A box set to a value that ends in a line break, with no caret in it: a chip inserted goes to the value's end
//   (not after the break that draws the empty last line), and so do focus(true)'s caret and what is typed then. Esc, then Tab or
//   Shift+Tab, moves the focus out of the box; a key in between, or a second Tab, indents again. The box draws a tab `tab-size` wide
//   (4, or 2) and is `white-space: pre-wrap`. Locked: Tab edits nothing.
// On the real composer (a plain chat of the mock's A2 seed) with `aiwb.composer.settings` = 2 spaces in localStorage before the page loads:
// Tab indents at every layout; Enter keeps the indent and continues the list (Shift+Enter too, on the wide layouts); Esc, then Tab, leaves
// the box; ⌘/Ctrl+Enter sends; the message sent holds the indents as typed.
import { callsOf, check, seed, until } from "../shot.mjs";
import { openState } from "./composer.mjs";
import { byTid, press, tidSel } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const J = JSON.stringify;
const BOX = tidSel("composer-input");
const POST = /\/chats\/(\w+)\/messages(\?|$)/;
const SETTINGS = "aiwb.composer.settings";

await check("ED1 the composer's box edits like code: Tab, Shift+Tab, Enter's indent and lists, undo, chips, line breaks", async ({ url, viewport, open, fail }) => {
  const phone = viewport === "phone";
  const enterKey = phone ? "Enter" : "Shift+Enter"; // (both are line breaks in the real composer: one of each, by the layout)

  // ---- the gallery
  {
    const { page, ctx } = await open({ query: "gallery", wait: tidSel("gallery-chip-editing-tab") });
    const T = (id) => byTid(page, id).first();
    const value = async () => (await T("gallery-chip-value").textContent()) ?? "";
    const holds = async (want, what) => { if (!await until(async () => (await value()) === want, 8000)) fail(`${what}: the box holds ${J(await value())}, not ${J(want)}`); };
    const set = (v) => page.evaluate((v) => window.__aiwbChip.set(v), v);
    const toEnd = () => page.evaluate((s) => {
      const el = document.querySelector(s); el.focus();
      const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    }, BOX);
    const inBox = () => page.evaluate((s) => document.activeElement?.matches(s) ?? false, BOX);
    const chips = () => page.$$eval(`${BOX} ${tidSel("ref-chip")}`, (els) => els.map((e) => e.dataset.ref));
    const style = (prop) => page.$eval(BOX, (el, p) => getComputedStyle(el).getPropertyValue(p), prop);
    const step = async (name, fn) => { try { await fn(); } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); } };
    const key = (k) => page.keyboard.press(k);
    // (Playwright on macOS gives Home the scroll of the page; the line's start is ⌘← there)
    const home = () => key(process.platform === "darwin" ? "Meta+ArrowLeft" : "Home");

    await press(page, T("gallery-chip-editing-tab"));
    await press(page, T("gallery-chip-enter-line"));
    await press(page, page.locator(BOX).first());

    await step("tab-size and white-space", async () => {
      if (await style("white-space") !== "pre-wrap") fail(`the box is white-space ${await style("white-space")}, not pre-wrap`);
      if (await style("tab-size") !== "4") fail(`a tab is drawn ${J(await style("tab-size"))} wide, not 4`);
    });

    await step("Tab at a caret, the focus, undo", async () => {
      await set(""); await toEnd();
      await page.keyboard.type("ab");
      await key("Tab");
      await holds("ab\t", "Tab after \"ab\"");
      if (!await inBox()) fail("Tab took the focus out of the box");
      await page.keyboard.type("c");
      await holds("ab\tc", "typing after Tab");
      await set(""); await toEnd();
      await page.keyboard.type("xy");
      await key("Tab");
      await holds("xy\t", "Tab after \"xy\"");
      await key("ControlOrMeta+z");
      await holds("xy", "⌘Z after Tab (one step)");
    });

    await step("Shift+Tab", async () => {
      await set("\tx"); await toEnd();
      await key("Shift+Tab");
      await holds("x", "Shift+Tab on \"\\tx\"");
      await key("Shift+Tab");
      await page.waitForTimeout(150);
      await holds("x", "Shift+Tab with nothing to outdent");
      if (!await inBox()) fail("Shift+Tab with nothing to outdent took the focus out of the box");
    });

    await step("Esc, then Tab, leaves the box", async () => {
      await set("ab"); await toEnd();
      await key("Escape");
      await key("Tab");
      await page.waitForTimeout(150);
      if (await inBox()) fail("Esc then Tab left the focus in the box");
      await holds("ab", "Esc then Tab");
      await set("ab"); await toEnd();
      await key("Escape");
      await key("Shift+Tab");
      await page.waitForTimeout(150);
      if (await inBox()) fail("Esc then Shift+Tab left the focus in the box");
      // a key in between: Tab is the box's again
      await set("ab"); await toEnd();
      await key("Escape");
      await page.keyboard.type("c");
      await key("Tab");
      await holds("abc\t", "Esc, \"c\", then Tab");
      if (!await inBox()) fail("Tab after Esc and another key took the focus out of the box");
      // only the next Tab: the one after it indents
      await set("ab"); await toEnd();
      await key("Escape");
      await key("Tab");
      await toEnd();
      await key("Tab");
      await holds("ab\t", "Tab after the Tab that left the box, the focus back in it");
      if (!await inBox()) fail("a second Tab after Esc, the focus back in the box, took the focus out");
    });

    await step("lines selected", async () => {
      await set("a\nb\nc"); await toEnd();
      await key("ControlOrMeta+a");
      await key("Tab");
      await holds("\ta\n\tb\n\tc", "Tab over three lines");
      await key("Shift+Tab");
      await holds("a\nb\nc", "Shift+Tab over three lines");
      await key("Tab");
      await holds("\ta\n\tb\n\tc", "Tab over three lines again");
      await key("ControlOrMeta+z");
      await holds("a\nb\nc", "⌘Z after a Tab over three lines (one step)");
    });

    await step("Enter keeps the indent", async () => {
      await set("\tfoo"); await toEnd();
      await key("Enter");
      await holds("\tfoo\n\t", "Enter on \"\\tfoo\"");
      await page.keyboard.type("bar");
      await holds("\tfoo\n\tbar", "typing after Enter");
      await key("Shift+Enter");
      await holds("\tfoo\n\tbar\n\t", "Shift+Enter on \"\\tbar\"");
    });

    await step("lists", async () => {
      await set("- item"); await toEnd();
      await key("Enter");
      await holds("- item\n- ", "Enter on \"- item\"");
      await key("Enter");
      await holds("- item\n", "Enter on an empty \"- \" (the list ends)");
      await page.keyboard.type("after");
      await holds("- item\nafter", "typing after the list");
      await set("1. one"); await toEnd();
      await key("Enter");
      await holds("1. one\n2. ", "Enter on \"1. one\"");
    });

    await step("a line break at the end of the box round-trips", async () => {
      await set("foo"); await toEnd();
      await key("Enter");
      await holds("foo\n", "Enter at the end of \"foo\"");
      await page.keyboard.type("x");
      await holds("foo\nx", "typing on the new last line");
      await set("foo\n");
      await holds("foo\n", "set(\"foo\\n\")");
      await toEnd();
      await page.keyboard.type("y");
      await holds("foo\ny", "typing at the end of a box set to \"foo\\n\"");
    });

    await step("the end of a box set to a value that ends in a line break", async () => {
      // (no caret in the box, as after a draft is loaded with the focus on the board: a chip goes to the value's end, not after the break that draws its empty last line)
      await page.evaluate(() => document.activeElement?.blur());
      await set("fix this\n");
      await press(page, T("gallery-chip-insert-point"));
      await until(async () => (await chips()).length === 1, 8000);
      const [tag] = await chips();
      await holds(`fix this\n${tag} `, "a point inserted with no caret into a box set to \"fix this\\n\"");
      await page.evaluate(() => document.activeElement?.blur());
      await set("foo\n");
      await page.evaluate(() => window.__aiwbChip.focus(true));
      const caret = await page.evaluate(() => window.__aiwbChip.caret());
      if (caret?.start !== 4 || caret?.end !== 4) fail(`focus(true) on "foo\\n" puts the caret at ${J(caret)}, not 4 (the value's end)`);
      await page.keyboard.type("z");
      await holds("foo\nz", "typing after focus(true) on a box set to \"foo\\n\"");
    });

    await step("chips", async () => {
      await press(page, T("gallery-chip-set"));
      await until(async () => (await chips()).length === 2, 8000);
      const [tag] = await chips();
      await set(`a ${tag}`); await toEnd();
      await key("Enter");
      await holds(`a ${tag}\n`, "Enter right after a chip");
      await page.keyboard.type("z");
      await holds(`a ${tag}\nz`, "typing after Enter right after a chip");
      await set(`${tag} a\nb`);
      await page.$eval(`${BOX} ${tidSel("ref-chip")}`, (c) => { c.dataset.mark = "same"; });
      await toEnd();
      await key("ControlOrMeta+a");
      await key("Tab");
      await holds(`\t${tag} a\n\tb`, "Tab over two lines, a chip in the first");
      if (!await page.$(`${BOX} ${tidSel("ref-chip")}[data-mark="same"]`)) fail("Tab over lines with a chip made the chip anew (or took it out)");
      await key("Shift+Tab");
      await holds(`${tag} a\nb`, "Shift+Tab over two lines, a chip in the first");
      await set(`x ${tag}`); await toEnd();
      await page.evaluate(() => window.__aiwbChip.select({ start: 0, end: 0 })); // (⌘← from after a chip stops before the chip)
      await key("Tab");
      await holds(`\tx ${tag}`, "Tab at the start of a line with a chip");
      if ((await chips()).length !== 1) fail("the chip is gone after Tab");
    });

    await step("2 spaces", async () => {
      await press(page, T("gallery-chip-editing-spaces"));
      await until(async () => (await style("tab-size")) === "2", 4000);
      if (await style("tab-size") !== "2") fail(`with 2 spaces a tab is drawn ${J(await style("tab-size"))} wide, not 2`);
      await set("a"); await toEnd();
      await key("Tab");
      await holds("a ", "Tab after \"a\" with 2 spaces (to the next stop)");
      await set("a"); await toEnd();
      await home();
      await key("Tab");
      await holds("  a", "Tab at a line's start with 2 spaces");
      await key("Shift+Tab");
      await holds("a", "Shift+Tab with 2 spaces");
    });

    await step("locked", async () => {
      await set("q"); await toEnd();
      await press(page, T("gallery-chip-locked"));
      await until(async () => ((await T("gallery-chip-mode").textContent()) ?? "").includes("locked"), 4000);
      await toEnd();
      await key("Tab");
      await page.waitForTimeout(150);
      await holds("q", "Tab while locked");
      await press(page, T("gallery-chip-locked"));
    });
    await ctx.close();
  }

  // ---- the real composer, the setting given before the page loads
  {
    const states = await seed(url, "A2");
    const { page, ctx } = await openState(open, states.find((s) => s.id === "plain-new"), viewport, 0,
      { ls: { [SETTINGS]: J({ tabInserts: "spaces", tabWidth: 2 }) } });
    const calls = callsOf(page);
    const box = byTid(page, "composer-input").first();
    await press(page, box);
    if (await box.evaluate((el) => getComputedStyle(el).tabSize) !== "2") fail("the composer's box does not draw a tab 2 wide with the setting at 2");
    await page.keyboard.type("list:");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    const inComposer = () => box.evaluate((el) => document.activeElement === el || el.contains(document.activeElement), null);
    if (!await inComposer()) fail("Tab took the focus out of the composer's box");
    await page.keyboard.type("- one");
    await page.keyboard.press(enterKey);
    await page.keyboard.type("two");
    const text = await box.evaluate((el) => el.textContent);
    if (!/^list:\n {2}- one\n {2}- two/.test(text ?? "")) fail(`the composer's box holds ${J(text)}, not "list:\\n  - one\\n  - two"`);
    // Esc, then Tab: the keyboard's way out of the composer's box (and back in by a press)
    await page.keyboard.press("Escape");
    await page.keyboard.press("Tab");
    await page.waitForTimeout(150);
    if (await inComposer()) fail("Esc then Tab left the focus in the composer's box");
    await box.evaluate((el) => {
      el.focus();
      const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    });
    const from = calls.length;
    await page.keyboard.press("ControlOrMeta+Enter");
    const sent = await until(() => calls.slice(from).find((c) => c.method === "POST" && POST.test(c.path)), 10000);
    if (!sent) fail("⌘/Ctrl+Enter did not send the message");
    else if (sent.body?.text !== "list:\n  - one\n  - two") fail(`the message sent is ${J(sent.body?.text)}, not "list:\\n  - one\\n  - two"`);
    await ctx.close();
  }
}, { viewports, page: false });
