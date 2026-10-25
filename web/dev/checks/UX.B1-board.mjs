// UX.B1-board (package B1, ux-improvements; plans/ux-improvements/b1-design.md §4, §5): the board screen on the phone. On the phone
// (iPhone 15, touch), with the boards of the A2 seed (the mock's own `b_ui` "Sketch" in the group "Shared", whose canvas a window can take,
// and `b_A2` "pipeline", with five chats one of which is at work), the screen is read in each role:
//   the bar        `board-bar`: the back control (`nav-back`, no label), the board's name, the place (the board's group, or the server's name
//                  for a board in no group) and the state word (`state-word`, dataSet word and tone) for a reader "View only", the holder
//                  "Editing", a take on its way "Taking over…", a board another window holds "Another window is editing", an archived board
//                  "Archived · read-only"; while a chat of the board is busy the state is "<Agent> is working…" and takes the place's line;
//                  the Chats button `board-chats` (dataSet count and busy, aria-label "Chats, N") and no other button on the bar
//   the row        `board-row`: a reader has `board-take` "Edit here" (a 44 pt button); the holder and an archived board have none; the
//                  `board-orb-slot` box (empty) is at the right end, 64 px wide or more, at the bottom of the window
//   no floating    none of the wide layouts' reader's bar (`board-role`), "Editing" mark (`board-editing`), presence pill (`presence`) or
//   parts          dropped-edit note (`canvas-note`) is drawn over the canvas, in any of the roles
//   the sheet      `board-chats` opens `chats-sheet` titled `Chats on “<board>”` (typographic quotes); its first row is `chats-new` "New
//                  chat on this board" (none on an archived board); then one `chats-row` (dataSet chat) per chat of the board, each at least
//                  50 px high; a row opens that chat full screen (the stack is …, board, chat) and the sheet closes; the chat's back lands on
//                  the board's screen again (`board-bar` and the ready canvas); `chats-new` opens a new chat on the board
//   dark           the same screen in the dark theme: the bar's ground is not white and is the theme's, so is the sheet's, and its text is read
//   the menu       Excalidraw's menu (its hamburger) shows a group titled with the board's name, then exactly "Find on the board", "Fit the whole
//                  board", "Export image…", "Share image…"; the holder's has a separator and "Clear the board…" last, a reader's neither
//   clear          "Clear the board…" asks (`Clear “<name>”?`, the server in the body, a red "Clear the board"); Cancel changes nothing;
//                  confirming empties the board in one change (one save) and one undo brings every shape back
//   share          "Share image…" downloads `<name>.png` (a PNG) on the web build; a board with nothing on it says "Nothing on the board to share"
//   inset          the band is one 64 px row flush with the bottom and both sides, the bar's ground, a 1 px line above; no control of
//                  Excalidraw's footer lies under `board-row` (the reader's, the holder's, and the footer with shapes selected)
//   open view      a board opened for the first time is fitted (inside the visible rect with ~16 px margins, zoom <= 1); panned and zoomed,
//                  left and opened again it is where it was left (`aiwb.boardviews`)
// On the desktop and the tablet the phone's bar, row and sheet are not drawn; today's board bar and reader's bar are, with Excalidraw's own
// menu and the scene's own view.
// The menu, Clear and Share are tried with the voice pill hidden: it floats over the menu's lower items until V1's docked orb replaces it.
// `OUT=/tmp/x` keeps a screenshot of each state (the phone).
//
// Run: `cd web && npm run uicheck -- UX.B1-board`, or alone: node web/dev/checks/UX.B1-board.mjs (VIEWPORT=phone, DIST=… as README.md says).
import fs from "node:fs";
import path from "node:path";
import { callMatcher, check, mockEval, seed, until } from "../shot.mjs";
import { IDS, back, byTid, press, tidSel, touchDrag } from "./sel.mjs";
import { LIVE } from "./boarddraw.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const WAIT = 15000;
const J = JSON.stringify;
const OUT = process.env.OUT;
const SKETCH = "b_ui", PIPELINE = "b_A2", LOOSE = "b_ux_loose";
const READY = (board) => tidSel("board-canvas", { board, state: "ready" });
const FLOATING = ["board-role", "board-editing", "presence", "canvas-note"]; // (the wide layouts' parts over the canvas: RoleBar.tsx, Overlays.tsx)

