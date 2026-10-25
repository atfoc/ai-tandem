// Proves ⌘⇧L, the board's half of the reference keys (the other half, ⌘L and the composer's chips, is P7.4-keys.mjs, K1's, and the quote of
// the text selected in a message is K5's). Ports "a chat beside a board whose canvas can be edited" of dev/checks/P7.4-keys.mjs (B4), at
// desktop (mouse) and tablet (touch, with a hardware keyboard): with a chat of the board open beside it,
//   ⌘⇧L waits for a point on the board (the layer over the canvas, `pick-layer`), ⌘⇧L again or Esc ends that wait, and a press on the board
//   ends it with the point's box on the canvas (a flash that says "(x, y)") and its chip in the message (K3's composer: `registerInserter`);
//   ⌘L with nothing selected says "Select something on the board first" and puts nothing in, and with three shapes selected puts one chip, reading 3;
//   "+ Point" is lit while a point is waited for;
//   the key does not reach the canvas, whose own ⌘⇧L locks the selected shapes: after the keys no shape of the stored drawing is locked;
//   the point button of the context row ("+ Point", "Point at" under a finger) does what ⌘⇧L does: waits for a point, ends the wait on a second press, a press on the board puts the point's chip (C-RF-08: the web view of a device is not here);
//   a quote in a chat of a board (C-QT-04): ⌘L with words of a reply selected quotes them (the field, the count; the shapes selected on the board are not put in as well),
//   ⌘⇧L with words selected quotes nothing and waits for a point, and ⌘L with no words selected puts the shapes in as before;
//   the check's own proof: with the chat panel away (⌘J) the canvas hears the key, and the stored drawing has its shapes locked.
// (K3 added the composer's parts: the note, the chips and the lit "+ Point" are read on the real composer of the chat beside the board.)
// Added by the sweep (D-SL-12, D-SL-10 and D-SL-11 on the phone), which the old check had no step for:
//   while a point is waited for the board still pans and zooms, and a press that moved puts no point: a wheel and a ctrl+wheel and a drag with the
//   mouse (desktop), a finger's drag and two fingers' pinch (tablet, phone), each read as the board's `view` (scroll, zoom: `window.__aiwbView()`
//   of a build made for the checks), each with the wait still on and no chip added; the press that follows puts the point as before;
//   on the phone, where the chat is a screen over the board (AD-71), the point flow of refs.ts: "Point at" (the "+" sheet's `point` row and ⌘⇧L) takes the
//   user to the board, which draws no layer or hint over the canvas (B2): the bottom row is the pick bar (`pick-bar`, kind point: "Tap a spot on the board",
//   Cancel = `pick-cancel`), the canvas has the accent border (`pick-border`), the bar's state word reads "Picking a point" and its Chats button is off; the board
//   still pans and zooms under the wait; Cancel, the stack's back and ⌘⇧L again end the wait with the chat open again, its draft as it was and no chip; a tap
//   draws the pin and its label (`pick-pin`, `pick-pin-label`) and the chat opens with the box still "first second" and the point as one `ctx-chip` (kind
//   point) of the context row; what is sent is unchanged: the tag stands where the caret was ("first <point x=".." y="..">…</point> second", the same x and y
//   as the pin's label), read from the mock's stored message.
// Deviations: the phone has no beside-the-board chat, so its steps are their own (the steps of the old check that read `chat-head` beside
// the board, ⌘L and the locked shapes, are run at desktop and tablet only, as before, and ⌘L on the phone is K3's `L16`); the old page had
// no touch step at all (its layer took every touch, so a finger could not pan under it).
import { check, mockEval, seed, until } from "../shot.mjs";
import { act, back, byTid, mouseDrag, press, tidSel, touchDrag } from "./sel.mjs";
import { select } from "./quote.mjs";
import { editHere } from "./boarddraw.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const BOARD = "b_ui", CHAT = "c_A2_sketch";
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const label = /^\(-?\d+, -?\d+\)$/;
const J = JSON.stringify;
/** The texts of the user's messages in the board's chat, as the mock has them (what was sent). */
const texts = (url) => mockEval(`return (items[${J(CHAT)}] ?? []).filter((x) => x.kind === "user").map((x) => x.text);`, url);

