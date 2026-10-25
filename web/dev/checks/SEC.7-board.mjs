// Proves what an open board does when its server drops, and when it is back (plans/remote-server-sections-goal.md, 3.8 and 3.9; the contract's
// 3.6 and 3.10): a board that is open and held can still be drawn on, under the banner that it is not saved; back at the revision the page has,
// the drawing is saved there; back at another one (the board was changed there meanwhile), it is dropped with the notice, and that server's drawing
// is the one shown; the section's rows are gone while its server is away. Ports the board part of dev/checks/SEC.7-drop.mjs (B4) to the new
// build, at all three viewports; the chat parts of the old check are in SEC.7-drop.mjs. Deviations: the drawing is made by the viewport's
// pointer (a mouse on the desktop, a finger on a touch viewport: boarddraw.mjs); the banner and the note are read by their testIDs.
// From the sweep (rows of area D that were true and not shown): the note's × hides it (D-RB-06); a board whose scene the server answers 503 shows the
// view that says it is not connected, and its "Servers…" opens the dialog (D-RB-02); the box beside the board's chat, read-only while the server is away,
// takes no chip from ⌘L and no wait for a point from ⌘⇧L (D-RB-12).
// The phone (B1) has no reader's bar and no note over the canvas: "Edit here" is the bottom row's `board-take` (the writer's sign there is that the
// button is gone: boarddraw.mjs), the note of a dropped change is a toast (`toast`, data-kind `board-dropped`, which goes by itself after 8 s, so it has no ×:
// "the × hides it" is read as "it is gone within its time"), and the board's chat beside it is the screen over the board, reached by the bar's Chats
// button and a row of the Chats sheet (`board-chats`, `chats-row`).
// At the phone (B2) the board's chat has no selection or point button in its context row (the selection rule): the board's rows are the "+" sheet's `selection`
// ("Add selection") and `point` ("Point at"), which are on while the server is connected and dimmed (or the "+" off) while it is away.
import { callMatcher, callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { act, back as stackBack, byTid, openBoard, press, tidSel } from "./sel.mjs";
import { homeOf, sideSeen } from "./side.mjs";
// Added in the sweep (rn-sw-webtest), from web/test/sectionviews.test.ts "a section's board whose server is away and which this window keeps no drawing of says that it
// opens when the server is back; one deleted there says so" (A-ST-08), which nothing in the browser proved on the new build: the view in the canvas's place (`board-off`).
import { drawer, editHere, LIVE } from "./boarddraw.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const J = JSON.stringify;
const STUDIO = "s_studio";

await check("SEC.7 a board that is open when its server drops, and when it is back", async ({ url, open, fail, note, viewport, layout }) => {
  const drop = () => mockEval(`setServerState("${STUDIO}", "unreachable", { detail: "connection refused" });`, url);
  const back = (first = "") => mockEval(`${first}; setServerState("${STUDIO}", "connected");`, url);
  const there = (code) => mockEval(`return onServer("${STUDIO}", () => { ${code} });`, url);
  await seed(url, "SEC");
  const { page, ctx } = await open({ sel: { board: `${STUDIO}~b_loose`, chat: null } });
  const calls = callsOf(page);
  const on = (re, method) => calls.filter((c) => c.server === STUDIO && re.test(c.path) && (!method || c.method === method));
  const phone = viewport === "phone";
  const text = (id, data) => byTid(page, id, data).first().textContent({ timeout: 2000 }).catch(() => "");
  const says = async (name, id, want, data) => { if (!await until(async () => (await text(id, data)).includes(want), 10000)) fail(`${name}: ${id} says "${await text(id, data)}", not "${want}"`); };
  // the note of a dropped change: the reader bar's line (`board-role-dropped`) and the held canvas's note (`canvas-note`) on the wide layouts, the toast on the phone
  const [readerNote, heldNote] = phone ? [["toast", { kind: "board-dropped" }], ["toast", { kind: "board-dropped" }]] : [["board-role-dropped"], ["canvas-note"]];
  const noRows = async (name) => {
    // (the phone, package H1: Home, under the board in the stack, shows the server it showed last; Studio Mac's chip, or its Home's problem
    // card, says that it is not connected: what Home lists then is SEC.2's phone half)
    if (layout === "phone") {
      const away = (h) => (h.server === STUDIO ? h.state === "trouble" && h.card?.server === STUDIO : h.chips.find((c) => c.server === STUDIO)?.word === "unreachable");
      if (!await until(async () => away(await homeOf(page)), 10000)) fail(`${name}: Home under the board does not say that Studio Mac is not connected: ${J(await homeOf(page))}`);
      return;
    }
    if (!await until(async () => !(await sideSeen(page, STUDIO)).outline.length, 10000)) fail(`${name}: the section still has rows: ${J((await sideSeen(page, STUDIO)).outline)}`);
  };
  const none = async (id) => until(async () => !(await byTid(page, id).count()), 10000);

  await editHere(page); // (a board opens as a reader's: the button makes the window its writer)
  const saves = () => on(/\/boards\/b_loose\/scene\?/, "PUT");
  const count = () => there("return scenes.b_loose.scene.elements.filter((e) => !e.isDeleted).length;");
  const draw = drawer(page);
  const rev0 = await there("return scenes.b_loose.rev;");
  await draw();
  if (!await until(() => saves().some((c) => c.status === 200 && c.path.endsWith(`rev=${rev0}`)), 15000)) fail(`a drawing on the section's board was not saved there on the revision ${rev0}: ${J(saves().map((c) => [c.path, c.status]))}`);
  if (await count() !== 2) fail(`Studio Mac has ${await count()} shapes after one was drawn, not 2`);
  await drop();
  await noRows("a board, its server dropped");
  await draw();
  await says("a board drawn on while its server is away", "save-banner", "Not saved, Studio Mac unreachable");
  if (!await page.locator(LIVE).count() || await byTid(page, "board-off").count() || await byTid(page, "board-role").count()) fail("the open board cannot be drawn on while its server is away");
  await draw();
  if (!await until(() => saves().filter((c) => c.status === 503).length >= 1, 10000)) fail("no save of the board was answered 503 during the outage");
  if (await count() !== 2) fail("Studio Mac got a drawing while it was not connected");
  if (!await byTid(page, "save-banner").count()) fail("the banner went while the server is still away");
  // back, at the revision the page has: the drawing is saved there
  const at = saves().length;
  await back();
  // (the reconnection takes a moment: until the new stream's first scene the canvas is still the writer's, with no button, and Edit here would be a no-op)
  if (!await byTid(page, "board-take").first().waitFor({ state: "visible", timeout: 15000 }).then(() => true, () => false)) fail("back, the window holding an unsaved drawing shows no Edit here");
  await editHere(page); // (the new stream holds nothing: the window is a reader, with its unsaved drawing kept; the button saves it where it was made)
  if (!await until(async () => await count() === 4, 15000)) fail(`back at the same revision, the board's drawing was not saved: Studio Mac has ${await count()} shapes, not 4; the saves: ${J(saves().slice(at).map((c) => [c.path, c.status]))}`);
  if (!await none("save-banner")) fail("back and saved, the banner stays");
  if (saves().slice(at).some((c) => c.status !== 200 && c.status !== undefined)) fail(`back at the same revision, a save was refused: ${J(saves().slice(at).map((c) => [c.path, c.status]))}`);
  if (await byTid(page, ...heldNote).count()) fail("back at the same revision, the page says that changes were dropped");
  // back, at another revision: the drawing is dropped with the notice
  await drop();
  await draw();
  await says("the board drawn on, its server away again", "save-banner", "Not saved, Studio Mac unreachable");
  const other = { type: "excalidraw", version: 2, elements: [{ id: "sec_other", type: "ellipse", x: 200, y: 160, width: 140, height: 90 }], appState: {}, files: {} };
  await back(`onServer("${STUDIO}", () => { scenes.b_loose.scene = ${J(other)}; scenes.b_loose.rev += 5; })`);
  // (the window came back as a reader: the note is the reader bar's, with the words of a dropped change; the outage's own sentence belongs to the note on a held canvas)
  await says("a board changed there while its server was away", readerNote[0], "A change made here was not saved in time and was dropped.", readerNote[1]);
  if (!await none("save-banner")) fail("the edit dropped, the banner stays");
  if (!phone && await byTid(page, "canvas-note").count()) fail("the canvas of a reader shows the note of a held one");
  if (J(await there("return scenes.b_loose.scene.elements.map((e) => e.id);")) !== J(["sec_other"])) fail(`the drawing made during the outage replaced the one made there: ${J(await there("return scenes.b_loose.scene.elements.map((e) => e.id);"))}`);
  if (!await page.locator(".excalidraw").count() || !await byTid(page, "board-take").count()) fail("after the dropped edit the board is not shown to a reader with its button");
  // the button takes the board again at the stored scene, and the reader bar's note goes with the press (the phone said it once, as a toast)
  await editHere(page);
  if (!await until(async () => !(await byTid(page, ...readerNote).count()), 12000)) fail("the dropped note stays after Edit here");
  // a held canvas's note: a save refused as stale (the board was saved elsewhere meanwhile) drops the edit with the note, and its × hides it (D-RB-06)
  await there("return othersave('b_loose', [])");
  await draw();
  await says("a drawing refused as stale", heldNote[0], "A change made here was not saved in time and was dropped.", heldNote[1]);
  if (!phone) await press(page, byTid(page, "canvas-note-hide").first()); // (the phone's toast has no ×: it goes by itself)
  if (!await until(async () => !(await byTid(page, ...heldNote).count()), 12000)) fail(phone ? "the toast of the dropped change stays" : "the × of the note does not hide it");
  if (!await page.locator(".excalidraw").count()) fail("hiding the note took the canvas away");
  if (calls.some((c) => c.server === "local" && /^\/api\/boards\//.test(c.path))) fail("a call for the section's board went to this computer's routes");
  await ctx.close(); // (the mock has one stream: two pages open take it from each other)

  // ---- the server is connected and answers the board's scene 503: the view that says it is not connected, with "Servers…" (D-RB-02)
  {
    await seed(url, "SEC");
    const q = await open({ sel: { board: `${STUDIO}~b_loose`, chat: null } });
    await q.page.route(callMatcher(/^GET .*\/boards\/b_loose\/scene/, STUDIO), (route) => route.fulfill({ status: 503, contentType: "application/json", body: J({ error: "Studio Mac is not connected", code: "server_unreachable" }) }));
    await q.page.reload();
    const off = byTid(q.page, "board-off", { view: "unreachable" });
    if (!await until(() => off.count(), 20000)) fail(`a scene read answered 503 shows no view that the server is not connected (the board is "${await byTid(q.page, "board-canvas").first().getAttribute("data-state").catch(() => null)}")`);
    else {
      const said = ((await off.first().textContent()) ?? "").replace(/\s+/g, " ");
      if (!said.includes("Studio Mac is not connected") || !said.includes("It opens when the server is connected again.")) fail(`the view of a board whose server is away says "${said}"`);
      if (await byTid(q.page, "board-canvas").first().getAttribute("data-state") !== "off") fail("the board's state is not off while its view says the server is not connected");
      if (await q.page.locator(".excalidraw").count()) fail("a canvas is drawn under the view that says the server is not connected");
      await press(q.page, byTid(q.page, "board-off-servers").first());
      // (the phone: S2's list, a screen pushed over the board, left by the stack's back; the wide layouts: the dialog, left by Esc)
      const servers = byTid(q.page, layout === "phone" ? "srv-list" : "servers-dialog");
      if (!await until(() => servers.count(), 10000)) fail(`"Servers…" in the view of a board whose server is away does not open ${layout === "phone" ? "the Servers list" : "the Servers dialog"}`);
      if (layout === "phone") await stackBack(q.page); else await q.page.keyboard.press("Escape");
      if (!await until(async () => !(await servers.count()), 10000)) fail(`${layout === "phone" ? "Back does not leave the Servers list" : "Esc does not close the Servers dialog"}`);
    }
    await q.ctx.close();
  }

  // ---- the box beside the board's chat is read-only while its server is away: ⌘L puts no chip in it, ⌘⇧L waits for no point (D-RB-12)
  {
    await seed(url, "SEC");
    const KEY = `${STUDIO}~c_on_floor`;
    const q = await open({ sel: { board: `${STUDIO}~b_loose`, chat: null } });
    await editHere(q.page);
    await act(q.page, "select");
    await press(q.page, byTid(q.page, "board-chats").first()); // (the chat beside the board; on the phone the Chats button opens the sheet, a row of which opens the chat's screen over the board)
    if (phone) await press(q.page, byTid(q.page, "chats-row").first());
    const chips = () => byTid(q.page, "composer-input").locator(tidSel("ref-chip")).allTextContents();
    const picking = () => byTid(q.page, "pick-layer").count().then((n) => n > 0);
    const keys = viewport !== "phone"; // (the tablet has a hardware keyboard, as P7.4-board has it; the phone has none)
    // (the phone has no such buttons in the context row (B2: the selection rule); the board's rows are the "+" sheet's `selection` and `point`: on while the
    // server is connected, dimmed with a reason while it is away)
    const plusRows = async () => {
      const plus = byTid(q.page, "composer-plus").first();
      // (V1: while the server is away the block replaces the toolbar, so the "+" may go between two reads: a "+" gone is one that takes nothing)
      const off = () => plus.isDisabled({ timeout: 3000 }).catch(() => true);
      if (!await plus.count() || await off()) return []; // (a box that takes nothing: the "+" is off or gone)
      if (!await plus.tap({ timeout: 3000 }).then(() => true, () => false)) return await off() ? [] : null; // (the box went read-only meanwhile)
      if (!await until(() => byTid(q.page, "plus-sheet").count(), 10000)) return null;
      const rows = await q.page.evaluate(() => [...document.querySelectorAll('[data-testid="plus-sheet"] [data-testid="action-row"]')].filter((e) => ["selection", "point"].includes(e.dataset.action)).map((e) => ({ action: e.dataset.action, dimmed: e.getAttribute("aria-disabled") === "true" || getComputedStyle(e).opacity < 1 || e.querySelector('[aria-disabled="true"]') !== null })));
      await q.page.keyboard.press("Escape");
      await until(async () => !await byTid(q.page, "plus-sheet").count(), 5000);
      return rows;
    };
    if (phone) {
      await q.page.waitForSelector(tidSel("composer-input"), { timeout: 15000 });
      const rows = await plusRows();
      if (rows?.length !== 2 || rows.some((r) => r.dimmed)) return fail(`the board's chat has no on "+" rows for the selection and the point while its server is connected: ${J(rows)}`);
    } else
    if (!await until(() => byTid(q.page, "ctx-act", { kind: "selection" }).count(), 15000)) return fail("the board's chat beside it has no button for the selection while its server is connected");
    if (keys) {
      await q.page.keyboard.press("ControlOrMeta+Shift+l");
      if (!await until(picking, 5000)) fail("⌘⇧L waits for no point while the server is connected: the proof of the next lines is of no use");
      await q.page.keyboard.press("Escape");
      await until(async () => !(await picking()), 5000);
    }
    await mockEval(`setServerState("${STUDIO}", "unreachable", { detail: "connection refused" });`, url);
    if (phone) {
      const off = await until(async () => { const rows = await plusRows(); return !rows || rows.length === 0 || rows.every((r) => r.dimmed) ? true : null; }, 15000);
      if (!off) fail("the board's chat still offers its \"+\" rows for the selection and the point while its server is away");
    } else
    if (!await until(async () => !(await byTid(q.page, "ctx-act").count()), 15000)) fail("the board's chat still offers its buttons for the selection and the point while its server is away");
    if (keys) {
      await q.page.keyboard.press("ControlOrMeta+l");
      await q.page.keyboard.press("ControlOrMeta+Shift+l");
      await q.page.waitForTimeout(500);
      if ((await chips()).length) fail(`⌘L with a selection put ${J(await chips())} in the read-only box`);
      if (await picking()) fail("⌘⇧L waits for a point while the box is read-only: the chip would have no box to go into");
    }
    if (!await byTid(q.page, "board-canvas", { state: "ready" }).count()) fail("the board went away with its server: it stays open, to be drawn on");
    void KEY;
    await q.ctx.close();
  }

  // ---- a board of the section whose drawing this window has not read when its server drops: the view in the canvas's place says that it opens when the server
  // is connected again (a board that was drawn on is kept in this window, and shows as above); back, it opens; deleted there, it says that it is no longer there
  {
    await seed(url, "SEC"); // (the block above left Studio Mac away)
    const cold = await open({});
    const held = [];
    await cold.page.route((u) => u.pathname === "/host/call" && /\/boards\/b_arch\/scene/.test(u.searchParams.get("path") ?? ""), (route) => { held.push(route); });
    await openBoard(cold.page, `${STUDIO}~b_arch`);
    if (!await until(() => held.length > 0, 15000)) fail("opening a board of the section did not ask its server for the drawing");
    await drop();
    for (const route of held.splice(0)) await route.continue().catch(() => {});
    const off = byTid(cold.page, "board-off").first();
    if (!await until(async () => await off.count() > 0 && await off.getAttribute("data-view") === "unreachable", 15000)) fail("a board whose drawing was never read, its server away, has no view of the kind unreachable in the canvas's place");
    else {
      const said = await off.textContent();
      if (!said.includes("Studio Mac is not connected") || !said.includes("It opens when the server is connected again.")) fail(`the view of a board whose server is away says "${said}"`);
      if (!await byTid(cold.page, "board-off-servers").count()) fail("the view of a board whose server is away has no Servers…");
    }
    await mockEval(`setServerState("${STUDIO}", "connected");`, url);
    if (!await until(async () => await byTid(cold.page, "board-canvas").count() > 0 && !await off.count(), 20000)) fail("back, the board whose drawing was never read does not open (its view is still in the canvas's place)");
    await mockEval(`await elsewhere("${STUDIO}", "DELETE", "/boards/b_arch");`, url);
    if (!await until(async () => await off.count() > 0 && await off.getAttribute("data-view") === "gone", 15000)) fail("a board deleted on its server while it is open has no view of the kind gone in the canvas's place");
    else if (!(await off.textContent()).includes("No longer on Studio Mac")) fail(`the view of a board that is no longer on its server says "${await off.textContent()}"`);
    if (await byTid(cold.page, "board-off-servers").count()) fail("the view of a board that is no longer on its server offers Servers…");
    await cold.ctx.close();
  }
  note("a board drawn on under the banner while its server is away, saved at the same revision and dropped at another, with the notice and its ×; a scene read answered 503 shows the view with Servers…; the read-only box takes no chip and no point; a board never read: its view while the server is away and when it is gone");
}, { viewports, page: false, allowConsole: [/^saving board /] }); // (a failed save is logged by the board side: the outage is what the check makes)
