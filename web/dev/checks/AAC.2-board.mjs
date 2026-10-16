// Proves what an open board of this computer does when this computer's server drops, and when it is back (app-as-client-goal.md, 3.3, 4.4: "a
// server that stops while the app is open"; plan C7), as SEC.7-board.mjs does for a remote server's section: a board that is open and held can
// still be drawn on, under the banner that it is not saved; back at the revision the page has, the drawing is saved; at another one it is dropped
// with the notice; a board that was never loaded here is not opened while the server is away, and opens when it is back. The page is not loaded
// again by any of it. Ports the board parts of dev/checks/AAC.2-localdown.mjs (B4, S1) to the new build, at all three viewports; the chat parts are
// the chat view's (S4, AAC.2-localdown.mjs). Deviations: the drawing is made by the viewport's pointer (boarddraw.mjs); the banner and the note
// are read by their testIDs; the board that was never loaded is opened by the sidebar's row (`openBoard` of sel.mjs). This computer's rows are
// gone while it is away (read in the sidebar where it stands: on the phone it is the stack's first screen).
import { callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { byTid, openBoard } from "./sel.mjs";
import { drawer, editHere, LIVE } from "./boarddraw.mjs";
import { sideSeen } from "./side.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const J = JSON.stringify;

await check("AAC.2 a board of this computer that is open when its server drops, and when it is back", async ({ url, open, fail, note }) => {
  const drop = () => mockEval('setServerState("local", "unreachable", { detail: "connection refused" });', url);
  const back = (first = "") => mockEval(`${first}; setServerState("local", "connected");`, url);
  const here = (code) => mockEval(`return onServer("local", () => { ${code} });`, url);
  const start = async (sel) => {
    await seed(url, "A1", "SEC");
    const p = await open({ sel });
    p.calls = callsOf(p.page);
    p.on = (re, method) => p.calls.filter((c) => c.server === "local" && re.test(c.path) && (!method || c.method === method));
    await p.page.evaluate(() => { window.__mark = "same page"; });
    return p;
  };
  const text = (page, id) => byTid(page, id).first().textContent({ timeout: 2000 }).catch(() => "");
  const says = async (name, page, id, want) => { if (!await until(async () => (await text(page, id)).includes(want), 10000)) fail(`${name}: ${id} says "${await text(page, id)}", not "${want}"`); };
  const none = (page, id) => until(async () => !(await byTid(page, id).count()), 10000);

  // ---- a board, open and drawn on
  {
    const { page, ctx, on } = await start({ board: "b_ui", chat: null });
    await editHere(page); // (a board opens as a reader's: the button makes the window its writer)
    const saves = () => on(/\/boards\/b_ui\/scene\?/, "PUT");
    const count = () => here("return scenes.b_ui.scene.elements.filter((e) => !e.isDeleted).length;");
    const draw = drawer(page);
    const rev0 = await here("return scenes.b_ui.rev;"), shapes = await count();
    await draw();
    if (!await until(() => saves().some((c) => c.status === 200 && c.path.endsWith(`rev=${rev0}`)), 15000)) fail(`a drawing on this computer's board was not saved on the revision ${rev0}: ${J(saves().map((c) => [c.path, c.status]))}`);
    if (await count() !== shapes + 1) fail(`this computer has ${await count()} shapes after one was drawn, not ${shapes + 1}`);
    await drop();
    await draw();
    await says("a board drawn on while its server is away", page, "save-banner", "Not saved, This computer unreachable");
    if (!await page.locator(LIVE).count() || await byTid(page, "board-off").count() || await byTid(page, "board-role").count()) fail("the open board cannot be drawn on while its server is away");
    await draw();
    if (!await until(() => saves().filter((c) => c.status === 503).length >= 1, 10000)) fail("no save of the board was answered 503 during the outage");
    if (await count() !== shapes + 1) fail("this computer got a drawing while it was not connected");
    const at = saves().length;
    await back();
    await editHere(page); // (the new stream holds nothing: the window is a reader, with its unsaved drawing kept; the button saves it where it was made)
    if (!await until(async () => await count() === shapes + 3, 15000)) fail(`back at the same revision, the board's drawing was not saved: ${await count()} shapes, not ${shapes + 3}; the saves: ${J(saves().slice(at).map((c) => [c.path, c.status]))}`);
    if (!await none(page, "save-banner")) fail("back and saved, the banner stays");
    if (await byTid(page, "canvas-note").count()) fail("back at the same revision, the page says that changes were dropped");
    // back, at another revision: the drawing is dropped with the notice
    await drop();
    await draw();
    await says("the board drawn on, its server away again", page, "save-banner", "Not saved, This computer unreachable");
    const other = { type: "excalidraw", version: 2, elements: [{ id: "aac_other", type: "ellipse", x: 200, y: 160, width: 140, height: 90 }], appState: {}, files: {} };
    await back(`scenes.b_ui.scene = ${J(other)}; scenes.b_ui.rev += 5`);
    // (the window came back as a reader: the note is the reader bar's, with the words of a dropped change; the outage's own sentence belongs to the note on a held canvas)
    await says("a board changed while its server was away", page, "board-role-dropped", "A change made here was not saved in time and was dropped.");
    if (!await none(page, "save-banner")) fail("the edit dropped, the banner stays");
    if (J(await here("return scenes.b_ui.scene.elements.map((e) => e.id);")) !== J(["aac_other"])) fail("the drawing made during the outage replaced the one made meanwhile");
    if (!await page.locator(".excalidraw").count() || !await byTid(page, "board-take").count()) fail("after the dropped edit the board is not shown to a reader with its button");
    await editHere(page);
    if (!await none(page, "board-role-dropped")) fail("the dropped note stays after Edit here");
    if (await page.evaluate(() => window.__mark) !== "same page") fail("the page was loaded again");
    await ctx.close();
  }

  // ---- a board that was never loaded here is not opened while the server is away
  {
    const { page, ctx } = await start({});
    await page.waitForSelector('[data-testid="side-row"][data-kind="board"]', { state: "attached", timeout: 20000 });
    await drop();
    if (!await until(async () => !(await sideSeen(page, "local")).outline.length, 10000)) fail("this computer's rows stay while it is away");
    if (await byTid(page, "board-off").count()) fail("a board off screen shows a view for a server that is away");
    await back();
    await openBoard(page, "b_ui", { timeout: 30000 });
    if (!await until(async () => !!(await page.locator('.excalidraw, [data-testid="board-off"]').count()), 15000)) fail("back, the board does not open");
    if (await page.locator(LIVE).count()) fail("back, the board opened as the window's to write before the button was pressed");
    await editHere(page);
    await ctx.close();
  }
  note("a board drawn on under the banner naming This computer, saved at the same revision (after Edit here) and dropped at another, with the reader bar's note; the page was not loaded again; a board never loaded opened once the server was back");
}, { viewports, page: false, allowConsole: [/^saving board /] }); // (a failed save is logged by the board side: the outage is what the check makes)