/** Two fingers on the page, `from` px either side of `c` (horizontally) at the start and `to` at the end, in steps. */
async function pinch(page, c, from, to) {
  const cdp = await page.context().newCDPSession(page);
  const points = (d) => [{ x: c.x - d, y: c.y, id: 1 }, { x: c.x + d, y: c.y, id: 2 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(from) });
  for (let i = 1; i <= 10; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(from + ((to - from) * i) / 10) }); await sleep(16); }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

/** While a point is waited for (D-SL-12): the board still pans and zooms. Each move is read as the board's view, and `waiting(what)` says the wait
 *  is still on and no point was put. The layer's box is where the moves are made (the hint at its top left alone). */
async function movesBoard({ page, touch, fail, view, box, waiting, note }) {
  const mid = { x: box.x + box.width / 2, y: box.y + box.height * 0.6 };
  const moved = async (what, doit, was, key) => {
    await doit();
    const now = await until(async () => {
      const v = await view();
      return v && (key === "zoom" ? v.zoom !== was.zoom : v.scrollX !== was.scrollX || v.scrollY !== was.scrollY) ? v : null;
    }, 10000);
    if (!now) fail(`${what} did not change the board's ${key === "zoom" ? "zoom" : "scroll"} (${JSON.stringify(await view())}) while a point is waited for`);
    await waiting(what);
    return now || was;
  };
  let v = await view();
  if (!v) return fail(`the build shows no view (window.__aiwbView): it is not made for the checks`);
  if (!touch) {
    await page.mouse.move(mid.x, mid.y);
    v = await moved("a wheel over the layer", () => page.mouse.wheel(0, 240), v, "scroll");
    await page.keyboard.down("Control");
    v = await moved("a ctrl+wheel over the layer", () => page.mouse.wheel(0, -240), v, "zoom");
    await page.keyboard.up("Control");
    v = await moved("a drag with the mouse over the layer", () => mouseDrag(page, mid, { x: mid.x - 120, y: mid.y - 60 }), v, "scroll");
  } else {
    v = await moved("a finger's drag over the layer", () => touchDrag(page, mid, { x: mid.x - 120, y: mid.y - 60 }, { hold: 0, steps: 10 }), v, "scroll");
    v = await moved("two fingers' pinch over the layer", () => pinch(page, mid, 30, 110), v, "zoom");
  }
  note(`while a point was waited for the board panned and zoomed (${touch ? "a finger's drag, two fingers' pinch" : "a wheel, ctrl+wheel, a mouse drag"}) and no point was put`);
}

const LIVE = ".excalidraw:not(.excalidraw--view-mode) canvas.interactive";

