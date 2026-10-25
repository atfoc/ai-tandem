// UX.B2-pick (package B2, ux-improvements; plans/ux-improvements/b2-design.md §1, §4–§7; goal 3.4 "Point at", "Add selection", "A selection on the
// board goes to no chat by itself", 6.2; mockups bd-07b, bd-07c, bd2-f-b, bd2-f-c): Point at and Add selection on the phone, on the mock's section UXB2
// (dev/mock-ui.js: the board "Checkout flow" with the rectangles "Checkout service", "Payments", "Inventory", "Orders DB" and one without a label, spread
// over the scene, and the chat "Draw the request flow" on it, which takes messages). Phone only (iPhone 15, touch). Every session seeds the section anew.
//   0 the fit         a chat opened directly ({board, chat}) leaves the board mounted under it with no size; shown by "+" › Point at, it is fitted:
//                     the view's zoom is above 0.1 and at most 1 and the four labelled shapes lie inside the canvas
//   1 Point at, the   "+" › Point at ("Tap a spot on the board") with the draft "first second" and the caret after "first": the board screen with
//     board while       `pick-bar` (kind point; title, the sub-line `for “Draw the request flow”`), `pick-cancel` (44 px or more, white ground), the bar's
//     picking           state word "Picking a point", `board-chats` dimmed and disabled, `pick-border`; no `pick-hint`, `pick-layer`, `board-row` and no
//                       voice pill; the stack's top is the board. Cancel, the system back (`back`) and the stack's goBack each bring the chat back
//                       with "first second" in the box and no point chip
//   2 a tap           a tap on the middle of "Payments": `pick-pin` and `pick-pin-label` ("x <n>, y <n> · near Payments", inside the screen); the chat is
//                     not back before 400 ms and is back within 5 s; the box reads "first second"; the context row holds the chip "Point near Payments"
//                     (kind point) with a `ctx-chip-remove` of 44 px (the pressable is 24×34 on the web build, which does not draw the hit slop; the 44 pt comes from hitSlop in RefChips.tsx); Send puts
//                     `first <point x=".." y="..">near: … Payments …</point> second` into the message, the point inside Payments' box
//   3 ×               a new draft "here", Point at, a tap, back: × takes the chip out and the draft saved by the mock has no `<point`
//   4 Add selection   (a reader, then the holder) "+" › Add selection ("Select shapes on the board"): `pick-bar` kind select, "Select items", the state
//                     word "Selecting for the chat", `pick-take` "Edit here" and no `pick-add`; Edit here, then `pick-add` "Add (0)" disabled (a press does
//                     nothing); "Payments" and "Inventory" selected with Excalidraw's own tools: "Add (2)", enabled; Add puts the chip "2 shapes · Payments,
//                     Inventory" (kind selection) into the chat; Send puts `<selection ids="…">` with exactly those two ids and the draft's words
//   5 Back cancels    Back from the selecting board: the chat again with the draft as it was, no selection chip
//   6 the rule        with two shapes selected on the board, the chat opened by the Chats sheet has no selection chip, no `ctx-act`, no word "selected" in
//                     its context row; the "+" sheet's Add selection row says "2 shapes selected on the board" and goes to the board, where `Add (2)` is
//                     lit at once, and Back from there still puts nothing into the chat
//   7 dark            the board half of 1 in the dark theme: the bar's ground is the accent (not white, not grey) and its title reads at 4.5:1 or more
// `OUT=/tmp/x` keeps a screenshot of each state.
//
// Run: `cd web && npm run uicheck -- UX.B2-pick`, or alone: node web/dev/checks/UX.B2-pick.mjs (VIEWPORT=phone, DIST=… as README.md says).
import fs from "node:fs";
import path from "node:path";

import { check, mockEval, seed, until } from "../shot.mjs";
import { back, byTid, press, tidSel } from "./sel.mjs";

export const viewports = ["phone"];

const WAIT = 15000;
const J = JSON.stringify;
const OUT = process.env.OUT;
const BOARD = "b_UXB2", CHAT = "c_UXB2", TITLE = "Draw the request flow";
const SHAPES = { checkout: "Checkout service", payments: "Payments", inventory: "Inventory", orders: "Orders DB" };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

