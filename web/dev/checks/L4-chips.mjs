// L4 (new in the app, AD-80; package K1): the chip input (app/src/platform/chipinput, AD-60) on the gallery (`/?gallery`, section
// "Chip input"), at desktop (mouse) and tablet (touch, a hardware keyboard). It has no old check to port: the old page's box
// (RefInput.tsx) was proved only through P7.4 (⌘L, ⌘⇧L), PL5.1 and PL5.2 (the insert popup), none of which looks at the box itself.
// What it proves are the C-RF rows of the parity inventory that have no check today and the contract of types.ts:
//   Put in (C-RF-11, 12): a chip goes in at the caret, in place of a selection, else where the caret last was, else at the end; the box
//   gets the focus; a space before it unless white space is there, and after it unless white space follows; the caret ends after
//   that space (typing continues there).
//   One unit (C-RF-13, 14): the arrow keys, Home and End step over a chip whole; a press on a chip puts the caret before or after,
//   never inside, and the tag stays whole; a chip is not editable inside, shows a dashed square (selection) or a dot (point), its
//   tooltip (C-RF-05), wraps with the text and does not widen the box; it takes the theme's colour.
//   Remove (C-RF-15, 16, 17): Backspace right after a chip and Delete right before one remove it whole, the caret where it was
//   (the end of the text before it); a selection that holds a chip, typed over or deleted, removes it with the rest.
//   Clipboard (C-RF-18, 19): a copy of a part with chips puts their tags on the clipboard; a cut does and deletes the part; a copy
//   with no chip is the browser's own; a paste of tags gives chips again, plain text goes in as text, and the paste replaces the
//   selection. Image files pasted go to onImages with their name and are no part of the value; with text and rich text too, the
//   text is pasted.
//   The value (C-RF-07, 21, 24): `set` gives chips for the tags and the value read back is the same text; a box of chips alone has a value.
//   Insert popup (C-RF-22): ⌘P (Ctrl+P) opens the popup and not the browser's print; what the popup inserts goes where the caret or
//   selection was, the chips beside it are the very elements they were, a selection that ends inside a chip takes the chip whole;
//   a cancel leaves the box as it was. A completed @ mention (replaceBeforeCaret) leaves the chips alone.
//   Keys: Enter is the composer's (handled: no line break), Shift+Enter is not (a line break), Esc reaches onKey; none of them
//   reaches the page's shortcuts.
//   @ list (C-RF-26): the text before the caret is "" right after a chip and moves with the arrow keys.
//   Locked and read-only (C-RF-25): nothing is typed, pasted, cut, deleted or put in by the handle; the chips are shown and the
//   text can be selected and copied; `set` still fills the box (a draft that arrives).
//
// Alone, from the repository root (the runner of `npm run uicheck` runs this file the same way):
//   node web/dev/checks/L4-chips.mjs        (see web/dev/standalone.mjs for DIST, PORT and VIEWPORT)
import { until } from "../shot.mjs";
import { standalone } from "../standalone.mjs";

export const viewports = ["desktop", "tablet"];

const tid = (id) => `[data-testid="${id}"]`;
const BOX = tid("composer-input"), CHIP = `${BOX} ${tid("ref-chip")}`;
const MARK = "¦";