await check("UX.B1-board the board screen on the phone: the bar, the state words, the bottom row, no floating parts, the Chats sheet", async ({ url, layout, viewport, open, fail, note }) => {
  const stack = (page) => page.evaluate(() => window.__aiwbStack.entries().map((e) => e.key));
  const rect = (loc) => loc.evaluate((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; });
  const shot = async (page, name) => { if (OUT) { fs.mkdirSync(OUT, { recursive: true }); await page.screenshot({ path: path.join(OUT, `${viewport}-b1-${name}.png`) }); } };
  const resetWorld = async () => { await seed(url, "A2"); await mockEval(`writer(${J(SKETCH)}, ""); return 1;`, url); };

  /** Opens `board` as the selection (the stack is derived from it) and waits for its canvas to be drawn. */
  const openAt = async (board, opts = {}) => {
    const o = await open({ sel: { board, chat: null }, wait: READY(board), ...opts });
    return o;
  };
  /** The state word on the bar: waits for `word` (its key), then checks its text and tone. */
  const stateIs = async (page, what, word, text, tone) => {
    const w = byTid(page, "board-bar").locator(tidSel("state-word"));
    const ok = await until(async () => (await w.first().getAttribute("data-word").catch(() => null)) === word, WAIT);
    if (!ok) return fail(`${what}: the state word is ${J(await w.first().getAttribute("data-word").catch(() => null))}, not ${J(word)}`);
    const said = ((await w.first().textContent()) ?? "").trim();
    if (typeof text === "string" ? said !== text : !text.test(said)) fail(`${what}: the state word says ${J(said)}, not ${text}`);
    if (tone && (await w.first().getAttribute("data-tone")) !== tone) fail(`${what}: the state word's tone is ${await w.first().getAttribute("data-tone")}, not ${tone}`);
  };
  /** No part of the wide layouts floats over the canvas. */
  const noFloating = async (page, what) => {
    for (const id of FLOATING) if (await byTid(page, id).count()) fail(`${what}: ${id} is drawn on the phone`);
  };

  if (layout !== "phone") {
    // ---- the wide layouts keep today's board bar and reader's bar; nothing of the phone's screen
    await resetWorld();
    const { page, ctx } = await openAt(SKETCH);
    if (!(await until(() => byTid(page, "board-bar").count(), WAIT))) fail("a wide layout draws no board bar");
    if (!(await until(() => byTid(page, "board-role").count(), WAIT))) fail("a wide layout draws no reader's bar (board-role) over the canvas of a reader");
    if (!(await byTid(page, "board-take").count())) fail("the reader's bar of a wide layout has no Edit here");
    for (const id of ["board-row", "board-orb-slot", "chats-sheet", "chats-new", "board-float"]) if (await byTid(page, id).count()) fail(`a wide layout draws ${id}, a part of the phone's screen`);
    // (today's bar keeps the testID `board-chats` on its Show chat button; the phone's Chats button is that id with a count and a "Chats" label)
    const showChat = byTid(page, "board-chats");
    if (await showChat.count() && ((await showChat.first().getAttribute("data-count")) !== null || !/^Show chat/.test((await showChat.first().getAttribute("aria-label")) ?? (await showChat.first().innerText()))))
      fail(`a wide layout's board-chats is not today's Show chat (label ${J(await showChat.first().getAttribute("aria-label"))}, data-count ${J(await showChat.first().getAttribute("data-count"))})`);
    if (await byTid(page, "board-bar").locator(tidSel("state-word")).count()) fail("a wide layout's board bar draws the phone's state word");
    // Excalidraw's own menu (not the phone's trimmed one), and the scene's own view (no fit, nothing kept)
    await page.waitForSelector(READY(SKETCH), { timeout: WAIT });
    await page.locator('[data-testid="main-menu-trigger"]').first().click();
    await page.locator(".dropdown-menu").first().waitFor({ state: "visible", timeout: WAIT }).catch(() => fail("a wide layout's menu does not open"));
    const items = await page.locator(".dropdown-menu .dropdown-menu-item__text").allInnerTexts().catch(() => []);
    if (await byTid(page, "phone-menu-find").count() || items.includes("Find on the board") || !items.some((t) => /help|theme|dark|open/i.test(t))) fail(`a wide layout's menu is not Excalidraw's own: [${items.join(", ")}]`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
    const v = await page.evaluate(() => window.__aiwbView?.() ?? null);
    if (v && (v.zoom !== 1 || v.scrollX !== 0 || v.scrollY !== 0)) fail(`a wide layout opens the board at the scene's own view (zoom 1, scroll 0), not at ${JSON.stringify({ zoom: v.zoom, x: v.scrollX, y: v.scrollY })}`);
    if (await page.evaluate(() => !!localStorage.getItem("aiwb.boardviews"))) fail("a wide layout keeps a view of the board (aiwb.boardviews)");
    await ctx.close();
    note("the wide layout draws today's board bar and reader's bar, none of the phone's bar, row or sheet; Excalidraw's own menu; the scene's own view");
    return;
  }

  const take = (page) => byTid(page, "board-take");
  const bar = (page) => byTid(page, "board-bar");
  const barBack = (page) => bar(page).locator(tidSel(IDS.back));

  // ---- 1. a reader: View only, in a group
  await resetWorld();
  let o = await openAt(SKETCH);
  {
    const { page } = o;
    if (!(await until(() => bar(page).isVisible(), WAIT))) return fail("the phone's board screen has no bar");
    if (!(await barBack(page).count())) fail("the board's bar has no back control");
    else if ((await barBack(page).getAttribute("aria-label")) !== "Back" || ((await barBack(page).innerText()).trim() !== "")) fail(`the back control of the board's bar is ${J(await barBack(page).innerText())} (label ${await barBack(page).getAttribute("aria-label")}): the chevron alone, named "Back"`);
    const title = (await bar(page).locator(tidSel("bar-title")).first().innerText()).trim();
    if (title !== "Sketch") fail(`the bar's title is ${J(title)}, not "Sketch"`);
    const sub = (await bar(page).locator(tidSel("bar-sub")).first().innerText().catch(() => "")).trim();
    if (sub !== "Shared") fail(`the bar's place is ${J(sub)}, not the board's group "Shared"`);
    await stateIs(page, "a reader", "view", "View only", "wait");
    const chats = byTid(page, "board-chats");
    if (!(await chats.count())) fail("the bar has no Chats button");
    else {
      if ((await chats.getAttribute("aria-label")) !== "Chats, 1") fail(`the Chats button is labelled ${J(await chats.getAttribute("aria-label"))}, not "Chats, 1"`);
      if ((await chats.getAttribute("data-count")) !== "1" || (await chats.getAttribute("data-busy")) !== "false") fail(`the Chats button's count and busy are ${await chats.getAttribute("data-count")} and ${await chats.getAttribute("data-busy")}, not 1 and false`);
      if (!/Chats/.test(await chats.innerText())) fail(`the Chats button reads ${J(await chats.innerText())}: it has no label`);
      const b = await rect(chats);
      if (b.h < 43.5) fail(`the Chats button is ${b.h} px high`);
    }
    if ((await bar(page).locator('[role="button"],button').count()) > 3) fail("the board's bar has more than the back, the title and the Chats button as controls");
    // the bottom row: Edit here and the orb's box
    const row = byTid(page, "board-row"), slot = byTid(page, "board-orb-slot");
    if (!(await row.count())) fail("a reader's board has no bottom row (board-row)");
    if ((await take(page).count()) !== 1) fail(`a reader's board has ${await take(page).count()} Edit here buttons, not 1`);
    else {
      if (((await take(page).innerText()) ?? "").trim() !== "Edit here") fail(`the button reads ${J(await take(page).innerText())}, not "Edit here"`);
      const b = await rect(take(page));
      if (b.h < 43.5) fail(`Edit here is ${b.h} px high`);
    }
    if (!(await slot.count())) fail("the bottom row has no orb slot (board-orb-slot)");
    else {
      const s = await rect(slot), win = page.viewportSize();
      if (s.w < 63.5) fail(`the orb slot is ${s.w} px wide, not 64 or more`);
      if (Math.abs(s.right - win.width) > 2) fail(`the orb slot ends at ${s.right}, not at the window's right edge ${win.width}`);
      if (Math.abs(s.bottom - win.height) > 2) fail(`the orb slot ends at ${s.bottom}, not at the window's bottom ${win.height}`);
      if (((await slot.innerText()) ?? "").trim()) fail(`the orb slot is not empty: ${J(await slot.innerText())}`);
      if (await take(page).count()) {
        const t = await rect(take(page));
        if (t.right > s.x + 0.5) fail(`Edit here (ends at ${t.right}) is over the orb slot (starts at ${s.x})`);
      }
    }
    await noFloating(page, "a reader");
    await shot(page, "reader");
    note("a reader: back, name, place, \"View only\", Chats 1; Edit here and the orb's box in the bottom row; no part floats over the canvas");

    // ---- 2. the sheet, from this reader's screen
    await press(page, chats);
    const sheet = byTid(page, "chats-sheet");
    if (!(await sheet.waitFor({ state: "visible", timeout: WAIT }).then(() => true, () => false))) fail("the Chats button did not open the sheet (chats-sheet)");
    else {
      await page.waitForTimeout(500); // (the sheet rises)
      const text = await sheet.innerText();
      if (!text.includes("Chats on “Sketch”")) fail(`the sheet's title is not Chats on “Sketch”: ${J(text.slice(0, 80))}`);
      const fresh = byTid(page, "chats-new"), rows = byTid(page, "chats-row");
      if (!(await fresh.count())) fail("the sheet has no row New chat on this board");
      else {
        if (!((await fresh.innerText()).includes("New chat on this board"))) fail(`the first row reads ${J(await fresh.innerText())}`);
        const f = await rect(fresh);
        if (f.h < 49.5) fail(`the New chat row is ${f.h} px high, not 50 or more`);
        if (await rows.count()) { const r0 = await rect(rows.first()); if (f.y >= r0.y) fail("New chat on this board is not the first row of the sheet"); }
      }
      const want = await mockEval(`return Object.values(chats).filter((c) => c.board === ${J(SKETCH)} && !c.archived).map((c) => c.id);`, url);
      const got = await rows.evaluateAll((els) => els.map((e) => e.dataset.chat));
      if (got.slice().sort().join() !== want.slice().sort().join()) fail(`the sheet lists the chats [${got.join(", ")}], the board has [${want.join(", ")}]`);
      for (const r of await rows.all()) { const b = await rect(r); if (b.h < 49.5) fail(`a chat row is ${b.h} px high, not 50 or more`); }
      await shot(page, "sheet");
      // a row opens the chat full screen; the sheet closes; the chat's back lands on the board's screen
      await press(page, rows.first());
      if (!(await until(async () => (await sheet.count()) === 0, WAIT))) fail("the sheet stays open after a row was pressed");
      if (!(await byTid(page, IDS.chatHead).first().waitFor({ state: "visible", timeout: WAIT }).then(() => true, () => false))) fail("a row of the sheet did not open the chat");
      const keys = await stack(page);
      if (keys.slice(-2).join() !== `board:${SKETCH},chat:${want[0]}`) fail(`after a row the stack ends [${keys.slice(-2).join(", ")}], not [board:${SKETCH}, chat:${want[0]}]`);
      if (await bar(page).last().isVisible().catch(() => false)) fail("the board's bar is on screen over the chat that is full screen");
      await press(page, byTid(page, IDS.back).last());
      if (!(await until(async () => (await stack(page)).slice(-1)[0] === `board:${SKETCH}`, WAIT))) fail(`the chat's back left the stack at [${(await stack(page)).join(", ")}]`);
      if (!(await bar(page).last().waitFor({ state: "visible", timeout: WAIT }).then(() => true, () => false))) fail("the board's bar is not on screen after the chat's back");
      if (!(await page.waitForSelector(READY(SKETCH), { timeout: WAIT }).then(() => true, () => false))) fail("the board's canvas is not ready after the chat's back");
      if (await byTid(page, IDS.chatHead).count()) fail("the chat stays drawn after its back");
      note("the Chats sheet: its title, New chat first, one 50 pt row per chat; a row opens the chat full screen and the back returns to the board");

      // New chat on this board opens a new chat on it
      await press(page, byTid(page, "board-chats"));
      await byTid(page, "chats-new").waitFor({ state: "visible", timeout: WAIT }).catch(() => fail("the sheet did not open again"));
      await page.waitForTimeout(500);
      await press(page, byTid(page, "chats-new"));
      if (!(await until(async () => (await byTid(page, "chats-sheet").count()) === 0, WAIT))) fail("the sheet stays open after New chat was pressed");
      if (!(await byTid(page, IDS.chatHead).first().waitFor({ state: "visible", timeout: WAIT }).then(() => true, () => false))) fail("New chat on this board opened no chat");
      const k2 = await stack(page);
      if (k2.at(-2) !== `board:${SKETCH}` || !k2.at(-1).startsWith("chat:") || k2.at(-1) === `chat:${want[0]}`) fail(`after New chat the stack ends [${k2.slice(-2).join(", ")}]: not a new chat over the board`);
      note("New chat on this board opens a new chat over the board");
    }
  }
  await o.ctx.close();

  // ---- 3. the holder: Editing, no Edit here, the orb's box stays
  await resetWorld();
  o = await openAt(SKETCH);
  {
    const { page } = o;
    await take(page).first().waitFor({ state: "visible", timeout: WAIT });
    // the server answers the take "waiting" (the window that holds the board was asked to hand it over): "Taking over…" until `held` comes
    let asked = 0;
    const TAKE = callMatcher(/^POST .*\/boards\/b_ui\/take/);
    await page.route(TAKE, (route) => { asked++; return route.fulfill({ status: 200, contentType: "application/json", body: J({ state: "waiting" }) }); });
    await press(page, take(page).first());
    if (!(await until(() => asked === 1, WAIT))) fail("Edit here did not ask the server for the board");
    await stateIs(page, "a take on its way", "taking", "Taking over…", "wait");
    const t = take(page).first();
    if (!(await t.count()) || (await t.getAttribute("data-taking")) !== "true") fail("the button of a take on its way is not the taking one (data-taking)");
    else if (((await t.innerText()) ?? "").trim() !== "Taking over…") fail(`the button of a take on its way reads ${J(await t.innerText())}`);
    if (await byTid(page, "board-role-spin").count() !== 1) fail("the taking button has no spinner");
    if (!(await byTid(page, "board-orb-slot").count())) fail("the orb slot went while the board is taken");
    await noFloating(page, "taking");
    await shot(page, "taking");
    await page.unroute(TAKE);
    await mockEval(`heldBoards.add(${J(SKETCH)}); send({ type: "held", board: ${J(SKETCH)}, rev: 1 }); return 1;`, url); // (the holder let go: the server's word)
    await stateIs(page, "the holder", "editing", "Editing", "ok");
    if (!(await until(() => page.locator(LIVE).count(), WAIT))) fail("the canvas of the holder cannot be drawn on");
    if (await take(page).count()) fail("the holder's board has an Edit here button");
    const slot = byTid(page, "board-orb-slot");
    if (!(await slot.count())) fail("the holder's bottom row has no orb slot");
    else { const s = await rect(slot); if (s.w < 63.5 || Math.abs(s.right - page.viewportSize().width) > 2) fail(`the holder's orb slot is ${s.w} px wide and ends at ${s.right}`); }
    if (!(await byTid(page, "board-row").count())) fail("the holder's board has no bottom row");
    await noFloating(page, "the holder");
    await shot(page, "holder");

    // another window takes the board under this one: the word says so, Edit here is back
    await mockEval(`writer(${J(SKETCH)}, "window"); return 1;`, url);
    await stateIs(page, "a board another window holds", "taken", "Another window is editing", "warn");
    if (!(await until(() => take(page).count(), WAIT))) fail("the window that lost the board has no Edit here");
    await noFloating(page, "the window that lost the board");
    // (the toast "Another window took over this board" is B1-3's: asserted only when it is drawn)
    note("the holder: \"Editing\", no Edit here, the orb's box; a take on its way \"Taking over…\" (disabled, with a spinner); the board lost to another window: \"Another window is editing\"");
  }
  await o.ctx.close();

  // ---- 4. a board another window holds, from the start
  await resetWorld();
  await mockEval(`writer(${J(SKETCH)}, "window"); return 1;`, url);
  o = await openAt(SKETCH);
  {
    const { page } = o;
    await stateIs(page, "a board another window holds", "taken", "Another window is editing", "warn");
    if (!(await take(page).count())) fail("a reader of a board another window holds has no Edit here");
    await noFloating(page, "another window");
    await shot(page, "another-window");
  }
  await o.ctx.close();

  // ---- 5. an archived board: read-only, nothing to take, no New chat
  await resetWorld();
  await mockEval(`boards.${SKETCH}.archived = true; boards.${SKETCH}.archiveOp = "op_ux_b1"; return 1;`, url);
  o = await openAt(SKETCH);
  {
    const { page } = o;
    await stateIs(page, "an archived board", "archived", "Archived · read-only", "wait");
    await page.waitForTimeout(500);
    if (await take(page).count()) fail("an archived board has an Edit here button");
    const slot = byTid(page, "board-orb-slot");
    if (!(await slot.count())) fail("an archived board's bottom row has no orb slot");
    await noFloating(page, "an archived board");
    await shot(page, "archived");
    await press(page, byTid(page, "board-chats"));
    if (!(await byTid(page, "chats-sheet").waitFor({ state: "visible", timeout: WAIT }).then(() => true, () => false))) fail("an archived board's Chats button opens no sheet");
    else {
      await page.waitForTimeout(500);
      if (await byTid(page, "chats-new").count()) fail("the sheet of an archived board offers New chat on this board");
      if (!(await byTid(page, "chats-row").count())) fail("the sheet of an archived board lists no chat");
    }
  }
  await o.ctx.close();

  // ---- 6. a chat of the board is at work: "<Agent> is working…" in the place of the place
  await resetWorld();
  o = await openAt(PIPELINE);
  {
    const { page } = o;
    await stateIs(page, "a board with a chat at work", "working", /^\S+ is working…$/, "ok");
    if (await bar(page).locator(tidSel("bar-sub")).count()) fail(`the place stays beside the working state: ${J(await bar(page).locator(tidSel("bar-sub")).first().innerText())}`);
    const chats = byTid(page, "board-chats");
    const n = await mockEval(`return Object.values(chats).filter((c) => c.board === ${J(PIPELINE)} && !c.archived).length;`, url);
    if ((await chats.getAttribute("data-busy")) !== "true") fail(`the Chats button's busy is ${await chats.getAttribute("data-busy")}, not true`);
    if ((await chats.getAttribute("data-count")) !== String(n) || (await chats.getAttribute("aria-label")) !== `Chats, ${n}`) fail(`the Chats button says ${await chats.getAttribute("data-count")} / ${J(await chats.getAttribute("aria-label"))} for ${n} chats`);
    await noFloating(page, "an agent at work");
    await shot(page, "working");
    // the sheet lists every chat of the board; the busy one says so
    await press(page, chats);
    await byTid(page, "chats-sheet").waitFor({ state: "visible", timeout: WAIT }).catch(() => fail("the Chats button of the working board opened no sheet"));
    await page.waitForTimeout(500);
    if ((await byTid(page, "chats-row").count()) !== n) fail(`the sheet lists ${await byTid(page, "chats-row").count()} chats, the board has ${n}`);
    for (const r of await byTid(page, "chats-row").all()) { const b = await rect(r); if (b.h < 49.5) fail(`a chat row is ${b.h} px high, not 50 or more`); }
    await shot(page, "sheet-many");
  }
  await o.ctx.close();

  // ---- 7. a board in no group names its server in the place
  await resetWorld();
  await mockEval(`boards.${LOOSE} = { id: ${J(LOOSE)}, name: "Loose sheet", group: "", created: iso(T0 - 20 * MIN) }; send({ type: "board", board: boards.${LOOSE} }); return 1;`, url);
  o = await open({ sel: { board: LOOSE, chat: null }, wait: tidSel("board-bar") });
  {
    const { page } = o;
    const sub = (await bar(page).locator(tidSel("bar-sub")).first().innerText().catch(() => "")).trim();
    if (sub !== "This computer") fail(`the place of a board in no group is ${J(sub)}, not the server's name "This computer"`);
    const c = byTid(page, "board-chats");
    if ((await c.getAttribute("aria-label")) !== "Chats" || (await c.getAttribute("data-count")) !== "0") fail(`the Chats button of a board with no chat is ${J(await c.getAttribute("aria-label"))} / ${await c.getAttribute("data-count")}`);
    await shot(page, "root");
  }
  await o.ctx.close();

  // ---- 8. dark: the screen draws on the theme's ground
  await resetWorld();
  o = await openAt(SKETCH, { ls: { "aiwb.theme": "dark" } });
  {
    const { page } = o;
    await stateIs(page, "dark", "view", "View only", "wait");
    const ground = (sel) => page.evaluate((s) => getComputedStyle(document.querySelector(s)).backgroundColor, sel);
    const lum = (css) => { const [r, g, b] = css.match(/[\d.]+/g).slice(0, 3).map(Number); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
    const barBg = await ground(tidSel("board-bar"));
    if (barBg === "rgb(255, 255, 255)" || lum(barBg) > 0.3) fail(`in the dark theme the bar's ground is ${barBg}`);
    if (!(await byTid(page, "board-row").count()) || !(await take(page).count())) fail("the dark theme's board screen draws no bottom row");
    await press(page, byTid(page, "board-chats"));
    if (!(await byTid(page, "chats-sheet").waitFor({ state: "visible", timeout: WAIT }).then(() => true, () => false))) fail("the sheet is not drawn in the dark theme");
    else {
      await page.waitForTimeout(500);
      const sheetBg = await page.evaluate(() => { for (let e = document.querySelector('[data-testid="chats-sheet"]'); e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (!/rgba?\(\s*\d+,\s*\d+,\s*\d+,\s*0\)/.test(c) && c !== "transparent") return c; } return "transparent"; });
      if (sheetBg === "rgb(255, 255, 255)") fail(`in the dark theme the sheet's ground is ${sheetBg}`);
      await shot(page, "sheet-dark");
    }
  }
  await o.ctx.close();

  // ================= what needed the app's glue (b1-design.md §2, §4, §6) =================
  const TRIGGER = '[data-testid="main-menu-trigger"]', MENU = ".dropdown-menu";
  const SHAPES = [["ux_a", 40, 40], ["ux_b", 620, 120], ["ux_c", 300, 520]].map(([id, x, y]) => ({ id, type: "rectangle", x, y, width: 180, height: 110 }));
  const liveOnServer = () => mockEval(`return scenes.${LOOSE}.scene.elements.filter((e) => !e.isDeleted).length;`, url);
  /** A board in no group, "Loose sheet", with `shapes` on its stored scene (which makes it one a window can take). */
  const makeLoose = async (shapes) => {
    await resetWorld();
    await mockEval(`boards.${LOOSE} = { id: ${J(LOOSE)}, name: "Loose sheet", group: "", created: iso(T0 - 20 * MIN) }; send({ type: "board", board: boards.${LOOSE} }); return othersave(${J(LOOSE)}, ${J(shapes)});`, url);
  };
  const openLoose = (opts) => openAt(LOOSE, opts);
  const toEdit = async (page, what) => {
    await press(page, take(page).first());
    await stateIs(page, what, "editing", "Editing", "ok");
    if (!(await until(() => page.locator(LIVE).count(), WAIT))) fail(`${what}: the canvas cannot be drawn on after Edit here`);
  };
  // (the voice pill (VC-28) floats over the board's bottom centre and covers the lower items of the menu until V1's docked orb replaces it: the menu's own
  // items are tested with the pill hidden; that it covers them is told in the report, not decided here)
  const hidePill = (page) => page.addStyleTag({ content: '[data-testid="pill"] { display: none !important; }' });
  const openMenu = async (page) => {
    await press(page, page.locator(TRIGGER).first());
    await page.locator(MENU).first().waitFor({ state: "visible", timeout: WAIT });
    await page.waitForTimeout(300);
  };
  const closeMenu = async (page) => { // (a press on the menu's button again closes it, as a person closes it)
    await press(page, page.locator(TRIGGER).first());
    if (!(await until(async () => !(await page.locator(MENU).count()), 3000))) fail("the menu stays open after its button was pressed again");
  };
  /** The menu as drawn: its group's title, every item's text in order, and the children of its container that hold no item (the separators). */
  const readMenu = (page) => page.evaluate(() => {
    const m = document.querySelector(".dropdown-menu"), c = m.querySelector(".dropdown-menu-container");
    const kids = [...c.children].map((k) => ({ group: k.classList.contains("dropdown-menu-group"), items: [...k.querySelectorAll(".dropdown-menu-item__text")].map((e) => e.textContent.trim()), own: k.classList.contains("dropdown-menu-item") ? k.textContent.trim() : null }));
    return { title: m.querySelector(".dropdown-menu-group-title")?.textContent.trim() ?? null, items: [...m.querySelectorAll(".dropdown-menu-item__text")].map((e) => e.textContent.trim()), kids };
  });
  const view = (page) => page.evaluate(() => window.__aiwbView?.() ?? null);
  const settled = async (page) => { // (the view has stopped moving)
    let last = JSON.stringify(await view(page));
    for (let i = 0; i < 20; i++) { await page.waitForTimeout(250); const now = JSON.stringify(await view(page)); if (now === last) return; last = now; }
  };

  // ---- 9. Excalidraw's menu, trimmed: the reader's, then the holder's
  await makeLoose(SHAPES);
  o = await openLoose();
  {
    const { page } = o;
    await hidePill(page);
    await openMenu(page);
    let m = await readMenu(page);
    if (m.title !== "Loose sheet") fail(`the menu's group is titled ${J(m.title)}, not the board's name "Loose sheet"`);
    const READER = ["Find on the board", "Fit the whole board", "Export image…", "Share image…"];
    if (m.items.join("|") !== READER.join("|")) fail(`a reader's menu offers [${m.items.join(", ")}], not [${READER.join(", ")}]`);
    if (m.kids.some((k) => !k.group && !k.own)) fail("a reader's menu has a separator: it has nothing below the group");
    await shot(page, "menu-reader");
    await closeMenu(page);
    await toEdit(page, "the holder");
    await openMenu(page);
    m = await readMenu(page);
    if (m.items.join("|") !== [...READER, "Clear the board…"].join("|")) fail(`the holder's menu offers [${m.items.join(", ")}], not [${[...READER, "Clear the board…"].join(", ")}]`);
    const at = m.kids.findIndex((k) => !k.group && !k.own);
    if (at !== 1 || m.kids.length !== 3 || m.kids[2].own !== "Clear the board…") fail(`the holder's menu is not the group, a separator, "Clear the board…" last (${J(m.kids)})`);
    await shot(page, "menu-holder");
    await closeMenu(page);
    note("the menu: the board's name over \"Find on the board\", \"Fit the whole board\", \"Export image…\", \"Share image…\"; for the holder a separator and \"Clear the board…\" last; nothing else");

    // ---- 10. Clear: asked first; Cancel changes nothing; confirmed it is one change
    if ((await liveOnServer()) !== SHAPES.length) fail(`the stored scene has ${await liveOnServer()} shapes before Clear, not ${SHAPES.length}`);
    await openMenu(page);
    await press(page, byTid(page, "phone-menu-clear").first());
    const dlg = byTid(page, "confirm-dialog");
    if (!(await dlg.first().waitFor({ state: "visible", timeout: WAIT }).then(() => true, () => false))) fail("Clear the board… asked nothing (no confirm dialog)");
    else {
      await page.waitForTimeout(400);
      const title = ((await byTid(page, "confirm-title").first().innerText().catch(() => "")) ?? "").trim();
      const body = ((await byTid(page, "confirm-body").first().innerText().catch(() => "")) ?? "").trim();
      const go = byTid(page, "confirm-go").first();
      if (title !== "Clear “Loose sheet”?") fail(`the confirm is titled ${J(title)}, not Clear “Loose sheet”?`);
      if (!body.includes("This computer")) fail(`the confirm's body does not name the server "This computer": ${J(body)}`);
      if (((await go.innerText().catch(() => "")) ?? "").trim() !== "Clear the board") fail(`the confirm's button reads ${J(await go.innerText().catch(() => ""))}, not "Clear the board"`);
      const red = await go.evaluate((e) => { for (let x = e; x; x = x.parentElement) { const c = getComputedStyle(x).backgroundColor; if (!/rgba?\(\s*\d+,\s*\d+,\s*\d+,\s*0\)/.test(c) && c !== "transparent") return c; } return ""; });
      const [r, g, b] = (red.match(/[\d.]+/g) ?? [0, 0, 0]).slice(0, 3).map(Number);
      if (!(r > 150 && r > g + 60 && r > b + 60)) fail(`the confirm's button is not a danger (red) button: ${red}`);
      await shot(page, "clear-confirm");
      await press(page, byTid(page, "confirm-cancel").first());
      if (!(await until(async () => !(await dlg.count()), WAIT))) fail("Cancel left the confirm open");
      await page.waitForTimeout(1500);
      if ((await liveOnServer()) !== SHAPES.length) fail(`Cancel changed the board: ${await liveOnServer()} shapes on the server`);
      // confirm
      const revBefore = await mockEval(`return scenes.${LOOSE}.rev;`, url);
      await openMenu(page);
      await press(page, byTid(page, "phone-menu-clear").first());
      await dlg.first().waitFor({ state: "visible", timeout: WAIT }).catch(() => fail("the second Clear asked nothing"));
      await page.waitForTimeout(400);
      await press(page, byTid(page, "confirm-go").first());
      if (!(await until(async () => (await liveOnServer()) === 0, WAIT))) fail(`confirming Clear left ${await liveOnServer()} shapes on the server`);
      if (!(await until(async () => !(await dlg.count()), WAIT))) fail("the confirm stays open after Clear");
      const revAfter = await mockEval(`return scenes.${LOOSE}.rev;`, url);
      if (revAfter !== revBefore + 1) fail(`Clear was saved as ${revAfter - revBefore} changes (rev ${revBefore} → ${revAfter}), not one`);
      await shot(page, "cleared");
      // one undo brings every shape back
      const undo = page.locator('[data-testid="button-undo"]');
      if (!(await undo.count()) || (await undo.first().isDisabled())) fail("Excalidraw's undo is not available after Clear");
      else await press(page, undo.first());
      if (!(await until(async () => (await liveOnServer()) === SHAPES.length, WAIT))) fail(`one undo after Clear left ${await liveOnServer()} of ${SHAPES.length} shapes on the server`);
      else note("Clear the board…: asks first (title with the name, the server in the body, a red \"Clear the board\"); Cancel changes nothing; confirming empties the board in one change and one undo brings every shape back");
    }
  }
  await o.ctx.close();

  // ---- 11. Share image…: a PNG download on the web build; a toast for a board with nothing on it
  await makeLoose(SHAPES);
  o = await openLoose();
  {
    const { page } = o;
    await hidePill(page);
    await openMenu(page);
    const dl = page.waitForEvent("download", { timeout: WAIT }).catch(() => null);
    await press(page, byTid(page, "phone-menu-share").first());
    const d = await dl;
    if (!d) fail("Share image… on the web build downloaded no file");
    else {
      if (d.suggestedFilename() !== "Loose sheet.png") fail(`the shared file is named ${J(d.suggestedFilename())}, not "Loose sheet.png"`);
      const bytes = fs.readFileSync(await d.path());
      if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") fail("the shared file does not begin with the PNG signature");
      else if (bytes.length < 1000) fail(`the shared picture is ${bytes.length} bytes: nothing seems drawn on it`);
      else note(`Share image…: downloads "Loose sheet.png" (a PNG of ${bytes.length} bytes)`);
    }
  }
  await o.ctx.close();
  await makeLoose([]);
  o = await openLoose();
  {
    const { page } = o;
    await hidePill(page);
    await openMenu(page);
    await press(page, byTid(page, "phone-menu-share").first());
    const t = byTid(page, "toast").first();
    if (!(await t.waitFor({ state: "visible", timeout: WAIT }).then(() => true, () => false))) fail("Share image… on an empty board said nothing (no toast)");
    else if (!((await t.innerText()).includes("Nothing on the board to share"))) fail(`the toast on an empty board reads ${J(await t.innerText())}, not "Nothing on the board to share"`);
    else note("Share image… on a board with nothing on it: the toast \"Nothing on the board to share\"");
  }
  await o.ctx.close();

  // ---- 12. the inset (open question 1): the band, and no footer control under the bottom row
  const band = (page) => page.evaluate(() => {
    const el = document.querySelector(".aiwb-phone .App-bottom-bar .App-toolbar") ?? document.querySelector(".App-bottom-bar .App-toolbar");
    if (!el) return null;
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    const bar = document.querySelector('[data-testid="board-bar"]');
    return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, h: r.height, bg: cs.backgroundColor, line: cs.borderTopWidth, lineColour: cs.borderTopColor, barBg: bar ? getComputedStyle(bar).backgroundColor : null };
  });
  const controls = (page) => page.evaluate(() => [...document.querySelectorAll(".App-bottom-bar button, .App-bottom-bar input, .App-bottom-bar a, .App-bottom-bar [role=button], .App-bottom-bar select, .App-bottom-bar label")].map((e) => {
    const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
    return { name: (e.getAttribute("aria-label") || e.getAttribute("title") || e.dataset.testid || e.textContent || e.tagName).trim().slice(0, 30), x: r.x, y: r.y, right: r.right, bottom: r.bottom, w: r.width, h: r.height, seen: cs.visibility !== "hidden" && cs.display !== "none" && r.width > 0 && r.height > 0 };
  }).filter((c) => c.seen));
  const insetHolds = async (page, what) => {
    const row = byTid(page, "board-row");
    if (!(await row.count())) return fail(`${what}: no bottom row to measure`);
    const R = await rect(row), cs = await controls(page), bd = await band(page), win = page.viewportSize();
    if (!bd) return fail(`${what}: Excalidraw's footer band (.App-bottom-bar .App-toolbar) is not drawn`);
    if (Math.abs(bd.h - 64) > 1 || Math.abs(bd.bottom - win.height) > 1.5 || bd.x > 1 || Math.abs(bd.right - win.width) > 1.5)
      fail(`${what}: the band is ${bd.h} px high at (${bd.x}, ${bd.y})–(${bd.right}, ${bd.bottom}), not 64 px flush with the bottom and both sides of ${win.width}×${win.height}`);
    if (bd.bg !== bd.barBg) fail(`${what}: the band's ground is ${bd.bg}, not the bar's ${bd.barBg}`);
    if (bd.line !== "1px" || /rgba?\(\s*\d+,\s*\d+,\s*\d+,\s*0\)/.test(bd.lineColour)) fail(`${what}: the line above the band is ${bd.line} ${bd.lineColour}, not 1 px`);
    if (!cs.length) fail(`${what}: the footer has no control to measure`);
    const hits = cs.filter((c) => c.x < R.right - 0.5 && c.right > R.x + 0.5 && c.y < R.bottom - 0.5 && c.bottom > R.y + 0.5);
    if (hits.length) fail(`${what}: footer controls lie under the bottom row (${R.x}…${R.right}, ${R.y}…${R.bottom}): ${hits.map((c) => `${J(c.name)} ${Math.round(c.x)}…${Math.round(c.right)}`).join(", ")}`);
    return cs.length;
  };
  await makeLoose(SHAPES);
  o = await openLoose();
  {
    const { page } = o;
    await page.waitForTimeout(600);
    const n1 = await insetHolds(page, "a reader's footer");
    await shot(page, "inset-reader");
    await toEdit(page, "the holder");
    await page.waitForTimeout(600);
    const n2 = await insetHolds(page, "the holder's footer");
    await shot(page, "inset-holder");
    await page.mouse.click(60, page.viewportSize().height * 0.45); // (an empty place: the canvas takes the keys)
    await page.keyboard.press("ControlOrMeta+a");
    if (!(await page.locator('.App-bottom-bar [aria-label="Duplicate"]').first().waitFor({ state: "visible", timeout: WAIT }).then(() => true, () => false))) fail("shapes were selected, but the footer shows no Duplicate: the selected footer was not measured");
    await page.waitForTimeout(700);
    const n3 = await insetHolds(page, "the footer with shapes selected");
    await shot(page, "inset-selected");
    if (n1 && n2 && n3) note(`the band is one 64 px row, flush with the bottom and both sides, the bar's ground, a 1 px line above; no footer control (${n1} for a reader, ${n2} for the holder, ${n3} with shapes selected) lies under the bottom row`);
  }
  await o.ctx.close();

  // ---- 13. the open view: fitted the first time, where it was left the next
  await makeLoose(SHAPES);
  o = await openLoose();
  {
    const { page } = o;
    const kept = () => page.evaluate(() => { try { return JSON.parse(localStorage.getItem("aiwb.boardviews") ?? "[]"); } catch { return null; } });
    if ((await kept())?.some?.((e) => e.board === LOOSE)) fail("the kv aiwb.boardviews holds the board before it was ever opened");
    await settled(page);
    const v = await view(page), box = await rect(byTid(page, "board-canvas").first()), row = await rect(byTid(page, "board-row"));
    if (!v) fail("the build shows no view (window.__aiwbView)");
    else {
      const minX = Math.min(...SHAPES.map((e) => e.x)), maxX = Math.max(...SHAPES.map((e) => e.x + e.width)), minY = Math.min(...SHAPES.map((e) => e.y)), maxY = Math.max(...SHAPES.map((e) => e.y + e.height));
      const scr = { l: box.x + (minX + v.scrollX) * v.zoom, r: box.x + (maxX + v.scrollX) * v.zoom, t: box.y + (minY + v.scrollY) * v.zoom, b: box.y + (maxY + v.scrollY) * v.zoom };
      const visible = { l: box.x, r: box.x + box.w, t: box.y, b: Math.min(box.bottom, row.y) };
      const m = { l: scr.l - visible.l, r: visible.r - scr.r, t: scr.t - visible.t, b: visible.b - scr.b };
      if (v.zoom > 1.0001) fail(`the first open is at zoom ${v.zoom}, over 1`);
      if (Math.min(m.l, m.r, m.t, m.b) < 14) fail(`the first open does not fit: margins left ${Math.round(m.l)}, right ${Math.round(m.r)}, top ${Math.round(m.t)}, bottom ${Math.round(m.b)} px (zoom ${v.zoom.toFixed(3)}); the shapes are not all inside the visible rect with ~16 px margins`);
      if (Math.min(m.l, m.r) > 20 && Math.min(m.t, m.b) > 20) fail(`the first open is not fitted (it leaves ${Math.round(Math.min(m.l, m.r))} px at the sides and ${Math.round(Math.min(m.t, m.b))} above and below, not ~16 on a side)`);
      await shot(page, "open-fitted");
      note(`a board opened for the first time is fitted: zoom ${v.zoom.toFixed(2)}, margins ${Math.round(m.l)}/${Math.round(m.r)}/${Math.round(m.t)}/${Math.round(m.b)} px`);
    }
    // pan and zoom it, leave, open again
    const c = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    await touchDrag(page, { x: c.x, y: c.y }, { x: c.x - 70, y: c.y - 110 }, { hold: 0, steps: 10 });
    await page.mouse.move(c.x, c.y);
    await page.keyboard.down("Control"); await page.mouse.wheel(0, -300); await page.keyboard.up("Control");
    await settled(page);
    const left = await view(page);
    if (!left || !v || (Math.abs(left.scrollX - v.scrollX) < 1 && Math.abs(left.scrollY - v.scrollY) < 1 && Math.abs(left.zoom - v.zoom) < 0.01)) fail("the view did not move when it was panned and zoomed: the check cannot tell where it was left");
    await page.waitForTimeout(800); // (the app keeps the view once it has been still for 400 ms)
    if (!(await back(page))) fail("the board's screen has no back to leave by");
    await byTid(page, "board-bar").first().waitFor({ state: "hidden", timeout: WAIT }).catch(() => fail("the board's bar stays after the back"));
    const stored = (await kept())?.find?.((e) => e.board === LOOSE);
    if (!stored) fail(`the kv aiwb.boardviews holds no view of the board after leaving it (${J(await kept())})`);
    else if (left && (Math.abs(stored.zoom - left.zoom) > 0.01 || Math.abs(stored.scrollX - left.scrollX) > 1 || Math.abs(stored.scrollY - left.scrollY) > 1)) fail(`the kv holds ${J(stored)}, the view left was ${J({ scrollX: left.scrollX, scrollY: left.scrollY, zoom: left.zoom })}`);
    await page.evaluate((b) => window.__aiwbStack.select({ board: b, chat: null }), LOOSE);
    await page.waitForSelector(READY(LOOSE), { timeout: WAIT });
    await settled(page);
    const again = await view(page);
    if (!again || !left) fail("no view after the board was opened again");
    else if (Math.abs(again.scrollX - left.scrollX) > 1 || Math.abs(again.scrollY - left.scrollY) > 1 || Math.abs(again.zoom - left.zoom) > 0.01)
      fail(`the board opened again at ${J({ x: again.scrollX, y: again.scrollY, z: again.zoom })}, not where it was left ${J({ x: left.scrollX, y: left.scrollY, z: left.zoom })}`);
    else note("opened again, the board is where it was left (the kv aiwb.boardviews holds its view)");
  }
  await o.ctx.close();
}, { viewports, page: false });