await check("UX.B2-pick Point at and Add selection on the phone: the pick bar, the pin, the chips, what is sent, the selection rule", async ({ url, open, viewport, fail, note }) => {
  const shot = async (page, name) => { if (OUT) { fs.mkdirSync(OUT, { recursive: true }); await page.screenshot({ path: path.join(OUT, `${viewport}-b2-${name}.png`) }); } };
  const READY = tidSel("board-canvas", { board: BOARD, state: "ready" });
  const input = (page) => byTid(page, "composer-input").first();
  const boxText = (page) => input(page).evaluate((e) => (e.value ?? e.innerText ?? e.textContent ?? "").replace(/[​ ]/g, " ").replace(/\n$/, ""));
  const chatShown = (page) => byTid(page, "chat-head").count().then((n) => n > 0);
  const sent = () => mockEval(`return (items[${J(CHAT)}] ?? []).filter((x) => x.kind === "user").map((x) => x.text);`, url);
  /** The text of the chat's saved draft (the mock keeps it on the chat while it has one branch; "" when none). */
  const draftText = () => mockEval(`return JSON.stringify(chats[${J(CHAT)}]?.draft ?? "");`, url);
  const stackKeys = (page) => page.evaluate(() => window.__aiwbStack.entries().map((e) => e.key));
  const rect = (loc) => loc.evaluate((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; });
  const visible = (page, id, data) => byTid(page, id, data).first().isVisible().catch(() => false);
  const chips = (page, kind) => byTid(page, "ctx-chip", { kind });
  const waitChat = async (page, what, text) => {
    if (!(await until(() => chatShown(page), WAIT))) return fail(`${what}: the chat is not open again`) ?? false;
    if (!(await until(async () => (await input(page).count()) > 0, WAIT))) return fail(`${what}: the chat has no message box`) ?? false;
    const got = await until(async () => { const x = await boxText(page); return x === text ? x : null; }, 5000);
    if (got === null) { fail(`${what}: the box reads ${J(await boxText(page))}, not ${J(text)}: the draft changed on the way`); return false; }
    return true;
  };
  const noPickState = async (page, what) => {
    const st = await page.evaluate(() => window.__aiwbPick?.state?.() ?? null);
    if (st && st.picking) fail(`${what}: a chat still waits (${J(st)})`);
  };
  const typeDraft = async (page, text, caretAfter) => {
    await press(page, input(page));
    await page.waitForFunction(() => document.activeElement?.dataset?.testid === "composer-input", null, { timeout: WAIT });
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await page.keyboard.type(text);
    if (caretAfter !== undefined) for (let i = 0; i < text.length - caretAfter; i++) await page.keyboard.press("ArrowLeft");
  };
  const plusRow = async (page, action) => {
    await press(page, byTid(page, "composer-plus").first());
    const row = byTid(page, "action-row", { action }).first();
    await row.waitFor({ state: "visible", timeout: WAIT });
    return row;
  };
  /** The bar of the board while a wait is on. */
  const onBoard = async (page, what, kind) => {
    const bar = byTid(page, "pick-bar").first();
    if (!(await until(() => bar.isVisible().catch(() => false), WAIT))) { fail(`${what}: the board screen has no pick-bar`); return null; }
    if ((await bar.getAttribute("data-kind")) !== kind) fail(`${what}: pick-bar is kind ${J(await bar.getAttribute("data-kind"))}, not ${kind}`);
    return bar;
  };
  const openSession = async (opts = {}) => {
    await seed(url, "UXB2");
    // (opened directly, as other checks do: the board is mounted under its chat; it must still be fitted once it is shown)
    const o = await open({ sel: { board: BOARD, chat: CHAT }, wait: tidSel("composer-input"), ...opts });
    return o;
  };
  /** The page point of a shape's middle (the canvas, the board's view and the scene's coordinates). */
  const where = async (page, id) => {
    const v = await page.evaluate(() => window.__aiwbView());
    const c = await page.locator(".excalidraw canvas.interactive").first().boundingBox();
    const e = await mockEval(`return scenes[${J(BOARD)}].scene.elements.find((x) => x.id === ${J(id)});`, url);
    const sx = (x) => c.x + (x + v.scrollX) * v.zoom, sy = (y) => c.y + (y + v.scrollY) * v.zoom;
    return { x: sx(e.x + e.width / 2), y: sy(e.y + e.height / 2), el: e, sx, sy, v };
  };
  const toBoard = async (page, what) => { // from the chat, by the stack's back, to the board screen
    if (!(await back(page))) return fail(`${what}: the stack has no back from the chat to the board`);
    await page.waitForSelector(READY, { timeout: WAIT }).catch(() => fail(`${what}: the board's canvas is not ready`));
  };
  /** Selects exactly the two shapes with Excalidraw's own tools: a tap on the first, the shift key and a click on the second. (The count is read
   *  where it is shown: the bar's Add (n), the "+" sheet's row.) */
  const selectTwo = async (page, a, b) => {
    const A = await where(page, a), B = await where(page, b);
    await page.touchscreen.tap(A.x, A.y);
    await sleep(250);
    await page.keyboard.down("Shift");
    await page.mouse.click(B.x, B.y);
    await page.keyboard.up("Shift");
    await sleep(400);
  };

  // ================= 1. Point at: the board while picking, and the three ways out
  let o = await openSession();
  const { page } = o;
  if (!(await until(() => visible(page, "chat-head"), WAIT))) return fail("the seeded chat did not open");
  if (!(await until(() => page.evaluate(() => !!window.__aiwbStack && !!window.__aiwbPick), WAIT))) return fail("the build has no window.__aiwbStack or window.__aiwbPick: it is not made for the checks");
  note(`the stack of the opened chat: ${J(await stackKeys(page))}`);
  // the board under a chat opened directly is fitted once it is shown (it had no size when it was asked to fit): by "+" > Point at, then Cancel
  await typeDraft(page, "first second", "first".length);
  await press(page, await plusRow(page, "point"));
  if (await onBoard(page, "the board under a chat opened directly", "point")) {
    await page.waitForSelector(READY, { timeout: WAIT });
    const fitted = await until(async () => { const v = await page.evaluate(() => window.__aiwbView()); return v && v.zoom > 0.1 && v.zoom <= 1 ? v : null; }, 5000);
    if (!fitted) fail(`the board opened under a chat is not fitted: its view is ${J(await page.evaluate(() => window.__aiwbView()))}, the zoom is not above 0.1 and at most 1`);
    else {
      const c = await page.locator(".excalidraw canvas.interactive").first().boundingBox();
      for (const [key, name] of Object.entries(SHAPES)) {
        const id = "uxb2_" + key;
        const w = await where(page, id);
        const x0 = w.sx(w.el.x), x1 = w.sx(w.el.x + w.el.width), y0 = w.sy(w.el.y), y1 = w.sy(w.el.y + w.el.height);
        if (x0 < c.x - 1 || x1 > c.x + c.width + 1 || y0 < c.y - 1 || y1 > c.y + c.height + 1)
          fail(`the board opened under a chat is fitted to zoom ${fitted.zoom.toFixed(2)}, but "${name}" (${Math.round(x0)}…${Math.round(x1)}, ${Math.round(y0)}…${Math.round(y1)}) is outside the canvas (${Math.round(c.x)}…${Math.round(c.x + c.width)}, ${Math.round(c.y)}…${Math.round(c.y + c.height)})`);
      }
      note(`the board opened under a chat is fitted: zoom ${fitted.zoom.toFixed(2)}, the shapes inside the canvas`);
    }
    await shot(page, "fitted");
    await press(page, byTid(page, "pick-cancel").first());
    await waitChat(page, "Cancel after the fit check", "first second");
  }
  await typeDraft(page, "first second", "first".length);
  if ((await boxText(page)) !== "first second") return fail(`the check could not make its draft: the box reads ${J(await boxText(page))}`);

  /** Starts Point at from the "+" sheet. */
  const startPoint = async () => press(page, await plusRow(page, "point"));
  const sheetRow = await plusRow(page, "point");
  {
    const t = ((await sheetRow.innerText()) ?? "").replace(/\s+/g, " ").trim();
    if (!/^Point at/.test(t) || !/Tap a spot on the board/.test(t)) fail(`the "+" sheet's point row reads ${J(t)}, not "Point at" with the note "Tap a spot on the board"`);
    const sel = ((await byTid(page, "action-row", { action: "selection" }).first().innerText().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
    if (!/^Add selection/.test(sel) || !/Select shapes on the board/.test(sel)) fail(`the "+" sheet's selection row reads ${J(sel)}, not "Add selection" with the note "Select shapes on the board"`);
    await press(page, sheetRow);
  }
  let lightBar = null;
  const bar1 = await onBoard(page, "Point at", "point");
  if (bar1) {
    const title = ((await bar1.innerText()) ?? "").replace(/\s+/g, " ");
    if (!title.includes("Tap a spot on the board")) fail(`Point at: the bar's title is not "Tap a spot on the board": ${J(title)}`);
    if (!title.includes(`for “${TITLE}”`)) fail(`Point at: the bar's sub-line is not ${J(`for “${TITLE}”`)}: ${J(title)}`);
    const cancel = byTid(page, "pick-cancel").first();
    if (!(await cancel.count())) fail("Point at: the bar has no Cancel (pick-cancel)");
    else {
      const r = await rect(cancel);
      if (r.h < 43.5) fail(`Point at: Cancel is ${r.h} px high, under 44`);
      const bg = await cancel.evaluate((e) => getComputedStyle(e).backgroundColor);
      if (bg !== "rgb(255, 255, 255)") fail(`Point at: Cancel's ground is ${bg}, not white`);
      if (((await cancel.innerText()) ?? "").trim() !== "Cancel") fail(`Point at: the button reads ${J(await cancel.innerText())}, not "Cancel"`);
    }
    lightBar = await bar1.evaluate((e) => getComputedStyle(e).backgroundColor);
    const word = byTid(page, "board-bar").locator(tidSel("state-word")).first();
    if ((await word.getAttribute("data-word").catch(() => null)) !== "picking" || ((await word.innerText().catch(() => "")) ?? "").trim() !== "Picking a point")
      fail(`Point at: the bar's state word is ${J(await word.getAttribute("data-word").catch(() => null))} reading ${J(await word.innerText().catch(() => null))}, not picking "Picking a point"`);
    const chats = byTid(page, "board-chats").first();
    const off = (await chats.getAttribute("aria-disabled")) === "true" || (await chats.getAttribute("disabled")) !== null || (await chats.getAttribute("data-off")) === "true";
    if (!off) fail(`Point at: the Chats button is not disabled (aria-disabled ${J(await chats.getAttribute("aria-disabled"))})`);
    if (!(await byTid(page, "pick-border").count())) fail("Point at: the canvas has no accent border (pick-border)");
    for (const id of ["pick-hint", "pick-layer", "board-row"]) if (await byTid(page, id).count()) fail(`Point at: ${id} is drawn on the phone's board while a point is picked`);
    const pills = await page.locator('[data-testid^="pill"]').count();
    if (pills) fail(`Point at: ${pills} parts of the voice pill (pill-…) are drawn on the board while a point is picked`);
    const keys = await stackKeys(page);
    if (!/board/i.test(keys.at(-1) ?? "")) fail(`Point at: the stack's top is ${J(keys.at(-1))}, not the board (stack ${J(keys)})`);
    await shot(page, "point-bar");
  }
  const cancelWays = [
    ["Cancel", () => press(page, byTid(page, "pick-cancel").first())],
    ["the system back", async () => { if (!(await back(page))) fail("Point at: the board's bar has no back control"); }],
    ["the stack's goBack", () => page.evaluate(() => window.__aiwbStack.goBack())],
  ];
  for (const [i, [what, doit]] of cancelWays.entries()) {
    if (i > 0) { await typeDraft(page, "first second", "first".length); await startPoint(); await onBoard(page, `Point at (${what})`, "point"); }
    await doit();
    if (await waitChat(page, what, "first second")) {
      if (await chips(page, "point").count()) fail(`${what}: a point chip is in the context row`);
      await noPickState(page, what);
    }
  }
  note("Point at: the board's bar, Cancel, the system back and the stack's goBack each end the wait with the chat and its draft as they were");

  // ================= 2. Point at: a tap
  await typeDraft(page, "first second", "first".length);
  await startPoint();
  await onBoard(page, "Point at (a tap)", "point");
  await page.waitForSelector(READY, { timeout: WAIT });
  await sleep(600); // (the canvas has taken its fit)
  const pay = await where(page, "uxb2_payments");
  await page.touchscreen.tap(pay.x, pay.y);
  const t0 = Date.now();
  const pin = byTid(page, "pick-pin").first(), label = byTid(page, "pick-pin-label").first();
  if (!(await until(() => pin.isVisible().catch(() => false), 3000))) fail("a tap on Payments drew no pick-pin");
  if (!(await until(() => label.isVisible().catch(() => false), 3000))) fail("a tap on Payments drew no pick-pin-label");
  else {
    const text = ((await label.innerText()) ?? "").trim();
    if (!/^x -?\d+, y -?\d+ · near Payments$/.test(text)) fail(`the pin's label reads ${J(text)}, not "x <n>, y <n> · near Payments"`);
    // (the label is drawn, at opacity 1, once its width and the layer's are measured and it has been moved inside the layer's sides)
    await until(() => label.evaluate((e) => getComputedStyle(e).opacity === "1").catch(() => false), 3000);
    const r = await rect(label), w = page.viewportSize().width;
    if (r.x < 7.5 || r.right > w - 7.5) fail(`the pin's label is not inside the screen (8 px in from each side): x ${Math.round(r.x)}…${Math.round(r.right)} of 0…${w}`);
    await shot(page, "pin");
  }
  if (Date.now() - t0 < 400 && (await chatShown(page))) fail("the chat was back before 400 ms after the tap: the pin was not shown long enough");
  await sleep(Math.max(0, 250 - (Date.now() - t0)));
  if (Date.now() - t0 < 400 && (await chatShown(page))) fail(`the chat was back ${Date.now() - t0} ms after the tap (the pin stays for 600 ms)`);
  const backAt = await until(async () => ((await chatShown(page)) ? Date.now() - t0 : null), 5000);
  if (backAt === null) return fail("a tap on Payments did not bring the chat back within 5 s");
  note(`Point at: the chat was back ${backAt} ms after the tap`);
  if (await waitChat(page, "a tap on Payments", "first second")) {
    const chip = chips(page, "point").first();
    if (!(await chip.count())) fail("a tap on Payments put no point chip into the context row");
    else {
      const text = ((await chip.innerText()) ?? "").replace(/\s+/g, " ").trim();
      if (text !== "Point near Payments") fail(`the point chip reads ${J(text)}, not "Point near Payments"`);
      if (!(await byTid(page, "context-row").first().locator(tidSel("ctx-chip", { kind: "point" })).count())) fail("the point chip is not in the context row");
      await shot(page, "point-chip");
      // the × target: on the web build the pressable is what can be measured (24 px wide, as high as the chip); the design's hit slop (10 px each side, 5 above and below:
      // RefChips.tsx) makes it 44×44 on a device, and the web build does not draw it
      const x = chip.locator(tidSel("ctx-chip-remove")).first();
      if (!(await x.count())) fail("the point chip has no × (ctx-chip-remove)");
      else {
        const r = await rect(x);
        if (r.w < 23.5 || r.h < 33.5) fail(`the point chip's × is ${Math.round(r.w)}×${Math.round(r.h)} px, under the 24×34 the design's hit slop (44×44) is added to`);
        else note(`the × target measured: the pressable is ${Math.round(r.w)}×${Math.round(r.h)} px (hit slop is not drawn by the web build; the design's slop makes it 44×44 on a device)`);
      }
    }
    // send
    const before = (await sent()).length;
    await press(page, byTid(page, "send").first());
    const texts = await until(async () => { const t = await sent(); return t.length > before ? t : null; }, WAIT);
    if (!texts) fail("Send did not reach the mock");
    else {
      const m = /^first <point x="(-?\d+)" y="(-?\d+)">near: ([^<]*Payments[^<]*)<\/point> second$/.exec(texts.at(-1));
      if (!m) fail(`the sent message is ${J(texts.at(-1))}, not "first <point x=… y=…>near: … Payments …</point> second"`);
      else {
        const [, x, y] = m, e = pay.el;
        if (+x < e.x || +x > e.x + e.width || +y < e.y || +y > e.y + e.height) fail(`the sent point (${x}, ${y}) is outside Payments' box (${e.x}…${e.x + e.width}, ${e.y}…${e.y + e.height})`);
        else note(`Point at: the message sent is ${J(texts.at(-1)).slice(0, 120)}…`);
      }
    }
  }

  // ================= 3. × takes the point out of the message
  await typeDraft(page, "here");
  await startPoint();
  await onBoard(page, "Point at (for ×)", "point");
  await sleep(300);
  const pay3 = await where(page, "uxb2_payments");
  await page.touchscreen.tap(pay3.x, pay3.y);
  if (await waitChat(page, "a tap (for ×)", "here")) {
    const chip = chips(page, "point").first();
    if (!(await until(() => chip.isVisible().catch(() => false), WAIT))) fail("a tap put no point chip into the message (for ×)");
    else {
      // (the draft is saved a moment after the chip came in: it has the tag before the × and none after)
      await until(async () => /<point/.test(await draftText()), 8000);
      await press(page, chip.locator(tidSel("ctx-chip-remove")).first());
      if (!(await until(async () => (await chips(page, "point").count()) === 0, 5000))) fail("× did not take the point chip out");
      if (await boxText(page) !== "here") fail(`after × the box reads ${J(await boxText(page))}, not "here"`);
      const gone = await until(async () => { const s = await draftText(); return /here/.test(s) && !/<point/.test(s) ? s : null; }, 10000);
      if (gone === null) fail(`after × the draft saved by the mock is ${await draftText()}: it has no "here" or still has the <point tag`);
      else note(`× took the point out: the saved draft is ${gone}`);
    }
  }
  await o.ctx.close();

  // ================= 4. Add selection: a reader, then the holder; 5. back cancels
  o = await openSession();
  const p4 = o.page;
  await p4.waitForSelector(tidSel("chat-head"), { timeout: WAIT });
  await typeDraft(p4, "which two", "which".length);
  const selRow = await plusRow(p4, "selection");
  await press(p4, selRow);
  const bar4 = await onBoard(p4, "Add selection (a reader)", "select");
  if (bar4) {
    const text = ((await bar4.innerText()) ?? "").replace(/\s+/g, " ");
    if (!text.includes("Select items")) fail(`Add selection: the bar's title is not "Select items": ${J(text)}`);
    const word = byTid(p4, "board-bar").locator(tidSel("state-word")).first();
    if (((await word.innerText().catch(() => "")) ?? "").trim() !== "Selecting for the chat" || (await word.getAttribute("data-word").catch(() => null)) !== "selecting")
      fail(`Add selection: the bar's state word is ${J(await word.getAttribute("data-word").catch(() => null))} reading ${J(await word.innerText().catch(() => null))}, not selecting "Selecting for the chat"`);
    const take = byTid(p4, "pick-take").first();
    if (!(await take.count()) || ((await take.innerText()) ?? "").trim() !== "Edit here") fail(`Add selection: a reader's bar has ${J(await take.innerText().catch(() => null))}, not "Edit here" (pick-take)`);
    if (await byTid(p4, "pick-add").count()) fail("Add selection: a reader's bar has pick-add before Edit here");
    await shot(p4, "select-bar-reader");
    await press(p4, take);
    const add = byTid(p4, "pick-add").first();
    if (!(await until(() => add.isVisible().catch(() => false), WAIT))) fail("Add selection: Edit here did not give the bar its Add (n)");
    else {
      const t = ((await add.innerText()) ?? "").trim();
      if (t !== "Add (0)") fail(`Add selection: the holder's button reads ${J(t)}, not "Add (0)"`);
      if ((await add.getAttribute("aria-disabled")) !== "true" && (await add.getAttribute("disabled")) === null) fail("Add selection: Add (0) is not disabled");
      const r = await rect(add);
      await p4.touchscreen.tap(r.x + r.w / 2, r.y + r.h / 2);
      await sleep(500);
      if (!(await visible(p4, "pick-bar")) || (await chatShown(p4))) fail("Add selection: a press on Add (0) left the board");
      await shot(p4, "select-bar-empty");
      await p4.waitForSelector(".excalidraw:not(.excalidraw--view-mode) canvas.interactive", { timeout: WAIT }).catch(() => fail("Add selection: the board is not editable after Edit here"));
      await sleep(400);
      await selectTwo(p4, "uxb2_payments", "uxb2_inventory");
      const n = await until(async () => { const x = ((await add.innerText().catch(() => "")) ?? "").trim(); return x === "Add (2)" ? x : null; }, 5000);
      if (n === null) fail(`Add selection: after two shapes were selected the button reads ${J(((await add.innerText().catch(() => "")) ?? "").trim())}, not "Add (2)"`);
      else {
        if ((await add.getAttribute("aria-disabled")) === "true") fail("Add selection: Add (2) is disabled");
        await shot(p4, "select-bar");
        await press(p4, add);
        if (await waitChat(p4, "Add (2)", "which two")) {
          const chip = chips(p4, "selection").first();
          if (!(await until(() => chip.isVisible().catch(() => false), WAIT))) fail("Add (2) put no selection chip into the context row");
          else {
            const text = ((await chip.innerText()) ?? "").replace(/\s+/g, " ").trim();
            if (text !== "2 shapes · Payments, Inventory") fail(`the selection chip reads ${J(text)}, not "2 shapes · Payments, Inventory"`);
            await shot(p4, "selection-chip");
          }
          const before = (await sent()).length;
          await press(p4, byTid(p4, "send").first());
          const texts = await until(async () => { const t = await sent(); return t.length > before ? t : null; }, WAIT);
          if (!texts) fail("Send did not reach the mock (the selection)");
          else {
            const msg = texts.at(-1), m = /<selection ids="([^"]*)"/.exec(msg);
            const ids = (m?.[1] ?? "").split(",").sort().join(","), want = ["uxb2_inventory", "uxb2_payments"].join(",");
            if (!m) fail(`the sent message has no <selection ids=…>: ${J(msg)}`);
            else if (ids !== want) fail(`the sent selection has the ids ${J(ids)}, not ${J(want)}`);
            if (!/which/.test(msg) || !/two/.test(msg)) fail(`the sent message lost the draft's words: ${J(msg)}`);
            else note(`Add selection: the message sent is ${J(msg).slice(0, 140)}…`);
          }
        }
      }
    }
  }

  // ---- 5. Back cancels Add selection, the draft kept (the board is the holder's now: Add (n) shows the two still selected)
  await typeDraft(p4, "keep me");
  await press(p4, await plusRow(p4, "selection"));
  const bar5 = await onBoard(p4, "Add selection (to cancel)", "select");
  if (bar5) {
    await back(p4);
    if (await waitChat(p4, "Back from Add selection", "keep me")) {
      if (await chips(p4, "selection").count()) fail("Back from Add selection left a selection chip in the chat");
      await noPickState(p4, "Back from Add selection");
      note("Add selection: Back ends the wait, the chat has its draft and no chip");
    }
  }

  // ================= 6. the rule: a selection on the board goes to no chat by itself
  await toBoard(p4, "the selection rule");
  await sleep(400);
  await p4.keyboard.press("Escape");
  await selectTwo(p4, "uxb2_payments", "uxb2_inventory");
  await press(p4, byTid(p4, "board-chats").first());
  await press(p4, byTid(p4, "chats-row", { chat: CHAT }).first());
  if (await waitChat(p4, "the Chats sheet", "keep me")) {
    if (await chips(p4, "selection").count()) fail("two shapes were selected on the board and the chat opened by the Chats sheet has a selection chip");
    if (await byTid(p4, "ctx-act").count()) fail("the chat has a ctx-act (a '+ Add N selected' offer) while shapes are selected on the board");
    const row = ((await byTid(p4, "context-row").first().innerText().catch(() => "")) ?? "");
    if (/selected/i.test(row)) fail(`the context row says ${J(row)} while shapes are selected on the board`);
    const rowSel = await plusRow(p4, "selection");
    const t = ((await rowSel.innerText()) ?? "").replace(/\s+/g, " ").trim();
    if (!/2 shapes selected on the board/.test(t)) fail(`with two shapes selected the Add selection row reads ${J(t)}, not "…2 shapes selected on the board"`);
    for (const a of await p4.locator('[data-testid="plus-sheet"] [data-testid="action-row"]').evaluateAll((es) => es.map((e) => e.dataset.action))) {
      if (!["files", "prompt", "selection", "point", "camera", "library"].includes(a)) fail(`the "+" sheet has an unexpected row ${J(a)}`);
    }
    await press(p4, rowSel);
    if (await chips(p4, "selection").count()) fail("pressing Add selection put the selection into the chat at once: it goes to the board first");
    const bar6 = await onBoard(p4, "Add selection (shapes already selected)", "select");
    if (bar6) {
      const add = byTid(p4, "pick-add").first();
      const lit = await until(async () => (((await add.innerText().catch(() => "")) ?? "").trim() === "Add (2)" ? true : null), 3000);
      if (!lit) fail(`Add selection with two shapes already selected opens with ${J(((await add.innerText().catch(() => "")) ?? "").trim())}, not "Add (2)" at once`);
      else if ((await add.getAttribute("aria-disabled")) === "true") fail("Add (2) is disabled on opening");
      await shot(p4, "select-bar-preselected");
      await back(p4);
      if (await waitChat(p4, "Back from Add selection (preselected)", "keep me")) {
        if (await chips(p4, "selection").count()) fail("after Back from the board the chat holds a selection chip: the selection went into the chat by itself");
        note("the selection rule: shapes selected on the board put nothing into the chat (no chip, no offer); Add selection goes to the board and its Add (2) is lit at once");
      }
    }
  }
  await o.ctx.close();

  // ================= 7. dark
  o = await openSession({ ls: { "aiwb.theme": "dark" } });
  const p7 = o.page;
  await p7.waitForSelector(tidSel("chat-head"), { timeout: WAIT });
  await press(p7, await plusRow(p7, "point"));
  const bar7 = await onBoard(p7, "Point at (dark)", "point");
  if (bar7) {
    const [bg, fg] = await bar7.evaluate((e) => {
      const q = (s) => getComputedStyle(s);
      const titleEl = [...e.querySelectorAll("*")].find((n) => n.children.length === 0 && n.textContent.trim() === "Tap a spot on the board");
      return [q(e).backgroundColor, titleEl ? q(titleEl).color : ""];
    });
    const rgb = (css) => (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    const lumOf = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const B = rgb(bg), F = rgb(fg);
    if (B.length < 3 || F.length < 3) fail(`dark: cannot read the bar's ground ${J(bg)} or its title's colour ${J(fg)}`);
    else {
      const chroma = Math.max(...B) - Math.min(...B);
      if (chroma < 40) fail(`dark: the bar's ground ${bg} is not the accent (chroma ${chroma}): a grey or white ground`);
      const [hi, lo] = [lumOf(B), lumOf(F)].sort((a, b) => b - a);
      const ratio = (hi + 0.05) / (lo + 0.05);
      if (ratio < 4.5) fail(`dark: the bar's title ${fg} on ${bg} has a contrast of ${ratio.toFixed(2)}:1, under 4.5:1`);
      else note(`dark: the bar's ground ${bg} (light theme: ${lightBar}), its title ${fg}, contrast ${ratio.toFixed(2)}:1`);
    }
    await shot(p7, "point-bar-dark");
  }
  await o.ctx.close();
}, { viewports, page: false });
