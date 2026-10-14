// Proves what is open when its server drops, and when it is back (plans/remote-server-sections-goal.md, 3.8 and 3.9;
// the contract's 3.6 and 3.10).
// A chat: the view stays as the page had it, read-only, under the warning that names the server; Send is off and says
// why, and so does the composer; what was typed and not yet taken by the server stays in the box, which is read-only
// and takes no more; the chat's row is gone with the rest of the section. Back: the section shows the tree again, the
// thread is level with that server, the warning is gone, Send works, the box takes text again, and the typed text is
// saved by one PUT …/draft to that server, on the counter the page had. Deleted there meanwhile, the view says so. Left during the outage, the chat is closed and cannot be opened
// until the server is back.
// A board that is open and held: it can still be drawn on, under the banner that it is not saved; back at the
// revision the page has, the drawing is saved there; back at another one (the board was changed there meanwhile), it
// is dropped with the notice, and that server's drawing is the one shown. (The wait while this computer's server took the
// board again there, a save answered 503 not_held_there, went with the relay: the page takes its boards again itself.)
// What the browser keeps of all this is SEC.9's.
import { callsOf, check, mockEval, openPage, seed, sideSeen, until } from "../shot.mjs";

const J = JSON.stringify;
const STUDIO = "s_studio", AWAY = "Studio Mac is not connected";
const WHY = `${AWAY}: nothing can be sent or changed until it is back.`;

