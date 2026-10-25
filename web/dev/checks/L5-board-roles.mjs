// New (B4; the rows D-SL and D-TK had no browser check): the board screen's two ways out of a canvas, at all three viewports.
//   Leaving a board writes it. A shape is drawn and the board is left at once (the sidebar's row of a chat on the wide layouts, the
//   stack's back on the phone), before the autosave's wait and before the view's own: the board side asks the view for its scene as the board
//   goes, and the server has the shape, with no console error from the view that went (the host lets its answer come before it ends).
//   Another window takes the board. The server says `superseded`: the canvas stays, in view mode, under the reader's bar (`board-role`, role
//   "lost"; "Another window took over this board. View only."), the rest of the window stays, and "Edit here" takes the board back: the canvas
//   is editable again, with the stored drawing. (Headless-board W12: a board opens as a reader's; the window writes only after the button.)
//   The phone (B1) has no reader's bar: a window that lost the board says so in a toast (`toast`, data-kind `board-lost`, "Another window took
//   over this board" with the action `toast-action` Edit here), and "Edit here" is the bottom row's button `board-take`, which is gone once the
//   board is taken back (the writer's sign there; no "Editing" mark either: boarddraw.mjs). The canvas stays in view mode as before. An archived
//   board's note is the bar's state word `state-word` (data-word `archived`, "Archived · read-only") in place of `archived-note`.
// And, from the sweep (rows of area D that were true and not shown): the stage is covered, with no canvas of any board, while the scene is read,
// and a read that fails says why (D-BD-03); an archived board opens read-only, with its note, and is not asked for (D-BD-10), and when it is
// unarchived under the open screen it is asked for and the canvas is editable (D-BD-11); a drawing is undone and redone by Excalidraw's own
// buttons at every viewport and by ⌘Z / ⌘⇧Z where there is a keyboard (D-BD-13).
import { callMatcher, callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { back, byTid, openBoard, openChat, press, tidSel } from "./sel.mjs";
import { drawer, editHere, LIVE } from "./boarddraw.mjs";

export const viewports = ["desktop", "tablet", "phone"];

await check("L5 leaving a board writes it; a board taken by another window shows the reader's bar and is taken back with Edit here", async ({ url, open, fail, note, touch, viewport }) => {
  const phone = viewport === "phone";
  await seed(url, "A2");
  const stored = () => mockEval("return scenes.b_ui.scene.elements.filter((e) => !e.isDeleted).length;", url);
  const ready = tidSel("board-canvas", { board: "b_ui", state: "ready" });

  // ---- leaving a board writes it
  {
    const { page, ctx } = await open({ sel: { board: "b_ui", chat: null }, wait: ready });
    if (await byTid(page, "board-editing").count() || await page.locator(LIVE).count()) fail("a board that was opened is the window's to write before the button was pressed");
    await editHere(page);
    const before = await stored();
    await drawer(page)();
    // (left at once: the view tells its change after 250 ms and the board is written 500 ms later; neither has passed)
    // (a DOM click, so that no wait of the driver lets the autosave win: the control is pressed within a few milliseconds of the shape)
    const row = byTid(page, "side-row", { kind: "chat", key: "c_plain" }).first(), backButton = byTid(page, "nav-back").last();
    const pre = await stored();
    if (await backButton.isVisible()) await backButton.evaluate((el) => el.click()); else await row.evaluate((el) => el.click());
    if (pre !== before) note("(the board was written before it was left: the leave's own write is not what this run shows)");
    if (!await until(async () => (await stored()) === before + 1, 15000)) fail(`the board was left right after a shape was drawn, and the server has ${await stored()} shapes, not ${before + 1}`);
    if (await byTid(page, "board-canvas", { board: "b_ui" }).count() && (await page.evaluate(() => JSON.parse(localStorage.getItem("aiwb.sel") ?? "{}"))).board === "b_ui") fail("the board is still the selection after it was left");
    await ctx.close(); // (the mock has one stream: two pages open take it from each other)
  }

  // ---- taken by another window, and taken back
  {
    await seed(url, "A2");
    const { page, ctx } = await open({ sel: { board: "b_ui", chat: null }, wait: ready });
    await editHere(page);
    const calls = callsOf(page);
    const takes = () => calls.filter((c) => c.method === "POST" && /\/boards\/b_ui\/take/.test(c.path)).length;
    await mockEval('writer("b_ui", "window");', url); // (the server's word for another window taking the board: `superseded`; who writes stays a window)
    const bar = byTid(page, "board-role"), toast = byTid(page, "toast", { kind: "board-lost" });
    const said = phone ? toast : bar;
    if (!await until(() => said.count(), 10000)) return fail(phone ? "the window that lost the board shows no toast that another window took it" : "the window that lost the board shows no reader's bar");
    if (phone) {
      if (!await byTid(page, "toast-action").first().textContent().then((t) => /Edit here/.test(t ?? ""), () => false)) fail("the toast of the lost board has no Edit here action");
    } else if (await bar.first().getAttribute("data-role") !== "lost") fail(`the bar's role is ${await bar.first().getAttribute("data-role")}, not lost`);
    if (!await until(async () => !(await page.locator(LIVE).count()), 10000)) fail("the canvas can still be drawn on after the board went to another window");
    if (!await page.locator(".excalidraw").count()) fail("the canvas went away when the board went to another window (it stays, in view mode)");
    if (!(await said.first().textContent())?.includes(phone ? "Another window took over this board" : "Another window took over this board. View only.")) fail(`the ${phone ? "toast" : "bar"} says "${await said.first().textContent()}"`);
    if (!await byTid(page, "board-bar").count()) fail("the board's bar went with its canvas");
    if (await byTid(page, "board-editing").count()) fail('the "Editing" mark stays after the board was lost');
    const before = takes();
    await press(page, byTid(page, "board-take").first());
    if (!await until(() => page.locator(`${ready} ${LIVE}`).count(), 15000)) fail('"Edit here" did not bring the canvas back, editable');
    if (takes() <= before) fail('"Edit here" did not ask the server for the board');
    if (phone ? await byTid(page, "board-take").count() : await bar.count()) fail(phone ? "the Edit here button stays after the board was taken back" : "the bar stays after the board was taken back");
    await ctx.close();
  }

  // ---- while the scene is read the stage is covered and shows no canvas of any board; a read that fails says why (D-BD-03)
  {
    const SCENE = callMatcher(/^GET .*\/boards\/b_ui\/scene/);
    await seed(url, "A2");
    const { page, ctx } = await open({ sel: { chat: "c_plain" }, wait: tidSel("chat-head") });
    let release = null, held = 0;
    await page.route(SCENE, async (route) => { held++; await new Promise((ok) => { release = ok; }); await route.continue(); });
    await openBoard(page, "b_ui");
    if (!await until(() => held === 1, 10000)) return fail("opening the board did not read its scene");
    const stage = byTid(page, "board-canvas", { board: "b_ui" });
    if (await stage.getAttribute("data-state") !== "loading") fail(`while the scene is read the board's state is ${await stage.getAttribute("data-state")}, not loading`);
    if (!await byTid(page, "canvas-empty").count()) fail("while the scene is read nothing covers the stage (canvas-empty)");
    if (await page.locator(".excalidraw").count()) fail("while the scene is read the stage shows a canvas");
    release();
    if (!await until(() => page.locator(`${ready} .excalidraw canvas.interactive`).count(), 15000)) fail("the board did not draw (in view mode, as a reader's) once its scene was read");
    if (await byTid(page, "canvas-empty").count()) fail("the cover stays over the board once it has drawn");
    await page.unroute(SCENE);
    await ctx.close(); // (the mock has one stream: two pages open take it from each other)

    // the read is refused: the cover says why, and no canvas is drawn
    await seed(url, "A2");
    const q = await open({ sel: { chat: "c_plain" }, wait: tidSel("chat-head") });
    await q.page.route(SCENE, (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "the drawing cannot be read", code: "broken" }) }));
    await openBoard(q.page, "b_ui");
    if (!await until(() => byTid(q.page, "canvas-error").count(), 15000)) return fail("a scene that cannot be read shows no reason (canvas-error)");
    const said = (await byTid(q.page, "canvas-error").first().textContent())?.trim();
    if (said !== "Couldn't open this board: the drawing cannot be read") fail(`a scene that cannot be read says "${said}"`);
    if (await byTid(q.page, "board-canvas", { board: "b_ui" }).getAttribute("data-state") !== "error") fail("a scene that cannot be read leaves the board's state other than error");
    if (await q.page.locator(".excalidraw").count()) fail("a scene that cannot be read shows a canvas");
    await q.ctx.close();
  }

  // ---- an archived board opens read-only and is not asked for; unarchived under the open screen it is asked for and drawn on (D-BD-10, D-BD-11)
  {
    await seed(url, "A2");
    await mockEval('boards.b_ui.archived = true; boards.b_ui.archiveOp = "op_l5"; return 1;', url);
    const { page, ctx } = await open({ sel: { board: "b_ui", chat: null }, wait: ready });
    const held = () => mockEval('return heldBoards.has("b_ui");', url); // (the server's word: a take made while the page loaded is in it too)
    // (the phone's bar says it with its state word)
    const archivedMark = phone ? byTid(page, "state-word", { word: "archived" }) : byTid(page, "archived-note");
    if (!await until(() => archivedMark.count(), 10000)) return fail("an archived board's bar has no note that it is read-only");
    const note = (await archivedMark.first().textContent())?.trim();
    if (note !== (phone ? "Archived · read-only" : "Archived — read-only")) fail(`the archived board's note says "${note}"`);
    if (!await until(() => page.locator(".excalidraw.excalidraw--view-mode canvas.interactive").count(), 15000)) fail("an archived board's canvas is not in view mode");
    if (await page.locator(LIVE).count()) fail("an archived board's canvas is editable");
    await page.waitForTimeout(800); // (a take, if one were to be made, is made as the screen settles)
    if (await held()) fail("an archived board was asked for: the server holds it for this window");
    // unarchived by another window: this one asks for the board, and it is drawn on
    await mockEval('delete boards.b_ui.archived; delete boards.b_ui.archiveOp; send({ type: "board", board: boards.b_ui }); return 1;', url);
    if (!await until(() => byTid(page, "board-take").count(), 10000)) return fail("the board was unarchived under the open screen and its bar offers no Edit here");
    await page.waitForTimeout(500);
    if (await held()) fail("the board was unarchived under the open screen and the window took it by itself");
    await editHere(page);
    if (!await held()) fail("Edit here on the unarchived board did not ask the server for it");
    if (await archivedMark.count()) fail("the archived note stays after the board was unarchived");
    await ctx.close();
  }

  // ---- a drawing is undone and redone (D-BD-13): by Excalidraw's own buttons everywhere, by the keys where there is a keyboard
  {
    await seed(url, "A2");
    const { page, ctx } = await open({ sel: { board: "b_ui", chat: null }, wait: ready });
    await editHere(page);
    const draw = drawer(page);
    const shapes = stored;
    const base = await shapes();
    await draw();
    if (!await until(async () => await shapes() === base + 1, 15000)) return fail(`a drawn shape was not stored (${await shapes()} shapes, not ${base + 1})`);
    // (the keys first, straight after the drawing: a click on the canvas is a step of Excalidraw's history of its own, the selection it clears)
    if (!touch) {
      await page.keyboard.press("ControlOrMeta+z");
      if (!await until(async () => await shapes() === base, 15000)) fail(`⌘Z did not take the drawn shape away (${await shapes()} shapes, not ${base})`);
      await page.keyboard.press("ControlOrMeta+Shift+z");
      if (!await until(async () => await shapes() === base + 1, 15000)) fail(`⌘⇧Z did not bring the shape back (${await shapes()} shapes, not ${base + 1})`);
    }
    const undo = page.locator('.excalidraw button[aria-label="Undo"]').first(), redo = page.locator('.excalidraw button[aria-label="Redo"]').first();
    if (!await undo.count()) return fail("the canvas has no Undo button");
    await press(page, undo);
    if (!await until(async () => await shapes() === base, 15000)) fail(`Undo did not take the drawn shape away (${await shapes()} shapes, not ${base})`);
    await press(page, redo);
    if (!await until(async () => await shapes() === base + 1, 15000)) fail(`Redo did not bring the shape back (${await shapes()} shapes, not ${base + 1})`);
    if (!await byTid(page, "board-canvas").count()) fail("the board went away with the undo");
    await ctx.close();
  }
  note("a shape drawn and the board left at once was written; the board that went to another window showed the reader's bar over its canvas, and \"Edit here\" brought the editable canvas back; "
    + "the stage was covered while the scene was read and said why it could not be; an archived board opened read-only and was drawn on once unarchived and taken with the button; undo and redo");
}, { viewports, page: false });
