// Proves the text box's side of the insert popup (plans/prompt-library.md, section 5; section 10, lines 11 to 15), in
// the page. What the box must hold afterwards is test/insert.test.ts's; here it is the page that holds it, with the
// caret, the focus and undo. The popup itself, with its list and its keys, is PL5.2's.
//   The app, a chat's composer. ⌘P in the text box is the box's: the page does not get it
//   (it would print), and once the popup it opens is closed with Esc the box has the focus and its caret or its
//   selection, so what is typed next goes where it would have gone. The toolbar has the Insert button, which does
//   the same. ⌘P with the cursor elsewhere (nowhere, in a message, in another field) is left to the browser.
//   A chat's toolbar draws the button only where its row has room left (logic/composerfit.ts fitWithTail): beside
//   a board, in a panel of 480 px, a started chat's whole row has the voice pair beside its controls and the meter's text,
//   and leaves the button no room: there is no button and no "more" chip, and ⌘P is the box's all the same. In a panel of
//   430 px the pair stays in the row and the folder gives way to it, into the "more" popup, where the button's entry is
//   too; the meter keeps its text. In a panel of 410 px the model is in the popup as well, and what that leaves is the
//   button's. In a pane of 300 px the composer fits its box, with the button or without.
//   The box alone (src/RefInput.tsx, bundled here with a stand-in for the popup that takes the focus as the popup's
//   search field will). A text goes in where the caret was when the popup opened: in the middle of typed text, in
//   place of a selection, in an empty box, with its line breaks; what was before and after is unchanged, the box has
//   the focus and the caret is right after the text (what is typed next stands there); ⌘Z takes the text out again.
//   Reference chips stay the very elements they were, and Backspace still removes one whole; a mention being typed
//   is still completed. What the box tells its composer (the value that is saved as the draft and sent) has the text.
//   Closed with nothing inserted, the box has the focus and the caret or the selection it had. A box filled anew
//   while the popup is open gets the text at its end; a selection that ends inside a chip, and a browser that does
//   not do the insertion, leave the box as test/insert.test.ts says all the same.// At the phone (ux-improvements C1) the composer is the phone's (a window under 700 px, also in the desktop and tablet runs' narrow windows): the Insert button is
// "+" (Add to message) and its "Insert a prompt" row (`action-row`, action `prompt`): the sheet closes, then the popup opens, with the same box afterwards; there is no "more"
// chip and no toolbar row to measure, so the fit is the phone's row (`composer-phone-tools`: nothing past the window, the primary not covered, no sideways scroll).
//
// Ports dev/checks/PL5.1-insert.mjs (S11) to the new build, at the three viewports (C-PL-20, 22 to 24, 30; the box alone is the chip input of the gallery, `?gallery`, with the stand-in for the popup
// that takes the focus as the popup's search does: it hands the checks its targets in `window.__aiwbInsert` and its handle in `window.__aiwbChip`). What changed: the selectors, the presses,
// and the toolbar's button, which a row too narrow for it does not draw (the phone's): there the "more" popup's entry opens the popup, with the same keys and the same box afterwards; the widths
// of a pane (a panel of 430 px beside a board, a page of 300 px) are the desktop's, and at the touch viewports a window of that width (the phone layout), where only the fit and ⌘P are held.

import { check, seed, until } from "../shot.mjs";
import { byTid, layoutNow, press, tidSel } from "./sel.mjs";
import { frame, measureComposer, openAt } from "./composer.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const KEY = "ControlOrMeta+p", PROMPT = "Review this change.\n\n- name what is wrong\n- say why";
const bare = (v) => v.replace(/\n+$/, ""); // (the break of an empty last line is the browser's)

/** In the page: notes every keydown before anything of the page gets it; taken() answers whether the last one was
 *  kept from the browser (which would print on ⌘P), read after the page has handled it. */
function watchKeys() {
  window.__keys = [];
  window.addEventListener("keydown", (e) => window.__keys.push(e), true);
  window.__taken = () => { const e = window.__keys.at(-1); return e ? { code: e.code, prevented: e.defaultPrevented } : null; };
}
/** In the page: where the focus is, and the selection's text. */
const focusOf = () => ({ box: !!document.activeElement?.matches('[data-testid="composer-input"]'), el: document.activeElement?.dataset?.testid || document.activeElement?.tagName, selected: String(getSelection()) });
const BOX = tidSel("composer-input");

