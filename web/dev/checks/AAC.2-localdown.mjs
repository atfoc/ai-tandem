// Proves what is open when this computer's server drops, and when it is back (app-as-client-goal.md, 3.3, 4.4: "a server that
// stops while the app is open"; plan C7), with another server of the list connected beside it. It goes on from SEC.7, which
// proves the same for a remote server's section: this computer's is a section like it.
// A chat of this computer: the view stays as the page had it, read-only, under the warning that names "This computer"; Send is
// off and says why, and so is the composer; what was typed stays in the box, which takes no more; the section's rows are gone,
// the other section's are not, and a chat of the other section opens and works while this computer is away. Back: the section
// shows the tree again, the thread is level with the server, the warning is gone, Send works, and the typed text is saved by one
// PUT …/draft on the counter the page had. Deleted meanwhile, the view says that it is no longer on this computer. Left during the
// outage, the chat is closed and its unsaved draft stays in the browser, to be saved when the server is back. A board that is open
// and held can still be drawn on, under the banner that it is not saved; back at the revision the page has, the drawing is
// saved; at another one it is dropped with the notice. The page is not loaded again by any of it.
import { callsOf, check, mockEval, openPage, seed, sideSeen, until } from "../shot.mjs";

const J = JSON.stringify;
const STUDIO = "s_studio", AWAY = "This computer is not connected";
const WHY = `${AWAY}: nothing can be sent or changed until it is back.`;