/** The body of the check at one viewport. ctx: { page, viewport, fail, url }. */
export async function body({ page, viewport, fail, url }) {
  const touch = viewport !== "desktop";
  const T = (id) => page.locator(tid(id));
  const press = (loc) => (touch ? loc.tap() : loc.click());
  const read = async (id) => ((await T(id).first().textContent()) ?? "");
  const expect = (ok, what) => { if (!ok) fail(`${viewport}: ${what}`); return ok; };
  const step = async (name, fn) => { try { await fn(); } catch (e) { fail(`${viewport}: ${name}: ${e.message.split("\n")[0]}`); } };
  const value = () => read("gallery-chip-value");
  /** Waits for the box to report `want`, and says what it reported when it does not. */
  const holds = async (want, what) => expect(await until(async () => (await value()) === want, 8000), `${what}: the box holds ${JSON.stringify(await value())}, not ${JSON.stringify(want)}`);
  const chips = () => page.$$eval(CHIP, (els) => els.map((e) => e.dataset.ref));
  const active = () => page.evaluate((s) => document.activeElement?.matches(s) ?? false, BOX);

  /** The value with MARK at the caret, found by typing it (and taking it away again): where typing would go. */
  const caret = async () => {
    await page.keyboard.type(MARK);
    const v = await until(async () => { const x = await value(); return x.includes(MARK) ? x : ""; }, 8000);
    await page.keyboard.press("Backspace");
    await until(async () => !(await value()).includes(MARK), 8000);
    return v;
  };
  const toEnd = () => page.evaluate((s) => {
    const el = document.querySelector(s); el.focus();
    const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  }, BOX);
  const keys = async (key, n = 1) => { for (let i = 0; i < n; i++) await page.keyboard.press(key); };
  // (Playwright on macOS gives Home and End the scroll of the page; the line's start and end are ⌘← and ⌘→ there)
  const mac = process.platform === "darwin";
  const home = () => keys(mac ? "Meta+ArrowLeft" : "Home");
  const end = () => keys(mac ? "Meta+ArrowRight" : "End");
  const reset = async () => {
    const mode = await read("gallery-chip-mode");
    if (mode.includes("read-only")) await press(T("gallery-chip-readonly"));
    if (mode.includes("locked")) await press(T("gallery-chip-locked"));
    await until(async () => !(await read("gallery-chip-mode")), 8000);
    await press(T("gallery-chip-clear"));
    await holds("", "Clear");
  };
  /** Fills the box with the draft (`set`): text, a selection chip, text, a point chip, text. Answers its two tags. */
  const draft = async () => {
    await press(T("gallery-chip-set"));
    await until(async () => (await chips()).length === 2, 8000);
    const [sel, point] = await chips();
    return { sel, point, text: `see ${sel} and ${point} for @bo` };
  };
  /** A clipboard event on the box, with the data given; answers whether the box took it over and what it put on the clipboard. */
  const clip = (kind, data = {}) => page.evaluate(([s, kind, data]) => {
    const dt = new DataTransfer();
    for (const [type, v] of Object.entries(data.types ?? {})) dt.setData(type, v);
    for (const f of data.files ?? []) dt.items.add(new File(["x"], f.name, { type: f.type }));
    const e = new ClipboardEvent(kind, { clipboardData: dt, bubbles: true, cancelable: true });
    document.querySelector(s).dispatchEvent(e);
    return { took: e.defaultPrevented, text: dt.getData("text/plain") };
  }, [BOX, kind, data]);

  const box = page.locator(BOX);
  await box.scrollIntoViewIfNeeded();

  // ---- the box
  await step("the box", async () => {
    expect(await box.getAttribute("role") === "textbox" && await box.getAttribute("aria-multiline") === "true", "the box is not a multiline textbox");
    expect(await box.getAttribute("contenteditable") === "plaintext-only", "the box is not editable as plain text");
    const ph = await page.evaluate((s) => getComputedStyle(document.querySelector(s), "::before").content, BOX);
    expect(ph.includes("Message"), `an empty box shows no placeholder (its ::before is ${ph})`);
    await press(box); await toEnd();
    await page.keyboard.type("hello");
    await holds("hello", "typing");
    const gone = await page.evaluate((s) => getComputedStyle(document.querySelector(s), "::before").content, BOX);
    expect(!gone.includes("Message"), "the placeholder stays when the box has text");
    expect(await active(), "the box is not focused after a press in it");
    await reset();
  });

  // ---- a chip put in
  await step("a chip put in", async () => {
    await press(box); await toEnd();
    await page.keyboard.type("look");
    await press(T("gallery-chip-insert-point"));
    await until(async () => (await chips()).length === 1, 8000);
    const [tag] = await chips();
    await holds(`look ${tag} `, "a point put in after text with no space");
    expect(await active(), "the box does not have the focus after a chip was put in");
    expect(await caret() === `look ${tag} ${MARK}`, "the caret is not after the space that follows the chip");
    await page.keyboard.type("more ");
    await press(T("gallery-chip-insert-point"));
    await holds(`look ${tag} more ${tag} `, "a point put in after text that ends in a space (one space, not two)");
    await reset();

    await press(T("gallery-chip-insert-point"));
    await until(async () => (await chips()).length === 1, 8000);
    await holds(`${tag} `, "a point put into an empty box that was never focused");

    // in the middle of the text: no extra space where white space is already
    await reset();
    await press(box); await toEnd();
    await page.keyboard.type("ab cd");
    await home(); await keys("ArrowRight", 2);
    await press(T("gallery-chip-insert-point"));
    await holds(`ab ${tag} cd`, "a point put between two words, the caret after the first");

    // in place of a selection
    await reset();
    await press(box); await toEnd();
    await page.keyboard.type("hello world");
    await keys("Shift+ArrowLeft", 5);
    await press(T("gallery-chip-insert-point"));
    await holds(`hello ${tag} `, "a point put in place of the selected word");

    // where the caret last was, when it is not in the box now
    await reset();
    await press(box); await toEnd();
    await page.keyboard.type("abc def");
    await keys("ArrowLeft", 3);
    await page.evaluate(() => document.querySelector('[data-testid="gallery-input"]').focus());
    await press(T("gallery-chip-insert-point"));
    await holds(`abc ${tag} def`, "a point put in while the focus is elsewhere");
    await reset();
  });

  // ---- one unit
  await step("a chip is one unit", async () => {
    const { sel, point, text } = await draft();
    await holds(text, "set(draft)");
    await press(box); await toEnd();
    await home();
    await keys("ArrowRight", 4);
    expect(await caret() === `see ${MARK}${sel} and ${point} for @bo`, "four arrow keys do not put the caret before the first chip");
    await keys("ArrowRight");
    expect(await caret() === `see ${sel}${MARK} and ${point} for @bo`, "one arrow key does not step over the whole chip");
    await keys("ArrowLeft");
    expect(await caret() === `see ${MARK}${sel} and ${point} for @bo`, "one arrow key back does not step over the whole chip");
    await end();
    expect(await caret() === `${text}${MARK}`, "End does not put the caret at the end");
    await home();
    expect(await caret() === `${MARK}${text}`, "Home does not put the caret at the start");

    // a press on a chip: the caret before or after it, the tag whole
    for (const side of ["left", "right"]) {
      const r = await page.locator(CHIP).first().boundingBox();
      const at = { x: r.x + (side === "left" ? 3 : r.width - 3), y: r.y + r.height / 2 };
      if (touch) await page.touchscreen.tap(at.x, at.y); else await page.mouse.click(at.x, at.y);
      // (a touch moves the caret after the tap's events: wait for it to be in the box, and not inside the chip)
      expect(await until(() => page.evaluate((s) => { const x = getSelection(), n = x.anchorNode; return document.activeElement?.matches(s) && !!n && !n.parentElement?.closest('[data-testid="ref-chip"]') && n !== document.querySelector('[data-testid="ref-chip"]'); }, BOX)), `a press on the ${side} of a chip left the caret inside it or out of the box`);
      const v = await caret();
      expect(v === `see ${MARK}${sel} and ${point} for @bo` || v === `see ${sel}${MARK} and ${point} for @bo`, `a press on the ${side} of a chip put the caret inside it: ${JSON.stringify(v)}`);
    }
    expect(await page.locator(CHIP).first().getAttribute("contenteditable") === "false", "a chip is editable inside");
    await reset();
  });

  // ---- how a chip looks
  await step("a chip's look", async () => {
    await draft();
    const look = () => page.evaluate((s) => [...document.querySelectorAll(s)].map((e) => {
      const c = getComputedStyle(e), b = getComputedStyle(e, "::before");
      return { kind: e.dataset.kind, title: e.title, text: e.textContent, color: c.color, display: c.display, dashed: b.borderTopStyle, round: b.borderTopLeftRadius };
    }), CHIP);
    const [a, p] = await look();
    expect(a.kind === "selection" && a.text === "rectangle “API”" && a.dashed === "dashed", `the selection chip is ${JSON.stringify(a)}: no dashed square before "rectangle “API”"`);
    expect(p.kind === "point" && p.text === "(5, 7)" && p.dashed !== "dashed" && /50%|[0-9]{2,}px/.test(p.round), `the point chip is ${JSON.stringify(p)}: no dot before "(5, 7)"`);
    expect(a.title.startsWith("Selection: 1 element\nrectangle id=r1") && p.title === "Point (5, 7)", `the tooltips are ${JSON.stringify([a.title, p.title])}`);
    expect(a.color === "rgb(105, 101, 219)", `the chip is ${a.color} in the light theme, not the accent`);
    await press(T("gallery-theme-dark"));
    expect(await until(async () => (await look())[0].color === "rgb(168, 165, 255)"), `the chip does not take the dark theme's accent (it is ${(await look())[0].color})`);
    await press(T("gallery-theme-light"));
    await until(async () => (await look())[0].color === "rgb(105, 101, 219)");

    // long text wraps with the chips; the box does not widen
    await press(box); await toEnd();
    for (let i = 0; i < 6; i++) { await page.keyboard.type("words that go on and on "); await press(T("gallery-chip-insert-point")); }
    const fit = await page.evaluate((s) => {
      const el = document.querySelector(s), r = el.getBoundingClientRect();
      const out = [...el.querySelectorAll('[data-testid="ref-chip"]')].filter((c) => { const q = c.getBoundingClientRect(); return q.left < r.left - 0.5 || q.right > r.right + 0.5; }).length;
      return { sideways: el.scrollWidth - el.clientWidth, out, lines: Math.round(el.scrollHeight / parseFloat(getComputedStyle(el).lineHeight)) };
    }, BOX);
    expect(fit.sideways <= 0 && fit.out === 0 && fit.lines >= 2, `long text with chips: ${JSON.stringify(fit)} (it must wrap, with no chip and no scroll sideways)`);
    await reset();
  });

  // ---- removing a chip
  await step("removing a chip", async () => {
    const { sel, point } = await draft();
    // Backspace right after a chip
    await press(box); await toEnd(); await home(); await keys("ArrowRight", 5);
    await keys("Backspace");
    await holds(`see  and ${point} for @bo`, "Backspace right after a chip");
    expect(await caret() === `see ${MARK} and ${point} for @bo`, "after Backspace the caret is not where the chip was (the end of the text before it)");
    // Delete right before a chip
    await reset(); await draft();
    await press(box); await toEnd(); await home(); await keys("ArrowRight", 4);
    await keys("Delete");
    await holds(`see  and ${point} for @bo`, "Delete right before a chip");
    expect(await caret() === `see ${MARK} and ${point} for @bo`, "after Delete the caret is not where the chip was");
    // a chip at the start: the caret ends at the start of the text after it
    await reset();
    await press(T("gallery-chip-insert-point"));
    await until(async () => (await chips()).length === 1, 8000);
    await page.keyboard.type("rest");
    await keys("ArrowLeft", 5); // back over " rest": right after the chip
    await keys("Backspace");
    await holds(" rest", "Backspace right after a chip at the start");
    expect(await caret() === `${MARK} rest`, "after the first chip was removed the caret is not at the start of the text after it");
    // two chips together: the empty text between them is skipped
    await reset();
    await press(box); await toEnd();
    await clip("paste", { types: { "text/plain": sel + point } });
    await holds(sel + point, "a paste of two tags together");
    await keys("Backspace");
    await holds(sel, "Backspace after the second of two chips");
    await keys("Backspace");
    await holds("", "Backspace after the first chip, the other gone");
    await reset();
  });

  // ---- a selection that holds a chip
  await step("a selection with a chip", async () => {
    const { point } = await draft();
    await press(box); await toEnd(); await home(); await keys("ArrowRight", 4);
    await keys("Shift+ArrowRight"); // the chip
    await keys("Delete");
    await holds(`see  and ${point} for @bo`, "Delete on a selected chip");
    await keys("ControlOrMeta+a");
    await page.keyboard.type("x");
    await holds("x", "typing over a selection that holds a chip");
    await reset();
  });

  // ---- copy, cut, paste
  await step("the clipboard", async () => {
    const { sel, point, text } = await draft();
    await press(box); await toEnd(); await home(); await keys("ArrowRight", 4); await keys("Shift+ArrowRight"); // the first chip
    await keys("Shift+ArrowRight", 4); // " and"
    const copied = await clip("copy");
    expect(copied.took && copied.text === `${sel} and`, `a copy of a part with a chip put ${JSON.stringify(copied.text)} on the clipboard, not the tags`);
    const cut = await clip("cut");
    expect(cut.took && cut.text === `${sel} and`, `a cut of a part with a chip put ${JSON.stringify(cut.text)} on the clipboard`);
    await holds(`see  ${point} for @bo`, "a cut of a part with a chip");
    // a copy with no chip is the browser's own
    await home(); await keys("Shift+ArrowRight", 3);
    const plain = await clip("copy");
    expect(!plain.took && plain.text === "", "a copy with no chip is taken over (it must be the browser's own)");
    // a paste of tags gives chips; plain text goes in as text; the paste replaces the selection
    await reset();
    await press(box); await toEnd();
    await page.keyboard.type("A ");
    const pasted = await clip("paste", { types: { "text/plain": `x ${sel} y ${point} z` } });
    expect(pasted.took, "a paste of text with tags was left to the browser");
    await holds(`A x ${sel} y ${point} z`, "a paste of tags");
    expect((await chips()).length === 2, "a paste of two tags did not give two chips");
    await clip("paste", { types: { "text/plain": "<b>not a tag</b> & <selection> alone" } });
    await holds(`A x ${sel} y ${point} z<b>not a tag</b> & <selection> alone`, "a paste of plain text that looks like markup");
    await keys("ControlOrMeta+a");
    await clip("paste", { types: { "text/plain": `only ${point}` } });
    await holds(`only ${point}`, "a paste over a selection");
    await reset();
  });

  // ---- pasted images
  await step("pasted images", async () => {
    await press(box); await toEnd();
    const image = { name: "image.png", type: "image/png" };
    const took = await clip("paste", { files: [image] });
    expect(took.took, "a pasted image was left to the browser");
    expect(await until(async () => (await read("gallery-chip-images")) === "Pasted image"), `a pasted image reached onImages as ${JSON.stringify(await read("gallery-chip-images"))}, not "Pasted image"`);
    expect(await value() === "", "a pasted image became part of the value");
    const withText = await clip("paste", { types: { "text/plain": "B2 cell", "text/html": "<td>B2 cell</td>" }, files: [{ name: "image.png", type: "image/png" }] });
    expect(withText.took, "a paste of a picture with text and rich text was left to the browser");
    await holds("B2 cell", "a paste with plain and rich text and a picture (the text is meant)");
    await reset();
  });

  // ---- the keys
  await step("keys", async () => {
    await press(box); await toEnd();
    await page.keyboard.type("one");
    const sent = Number(await read("gallery-chip-sent"));
    await keys("Enter");
    expect(await until(async () => Number(await read("gallery-chip-sent")) === sent + 1), "Enter did not reach onKey");
    expect(await value() === "one", `Enter (handled) put a line break into the box: ${JSON.stringify(await value())}`);
    await keys("Shift+Enter");
    await page.keyboard.type("two");
    await holds("one\ntwo", "Shift+Enter (not handled: a line break)");
    expect(Number(await read("gallery-chip-sent")) === sent + 1, "Shift+Enter was handled as Enter");
    await keys("Escape");
    expect(await until(async () => (await read("gallery-chip-keys")) === "Escape"), "Esc did not reach onKey");
    // a key in the box does not reach the page's own handler
    const leaked = await page.evaluate(() => new Promise((ok) => {
      const seen = []; const h = (e) => seen.push(e.key);
      document.addEventListener("keydown", h);
      const box = document.querySelector('[data-testid="composer-input"]');
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true }));
      document.removeEventListener("keydown", h); ok(seen);
    }));
    expect(leaked.length === 0, "a key pressed in the box reached the document's own key handlers");
    await reset();
  });

  // ---- @ and the text before the caret
  await step("the @ list", async () => {
    await press(box); await toEnd();
    await page.keyboard.type("hi @bo");
    expect(await until(async () => (await read("gallery-chip-before")) === "hi @bo"), `the text before the caret is ${JSON.stringify(await read("gallery-chip-before"))}, not "hi @bo"`);
    await keys("Tab");
    await holds("hi @board ", "the completed mention (replaceBeforeCaret)");
    await reset();
    await draft();
    await press(box); await toEnd();
    const before = async (want, what) => expect(await until(async () => (await read("gallery-chip-before")) === want), `${what}: the text before the caret is ${JSON.stringify(await read("gallery-chip-before"))}, not ${JSON.stringify(want)}`);
    await end();
    await before(" for @bo", "at the end");
    await keys("ArrowLeft", 8);
    await before("", "right after a chip (no mention is open there)");
    await keys("ArrowLeft");
    await before(" and ", "right before a chip, in the text before it");
    await home();
    await before("", "at the start");
    await reset();
  });

  // ---- the insert popup
  await step("the insert popup", async () => {
    const { sel, point } = await draft();
    await page.evaluate((s) => document.querySelectorAll(s).forEach((c, i) => { c.__was = i; }), CHIP);
    const was = () => page.$$eval(CHIP, (els) => els.map((e) => e.__was));
    await press(box); await toEnd(); await end();
    await page.keyboard.press("ControlOrMeta+p");
    expect(await until(async () => await T("gallery-chip-popup").count() === 1), "⌘P did not open the insert popup");
    await press(T("gallery-chip-popup-cancel"));
    expect(await until(async () => await active()), "the cancelled popup did not give the focus back to the box");
    await holds(`see ${sel} and ${point} for @bo`, "a cancelled popup");
    // inserted at the end: the chips are the very elements they were
    await press(T("gallery-chip-open-insert"));
    await until(async () => await T("gallery-chip-popup").count() === 1);
    await press(T("gallery-chip-popup-do"));
    await holds(`see ${sel} and ${point} for @bo` + "a prompt text\nof two lines", "an insertion at the end");
    expect((await was()).join() === "0,1", `the chips are not the elements they were after an insertion: ${JSON.stringify(await was())}`);
    // a selection that ends inside a chip takes the chip whole
    await page.evaluate((s) => {
      const el = document.querySelector(s), chip = el.querySelector('[data-testid="ref-chip"]'), r = document.createRange();
      el.focus(); r.setStart(el.firstChild, 1); r.setEnd(chip.firstChild, 3);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    }, BOX);
    await page.keyboard.press("ControlOrMeta+p");
    await until(async () => await T("gallery-chip-popup").count() === 1);
    await press(T("gallery-chip-popup-do"));
    await holds(`s` + "a prompt text\nof two lines" + ` and ${point} for @bo` + "a prompt text\nof two lines", "an insertion over a selection that ends inside a chip");
    await reset();
  });

  // ---- locked and read-only
  for (const mode of ["gallery-chip-readonly", "gallery-chip-locked"]) await step(mode === "gallery-chip-readonly" ? "read-only" : "locked", async () => {
    const readOnly = mode === "gallery-chip-readonly";
    const { text } = await draft();
    await press(T(mode));
    expect(await until(async () => (await box.getAttribute("aria-readonly")) === (readOnly ? "true" : null)), `the box's aria-readonly is wrong while ${readOnly ? "read-only" : "locked"}`);
    expect((await chips()).length === 2 && await value() === text, "the chips are not shown while the box is not editable");
    const still = async (what) => {
      await new Promise((ok) => setTimeout(ok, 150));
      expect(await value() === text && (await chips()).length === 2, `${what} changed a box that takes nothing: it holds ${JSON.stringify(await value())}`);
    };
    await box.click({ force: true }).catch(() => {});
    await page.evaluate((s) => document.querySelector(s).focus(), BOX);
    await page.keyboard.type("x"); await still("typing");
    await keys("Backspace"); await still("Backspace");
    await keys("Delete"); await still("Delete");
    await end(); await keys("Backspace"); await still("Backspace at the end");
    await home(); await keys("Delete"); await still("Delete at the start");
    await clip("paste", { types: { "text/plain": "pasted" } }); await still("a paste");
    await press(T("gallery-chip-insert-point")); await still("a chip put in by the handle");
    await press(T("gallery-chip-open-insert"));
    await keys("ControlOrMeta+p");
    await new Promise((ok) => setTimeout(ok, 300));
    await still("the insert popup");
    // the chips can be selected and copied; cut does not take them
    await page.evaluate((s) => { const r = document.createRange(); r.selectNodeContents(document.querySelector(s)); const x = getSelection(); x.removeAllRanges(); x.addRange(r); }, BOX);
    const copied = await clip("copy");
    expect(copied.took && copied.text === text, `a copy from a box that takes nothing put ${JSON.stringify(copied.text)} on the clipboard`);
    await clip("cut");
    await keys("Delete");
    expect(await value() === text, "a cut or Delete took text out of a box that takes nothing");
    // a draft that arrives still fills it
    await press(T("gallery-chip-clear"));
    await holds("", "set('') on a box that takes nothing");
    await press(T("gallery-chip-set"));
    await holds(text, "set(draft) on a box that takes nothing");
    await reset();
  });
}

await standalone(import.meta.url, "L4-chips", viewports, body);