/** The fit of the page's composer: the wide toolbar's measure (measureComposer) or, in a window of the phone layout, the phone row's. */
async function fitOf(page) {
  if (layoutNow(page) !== "phone") return (await measureComposer(page)).find((c) => !c.none);
  return page.evaluate(() => {
    const comp = document.querySelector('[data-testid="composer"]'), tools = comp?.querySelector('[data-testid="composer-phone-tools"]');
    if (!tools) return null;
    const over = [...tools.children].filter((e) => e.getBoundingClientRect().right > innerWidth + 0.5 || e.getBoundingClientRect().left < -0.5);
    const p = comp.querySelector('[data-testid="send"], [data-testid="composer-talk"], [data-testid="stop"]');
    let send = "none";
    if (p) { const q = p.getBoundingClientRect(), h = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2); send = h === p || p.contains(h) ? "ok" : h ? "covered" : "outside the window"; }
    return { past: over.length, over: over.map((e) => e.dataset.testid), send, docScroll: document.documentElement.scrollWidth - innerWidth };
  });
}

await check("PL5.1 a text put into a composer's text box, and ⌘P in it and elsewhere", async ({ url, open, fail, note, layout }) => {
  // ---- the app
  const seeded = await seed(url, "A2");
  const state = (id) => seeded.find((s) => s.id === id) ?? fail(`the seed has no state ${id}`);
  {
    const name = "a chat's composer";
    const { page, ctx } = await open({ sel: state("plain-started").sel, wait: BOX });
    const boxText = () => page.locator(BOX).first().evaluate((e) => e.innerText);
    /** The app's insert popup, which ⌘P and the Insert button open, closed with Esc. */
    const shut = async () => { await page.waitForSelector(tidSel("insert-popup"), { timeout: 10000 }); await page.keyboard.press("Escape"); await page.waitForSelector(tidSel("insert-popup"), { state: "detached", timeout: 10000 }); };
    try {
      await page.evaluate(watchKeys);
      const box = byTid(page, "composer-input").first();
      // (the box is emptied by hand, as a user would)
      await press(page, box);
      await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.press("Backspace");
      await page.keyboard.type("Hello world");
      for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
      await page.keyboard.press(KEY);
      let k = await page.evaluate(() => window.__taken());
      if (k?.code !== "KeyP" || !k.prevented) fail(`${name}: ⌘P in the text box was left to the browser, which prints: ${JSON.stringify(k)}`);
      await shut();
      let f = await until(async () => { const x = await page.evaluate(focusOf); return x.box ? x : null; }, 5000) || await page.evaluate(focusOf);
      if (!f.box) fail(`${name}: after ⌘P and Esc the focus is in ${f.el}, not in the text box`);
      await page.keyboard.type("X");
      if (bare(await boxText()) !== "HelloX world") fail(`${name}: after ⌘P and Esc the caret is not where it was: typing gave ${JSON.stringify(await boxText())}`);
      // a selection is kept too
      for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowRight");
      await page.keyboard.press(KEY);
      await shut();
      await until(async () => (await page.evaluate(focusOf)).box, 5000);
      f = await page.evaluate(focusOf);
      if (!f.box || f.selected !== " worl") fail(`${name}: after ⌘P and Esc the selection is ${JSON.stringify(f.selected)} in ${f.el}, not " worl" in the text box`);

      // the toolbar's button: the same, and the focus stays in the box (a row without room for it has the "more" popup's entry in its place)
      const button = byTid(page, "insert-btn");
      // (a row with neither the button nor the chip, as a phone's with voice's pair beside the controls, has the key alone: the button gives way to the pair)
      const hasMore = await byTid(page, "more-chip").count();
      const atPhone = layoutNow(page) === "phone"; // ("+" and its "Insert a prompt" row: the sheet closes, the popup opens)
      const viaMore = async () => {
        if (atPhone) { await press(page, byTid(page, "composer-plus")); await press(page, byTid(page, "action-row", { action: "prompt" })); return; }
        if (!hasMore) { await page.keyboard.press(KEY); return; }
        await press(page, byTid(page, "more-chip")); await press(page, byTid(page, "more-insert"));
      };
      const has = await button.count();
      if (has > 1) fail(`${name}: the toolbar has ${has} Insert buttons`);
      if (has === 1) {
        const title = await button.getAttribute("title");
        if (!/^Insert a prompt \((⌘P|Ctrl\+P)\)$/.test(title ?? "")) fail(`${name}: the Insert button's title is ${JSON.stringify(title)}`);
        await press(page, button);
      } else await viaMore();
      await shut();
      await until(async () => (await page.evaluate(focusOf)).box, 5000);
      f = await page.evaluate(focusOf);
      if (!f.box || f.selected !== " worl") fail(`${name}: after ${has ? "a press on the Insert button" : atPhone ? "the \"+\" sheet's Insert a prompt row" : hasMore ? "the entry of the \"more\" popup" : "the key"} the selection is ${JSON.stringify(f.selected)} in ${f.el}`);
      await page.keyboard.type("Y");
      if (bare(await boxText()) !== "HelloXYd") fail(`${name}: typing after the Insert button gave ${JSON.stringify(await boxText())}`);
      // reached with the keyboard, it puts the focus back into the box, at the caret
      if (has === 1) { await button.focus(); await page.keyboard.press("Enter"); }
      else if (atPhone) { await byTid(page, "composer-plus").focus(); await page.keyboard.press("Enter"); const row = byTid(page, "action-row", { action: "prompt" }); await row.waitFor({ state: "visible", timeout: 8000 }); await row.focus(); await page.keyboard.press("Enter"); }
      else if (hasMore) { await byTid(page, "more-chip").focus(); await page.keyboard.press("Enter"); await byTid(page, "more-insert").focus(); await page.keyboard.press("Enter"); }
      else await page.keyboard.press(KEY);
      await shut();
      if (!await until(async () => (await page.evaluate(focusOf)).box, 5000)) fail(`${name}: Enter on the Insert button left the focus in ${(await page.evaluate(focusOf)).el}`);
      await page.keyboard.type("Z");
      if (bare(await boxText()) !== "HelloXYZd") fail(`${name}: typing after Enter on the Insert button gave ${JSON.stringify(await boxText())}`);
      const m = await fitOf(page);
      if (!m || m.past || m.send !== "ok" || m.docScroll > 0) fail(`${name}: the composer does not fit with the Insert button: ${JSON.stringify(m && { past: m.past, over: m.over, send: m.send })}`);

      // elsewhere ⌘P is the browser's: with the focus nowhere, after a press outside the composer, and in another field
      const left = async (where) => {
        await page.keyboard.press(KEY);
        k = await page.evaluate(() => window.__taken());
        if (k?.code !== "KeyP" || k.prevented) fail(`${name}: ⌘P ${where} was taken from the browser: ${JSON.stringify(k)}`);
      };
      await page.evaluate(() => document.activeElement?.blur());
      await left("with the focus nowhere");
      await press(page, byTid(page, "msg").first(), { position: { x: 5, y: 5 } });
      if ((await page.evaluate(focusOf)).box) fail(`${name}: a press on a message left the focus in the text box`);
      else await left("after a press on a message");
      await page.evaluate(() => { const i = document.createElement("input"); i.id = "other-field"; document.body.append(i); i.focus(); });
      await left("in another field");
      note(`${name}: ⌘P is the text box's alone, the ${has ? "Insert button is" : atPhone ? "\"+\" sheet's row is" : "\"more\" popup's entry is"} in the toolbar, the caret is kept`);
    } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); } finally { await ctx.close(); } // (one page at a time: the mock has one stream)
  }
  // a chat's toolbar draws the button where its row has room left, and the composer fits its box
  // (what the toolbar has: button, the Insert button in the row; text, the meter's text; chip, the "more" chip; null, either. Voice's pair stands in the row, and the
  // controls give way to it, into the "more" popup, before the meter's text does; the Insert button has what is left.
  // The panes are the desktop's; a touch viewport's window is the phone layout.)
  for (const [name, id, width, want] of [
    ["a started chat beside a board, in a panel of 480 px", "board-started", 480, { button: false, text: true, chip: false }], // (a whole row, the pair beside it, no room for the button)
    ["a started chat beside a board, in a panel of 430 px", "board-started", 430, { button: false, text: true, chip: true }], // (the folder is in the popup, with the button's entry)
    ["a started chat beside a board, in a panel of 410 px", "board-started", 410, { button: true, text: true, chip: true }], // (the model too: what is left is the button's)
    ["a started chat beside a board, at the default panel width", "board-started", 400, null],
    ["a chat's page of 300 px", "plain-started", 300, null]]) {
    const s = state(id);
    const { page, ctx } = await openAt(open, s, layout, width, { wait: BOX }); // (a window under 700 px is the phone layout, whose empty box shows Talk, not Send)
    try {
      await page.evaluate(watchKeys);
      await page.evaluate(() => document.fonts.ready);
      await frame(page);
      const m = await fitOf(page);
      if (!m || m.past || m.send !== "ok" || m.docScroll > 0) fail(`${name}: the composer does not fit: ${JSON.stringify(m && { past: m.past, over: m.over, send: m.send })}`);
      const has = await byTid(page, "insert-btn").count(), text = await byTid(page, "ctx-meter").and(page.locator(":not([data-compact])")).count();
      const chip = await byTid(page, "more-chip").count();
      if (want && layout === "desktop" && (!!has !== want.button || !!text !== want.text || !!chip !== want.chip)) fail(`${name}: the toolbar has ${has ? "the" : "no"} Insert button, the meter has ${text ? "its text" : "no text"} and the toolbar has ${chip ? "a" : "no"} "more" chip; the row wants ${JSON.stringify(want)}`);
      await press(page, byTid(page, "composer-input").first());
      await page.keyboard.press(KEY);
      const k = await page.evaluate(() => window.__taken());
      await page.waitForSelector(tidSel("insert-popup"), { timeout: 10000 });
      await page.keyboard.press("Escape");
      await page.waitForSelector(tidSel("insert-popup"), { state: "detached", timeout: 10000 });
      await until(async () => (await page.evaluate(focusOf)).box, 5000);
      const f = await page.evaluate(focusOf);
      if (k?.code !== "KeyP" || !k.prevented || !f.box) fail(`${name}: ⌘P in the text box: ${JSON.stringify(k)}, the focus after Esc in ${f.el}`);
      note(`${name}: the composer fits, ${has ? "with" : "without"} the Insert button`);
    } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); } finally { await ctx.close(); }
  }

  // ---- the box alone (the gallery's chip input and its stand-in for the popup)
  {
    const { page, ctx } = await open({ query: "gallery", wait: tidSel("gallery") });
    try {
      await page.evaluate(watchKeys);
      const box = byTid(page, "composer-input");
      await box.scrollIntoViewIfNeeded();
      const read = (id) => byTid(page, id).first().textContent();
      const value = () => read("gallery-chip-value");
      const calls = async () => Number(await read("gallery-chip-calls"));
      const handle = (fn, ...args) => page.evaluate(([fn, args]) => window.__aiwbChip[fn](...args), [fn, args]);
      /** The caret to the start or the end of its line (⌘ with an arrow on a Mac, Home and End elsewhere: each does nothing where the other acts). */
      const lineEdge = async (side) => { await page.keyboard.press(side === "Left" ? "Home" : "End"); await page.keyboard.press(`Meta+Arrow${side}`); };
      const clear = async () => { await handle("set", ""); await press(page, box); await until(async () => (await value()) === "", 5000); await toEnd(); await frame(page); };
      /** The caret to the end of the box, and the focus there (a tap on an empty box of a touch viewport may leave the caret where the text it held was). */
      const toEnd = () => page.evaluate((s) => { const el = document.querySelector(s); el.focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const g = getSelection(); g.removeAllRanges(); g.addRange(r); }, BOX);
      /** ⌘P in the box: the popup's stand-in has the focus and a new target. Answers false when it has not. */
      const openPopup = async (what) => {
        const n = await page.evaluate(() => (window.__aiwbInsert ?? []).length);
        await page.keyboard.press(KEY);
        const ok = await until(() => page.evaluate((n) => (window.__aiwbInsert ?? []).length === n + 1 && document.activeElement?.dataset?.testid === "gallery-chip-popup-field", n), 8000);
        const s = await page.evaluate(() => ({ n: (window.__aiwbInsert ?? []).length, field: document.activeElement?.dataset?.testid === "gallery-chip-popup-field", taken: window.__taken() }));
        if (!ok || !s.taken?.prevented) { fail(`${what}: ⌘P opened ${s.n - n} popups, the focus ${s.field ? "is" : "is not"} in its field, the key ${s.taken?.prevented ? "was" : "was not"} kept from the browser`); return false; }
        await page.keyboard.type("rev"); // (typed into the popup's field: the page's selection is there now)
        return true;
      };
      const insert = (text) => page.evaluate((t) => window.__aiwbInsert.at(-1).insert(t), text);
      const cancel = () => page.evaluate(() => window.__aiwbInsert.at(-1).cancel());
      /** After an insertion: the box holds `want`, has the focus, and the caret is right after `text` (a mark typed now stands there). */
      const holds = async (what, want, text) => {
        if (!await until(async () => bare(await value()) === bare(want), 8000)) return fail(`${what}: the box holds ${JSON.stringify(await value())}, not ${JSON.stringify(want)}`);
        await until(async () => (await page.evaluate(focusOf)).box, 5000);
        const f = await page.evaluate(focusOf);
        if (!f.box || f.selected) return fail(`${what}: the focus is in ${f.el} with ${JSON.stringify(f.selected)} selected, not in the text box with a caret`);
        await page.keyboard.type("‸");
        await until(async () => (await value()).includes("‸"), 8000);
        const at = (await value()).indexOf("‸"), end = want.indexOf(text) + text.length;
        if (at !== end) fail(`${what}: the caret is at ${at} of ${JSON.stringify(await value())}, not right after the inserted text (${end})`);
        await page.keyboard.press("Backspace");
        await until(async () => !(await value()).includes("‸"), 8000);
      };

      // in the middle of typed text, with line breaks; undone by ⌘Z
      await clear();
      await page.keyboard.type("Hello world");
      for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
      if (await openPopup("in the middle of typed text")) {
        await insert(" A\nB");
        await holds("in the middle of typed text", "Hello A\nB world", " A\nB");
        const shown = await box.evaluate((e) => e.innerText);
        if (bare(shown) !== "Hello A\nB world") fail(`in the middle of typed text: the box shows ${JSON.stringify(shown)}`);
        // (the mark and its Backspace are two steps of the browser's undo, the insertion is the third)
        for (let i = 0; i < 3; i++) await page.keyboard.press("ControlOrMeta+z");
        if (!await until(async () => bare(await value()) === "Hello world", 5000)) fail(`⌘Z after an insertion: the box holds ${JSON.stringify(await value())}, not what it held before`);
      }
      // in place of a selection
      await clear();
      await page.keyboard.type("Hello cruel world");
      for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
      for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowLeft");
      if (await openPopup("in place of a selection")) { await insert("kind"); await holds("in place of a selection", "Hello kind world", "kind"); }
      // in an empty box, a text of several lines with an empty one
      await clear();
      if (await openPopup("in an empty box")) { await insert(PROMPT); await holds("in an empty box", PROMPT, PROMPT); }
      // on a new line of the box, a text that ends with a line break
      await clear();
      await page.keyboard.type("First:");
      await page.keyboard.press("Shift+Enter");
      if (await openPopup("on a new line")) { await insert("one\r\ntwo\n"); await holds("on a new line", "First:\none\ntwo\n", "one\ntwo\n"); }

      // reference chips: the very elements they were, and Backspace still removes one whole
      await clear();
      await page.keyboard.type("Look at");
      await handle("insertRef", { kind: "selection", ids: ["a1"], label: "rectangle “API”", detail: 'rectangle id=a1 "API" (10,20 160×70)' });
      await page.keyboard.type("and");
      await handle("insertRef", { kind: "point", x: 120, y: -40, label: "(120, -40)", detail: "" });
      await page.keyboard.type("please");
      const TAGS = await page.evaluate(() => [...document.querySelectorAll('[data-testid="composer-input"] [data-testid="ref-chip"]')].map((c, i) => { c.__was = i; return c.dataset.ref; }));
      await until(async () => (await value()) === `Look at ${TAGS[0]} and ${TAGS[1]} please`, 5000);
      const before = await value();
      if (TAGS.length !== 2 || before !== `Look at ${TAGS[0]} and ${TAGS[1]} please`) fail(`the box with two chips holds ${JSON.stringify(before)}`);
      await lineEdge("Left");
      for (let i = 0; i < "Look at ".length; i++) await page.keyboard.press("ArrowRight"); // right before the first chip
      if (await openPopup("beside a chip")) {
        await insert("this: ");
        await holds("beside a chip", `Look at this: ${TAGS[0]} and ${TAGS[1]} please`, "this: ");
        const same = await page.evaluate(() => [...document.querySelectorAll('[data-testid="composer-input"] [data-testid="ref-chip"]')].map((c) => c.__was));
        if (same.join() !== "0,1") fail(`after an insertion the chips are not the elements they were: ${JSON.stringify(same)}`);
        await page.keyboard.press("Delete"); // the chip right after the caret goes whole
        if (!await until(async () => bare(await value()) === `Look at this:  and ${TAGS[1]} please`, 5000)) fail(`Delete before a chip after an insertion: the box holds ${JSON.stringify(await value())}`);
      }
      // a mention being typed is still completed (the composer's @ list)
      await lineEdge("Right");
      await page.keyboard.type(" @ar");
      await handle("replaceBeforeCaret", 3, "@arch ");
      if (!await until(async () => bare(await value()).endsWith("please @arch "), 5000)) fail(`a mention completed after an insertion: the box holds ${JSON.stringify(await value())}`);

      // closed with nothing inserted: the focus, and the caret or the selection, are back
      await clear();
      await page.keyboard.type("Hello world");
      for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
      await until(async () => (await value()) === "Hello world", 5000);
      if (await openPopup("closed at a caret")) {
        const was = await value(), n = await calls();
        await cancel();
        await until(async () => (await page.evaluate(focusOf)).box, 5000);
        const f = await page.evaluate(focusOf);
        if (!f.box || f.selected) fail(`closed with nothing inserted: the focus is in ${f.el} with ${JSON.stringify(f.selected)} selected`);
        if (await value() !== was || await calls() !== n) fail(`closed with nothing inserted: the box told its composer of a change, ${JSON.stringify(await value())}`);
        await page.keyboard.type("‸");
        await until(async () => (await value()).includes("‸"), 5000);
        if (await value() !== "Hello‸ world") fail(`closed with nothing inserted: the caret is not where it was, typing gave ${JSON.stringify(await value())}`);
        await page.keyboard.press("Backspace");
      }
      for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowLeft");
      if (await openPopup("closed at a selection")) {
        await cancel();
        await until(async () => (await page.evaluate(focusOf)).box, 5000);
        const f = await page.evaluate(focusOf);
        if (!f.box || f.selected !== "Hello") fail(`closed with nothing inserted: ${JSON.stringify(f.selected)} is selected in ${f.el}, not "Hello" in the text box`);
      }

      // a box filled anew while the popup is open (another window saved a later draft): the text goes to its end
      await clear();
      await page.keyboard.type("old text");
      await lineEdge("Left");
      if (await openPopup("a box filled anew")) {
        await handle("set", "a later draft");
        await insert(" plus");
        await holds("a box filled anew while the popup was open", "a later draft plus", " plus");
      }
      // a selection that ends inside a chip: the chip goes whole with the text before it that was selected, and the text comes in its place (the old check set a caret inside the chip's text: the
      // box is `plaintext-only` now, where a script's caret inside a chip is moved out of it by the browser, so a user's selection, which can end inside a chip, is what is held)
      await clear();
      await page.keyboard.type("see");
      await handle("insertRef", { kind: "point", x: 1, y: 2, label: "(1, 2)", detail: "" });
      await page.keyboard.type("end");
      await until(async () => /^see <point [^>]*\/> end$/.test(await value()), 5000);
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="composer-input"]'), chip = el.querySelector('[data-testid="ref-chip"]'), r = document.createRange();
        el.focus(); r.setStart(el.firstChild, 1); r.setEnd(chip.firstChild, 2);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      });
      const popups = await page.evaluate(() => (window.__aiwbInsert ?? []).length);
      await handle("openInsert"); // (the Insert button's way in)
      await until(() => page.evaluate((n) => (window.__aiwbInsert ?? []).length > n, popups), 5000);
      await insert("X");
      if (!await until(async () => bare(await value()) === "sX end", 5000)) fail(`a selection that ends inside a chip: the box holds ${JSON.stringify(await value())}, not the chip gone whole with the text selected before it and the text in its place`);
      // a browser that does not do the insertion: the box is made to hold it all the same
      await clear();
      await page.keyboard.type("Hello world");
      for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
      await until(async () => (await value()) === "Hello world", 5000);
      if (await openPopup("a browser that inserts nothing")) {
        await page.evaluate(() => { window.__stop = (e) => { if (e.inputType === "insertText" && e.data !== "‸") e.preventDefault(); }; document.addEventListener("beforeinput", window.__stop, true); });
        await insert(" A\nB");
        await page.evaluate(() => document.removeEventListener("beforeinput", window.__stop, true));
        await holds("a browser that inserts nothing", "Hello A\nB world", " A\nB");
      }
      note("the box alone: in typed text, over a selection, in an empty box, beside chips; undone, closed, filled anew");
    } catch (e) { fail(`the box alone: ${e.message.split("\n")[0]}`); } finally { await ctx.close(); }
  }
}, { viewports, page: false });