await check("AAC.2 a chat and a board of this computer that are open when its server drops, and when it is back", async ({ url, browser, fail, note }) => {
  const drop = () => mockEval('setServerState("local", "unreachable", { detail: "connection refused" });', url);
  const back = (first = "") => mockEval(`${first}; setServerState("local", "connected");`, url);
  const here = (code) => mockEval(`return onServer("local", () => { ${code} });`, url);
  /** A page on a seed made anew, with the selection given. */
  const open = async (sel) => {
    await seed(url, "A1", "SEC");
    const p = await openPage({ url, browser, sel, size: [1280, 900] });
    p.calls = callsOf(p.page);
    p.on = (re, method) => p.calls.filter((c) => c.server === "local" && re.test(c.path) && (!method || c.method === method));
    p.rows = async (id = "local") => (await sideSeen(p.page, id)).outline;
    p.end = async () => { for (const e of p.errors) fail(`page error: ${e}`); await p.ctx.close(); };
    await p.page.evaluate(() => { window.__mark = "same page"; });
    return p;
  };
  const text = (page, sel) => page.locator(sel).first().textContent({ timeout: 2000 }).catch(() => "");
  const says = async (name, page, sel, want) => { if (!await until(async () => (await text(page, sel)).includes(want), 10000)) fail(`${name}: ${sel} says "${await text(page, sel)}", not "${want}"`); };

  // ---- a chat
  {
    const p = await open({ chat: "c_plain" }), { page } = p, box = page.locator(".composer .composer-input"), send = page.locator(".composer .send:not(.stop)");
    await page.waitForSelector(".thread .msg.user");
    const typed = "half a thought";
    await box.click(); await page.keyboard.type(typed);
    if (!await until(() => p.on(/\/chats\/c_plain\/draft\?/, "PUT").some((c) => c.status === 200), 10000)) fail("what was typed in the chat of this computer was not saved");
    const rows = await p.rows(), studio = await p.rows(STUDIO), thread = await page.locator(".thread .msg").allTextContents();
    if (!rows.length || !studio.length) fail("the seed has no rows in this computer's section or in Studio Mac's");
    // typed just before the drop, and not yet taken by the server: the draft's save waits a moment after the last key, and the connection ends first
    const more = " and more just before", all = typed + more;
    const rev = await here("return chats.c_plain.draftRev;");
    await box.click(); await page.keyboard.press("End"); await page.keyboard.type(more);
    await drop();
    if (!await until(() => p.on(/\/chats\/c_plain\/draft\?/, "PUT").some((c) => c.status === 503), 10000)) fail("the save of what was typed was not refused 503 by the app while the server was away");
    await says("a chat, this computer's server dropped", page, ".remote-bar.off .remote-bar-text", `${AWAY}. This chat is shown as it was when the connection ended.`);
    if (J(await page.locator(".thread .msg").allTextContents()) !== J(thread)) fail("the thread of the open chat changed when its server dropped");
    if (!await send.isDisabled() || await send.getAttribute("title") !== WHY) fail(`Send of a chat whose server dropped is ${await send.isDisabled() ? "off" : "on"} and says "${await send.getAttribute("title")}"`);
    await says("the composer of a chat whose server dropped", page, ".composer .agent-reason", WHY);
    if (await text(page, ".composer .composer-input") !== all) fail(`the box has "${await text(page, ".composer .composer-input")}", not what was typed`);
    if (!await until(async () => !(await p.rows()).length, 10000)) fail(`this computer's section still has rows: ${J(await p.rows())}`);
    if (J(await p.rows(STUDIO)) !== J(studio)) fail(`Studio Mac's section changed when this computer dropped: ${J(await p.rows(STUDIO))}`);
    if ((await sideSeen(page, "local")).state !== "Unreachable") fail(`this computer's head says "${(await sideSeen(page, "local")).state}"`);
    if (!await page.locator(".side-head .icon-btn.new").isDisabled()) fail("the sidebar's + makes things on this computer while it is away");
    if (await page.locator(".composer button.tchip:not(.static):not([disabled])").count()) fail("a choice of the composer is still a choice while the chat's server is not connected");
    if (await box.getAttribute("aria-readonly") !== "true") fail("the box of a chat whose server dropped is not marked read-only");
    const quiet = p.calls.length;
    await box.click({ force: true }).catch(() => {}); await page.keyboard.press("End"); await page.keyboard.type(" never");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(700); // (longer than a draft's save waits)
    if (await text(page, ".composer .composer-input") !== all) fail(`the read-only box took what was typed during the outage: "${await text(page, ".composer .composer-input")}"`);
    if (p.calls.slice(quiet).some((c) => c.method !== "GET")) fail(`a call was made for a chat whose server is not connected: ${J(p.calls.slice(quiet).filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`))}`);
    // the other section works meanwhile: its chat opens, reads from its server and is not read-only
    const studioRow = page.locator(`.side-section[data-server="${STUDIO}"] .side-row:has(.side-name:text-is("Last night's failures"))`);
    await studioRow.click();
    await says("a chat of Studio Mac, this computer away", page, ".chat-head .chat-head-server", "Studio Mac");
    if (!await until(async () => !!(await page.locator(".thread .msg.user").count()) && !(await page.locator(".remote-bar").count()), 10000)) fail("a chat of Studio Mac does not open as usual while this computer is away");
    if (await page.locator(".composer .send:not(.stop)").isDisabled() && (await page.locator(".composer .composer-input").getAttribute("aria-readonly")) === "true") fail("the composer of Studio Mac's chat is read-only because this computer is away");
    if ((await page.evaluate(() => localStorage.getItem("aiwb.sel"))).includes('"c_plain"')) fail("the selection still names the chat of this computer that was left");
    // the draft stays where the browser keeps it, for when the server is back
    const kept = await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith("aiwb.draft.")).map(([k, v]) => [k, v]));
    if (!kept.some(([k, v]) => k.includes("c_plain") && v.includes(more))) fail(`the draft of the chat that was left is not kept: ${J(kept)}`);
    if (await here("return chats.c_plain.draft?.text;") !== typed) fail("this computer's server got the draft whose save never arrived");
    const puts = p.on(/\/chats\/c_plain\/draft\?/, "PUT").length;
    // back: the thread there has grown meanwhile
    await back(`onServer("local", () => { items.c_plain.push({ kind: "user", text: "from the owner" }, say("fine"), { kind: "end" }); versions.c_plain = (versions.c_plain ?? 1) + 1; })`);
    if (!await until(async () => J(await p.rows()) === J(rows), 10000)) fail(`back, this computer's section does not show the tree again: ${J(await p.rows())}`);
    if (!await until(async () => (await sideSeen(page, "local")).state === "Connected", 10000)) fail("back, this computer's head does not say Connected");
    if (!await until(async () => await here("return chats.c_plain.draft?.text;") === all, 10000)) fail(`back, what was typed is not saved: ${J(await here("return chats.c_plain.draft;"))}`);
    await until(() => p.on(/\/chats\/c_plain\/draft\?/, "PUT").slice(puts).some((c) => c.status === 200), 5000);
    const saved = p.on(/\/chats\/c_plain\/draft\?/, "PUT").slice(puts);
    if (saved.length !== 1 || saved[0].status !== 200 || !saved[0].path.includes(`rev=${rev}`) || saved[0].body?.text !== all) fail(`back, the saves were ${J(saved.map((c) => [c.path, c.status, c.body]))}, not one PUT …/draft on the counter ${rev}`);
    if (!await until(async () => !(await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith("aiwb.draft.") && k.includes("c_plain")))), 10000)) fail("back and saved, the browser still keeps the draft");
    // the chat opened again: level with its server
    await page.locator('.side-section[data-server="local"] .side-row:has(.side-name)').filter({ hasText: "build slow" }).first().click();
    if (!await until(async () => (await page.locator(".thread .msg").allTextContents()).some((t) => t.includes("from the owner")), 10000)) fail("back, the chat is not level with its server: the message made there meanwhile is missing");
    if (await page.locator(".remote-bar").count()) fail("back, the warning stays");
    if (await page.evaluate(() => window.__mark) !== "same page") fail("the page was loaded again");
    await p.end();
  }

  // ---- a chat that is deleted while its server is away, and one that is not
  {
    const p = await open({ chat: "c_plain" }), { page } = p, send = page.locator(".composer .send:not(.stop)");
    await page.waitForSelector(".thread .msg.user");
    await drop();
    await says("the chat, dropped", page, ".remote-bar.off", AWAY);
    await back('await elsewhere("local", "DELETE", "/chats/c_plain")');
    await says("a chat deleted while its server was away", page, ".remote-bar.gone .remote-bar-text", "This chat is no longer on This computer.");
    if (!await send.isDisabled()) fail("Send is on for a chat that was deleted while its server was away");
    if ((await p.rows()).some((l) => l.includes("build slow"))) fail("the chat deleted meanwhile has a row again");
    if (!await until(async () => (await sideSeen(page, "local")).state === "Connected" && (await p.rows()).length > 0, 10000)) fail("this computer's section is not whole again");
    // left, it goes
    await page.locator(`.side-section[data-server="${STUDIO}"] .side-row`).first().click();
    if (await page.locator(".remote-bar.gone").count()) fail("after another chat was opened, the view of the chat that was gone stays");
    await p.end();
  }

  // ---- a board, open and drawn on
  {
    const p = await open({ board: "b_ui", chat: null }), { page } = p;
    const live = ".excalidraw:not(.excalidraw--view-mode) canvas.interactive";
    await page.waitForSelector(live, { timeout: 15000 });
    const saves = () => p.on(/\/boards\/b_ui\/scene\?/, "PUT");
    const count = () => here("return scenes.b_ui.scene.elements.filter((e) => !e.isDeleted).length;");
    let drawn = 0;
    /** Draws one more rectangle on the canvas, by the tool's key and a drag. */
    const draw = async () => {
      const b = await page.locator(live).boundingBox(), x = b.x + 420 + (drawn % 3) * 110, y = b.y + 400 + Math.floor(drawn / 3) * 110;
      drawn++;
      await page.mouse.click(b.x + 200, b.y + b.height - 150);
      await page.keyboard.press("r");
      await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 40, y + 30, { steps: 4 }); await page.mouse.move(x + 80, y + 60, { steps: 4 }); await page.mouse.up();
    };
    const rev0 = await here("return scenes.b_ui.rev;"), shapes = await count();
    await draw();
    if (!await until(() => saves().some((c) => c.status === 200 && c.path.endsWith(`rev=${rev0}`)), 15000)) fail(`a drawing on this computer's board was not saved on the revision ${rev0}: ${J(saves().map((c) => [c.path, c.status]))}`);
    if (await count() !== shapes + 1) fail(`this computer has ${await count()} shapes after one was drawn, not ${shapes + 1}`);
    await drop();
    await draw();
    await says("a board drawn on while its server is away", page, ".canvas .save-banner", "Not saved, This computer unreachable");
    if (!await page.locator(live).count() || await page.locator(".board-off, .takeover").count()) fail("the open board cannot be drawn on while its server is away");
    await draw();
    if (!await until(() => saves().filter((c) => c.status === 503).length >= 1, 10000)) fail("no save of the board was answered 503 during the outage");
    if (await count() !== shapes + 1) fail("this computer got a drawing while it was not connected");
    const at = saves().length;
    await back();
    if (!await until(async () => await count() === shapes + 3, 15000)) fail(`back at the same revision, the board's drawing was not saved: ${await count()} shapes, not ${shapes + 3}; the saves: ${J(saves().slice(at).map((c) => [c.path, c.status]))}`);
    if (!await until(async () => !await page.locator(".canvas .save-banner").count(), 10000)) fail("back and saved, the banner stays");
    if (await page.locator(".canvas .canvas-note").count()) fail("back at the same revision, the page says that changes were dropped");
    // back, at another revision: the drawing is dropped with the notice
    await drop();
    await draw();
    await says("the board drawn on, its server away again", page, ".canvas .save-banner", "Not saved, This computer unreachable");
    const other = { type: "excalidraw", version: 2, elements: [{ id: "aac_other", type: "ellipse", x: 200, y: 160, width: 140, height: 90 }], appState: {}, files: {} };
    await back(`scenes.b_ui.scene = ${J(other)}; scenes.b_ui.rev += 5`);
    await says("a board changed while its server was away", page, ".canvas .canvas-note", "This board was changed while This computer was unreachable. Your unsaved changes were dropped.");
    if (!await until(async () => !await page.locator(".canvas .save-banner").count(), 10000)) fail("the edit dropped, the banner stays");
    if (J(await here("return scenes.b_ui.scene.elements.map((e) => e.id);")) !== J(["aac_other"])) fail("the drawing made during the outage replaced the one made meanwhile");
    if (!await page.locator(live).count()) fail("after the dropped edit the board cannot be drawn on");
    await p.end();
  }

  // ---- a board that was never loaded here is not opened while the server is away
  {
    const p = await open({}), { page } = p;
    await page.waitForSelector('.side-section[data-server="local"] .side-row');
    const row = page.locator('.side-section[data-server="local"] .side-row.is-board').first();
    await row.waitFor();
    await drop();
    if (!await until(async () => !(await p.rows()).length, 10000)) fail("this computer's rows stay while it is away");
    if (await page.locator(".board-off").count()) fail("a board off screen shows a view for a server that is away");
    await back();
    await row.click({ timeout: 10000 });
    if (!await until(async () => !!(await page.locator(".canvas, .board-off, .takeover-panel").count()), 10000)) fail("back, the board does not open");
    await p.end();
  }
  note("a chat: read-only under the warning naming This computer, Send off with the reason, the typed text kept in the browser when the chat was left and saved by one PUT on its counter when back; Studio Mac's rows and chat went on; a chat deleted meanwhile said so; a board drawn on under the banner, saved at the same revision and dropped at another");
});
