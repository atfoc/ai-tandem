// Proves the text box's side of the insert popup (plans/prompt-library.md, section 5; section 10, lines 11 to 15), in
// the page. What the box must hold afterwards is test/insert.test.ts's; here it is the page that holds it, with the
// caret, the focus and undo. The popup itself, with its list and its keys, is PL5.2's.
//   The app, a chat's composer. ⌘P in the text box is the box's: the page does not get it
//   (it would print), and once the popup it opens is closed with Esc the box has the focus and its caret or its
//   selection, so what is typed next goes where it would have gone. The toolbar has the Insert button, which does
//   the same. ⌘P with the cursor elsewhere (nowhere, in a message, in another field) is left to the browser.
//   A chat's toolbar draws the button only where its row has room left (logic/composerfit.ts fitWithInsert): beside
//   a board, in a panel of 430 px, a started chat's whole row leaves none and has no "more" chip, so there is no
//   button, the meter has its text as before, and ⌘P is the box's all the same. (That was the default panel, of
//   400 px, before the row had the attach button, which takes 30 px. There the row is no longer whole: the attach
//   button has the room of the meter's text, and the Insert button stands in what the ring leaves, still with no
//   "more" chip.) In a pane of 300 px the composer fits its box, with the button or without.
//   The box alone (src/RefInput.tsx, bundled here with a stand-in for the popup that takes the focus as the popup's
//   search field will). A text goes in where the caret was when the popup opened: in the middle of typed text, in
//   place of a selection, in an empty box, with its line breaks; what was before and after is unchanged, the box has
//   the focus and the caret is right after the text (what is typed next stands there); ⌘Z takes the text out again.
//   Reference chips stay the very elements they were, and Backspace still removes one whole; a mention being typed
//   is still completed. What the box tells its composer (the value that is saved as the draft and sent) has the text.
//   Closed with nothing inserted, the box has the focus and the caret or the selection it had. A box filled anew
//   while the popup is open gets the text at its end; a selection that ends inside a chip, and a browser that does
//   not do the insertion, leave the box as test/insert.test.ts says all the same.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { check, measureComposer, openPage, paneSize, seed, until } from "../shot.mjs";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
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
const focusOf = () => ({ box: !!document.activeElement?.matches(".composer-input"), el: document.activeElement?.className || document.activeElement?.tagName, selected: String(getSelection()) });
const boxText = (page) => page.locator(".composer .composer-input").first().evaluate((e) => e.innerText);
/** The app's insert popup, which ⌘P and the Insert button open, closed with Esc. */
const shut = async (page) => { await page.waitForSelector(".ins-dialog", { timeout: 10000 }); await page.keyboard.press("Escape"); await page.waitForSelector(".ins-dialog", { state: "detached", timeout: 10000 }); };

// The box alone: RefInput with a composer's two handlers, and a popup that only takes the focus and keeps its target.
const HARNESS = `
  import React from "react";
  import { createRoot } from "react-dom/client";
  import { flushSync } from "react-dom";
  import { RefInput } from "./RefInput.tsx";
  import { onInsertPopup } from "./logic/insert.ts";
  const h = (window.h = { values: [], targets: [], handle: null });
  function Box() {
    const ref = React.useRef(null);
    React.useEffect(() => { h.handle = ref.current; });
    return <div className="composer"><div className="composer-box with-tools">
      <RefInput ref={ref} placeholder="Ask" onChange={(v) => { h.values.push(v); }} onKeyDown={(e) => { e.stopPropagation(); }} />
    </div><input id="search" /></div>;
  }
  const root = createRoot(document.getElementById("root"));
  h.render = () => flushSync(() => root.render(<Box />));
  h.value = () => h.values.at(-1) ?? "";
  onInsertPopup((t) => { h.targets.push(t); document.getElementById("search").focus(); });
  h.render();
`;

