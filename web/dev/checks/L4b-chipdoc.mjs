// L4b (new in the app, AD-61; package K2): the native chip input's logic (app/src/platform/chipinput: ChipDocInput over chipdoc.ts,
// the box of ChipInput.native.tsx) in Chromium, on the chipdoc gallery (`/?gallery=chipdoc`, app/src/dev/ChipDocGallery.tsx), at
// desktop (mouse) and phone (touch, the keyboard is still page.keyboard). The gallery draws the box with the spike's web field
// (app/src/dev/chipdocfield.web.tsx: a transparent textarea over a layer that shows the chips), so the same document logic that
// runs on iOS and Android is driven here by real key events, without a simulator. It is the port of the composer spike's
// spikes/composer/checks/web.mjs (34 checks and the "no page errors so far" lines): the checks, their wording, their seeds and
// assertions are the spike's; the selectors, the navigation and the heights (the box: font 13 px, line 19 px, at most 6 lines +
// 6 = 120 px; the layer grows without bound, the scroll view around it is capped) are the new box's. Each check is
//   1 insert at the caret, type around it; 2 insert in the middle of a text; 3 Backspace and Delete take a chip whole;
//   4 the caret and the selection never land inside a chip (arrows, a tap on a chip, shift+arrow); 5 a double click in a chip
//   selects the chip; 6 growth with lines, with a wrapping line, and the scroll past the maximum height following the caret;
//   7 the message equals refs.ts' serialize, send, the box is emptied; 8 copy, paste and cut with tags on the clipboard;
// and, at the end, what the handle of the gallery adds to the spike: the @ mention completed (`mention`) and the text before
// the caret (`before`), the insert popup (`open-insert`, `popup-insert`), `readonly`, and `enter-sends`.
//
// Alone, from the repository root (the runner of `npm run uicheck` runs this file the same way):
//   node web/dev/checks/L4b-chipdoc.mjs        (see web/dev/standalone.mjs for DIST, PORT and VIEWPORT; VERBOSE=1 prints every
//                                                   check that passes too)
import { serialize } from "@aiwb/core/logic/refs.ts";
import { chipText } from "../../../app/src/platform/chipinput/chipdoc.ts";
import { INSERTED, POINT, SELECTIONS } from "../../../app/src/dev/chipdocfixtures.ts";
import { until } from "../shot.mjs";
import { standalone } from "../standalone.mjs";

export const viewports = ["desktop", "phone"];

const tid = (id) => `[data-testid="${id}"]`;
const BOX = tid("composer-input"), LAYER = tid("composer-input-layer"), CHIP = `${LAYER} ${tid("ref-chip")}`;
const LINE = 19; // 13 px font, line height round(13 * 1.45)
const MAX = 6 * LINE + 6;

const message = (...segs) => serialize(segs);
const sel = (i) => SELECTIONS[i]();