await check("P7.4 ⌘⇧L waits for a point on the board, and does not reach the canvas", async ({ url, open, fail, note, touch, layout }) => {
  await seed(url, "A2");
  // (on the phone the chat is the screen on top and the board is under it, not visible: the box of the chat is what is waited for there)
  const ready = tidSel("board-canvas", { board: BOARD, state: "ready" });
  const { page } = await open({ sel: { board: BOARD, chat: CHAT }, wait: layout === "phone" ? tidSel("composer-input") : ready });
  const key = (shift) => page.keyboard.press(shift ? "ControlOrMeta+Shift+l" : "ControlOrMeta+l");
  const frame = () => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok()))));
  // (the phone draws no layer over the canvas: the wait is the bottom row's `pick-bar` of kind point, B2)
  const picking = () => (layout === "phone" ? byTid(page, "pick-bar", { kind: "point" }) : byTid(page, "pick-layer")).count().then((n) => n > 0);
  const shows = async (name, on) => { if (!await until(async () => (await picking()) === on, 10000)) fail(`${name}: ${on ? "no point is waited for" : "a point is still waited for"}`); };
  const locked = () => mockEval(`return scenes.${BOARD}.scene.elements.filter((e) => e.locked && !e.isDeleted).length;`, url);
  const rev = () => mockEval(`return scenes.${BOARD}.rev;`, url);
  const view = () => page.evaluate(() => window.__aiwbView?.() ?? null);

  // (a board opens as a reader's: the button makes the window its writer, and only a writer's canvas has a selection to quote and a point to give. On the
  // phone the chat is the screen over the board: back to the board, the button, and the chat again by the Chats sheet's row)
  if (layout === "phone") {
    if (!await back(page)) return fail("the chat's screen has no back to the board");
    await editHere(page);
    await press(page, byTid(page, "board-chats").first()); // (the bar's Chats button opens the Chats sheet; its row opens the chat)
    await press(page, byTid(page, "chats-row", { chat: CHAT }).first());
    await byTid(page, "composer-input").first().waitFor({ state: "visible", timeout: 20000 });
  } else await editHere(page);
  await page.waitForSelector(ready, { timeout: 20000, state: "attached" });
  if (layout === "phone") return phoneFlow({ page, touch, fail, note, key, frame, picking, view, shows, url });
  if (!await until(() => byTid(page, "chat-head").count(), 10000)) fail("the chat of the board is not beside it: the key has no chat to give a point to");
  // the composer's half (K3): the chips it holds, its note, its two buttons
  const chips = () => byTid(page, "composer-input").locator(tidSel("ref-chip")).allTextContents();
  const note_ = async () => (await byTid(page, "ctx-note").first().textContent({ timeout: 1000 }).catch(() => "")) ?? "";
  const pointLit = async () => (await byTid(page, "ctx-act", { kind: "point" }).first().getAttribute("data-on").catch(() => null)) === "true";
  await key(false);
  if (!await until(async () => (await note_()) === "Select something on the board first", 5000)) fail(`⌘L with nothing selected on the board says "${await note_()}", not "Select something on the board first"`);
  if ((await chips()).length) fail(`⌘L with nothing selected put ${JSON.stringify(await chips())} in the message`);
  if (!await byTid(page, "ctx-act", { kind: "selection" }).first().isDisabled()) fail('"Selection" is on with nothing selected on the board');
  await act(page, "select");
  await until(async () => !await byTid(page, "ctx-act", { kind: "selection" }).first().isDisabled(), 10000);
  await key(false);
  const one = await until(async () => { const c = await chips(); return c.length === 1 ? c : null; }, 5000);
  if (!one) fail(`⌘L with three shapes selected put ${JSON.stringify(await chips())} in the message, not one chip`);
  else if (!/3/.test(one[0])) fail(`the reference of three selected shapes reads "${one[0]}"`);
  const at = await rev();

  // ⌘⇧L: on, off by the key, on, off by Esc, on, and a press on the board
  for (const [what, doit, on] of [["⌘⇧L", () => key(true), true], ["⌘⇧L again", () => key(true), false], ["⌘⇧L", () => key(true), true], ["Esc", () => page.keyboard.press("Escape"), false], ["⌘⇧L", () => key(true), true]]) {
    await doit();
    await shows(`${what}: ${on ? "a point is waited for" : "no point is waited for"}`, on);
    if (!await until(async () => (await pointLit()) === on, 5000)) fail(`${what}: "Point" is ${on ? "not lit" : "lit"} while ${on ? "a point is waited for" : "none is"}`);
  }
  const layer = byTid(page, "pick-layer");
  const box = await layer.boundingBox();
  if (!box) return fail("the layer that waits for a point has no box");
  // the board pans and zooms under the layer, and a press that moved puts no point (D-SL-12): one chip (the selection's) stays the only one
  const waiting = async (what) => {
    await frame();
    if (!await picking()) fail(`${what} ended the wait for a point`);
    if ((await chips()).length !== 1) fail(`${what} left ${JSON.stringify(await chips())} in the message: it put a point`);
    if ((await byTid(page, "flash-label").allTextContents()).some((t) => label.test(t.trim()))) fail(`${what} put a point on the canvas`);
  };
  await movesBoard({ page, touch, fail, view, box, waiting, note });
  // (a press on the empty middle: away from the layer's hint at its top)
  const spot = { x: box.x + box.width / 2, y: box.y + box.height * 0.6 };
  if (touch) await page.touchscreen.tap(spot.x, spot.y); else await page.mouse.click(spot.x, spot.y);
  await shows("a press on the board", false);
  const labelled = await until(async () => { const t = await byTid(page, "flash-label").allTextContents(); return t.find((x) => label.test(x.trim())); }, 10000);
  if (!labelled) fail(`a press on the board left no box with the point's label on the canvas: ${JSON.stringify(await byTid(page, "flash-label").allTextContents())}`);
  if (await page.evaluate(() => document.querySelector('[data-testid="pick-hint"]'))) fail("the layer's hint stays after the press");
  const two = await until(async () => { const c = await chips(); return c.length === 2 ? c : null; }, 5000);
  if (!two) fail(`after the press the message has ${JSON.stringify(await chips())}, not two chips`);
  else if (two[0] !== one?.[0] || two[1] === one?.[0]) fail(`after the press the message has ${JSON.stringify(two)}: the point's chip is not a second, other than the first`);

  // the button of the context row does what the key does (C-RF-08): "+ Point" ("Point at" under a finger) waits for a point, a second press ends the wait, a press on the board puts the point's chip
  {
    const button = byTid(page, "ctx-act", { kind: "point" }).first();
    const words = ((await button.textContent()) ?? "").replace(/\s+/g, " ").trim();
    if (!(touch ? words.startsWith("Point at") : words.startsWith("+ Point"))) fail(`the point button reads ${JSON.stringify(words)}, not "${touch ? "Point at" : "+ Point"}"`);
    const was = (await chips()).length;
    await press(page, button);
    await shows("a press on the point button: a point is waited for", true);
    if (!await until(async () => (await pointLit()) === true, 5000)) fail("the point button is not lit while a point is waited for");
    await press(page, button);
    await shows("a second press on the point button: no point is waited for", false);
    await press(page, button);
    await shows("a press on the point button again", true);
    const b2 = await byTid(page, "pick-layer").boundingBox();
    if (!b2) fail("the layer that waits for a point has no box after a press on the button");
    else {
      const at2 = { x: b2.x + b2.width / 3, y: b2.y + b2.height * 0.7 };
      if (touch) await page.touchscreen.tap(at2.x, at2.y); else await page.mouse.click(at2.x, at2.y);
      await shows("a press on the board after the button", false);
      if (!await until(async () => (await chips()).length === was + 1, 5000)) fail(`a press on the board after the point button put ${JSON.stringify(await chips())} into the message, one more chip than before (${was})`);
    }
  }

  // a quote in a chat of a board (C-QT-04): ⌘L with text selected in a reply quotes it, ahead of the board's selection (three shapes are selected); ⌘⇧L never quotes
  {
    const QUOTE = "font copy step", COMMENT = "which step?";
    const count = async () => (await byTid(page, "qcount").first().getAttribute("data-n", { timeout: 500 }).catch(() => null)) ?? "0"; // (the quotes in the draft)
    const float = () => byTid(page, "qfloat").count();
    const sel = () => page.evaluate(select, [QUOTE, false]);
    await act(page, "select");
    await until(async () => !await byTid(page, "ctx-act", { kind: "selection" }).first().isDisabled(), 10000);
    const before = (await chips()).length;
    if (await sel() !== QUOTE) fail(`the check did not select "${QUOTE}" in the reply of the board's chat`);
    await key(false);
    if (!await until(() => byTid(page, "qfloat-comment").count(), 10000)) fail("⌘L with text selected in a reply of a board's chat, shapes selected, opened no quote field");
    else {
      if ((await chips()).length !== before) fail(`⌘L with text selected put the board's selection into the message as well: ${JSON.stringify(await chips())}`);
      await page.keyboard.type(COMMENT);
      await page.keyboard.press("Enter");
      if (!await until(async () => (await count()) === "1", 5000)) fail(`⌘L with text selected, Enter: the draft has ${await count()} quotes, not 1`);
      // ⌘⇧L with text selected quotes nothing: it waits for a point
      if (await sel() !== QUOTE) fail("the check did not select the words again");
      await key(true);
      await shows("⌘⇧L with text selected: a point is waited for", true);
      await frame();
      if (await float() || (await count()) !== "1") fail(`⌘⇧L with text selected quoted it: the draft has ${await count()} quotes, the field is ${await float() ? "open" : "closed"}`);
      await page.keyboard.press("Escape");
      await shows("Esc after ⌘⇧L", false);
      // with no text selected ⌘L is the board's again: the shapes go into the message, no quote is taken
      await page.evaluate(() => getSelection().removeAllRanges());
      await act(page, "select"); // (the wait for a point may have left the board with nothing selected)
      await until(async () => !await byTid(page, "ctx-act", { kind: "selection" }).first().isDisabled(), 10000);
      const had = (await chips()).length;
      await key(false);
      if (!await until(async () => (await chips()).length === had + 1, 5000)) fail(`⌘L with no text selected put ${JSON.stringify(await chips())} into the message, not the board's selection as one more chip than the ${had} before (note ${JSON.stringify(await note_())}, the button ${JSON.stringify(await byTid(page, "ctx-act", { kind: "selection" }).first().textContent())})`);
      if (await float() || (await count()) !== "1") fail(`⌘L with no text selected quoted: the draft has ${await count()} quotes`);
    }
  }

  // the canvas did not hear ⌘⇧L: a shape is moved, so that the drawing is stored, and none of it is locked
  await act(page, "select");
  await page.keyboard.press("ArrowRight");
  if (!await until(async () => (await rev()) > at, 15000)) fail("the drawing was not stored after a shape was moved: the check cannot tell whether the canvas heard the key");
  if (await locked()) fail(`${await locked()} shapes of the stored drawing are locked: the canvas heard ⌘⇧L`);

  // the proof: with the panel away the key is the canvas's, which locks what is selected
  await page.keyboard.press("ControlOrMeta+j");
  if (!await until(async () => !(await byTid(page, "board-panel").count()), 10000)) fail("⌘J did not hide the chat panel");
  await act(page, "select");
  await key(true);
  await frame();
  if (await picking()) fail("with the chat panel away ⌘⇧L waits for a point: it has no chat to give it to");
  const n = await until(locked, 15000);
  if (!n) fail("the check's proof: with the chat panel away ⌘⇧L locked no shape of the stored drawing: the check would not see a canvas that hears the key");
  else note(`the proof: with the chat panel away the canvas heard ⌘⇧L and ${n} shapes of the stored drawing are locked`);
  note("⌘⇧L waited for a point, ended by the key and by Esc, took a press (the point's box on the canvas), and locked nothing");
  void press;
}, { viewports, page: false });