await check("PL5.1 a text put into a composer's text box, and ⌘P in it and elsewhere", async ({ url, browser, fail, note }) => {
  // ---- the app
  const seeded = await seed(url, "A2");
  const selOf = (id) => seeded.find((s) => s.id === id)?.sel ?? fail(`the seed has no state ${id}`);
  for (const [name, sel, elsewhere] of [["a chat's composer", selOf("plain-started"), ".thread .msg"]]) {
    const errors = [];
    const { ctx, page } = await openPage({ url, browser, sel, errors, wait: ".composer .composer-input" });
    try {
      await page.evaluate(watchKeys);
      const box = page.locator(".composer .composer-input").first();
      // (the box is emptied by hand, as a user would)
      await box.click();
      await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.press("Backspace");
      await page.keyboard.type("Hello world");
      for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
      await page.keyboard.press(KEY);
      let k = await page.evaluate(() => window.__taken());
      if (k?.code !== "KeyP" || !k.prevented) fail(`${name}: ⌘P in the text box was left to the browser, which prints: ${JSON.stringify(k)}`);
      await shut(page);
      let f = await page.evaluate(focusOf);
      if (!f.box) fail(`${name}: after ⌘P and Esc the focus is in ${f.el}, not in the text box`);
      await page.keyboard.type("X");
      if (bare(await boxText(page)) !== "HelloX world") fail(`${name}: after ⌘P and Esc the caret is not where it was: typing gave ${JSON.stringify(await boxText(page))}`);
      // a selection is kept too
      for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowRight");
      await page.keyboard.press(KEY);
      await shut(page);
      f = await page.evaluate(focusOf);
      if (!f.box || f.selected !== " worl") fail(`${name}: after ⌘P and Esc the selection is ${JSON.stringify(f.selected)} in ${f.el}, not " worl" in the text box`);

      // the toolbar's button: the same, and the focus stays in the box
      const button = page.locator(".composer .composer-tools .insert-btn");
      if (await button.count() !== 1) fail(`${name}: the toolbar has ${await button.count()} Insert buttons`);
      else {
        const title = await button.getAttribute("title");
        if (!/^Insert a prompt \((⌘P|Ctrl\+P)\)$/.test(title ?? "")) fail(`${name}: the Insert button's title is ${JSON.stringify(title)}`);
        await button.click();
        await shut(page);
        f = await page.evaluate(focusOf);
        if (!f.box || f.selected !== " worl") fail(`${name}: after a click on the Insert button the selection is ${JSON.stringify(f.selected)} in ${f.el}`);
        await page.keyboard.type("Y");
        if (bare(await boxText(page)) !== "HelloXYd") fail(`${name}: typing after the Insert button gave ${JSON.stringify(await boxText(page))}`);
        // reached with the keyboard, it puts the focus back into the box, at the caret
        await button.focus();
        await page.keyboard.press("Enter");
        await shut(page);
        if (!await until(async () => (await page.evaluate(focusOf)).box, 5000)) fail(`${name}: Enter on the Insert button left the focus in ${(await page.evaluate(focusOf)).el}`);
        await page.keyboard.type("Z");
        if (bare(await boxText(page)) !== "HelloXYZd") fail(`${name}: typing after Enter on the Insert button gave ${JSON.stringify(await boxText(page))}`);
      }
      const m = (await measureComposer(page)).find((c) => !c.none);
      if (!m || m.past || m.send !== "ok" || m.docScroll > 0) fail(`${name}: the composer does not fit with the Insert button: ${JSON.stringify(m && { past: m.past, over: m.over, send: m.send })}`);

      // elsewhere ⌘P is the browser's: with the focus nowhere, after a click outside the composer, and in another field
      const left = async (where) => {
        await page.keyboard.press(KEY);
        k = await page.evaluate(() => window.__taken());
        if (k?.code !== "KeyP" || k.prevented) fail(`${name}: ⌘P ${where} was taken from the browser: ${JSON.stringify(k)}`);
      };
      await page.evaluate(() => document.activeElement?.blur());
      await left("with the focus nowhere");
      await page.locator(elsewhere).first().click({ position: { x: 5, y: 5 } });
      if ((await page.evaluate(focusOf)).box) fail(`${name}: a click on ${elsewhere} left the focus in the text box`);
      else await left(`after a click on ${elsewhere}`);
      await page.evaluate(() => { const i = document.createElement("input"); i.id = "other-field"; document.body.append(i); i.focus(); });
      await left("in another field");
      for (const e of errors) fail(`${name}: page error: ${e}`);
      note(`${name}: ⌘P is the text box's alone, the Insert button is in the toolbar, the caret is kept`);
    } finally { await ctx.close(); }
  }
  // a chat's toolbar draws the button where its row has room left, and the composer fits its box
  // (button: false, a whole row with no room for it; true, a row whose meter is its ring anyway; null, either)
  for (const [name, id, kind, width, button] of [["a started chat beside a board, in a panel of 430 px", "board-started", "panel", 430, false], ["a started chat beside a board, at the default panel width", "board-started", "panel", 400, true], ["a chat's page of 300 px", "plain-started", "page", 300, null]]) {
    const { ctx, page } = await openPage({ url, browser, sel: selOf(id), ...paneSize(kind, width), wait: ".composer .composer-box .send" });
    try {
      await page.evaluate(watchKeys);
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok()))));
      const m = (await measureComposer(page)).find((c) => !c.none);
      if (!m || m.past || m.send !== "ok" || m.docScroll > 0) fail(`${name}: the composer does not fit: ${JSON.stringify(m && { past: m.past, over: m.over, send: m.send })}`);
      const has = await page.locator(".composer .composer-tools .insert-btn").count(), text = await page.locator(".composer .ctx-meter:not(.compact)").count();
      if (button === false && (has || !text)) fail(`${name}: the toolbar has ${has ? "the" : "no"} Insert button and the meter has ${text ? "its text" : "no text"}: a whole row leaves the button no room, and keeps the meter's text`);
      if (button === true && (!has || text)) fail(`${name}: the toolbar has ${has ? "the" : "no"} Insert button and the meter has ${text ? "its text" : "no text"}: the attach button leaves the meter's text no room, and the ring leaves room for the button`);
      if (button !== null && await page.locator(".composer .more-chip").count()) fail(`${name}: the toolbar has a "more" chip: the way to the insert popup must cost ${button ? "the row no control" : "a whole row nothing"}`);
      await page.locator(".composer .composer-input").click();
      await page.keyboard.press(KEY);
      const k = await page.evaluate(() => window.__taken());
      await shut(page);
      const f = await page.evaluate(focusOf);
      if (k?.code !== "KeyP" || !k.prevented || !f.box) fail(`${name}: ⌘P in the text box: ${JSON.stringify(k)}, the focus after Esc in ${f.el}`);
      note(`${name}: the composer fits, ${has ? "with" : "without"} the Insert button`);
    } finally { await ctx.close(); }
  }

  // ---- the box alone
  const built = await esbuild.build({
    stdin: { contents: HARNESS, resolveDir: SRC, loader: "tsx" }, bundle: true, write: false, format: "iife", jsx: "automatic", logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"' }, loader: { ".css": "empty", ".woff2": "empty" },
  });
  const ctx = await browser.newContext({ viewport: { width: 700, height: 500 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(url + "/mock/state"); // (a page of the mock's origin: nothing of the app runs in it)
    await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');
    await page.addStyleTag({ content: fs.readFileSync(path.join(SRC, "styles.css"), "utf8") });
    await page.addScriptTag({ content: built.outputFiles[0].text });
    await page.evaluate(watchKeys);
    const box = page.locator(".composer-input");
    const value = () => page.evaluate(() => window.h.value());
    /** The caret to the start or the end of its line (⌘ with an arrow on a Mac, Home and End elsewhere: each does nothing where the other acts). */
    const lineEdge = async (side) => { await page.keyboard.press(side === "Left" ? "Home" : "End"); await page.keyboard.press(`Meta+Arrow${side}`); };
    const clear = async () => { await page.evaluate(() => window.h.handle.set("")); await box.click(); };
    /** ⌘P in the box: the popup's stand-in has the focus and a new target. Answers false when it has not. */
    const open = async (what) => {
      const n = await page.evaluate(() => window.h.targets.length);
      await page.keyboard.press(KEY);
      const s = await page.evaluate(() => ({ n: window.h.targets.length, search: document.activeElement?.id === "search", taken: window.__taken() }));
      if (s.n !== n + 1 || !s.search || !s.taken?.prevented) { fail(`${what}: ⌘P opened ${s.n - n} popups, the focus ${s.search ? "is" : "is not"} in its field, the key ${s.taken?.prevented ? "was" : "was not"} kept from the browser`); return false; }
      await page.keyboard.type("rev"); // (typed into the popup's field: the page's selection is there now)
      return true;
    };
    const insert = (text) => page.evaluate((t) => window.h.targets.at(-1).insert(t), text);
    const cancel = () => page.evaluate(() => window.h.targets.at(-1).cancel());
    /** After an insertion: the box holds `want`, has the focus, and the caret is right after `text` (a mark typed now stands there). */
    const holds = async (what, want, text) => {
      const v = await value(), f = await page.evaluate(focusOf);
      if (bare(v) !== bare(want)) return fail(`${what}: the box holds ${JSON.stringify(v)}, not ${JSON.stringify(want)}`);
      if (!f.box || f.selected) return fail(`${what}: the focus is in ${f.el} with ${JSON.stringify(f.selected)} selected, not in the text box with a caret`);
      await page.keyboard.type("‸");
      const at = (await value()).indexOf("‸"), end = want.indexOf(text) + text.length;
      if (at !== end) fail(`${what}: the caret is at ${at} of ${JSON.stringify(await value())}, not right after the inserted text (${end})`);
      await page.keyboard.press("Backspace");
    };

    // in the middle of typed text, with line breaks; undone by ⌘Z
    await clear();
    await page.keyboard.type("Hello world");
    for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
    if (await open("in the middle of typed text")) {
      await insert(" A\nB");
      await holds("in the middle of typed text", "Hello A\nB world", " A\nB");
      const shown = await box.evaluate((e) => e.innerText);
      if (bare(shown) !== "Hello A\nB world") fail(`in the middle of typed text: the box shows ${JSON.stringify(shown)}`);
      // (the mark and its Backspace are two steps of the browser's undo, the insertion is the third)
      for (let i = 0; i < 3; i++) await page.keyboard.press("ControlOrMeta+z");
      if (bare(await value()) !== "Hello world") fail(`⌘Z after an insertion: the box holds ${JSON.stringify(await value())}, not what it held before`);
    }
    // in place of a selection
    await clear();
    await page.keyboard.type("Hello cruel world");
    for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
    for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowLeft");
    if (await open("in place of a selection")) { await insert("kind"); await holds("in place of a selection", "Hello kind world", "kind"); }
    // in an empty box, a text of several lines with an empty one
    await clear();
    if (await open("in an empty box")) { await insert(PROMPT); await holds("in an empty box", PROMPT, PROMPT); }
    // on a new line of the box, a text that ends with a line break
    await clear();
    await page.keyboard.type("First:");
    await page.keyboard.press("Shift+Enter");
    if (await open("on a new line")) { await insert("one\r\ntwo\n"); await holds("on a new line", "First:\none\ntwo\n", "one\ntwo\n"); }

    // reference chips: the very elements they were, and Backspace still removes one whole
    await clear();
    await page.keyboard.type("Look at");
    await page.evaluate(() => window.h.handle.insertRef({ kind: "selection", ids: ["a1"], label: "rectangle “API”", detail: 'rectangle id=a1 "API" (10,20 160×70)' }));
    await page.keyboard.type("and");
    await page.evaluate(() => window.h.handle.insertRef({ kind: "point", x: 120, y: -40, label: "(120, -40)", detail: "" }));
    await page.keyboard.type("please");
    const TAGS = await page.evaluate(() => [...document.querySelectorAll(".composer-input .ref-chip")].map((c, i) => { c.__was = i; return c.dataset.ref; }));
    const before = await value();
    if (TAGS.length !== 2 || before !== `Look at ${TAGS[0]} and ${TAGS[1]} please`) fail(`the box with two chips holds ${JSON.stringify(before)}`);
    await lineEdge("Left");
    for (let i = 0; i < "Look at ".length; i++) await page.keyboard.press("ArrowRight"); // right before the first chip
    if (await open("beside a chip")) {
      await insert("this: ");
      await holds("beside a chip", `Look at this: ${TAGS[0]} and ${TAGS[1]} please`, "this: ");
      const same = await page.evaluate(() => [...document.querySelectorAll(".composer-input .ref-chip")].map((c) => c.__was));
      if (same.join() !== "0,1") fail(`after an insertion the chips are not the elements they were: ${JSON.stringify(same)}`);
      await page.keyboard.press("Delete"); // the chip right after the caret goes whole
      if (bare(await value()) !== `Look at this:  and ${TAGS[1]} please`) fail(`Delete before a chip after an insertion: the box holds ${JSON.stringify(await value())}`);
    }
    // a mention being typed is still completed (the composer's @ list)
    await lineEdge("Right");
    await page.keyboard.type(" @ar");
    await page.evaluate(() => window.h.handle.replaceBeforeCaret(3, "@arch "));
    if (!bare(await value()).endsWith("please @arch ")) fail(`a mention completed after an insertion: the box holds ${JSON.stringify(await value())}`);

    // closed with nothing inserted: the focus, and the caret or the selection, are back
    await clear();
    await page.keyboard.type("Hello world");
    for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
    if (await open("closed at a caret")) {
      const was = await value(), n = await page.evaluate(() => window.h.values.length);
      await cancel();
      const f = await page.evaluate(focusOf);
      if (!f.box || f.selected) fail(`closed with nothing inserted: the focus is in ${f.el} with ${JSON.stringify(f.selected)} selected`);
      if (await value() !== was || await page.evaluate(() => window.h.values.length) !== n) fail(`closed with nothing inserted: the box told its composer of a change, ${JSON.stringify(await value())}`);
      await page.keyboard.type("‸");
      if (await value() !== "Hello‸ world") fail(`closed with nothing inserted: the caret is not where it was, typing gave ${JSON.stringify(await value())}`);
      await page.keyboard.press("Backspace");
    }
    for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowLeft");
    if (await open("closed at a selection")) {
      await cancel();
      const f = await page.evaluate(focusOf);
      if (!f.box || f.selected !== "Hello") fail(`closed with nothing inserted: ${JSON.stringify(f.selected)} is selected in ${f.el}, not "Hello" in the text box`);
    }

    // a box filled anew while the popup is open (another window saved a later draft): the text goes to its end
    await clear();
    await page.keyboard.type("old text");
    await lineEdge("Left");
    if (await open("a box filled anew")) {
      await page.evaluate(() => window.h.handle.set("a later draft"));
      await insert(" plus");
      await holds("a box filled anew while the popup was open", "a later draft plus", " plus");
    }
    // a selection that ends inside a chip: the chip is whole afterwards, the text right after it
    await clear();
    await page.keyboard.type("see");
    await page.evaluate(() => window.h.handle.insertRef({ kind: "point", x: 1, y: 2, label: "(1, 2)", detail: "" }));
    await page.keyboard.type("end");
    const TAG = await page.evaluate(() => {
      const chip = document.querySelector(".composer-input .ref-chip"), r = document.createRange();
      r.setStart(chip.firstChild, 2); r.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      return chip.dataset.ref;
    });
    await page.evaluate(() => window.h.handle.openInsert()); // (the Insert button's way in: no key is pressed inside a chip)
    await insert("X");
    if (bare(await value()) !== `see ${TAG}X end`) fail(`a caret inside a chip: the box holds ${JSON.stringify(await value())}, not the chip whole with the text after it`);
    // a browser that does not do the insertion: the box is made to hold it all the same
    await clear();
    await page.keyboard.type("Hello world");
    for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
    if (await open("a browser that inserts nothing")) {
      await page.evaluate(() => { window.__stop = (e) => { if (e.inputType === "insertText" && e.data !== "‸") e.preventDefault(); }; document.addEventListener("beforeinput", window.__stop, true); });
      await insert(" A\nB");
      await page.evaluate(() => document.removeEventListener("beforeinput", window.__stop, true));
      await holds("a browser that inserts nothing", "Hello A\nB world", " A\nB");
    }

    for (const e of errors) fail(`the box alone: page error: ${e}`);
    note("the box alone: in typed text, over a selection, in an empty box, beside chips; undone, closed, filled anew");
  } finally { await ctx.close(); }
});