/** The body of the check at one viewport. ctx: { page, viewport, fail, url }. */
export async function body({ page, viewport, fail, url }) {
  const touch = viewport !== "desktop";
  const gallery = url.replace(/\?gallery.*$/, "?gallery=chipdoc");
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  const T = (id) => page.locator(tid(id));
  const press = (loc) => (touch ? loc.tap() : loc.click());
  const hit = (id) => press(T(id));
  const read = async (id) => ((await T(id).first().textContent()) ?? "");
  const A = sel(0), P = POINT();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  const ok = (cond, what, detail = "") => {
    if (!cond) fail(`${viewport}: ${what}${detail ? `\n     ${detail}` : ""}`);
    else if (process.env.VERBOSE) console.log(`PASS ${viewport}: ${what}`);
    return !!cond;
  };
  const eq = (actual, expected, what) => ok(actual === expected, what, `expected ${JSON.stringify(expected)}\n     actual   ${JSON.stringify(actual)}`);
  const noErrors = () => ok(errors.length === 0, "no page errors so far", errors.slice(0, 1).join("\n"));
  /** The readout `model` (the box's value) is `want`: waits for it, and says what it showed when it does not come. */
  const model = (want, what) => until(async () => (await read("model")) === want, 8000).then(async () => eq(await read("model"), want, what));
  const field = () => page.locator(BOX).evaluate((e) => ({ value: e.value, start: e.selectionStart, end: e.selectionEnd }));
  const keys = async (key, n = 1) => { for (let i = 0; i < n; i++) await page.keyboard.press(key); };
  // (Playwright on macOS gives Home the scroll of the page; the line's start is ⌘← there)
  const mac = process.platform === "darwin";
  const home = () => keys(mac ? "Meta+ArrowLeft" : "Home");
  const fresh = async () => {
    await page.goto(gallery, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(BOX, { timeout: 30000 });
    await page.locator(BOX).click();
  };
  const heightOf = () => page.locator(LAYER).evaluate((e) => e.getBoundingClientRect().height);
  /** The bounding box of the first chip drawn in the layer. */
  const chipBox = async () => {
    await until(async () => (await page.locator(CHIP).count()) > 0, 8000);
    return page.locator(CHIP).first().boundingBox();
  };

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

  // ---- 1. insert at the caret, type around it
  await fresh();
  await page.keyboard.type("move");
  await hit("insert-selection");
  await model(message("move ", A, " "), "insert after typed text: space before and after, tag in the message");
  let f = await field();
  eq(f.start, f.value.length, "the caret is after the chip's trailing space");
  await page.keyboard.type("to");
  await model(message("move ", A, " to"), "typing after the chip");
  // the caret to the very start, type before the chip
  await home();
  await page.keyboard.type("Hey ");
  await model(message("Hey move ", A, " to"), "typing before the chip at the start of the text");
  await hit("insert-point");
  await model(message("Hey ", P, " move ", A, " to"), "a second chip (a point) goes in at the caret, after the typed \"Hey \"");

  noErrors();
  // ---- 2. insert in the middle of a text
  await fresh();
  await page.keyboard.type("ab cd");
  await keys("ArrowLeft", 2);
  await hit("insert-selection");
  await model(message("ab ", A, " cd"), "insert in the middle of a text");
  f = await field();
  eq(f.value.slice(f.start), "cd", "the caret is after the chip's space, before 'cd'");

  noErrors();
  // ---- 3. backspace deletes a chip whole
  await fresh();
  await page.keyboard.type("x");
  await hit("insert-selection");
  await keys("Backspace"); // the space after it
  await model(message("x ", A), "backspace removes the space after the chip first");
  await keys("Backspace"); // the chip
  await model("x ", "the next backspace removes the whole chip");
  f = await field();
  eq(f.value, "x ", "the field's string is the text only");
  // delete (forward)
  await fresh();
  await page.keyboard.type("a b");
  await keys("ArrowLeft", 2);
  await hit("insert-selection");
  await keys("ArrowLeft"); // over the chip: the caret is at its start
  await keys("Delete");
  await model("a  b", "forward delete at the chip's start removes it whole");

  noErrors();
  // ---- 4. the caret and the selection never land inside a chip
  await fresh();
  await page.keyboard.type("ab");
  await hit("insert-selection");
  await page.keyboard.type("cd");
  let chip;
  {
    const v = (await field()).value;
    const c = chipText(A);
    chip = { start: v.indexOf(c), end: v.indexOf(c) + c.length };
  }
  const inside = (p) => p > chip.start && p < chip.end;
  await home();
  const walk = [];
  for (let i = 0; i < 14; i++) { await keys("ArrowRight"); const g = await field(); walk.push(g.start); }
  ok(walk.every((p) => !inside(p)), "ArrowRight across the whole line never stops inside the chip", `positions ${walk}`);
  ok(walk.includes(chip.end), "the caret goes over the chip in one step", `positions ${walk}`);
  const back = [];
  for (let i = 0; i < 14; i++) { await keys("ArrowLeft"); const g = await field(); back.push(g.start); }
  ok(back.every((p) => !inside(p)), "ArrowLeft across the whole line never stops inside the chip", `positions ${back}`);
  // a click in the middle of the chip
  {
    const target = await chipBox();
    ok(!!target, "the chip is drawn as its own run in the layer");
    if (target) {
      await page.mouse.click(target.x + target.width * 0.55, target.y + target.height / 2);
      const g = await field();
      ok(!inside(g.start) && !inside(g.end), "a tap on the chip puts the caret at one of its edges", `caret ${g.start}-${g.end} chip ${chip.start}-${chip.end}`);
    }
  }
  // shift+arrow takes a chip whole
  await home();
  await keys("ArrowRight", 3); // after "ab "
  { const g = await field(); eq(g.start, 3, "caret after 'ab ' (the text before the chip)"); }
  await page.keyboard.press("Shift+ArrowRight");
  {
    const g = await field();
    ok(g.start === chip.start && g.end === chip.end, "shift+right from the chip's edge selects the whole chip", `selection ${g.start}-${g.end} chip ${chip.start}-${chip.end}`);
  }
  await page.keyboard.type("Z"); // typed over a selected chip
  await model("ab Z cd", "typing over a selected chip replaces it");

  noErrors();
  // ---- 5. a double click inside a chip (a word of its label) selects the chip whole
  await fresh();
  await page.keyboard.type("ab");
  await hit("insert-selection");
  await page.keyboard.type("cd");
  {
    const target = await chipBox();
    await page.mouse.dblclick(target.x + target.width * 0.3, target.y + target.height / 2);
    const g = await field(), c = chipText(A);
    ok(g.start === g.value.indexOf(c) && g.end === g.value.indexOf(c) + c.length, "a double click in a chip selects the chip, not a word of it", `selection ${g.start}-${g.end}`);
  }

  noErrors();
  // ---- 6. multi-line growth
  await fresh();
  const h0 = await heightOf();
  await page.keyboard.type("one");
  await keys("Enter");
  await page.keyboard.type("two");
  await keys("Enter");
  await page.keyboard.type("three");
  const h3 = await heightOf();
  ok(h3 > h0 + 2 * LINE - 8, "the box grows with its lines", `height ${h0} -> ${h3}`);
  await hit("insert-selection");
  // enough text to wrap at least three times in the box, whatever its width (about 6 px for a character)
  const width = await page.locator(LAYER).evaluate((e) => e.getBoundingClientRect().width);
  await page.keyboard.type("long ".repeat(Math.ceil((3.5 * width) / 30)));
  const hw = await heightOf();
  ok(hw > h3 + 2 * LINE, "the box grows when a line wraps", `height ${h3} -> ${hw}`);
  ok((await read("model")).startsWith("one\ntwo\nthree "), "line breaks are in the message");
  for (let i = 0; i < 12; i++) await keys("Enter");
  await page.keyboard.type("last");
  const outer = await page.locator(BOX).evaluate((e) => {
    let n = e;
    while (n && n.scrollHeight <= n.clientHeight + 1) n = n.parentElement;
    return n ? { top: n.scrollTop, scroll: n.scrollHeight, client: n.clientHeight } : null;
  });
  ok(outer && outer.client <= MAX + 4 && outer.top > 0 && outer.top + outer.client >= outer.scroll - 2 * LINE, "past its maximum height the box scrolls and follows the caret", JSON.stringify(outer));

  noErrors();
  // ---- 7. message model, send, draft
  await fresh();
  await page.keyboard.type("move");
  await hit("insert-selection");
  await page.keyboard.type("to");
  await hit("insert-selection"); // the second selection fixture
  await page.keyboard.type("and keep");
  await hit("insert-point");
  await page.keyboard.type("\nthanks");
  const A1 = sel(0), B1 = sel(1);
  const sent = message("move ", A1, " to ", B1, " and keep ", P, " \nthanks");
  await model(sent, "the message equals refs.ts' serialize of the same content (2 selections, a point, a line break)");
  await hit("send");
  await until(async () => (await read("sent")) !== "", 8000);
  eq(await read("sent"), sent.trim(), "what is sent is the trimmed message");
  await until(async () => (await field()).value === "", 8000);
  eq((await field()).value, "", "the box is empty after the send");

  noErrors();
  // ---- 8. copy and paste
  await fresh();
  await page.keyboard.type("see");
  await hit("insert-selection");
  await page.keyboard.type("ok");
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.press(`${mod}+c`);
  eq(await page.evaluate(() => navigator.clipboard.readText()), message("see ", A, " ok"), "copy puts the message form (tags) on the clipboard");
  await page.keyboard.press("Backspace");
  await model("", "everything deleted with a selection");
  await page.keyboard.press(`${mod}+v`);
  await model(message("see ", A, " ok"), "paste of that text gives the chips again");
  f = await field();
  ok(f.value.includes(chipText(A)), "the pasted tag is shown as a chip");
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.press(`${mod}+x`);
  await model("", "cut removes the selection");
  eq(await page.evaluate(() => navigator.clipboard.readText()), message("see ", A, " ok"), "cut puts the tags on the clipboard");

  noErrors();

  // ---- 9. the handle's parts the spike did not have
  // the @ mention: `before` is the text before the caret, `mention` completes it and `before` follows
  await fresh();
  await page.keyboard.type("ask @bo");
  await until(async () => (await read("before")) === "ask @bo", 8000);
  eq(await read("before"), "ask @bo", "before: the text before the caret follows the typing");
  await hit("mention");
  await model("ask @board ", "mention: the typed @bo is completed to @board and a space");
  await until(async () => (await read("before")) === "ask @board ", 8000);
  eq(await read("before"), "ask @board ", "before: updates after the mention is completed");

  // the insert popup: what it inserts goes at the caret, its line break kept
  await fresh();
  await page.keyboard.type("ab");
  await keys("ArrowLeft");
  await hit("open-insert");
  await T("popup-insert").waitFor({ timeout: 8000 });
  await hit("popup-insert");
  await until(async () => (await read("model")).includes(INSERTED), 8000);
  {
    const v = await read("model");
    ok(v.includes(INSERTED) && v.includes("\n"), "popup-insert: the prompt, with its line break, is in the value", JSON.stringify(v));
    ok(v.startsWith("a") && v.endsWith("b") && v.indexOf(INSERTED) === 1, "popup-insert: it went in at the caret, between a and b", JSON.stringify(v));
  }
  await T("popup-insert").waitFor({ state: "detached", timeout: 8000 });

  // read-only: nothing is typed; off again and it is
  await fresh();
  await page.keyboard.type("ab");
  await hit("readonly");
  await page.locator(BOX).click();
  await page.keyboard.type("cd");
  await keys("Backspace");
  await model("ab", "readonly: typing and Backspace change nothing");
  await hit("readonly");
  await page.locator(BOX).click();
  await page.keyboard.type("cd");
  await model("abcd", "readonly off: typing works again");

  // Enter sends: the message is sent trimmed, the box is empty, no line break stays
  await fresh();
  await hit("enter-sends");
  await page.locator(BOX).click();
  await page.keyboard.type("hi there ");
  await keys("Enter");
  await until(async () => (await read("sent")) !== "", 8000);
  eq(await read("sent"), "hi there", "enter-sends: Enter sends the value, trimmed");
  await until(async () => (await field()).value === "", 8000);
  eq(await read("model"), "", "enter-sends: the box is empty after the send");
  eq((await field()).value, "", "enter-sends: no line break stays in the field");

  ok(errors.length === 0, "no page errors", errors.join("\n"));
}

await standalone(import.meta.url, "L4b-chipdoc", viewports, body);