await check("SEC.7 a chat and a board that are open when their server drops, and when it is back", async ({ url, browser, fail, note }) => {
  const drop = () => mockEval(`setServerState("${STUDIO}", "unreachable", { detail: "connection refused" });`, url);
  const back = (first = "") => mockEval(`${first}; setServerState("${STUDIO}", "connected");`, url);
  const there = (code) => mockEval(`return onServer("${STUDIO}", () => { ${code} });`, url);
  const sec = `.side-section[data-server="${STUDIO}"]`;
  /** A page on a seed made anew, with the selection given. */
  const open = async (sel) => {
    await seed(url, "SEC");
    const p = await openPage({ url, browser, sel, size: [1280, 900] });
    p.calls = callsOf(p.page);
    p.on = (re, method) => p.calls.filter((c) => c.server === STUDIO && re.test(c.path) && (!method || c.method === method));
    p.rows = async () => (await sideSeen(p.page, STUDIO)).outline;
    p.end = async () => { for (const e of p.errors) fail(`page error: ${e}`); await p.ctx.close(); };
    return p;
  };
  const text = (page, sel) => page.locator(sel).first().textContent({ timeout: 2000 }).catch(() => "");
  const says = async (name, page, sel, want) => { if (!await until(async () => (await text(page, sel)).includes(want), 10000)) fail(`${name}: ${sel} says "${await text(page, sel)}", not "${want}"`); };
  const noRows = async (name, p) => { if (!await until(async () => !(await p.rows()).length, 10000)) fail(`${name}: the section still has rows: ${J(await p.rows())}`); };

  // ---- a chat
  {
    const p = await open({ chat: `${STUDIO}~c_plain` }), { page } = p, box = page.locator(".composer .composer-input"), send = page.locator(".composer .send:not(.stop)");
    await page.waitForSelector(".thread .msg.user");
    const typed = "half a thought";
    await box.click(); await page.keyboard.type(typed);
    if (!await until(() => p.on(/\/chats\/c_plain\/draft\?/, "PUT").some((c) => c.status === 200), 10000)) fail("what was typed in the chat of a section was not saved there");
    const rows = await p.rows(), thread = await page.locator(".thread .msg").allTextContents();
    // typed just before the drop, and not yet taken by the server: its save is on its way when the connection ends
    const more = " and more just before";
    await mockEval(`flags.draft = { hold: true };`, url);
    const sent = p.on(/\/chats\/c_plain\/draft\?/, "PUT").length;
    await box.click(); await page.keyboard.press("End"); await page.keyboard.type(more);
    if (!await until(() => p.on(/\/chats\/c_plain\/draft\?/, "PUT").length > sent, 10000)) fail("the save of what was typed was not made");
    const rev = await there("return chats.c_plain.draftRev;");
    await drop();
    await mockEval(`release("draft"); delete flags.draft;`, url);
    await says("a chat, its server dropped", page, ".remote-bar.off .remote-bar-text", `${AWAY}. This chat is shown as it was when the connection ended.`);
    if (J(await page.locator(".thread .msg").allTextContents()) !== J(thread)) fail("the thread of the open chat changed when its server dropped");
    if (!await send.isDisabled() || await send.getAttribute("title") !== WHY) fail(`Send of a chat whose server dropped is ${await send.isDisabled() ? "off" : "on"} and says "${await send.getAttribute("title")}"`);
    await says("the composer of a chat whose server dropped", page, ".composer .agent-reason", WHY);
    if (await text(page, ".composer .composer-input") !== typed + more) fail(`the box of a chat whose server dropped has "${await text(page, ".composer .composer-input")}", not what was typed`);
    await noRows("a chat, its server dropped", p);
    if (await page.locator(".composer button.tchip:not(.static):not([disabled])").count()) fail("a choice of the composer is still a choice while the chat's server is not connected");
    if (!await until(() => p.on(/\/chats\/c_plain\/draft\?/, "PUT").slice(sent).every((c) => c.status === 504), 10000)) fail(`the save that was on its way at the drop was answered ${J(p.on(/\/chats\/c_plain\/draft\?/, "PUT").slice(sent).map((c) => c.status))}, not 504`);
    if (await there("return chats.c_plain.draft?.text;") !== typed) fail("Studio Mac got the draft whose save never arrived");
    // read-only: the box keeps what it holds and takes no more, by a key, a paste or Enter, and no call is made for it
    if (await box.getAttribute("aria-readonly") !== "true") fail("the box of a chat whose server dropped is not marked read-only");
    const quiet = p.calls.length;
    await box.click({ force: true }).catch(() => {}); await page.keyboard.press("End"); await page.keyboard.type(" never");
    await page.keyboard.press("Backspace");
    await page.evaluate(() => document.execCommand("insertText", false, " pasted"));
    await page.keyboard.press("Enter"); // (Send by the key: nothing is sent)
    await page.waitForTimeout(700); // (longer than a draft's save waits)
    if (await text(page, ".composer .composer-input") !== typed + more) fail(`the read-only box took what was typed during the outage: "${await text(page, ".composer .composer-input")}"`);
    if (p.calls.slice(quiet).some((c) => c.method !== "GET")) fail(`a call was made for a chat whose server is not connected: ${J(p.calls.slice(quiet).filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`))}`);
    if (p.on(/\/messages/).length) fail("a message was sent to a chat whose server is not connected");
    const puts = p.on(/\/chats\/c_plain\/draft\?/, "PUT").length;
    // back: the thread there has grown meanwhile
    await back(`onServer("${STUDIO}", () => { items.c_plain.push({ kind: "user", text: "from the owner" }, say("fine"), { kind: "end" }); versions.c_plain = (versions.c_plain ?? 1) + 1; })`);
    if (!await until(async () => J(await p.rows()) === J(rows), 10000)) fail(`back, the section does not show the tree again: ${J(await p.rows())}`);
    if (!await until(async () => (await page.locator(".thread .msg").allTextContents()).some((t) => t.includes("from the owner")), 10000)) fail("back, the open chat is not level with its server: the message made there meanwhile is missing");
    if (!await until(async () => !await page.locator(".remote-bar").count(), 10000)) fail("back, the warning stays");
    if (!await until(async () => !await send.isDisabled(), 10000)) fail("back, Send stays off");
    if (!await until(async () => await there("return chats.c_plain.draft?.text;") === typed + more, 10000)) fail(`back, what was typed is not saved there: ${J(await there("return chats.c_plain.draft;"))}`);
    await until(() => p.on(/\/chats\/c_plain\/draft\?/, "PUT").slice(puts).some((c) => c.status === 200), 5000); // (a call is heard of a moment after it was made)
    const saved = p.on(/\/chats\/c_plain\/draft\?/, "PUT").slice(puts);
    if (saved.length !== 1 || saved[0].status !== 200 || !saved[0].path.includes(`rev=${rev}`) || saved[0].body?.text !== typed + more) fail(`back, the saves were ${J(saved.map((c) => [c.path, c.status, c.body]))}, not one PUT …/draft on the counter ${rev}`);
    if (await there("return chats.c_plain.draftRev;") !== rev + 1) fail("the draft's counter on Studio Mac is not one further");
    if (await text(page, ".composer .composer-input") !== typed + more) fail("back, the box lost what was typed");
    if (await box.getAttribute("aria-readonly") === "true") fail("back, the box is still read-only");
    if (p.calls.some((c) => c.server === "local" && /^\/api\/chats\/c_plain/.test(c.path))) fail("a call for the section's chat went to this computer's chat with the same id");

    // deleted there meanwhile: the view says so
    await drop();
    await says("the chat, dropped again", page, ".remote-bar.off", AWAY);
    await back(`await elsewhere("${STUDIO}", "DELETE", "/chats/c_plain")`);
    await says("a chat deleted while its server was away", page, ".remote-bar.gone .remote-bar-text", "This chat is no longer on Studio Mac.");
    if (!await send.isDisabled()) fail("Send is on for a chat that was deleted while its server was away");
    if ((await p.rows()).some((l) => l.includes("Render queue is stuck"))) fail("the chat deleted meanwhile has a row again");
    await p.end();
  }

  // ---- a chat that is left during the outage is closed, and cannot be opened until the server is back
  {
    const p = await open({ chat: `${STUDIO}~c_night` }), { page } = p;
    await page.waitForSelector(".thread .msg.user");
    await drop();
    await says("a second chat, its server dropped", page, ".remote-bar.off", AWAY);
    await page.locator('.side-section[data-server="local"] > .side-section-body > .side-loose .side-row.is-chat, .side-section[data-server="local"] > .side-section-body > .side-group .side-row.is-chat').first().click();
    if (!await until(async () => !await page.locator(".remote-bar").count() && !await page.locator(".chat-head .chat-head-server").count(), 10000)) fail("after another chat was opened, the view of the section's chat stays");
    await noRows("the chat left", p);
    if ((await page.evaluate(() => localStorage.getItem("aiwb.sel"))).includes(STUDIO)) fail("the selection still names the chat that was left");
    await page.reload(); await page.waitForSelector(".side-tree .side-section");
    if (await page.locator(".remote-bar, .chat-head .chat-head-server").count()) fail("after a reload during the outage a chat of the section is on screen");
    await back();
    const row = page.locator(`${sec} .side-row:has(.side-name:text-is("Last night's failures"))`);
    await row.click({ timeout: 10000 });
    await says("the chat opened again once the server is back", page, ".chat-head .chat-head-server", "Studio Mac");
    if (!await until(() => page.locator(".thread .msg.user").count(), 10000) || await page.locator(".remote-bar").count()) fail("back, the chat does not open as usual");
    await p.end();
  }

  // ---- a board, open and drawn on
  {
    const p = await open({ board: `${STUDIO}~b_loose`, chat: null }), { page } = p;
    const live = ".excalidraw:not(.excalidraw--view-mode) canvas.interactive";
    await page.waitForSelector(live, { timeout: 15000 });
    const saves = () => p.on(/\/boards\/b_loose\/scene\?/, "PUT");
    const count = () => there("return scenes.b_loose.scene.elements.filter((e) => !e.isDeleted).length;");
    let drawn = 0;
    /** Draws one more rectangle on the canvas, by the tool's key and a drag. */
    const draw = async () => {
      const b = await page.locator(live).boundingBox(), x = b.x + 420 + (drawn % 3) * 110, y = b.y + 300 + Math.floor(drawn / 3) * 110;
      drawn++;
      await page.mouse.click(b.x + 200, b.y + b.height - 150); // (an empty place of the canvas, which takes the keys)
      await page.keyboard.press("r");
      await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 40, y + 30, { steps: 4 }); await page.mouse.move(x + 80, y + 60, { steps: 4 }); await page.mouse.up();
    };
    const rev0 = await there("return scenes.b_loose.rev;");
    await draw();
    if (!await until(() => saves().some((c) => c.status === 200 && c.path.endsWith(`rev=${rev0}`)), 15000)) fail(`a drawing on the section's board was not saved there on the revision ${rev0}: ${J(saves().map((c) => [c.path, c.status]))}`);
    if (await count() !== 2) fail(`Studio Mac has ${await count()} shapes after one was drawn, not 2`);
    await drop();
    await noRows("a board, its server dropped", p);
    await draw();
    await says("a board drawn on while its server is away", page, ".canvas .save-banner", "Not saved, Studio Mac unreachable");
    if (!await page.locator(live).count() || await page.locator(".board-off, .takeover").count()) fail("the open board cannot be drawn on while its server is away");
    await draw();
    if (!await until(() => saves().filter((c) => c.status === 503).length >= 1, 10000)) fail("no save of the board was answered 503 during the outage");
    if (await count() !== 2) fail("Studio Mac got a drawing while it was not connected");
    if (!await page.locator(".canvas .save-banner").count()) fail("the banner went while the server is still away");
    // back, at the revision the page has: the drawing is saved there
    const at = saves().length;
    await back();
    if (!await until(async () => await count() === 4, 15000)) fail(`back at the same revision, the board's drawing was not saved: Studio Mac has ${await count()} shapes, not 4; the saves: ${J(saves().slice(at).map((c) => [c.path, c.status]))}`);
    if (!await until(async () => !await page.locator(".canvas .save-banner").count(), 10000)) fail("back and saved, the banner stays");
    if (saves().slice(at).some((c) => c.status !== 200 && c.status !== undefined)) fail(`back at the same revision, a save was refused: ${J(saves().slice(at).map((c) => [c.path, c.status]))}`);
    if (await page.locator(".canvas .canvas-note").count()) fail("back at the same revision, the page says that changes were dropped");
    // back, at another revision: the drawing is dropped with the notice
    await drop();
    await draw();
    await says("the board drawn on, its server away again", page, ".canvas .save-banner", "Not saved, Studio Mac unreachable");
    const other = { type: "excalidraw", version: 2, elements: [{ id: "sec_other", type: "ellipse", x: 200, y: 160, width: 140, height: 90 }], appState: {}, files: {} };
    await back(`onServer("${STUDIO}", () => { scenes.b_loose.scene = ${J(other)}; scenes.b_loose.rev += 5; })`);
    await says("a board changed there while its server was away", page, ".canvas .canvas-note", "This board was changed while Studio Mac was unreachable. Your unsaved changes were dropped.");
    if (!await until(async () => !await page.locator(".canvas .save-banner").count(), 10000)) fail("the edit dropped, the banner stays");
    if (J(await there("return scenes.b_loose.scene.elements.map((e) => e.id);")) !== J(["sec_other"])) fail(`the drawing made during the outage replaced the one made there: ${J(await there("return scenes.b_loose.scene.elements.map((e) => e.id);"))}`);
    if (!await page.locator(live).count()) fail("after the dropped edit the board cannot be drawn on");
    if (p.calls.some((c) => c.server === "local" && /^\/api\/boards\//.test(c.path))) fail("a call for the section's board went to this computer's routes");
    await p.end();
  }
  note("a chat: read-only under the warning, Send off with the reason, the box read-only with the typed text kept and saved by one PUT on its counter when back; a board drawn on under the banner, saved at the same revision and dropped at another; a chat deleted meanwhile, its view said so");
});