/** The phone (D-SL-10, D-SL-11, B2): the chat is a screen over the board, so "Point at" takes the user to the board and back (board/refs.ts). The board
 *  draws no layer over the canvas while a point is waited for: the bottom row is the pick bar (title, Cancel), the canvas has the accent border, the bar
 *  says "Picking a point" and its Chats button is off; a tap draws the pin and its label, and the chat opens 600 ms later with the point as a chip of
 *  its context row (the box keeps the plain text, "first second"; the tag is put in the message where the caret was when it is sent). */
async function phoneFlow({ page, touch, fail, note, key, frame, picking, view, shows, url }) {
  const box = byTid(page, "composer-input");
  const boxText = () => box.evaluate((el) => [...(el.isContentEditable ? el : el.querySelector("[contenteditable]")).childNodes].map((n) => (n.nodeType === 3 ? n.textContent : "[chip]")).join("").replace(/[​ ]/g, " "));
  const inlineChips = () => box.locator(tidSel("ref-chip")).count();
  const chips = () => byTid(page, "ctx-chip", { kind: "point" }).allTextContents();
  const chatShown = () => byTid(page, "chat-head").count().then((n) => n > 0);
  const gone = async (what, id) => { if (await byTid(page, id).count()) fail(`${what}: the phone draws ${id} over the canvas: its wait has the pick bar and the canvas's border, no layer or hint`); };
  const onBoard = async (what) => {
    await shows(`${what}: a point is waited for`, true);
    if (await chatShown()) fail(`${what}: the chat is still on screen: the board is under it`);
    const bar = byTid(page, "pick-bar", { kind: "point" }).first();
    const title = ((await bar.innerText().catch(() => "")) ?? "").replace(/\s+/g, " ");
    if (!/Tap a spot on the board/.test(title) || !/Cancel/.test(title)) fail(`${what}: the pick bar reads ${J(title)}, not "Tap a spot on the board" with Cancel`);
    if (!await byTid(page, "pick-cancel").first().isVisible().catch(() => false)) fail(`${what}: the pick bar has no Cancel`);
    const b = await byTid(page, "pick-border").first().boundingBox();
    if (!b || b.width < 200 || b.height < 200) fail(`${what}: the canvas has no accent border (pick-border) on screen (${J(b)})`);
    await gone(what, "pick-layer"); await gone(what, "pick-hint");
    const word = await byTid(page, "state-word").allTextContents();
    if (!word.some((w) => /Picking a point/.test(w))) fail(`${what}: the bar's state word reads ${J(word)}, not "Picking a point"`);
    if (!await byTid(page, "board-chats").first().isDisabled().catch(() => false)) fail(`${what}: the bar's Chats button is not off while a point is waited for`);
    return b;
  };
  const chatBack = async (what, was) => {
    if (!await until(chatShown, 10000)) return fail(`${what}: the chat is not open again`);
    await shows(`${what}: no point is waited for`, false);
    if (!await until(async () => (await box.count()) > 0, 10000)) return fail(`${what}: the chat has no message box`);
    const t = await until(async () => { const x = await boxText(); return x === was ? x : null; }, 5000);
    if (t === null) fail(`${what}: the message reads "${await boxText()}", not "${was}": the draft was lost on the way`);
    if ((await chips()).length || await inlineChips()) fail(`${what} added ${J(await chips())} to the message`);
    return was;
  };
  // (at the phone Point at is the "+" sheet's `point` row, not a chip of the context row: "+" opens the sheet, the row closes it and starts the wait;
  // the phone has no lit "+ Point" chip, so the wait is read by the pick bar alone)
  const point = async () => {
    await press(page, byTid(page, "composer-plus").first());
    const row = byTid(page, "action-row", { action: "point" }).first();
    await row.waitFor({ state: "visible", timeout: 10000 });
    return row;
  };
  const startPoint = async () => press(page, await point());
  const lit = async () => (await byTid(page, "ctx-act", { kind: "point" }).count()) > 0;

  // a draft with the caret after its first word
  const caretAfterFirst = async () => {
    await press(page, box);
    // (a tap on the wide box's middle puts the caret at the end of its one line; then seven keys back. Not Home or End: on a Mac they scroll)
    for (let i = 0; i < " second".length; i++) await page.keyboard.press("ArrowLeft");
  };
  await press(page, box);
  await page.keyboard.type("first second");
  await caretAfterFirst();
  if (await boxText() !== "first second") fail(`the check could not make its draft: the message reads "${await boxText()}"`);

  // Cancel, the stack's back and ⌘⇧L again end the wait with the chat open again and nothing added to it
  await startPoint();
  let b = await onBoard("Point at");
  await movesBoard({ page, touch, fail, view, box: b, note, waiting: async (what) => {
    await frame();
    if (!await picking()) fail(`${what} ended the wait for a point`);
    if (await chatShown()) fail(`${what} brought the chat back`);
    if (await byTid(page, "pick-pin").count()) fail(`${what} put a point (a pin is drawn)`);
  } });
  await press(page, byTid(page, "pick-cancel"));
  await chatBack("Cancel", "first second");
  if (await lit()) fail('"Point" is lit after Cancel');

  await startPoint();
  await onBoard("Point at again");
  if (!await back(page)) fail("the board's screen has no back");
  await chatBack("the stack's back", "first second");

  await key(true);
  await onBoard("⌘⇧L");
  await key(true);
  await chatBack("⌘⇧L again", "first second");

  // a tap draws the pin and its label, and 600 ms later the chat opens with the point as a chip of the context row; the box is still "first second"
  await caretAfterFirst();
  await startPoint();
  b = await onBoard("Point at, for a point");
  const spot = { x: b.x + b.width / 2, y: b.y + b.height * 0.6 };
  await page.touchscreen.tap(spot.x, spot.y);
  const pinned = await until(async () => (await byTid(page, "pick-pin").count()) && (await byTid(page, "pick-pin-label").allTextContents()).find((t) => /x -?\d+, y -?\d+/.test(t)), 10000);
  if (!pinned) fail(`a tap on the board drew no pin with its label (pins ${await byTid(page, "pick-pin").count()}, labels ${J(await byTid(page, "pick-pin-label").allTextContents())})`);
  if (!await until(chatShown, 10000)) return fail("a tap on the board did not bring the chat back");
  await shows("a tap on the board", false);
  const c = await until(async () => { const x = await chips(); return x.length ? x : null; }, 10000);
  if (!c) return fail(`after a tap the context row holds no point chip (the box reads "${await boxText()}")`);
  if (c.length !== 1 || !/^Point (near .+|at \(-?\d+, -?\d+\))/.test(c[0].trim())) fail(`after a tap the context row holds ${J(c)}, not one point chip ("Point near …" or "Point at (x, y)")`);
  if (await boxText() !== "first second" || await inlineChips()) fail(`after a tap the message reads "${await boxText()}" with ${await inlineChips()} inline chips, not the plain "first second"`);
  if (await lit()) fail('"Point" is lit after the point was made');
  if (!await byTid(page, "ctx-chip-remove").first().isVisible().catch(() => false)) fail("the point chip has no × to remove it");

  // what is sent is what it was: the tag stands where the caret was ("first <point …> second")
  const sentBefore = await texts(url);
  await page.keyboard.press("ControlOrMeta+Enter");
  const sent = await until(async () => { const t = await texts(url); return t.length === sentBefore.length + 1 ? t.at(-1) : null; }, 15000);
  const x = pinned.match(/x (-?\d+), y (-?\d+)/);
  if (sent === null) fail("the message with the point chip was not sent (Ctrl+Enter): the mock got no new message");
  else if (!/^first <point x="-?\d+" y="-?\d+"(\/>|>[\s\S]*<\/point>) second$/.test(sent)) fail(`the message sent is ${J(sent)}, not "first <point x=".." y="..">…</point> second": the tag is not where the caret was`);
  else if (x && !sent.includes(`<point x="${x[1]}" y="${x[2]}"`)) fail(`the pin said x ${x[1]}, y ${x[2]} and the message sent is ${J(sent)}`);

  note("phone: Point at took the user to the board (the pick bar with Cancel, the canvas's border, the state word, no layer or hint), the board panned and zoomed under it; Cancel, the back and ⌘⇧L ended the wait with the chat open again, its draft kept and no chip; a tap drew the pin and its label and the chat opened with one point chip, the box still plain; the message sent had the tag where the caret was");
}
