// Proves, on the new build, what is open when its server drops, and when it is back, for the chat (SEC.7; plans/remote-server-sections-goal.md,
// 3.8 and 3.9; B-RO-01, B-RO-02, B-RO-03, B-RO-06, B-RO-08, B-HD-09, B-SM-13).
// A chat: the thread stays as the app had it, under the warning that names the server, with its state's word and "Servers…"; the header
// has no status and offers no rename; what was open is level with that server when it is back (a message made there meanwhile appears
// once), the warning gone; deleted there meanwhile, the view says so, with no "Servers…". Left during the outage, the chat is closed and
// the selection names nothing of it; after a reload during the outage nothing of the chat is on screen; and back, it opens as usual.
// Ports the chat's part of dev/checks/SEC.7-drop.mjs at desktop, tablet and phone. Same seeds, same words; the sidebar's rows go while the
// server is away and are the same when it is back (a chat deleted meanwhile has no row again). The box keeps what was typed, is read-only
// and takes no more; Send is off with the reason as its title and the composer's line says it; no choice of the toolbar is a choice; the
// draft is saved by one PUT …/draft on its counter when back.
// Added in the sweep (rn-sw-webtest), from web/test/sectionviews.test.ts "a snapshot while a section has no tree (the page's own stream came back) closes nothing that is on
// screen" (A-ST-20): the mock's resync() gives the snapshot again while the server is away, and the chat stays as it was, with no call to that server.
// The board open and drawn on while its server is away (the banner, the saves at the same revision, the drop at another one) is B4's, in
// SEC.7-board.mjs: the same ID, run with this one.
// Deviation: the messages are read in the order they are on screen (messages of chat.mjs), the list being virtual.
import { callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { IDS, byTid, openChat, press } from "./sel.mjs";
import { sideSeen } from "./side.mjs";
import { WAIT, messages, says, textOf, threadShown } from "./chat.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const J = JSON.stringify;
const STUDIO = "s_studio", AWAY = "Studio Mac is not connected", WHY = `${AWAY}: nothing can be sent or changed until it is back.`;

await check("SEC.7 a chat that is open when its server drops, and when it is back", async ({ url, viewport, open, fail }) => {
  const drop = () => mockEval(`setServerState("${STUDIO}", "unreachable", { detail: "connection refused" });`, url);
  const back = (first = "") => mockEval(`${first}; setServerState("${STUDIO}", "connected");`, url);
  const bar = (page) => byTid(page, "remote-bar");
  /** The section's rows as the sidebar draws them (on the phone the list is behind the chat, still drawn). */
  const rowsOf = async (page) => (await sideSeen(page, STUDIO)).outline;
  const noRows = async (name, page) => { if (!await until(async () => !(await rowsOf(page)).length, WAIT)) fail(`${viewport}: ${name}: the section still has rows: ${J(await rowsOf(page))}`); };
  const sentence = (on) => `${on}. This chat is shown as it was when the connection ended.`;

  // ---- a chat
  {
    await seed(url, "SEC");
    const { page, ctx } = await open({ sel: { chat: `${STUDIO}~c_plain` }, wait: '[data-testid="chat-head"]' });
    const calls = callsOf(page), writes = (from) => calls.slice(from).filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`);
    await threadShown(page);
    const thread = await messages(page), rows = await rowsOf(page);
    if (!rows.length) fail(`${viewport}: the section has no row before its server drops`);
    if (!thread.length) fail(`${viewport}: the chat has no message on screen`);
    if (!await says(page, "chat-head-server", "Studio Mac")) fail(`${viewport}: the header of a chat of a section does not name its server: "${await textOf(page, "chat-head-server")}"`);
    // (the composer: what is typed is saved on the chat's own server, and what is typed just before the drop is on its way when the connection ends)
    const box = byTid(page, "composer-input").first(), send = byTid(page, "send").first(), typed = "half a thought", more = " and more just before";
    const there = (code) => mockEval(`return onServer("${STUDIO}", () => { ${code} });`, url);
    const on = (re, method) => calls.filter((c) => c.server === STUDIO && re.test(c.path) && (!method || c.method === method));
    const DRAFT = /\/chats\/c_plain\/draft\?/;
    let rev, sent = 0;
    await press(page, box); await page.keyboard.type(typed);
    if (!await until(() => on(DRAFT, "PUT").some((c) => c.status === 200), 10000)) fail(`${viewport}: what was typed in the chat of a section was not saved there`);
    await mockEval(`flags.draft = { hold: true };`, url);
    sent = on(DRAFT, "PUT").length;
    await press(page, box); await page.keyboard.press("End"); await page.keyboard.type(more);
    if (!await until(() => on(DRAFT, "PUT").length > sent, 10000)) fail(`${viewport}: the save of what was typed was not made`);
    rev = await there("return chats.c_plain.draftRev;");
    await drop();
    await mockEval(`release("draft"); delete flags.draft;`, url);
    if (!await says(page, "remote-bar-text", sentence(AWAY))) fail(`${viewport}: a chat, its server dropped: the warning says "${await textOf(page, "remote-bar-text")}", not "${sentence(AWAY)}"`);
    if (await bar(page).first().getAttribute("data-kind") !== "off") fail(`${viewport}: the warning of a server that dropped is not of the kind "off"`);
    if (J(await messages(page)) !== J(thread)) fail(`${viewport}: the thread of the open chat changed when its server dropped`);
    // the snapshot of the app's own stream comes again during the outage, with no tree of that server: nothing on screen closes, and nothing is asked of that server
    // (web/test/sectionviews.test.ts "a snapshot while a section has no tree ... closes nothing that is on screen", A-ST-20)
    const asked = calls.length;
    await mockEval("resync();", url);
    await page.waitForTimeout(600);
    if (J(await messages(page)) !== J(thread) || !await bar(page).count()) fail(`${viewport}: a snapshot with no tree of the server that is away closed or changed the chat on screen`);
    if (calls.slice(asked).some((c) => c.server === STUDIO)) fail(`${viewport}: a snapshot with no tree of the server that is away made the page ask that server: ${J(calls.slice(asked).filter((c) => c.server === STUDIO).map((c) => `${c.method} ${c.path}`))}`);
    if (!await says(page, "remote-bar-state", "Unreachable")) fail(`${viewport}: the warning does not say the server's state ("Unreachable"): "${await textOf(page, "remote-bar-state")}"`);
    if (!await byTid(page, "remote-servers").count()) fail(`${viewport}: the warning of a server that is not connected has no "Servers…"`);
    await noRows("a chat, its server dropped", page);
    if (await byTid(page, "chat-head").first().getAttribute("data-status")) fail(`${viewport}: the header of a chat shown as it was has a status: "${await byTid(page, "chat-head").first().getAttribute("data-status")}"`);
    if (await byTid(page, "chat-head").first().getAttribute("data-frozen") !== "true") fail(`${viewport}: the header does not know that the chat is shown as it was`);
    if (!await send.isDisabled() || await send.getAttribute("title") !== WHY) fail(`${viewport}: Send of a chat whose server dropped is ${await send.isDisabled() ? "off" : "on"} and says "${await send.getAttribute("title")}"`);
    if (!await says(page, "agent-reason", WHY)) fail(`${viewport}: the composer of a chat whose server dropped says "${await textOf(page, "agent-reason")}", not "${WHY}"`);
    if ((await box.textContent()) !== typed + more) fail(`${viewport}: the box of a chat whose server dropped has "${await box.textContent()}", not what was typed`);
    if (await byTid(page, "tchip").evaluateAll((els) => els.filter((e) => e.dataset.fixed !== "true" && e.dataset.kind !== "more" && e.getAttribute("aria-disabled") !== "true" && !e.disabled).length)) fail(`${viewport}: a choice of the composer is still a choice while the chat's server is not connected`);
    if (!await until(() => on(DRAFT, "PUT").slice(sent).every((c) => c.status === 504), 10000)) fail(`${viewport}: the save that was on its way at the drop was answered ${J(on(DRAFT, "PUT").slice(sent).map((c) => c.status))}, not 504`);
    if (await there("return chats.c_plain.draft?.text;") !== typed) fail(`${viewport}: Studio Mac got the draft whose save never arrived`);
    // read-only: the box keeps what it holds and takes no more, by a key, a paste or Enter, and no call is made for it
    if (await box.getAttribute("aria-readonly") !== "true") fail(`${viewport}: the box of a chat whose server dropped is not marked read-only`);
    const was = calls.length;
    await box.click({ force: true }).catch(() => {}); await page.keyboard.press("End"); await page.keyboard.type(" never");
    await page.keyboard.press("Backspace");
    await page.evaluate(() => document.execCommand("insertText", false, " pasted"));
    await page.keyboard.press("Enter"); // (Send by the key: nothing is sent)
    await page.waitForTimeout(700); // (longer than a draft's save waits)
    if ((await box.textContent()) !== typed + more) fail(`${viewport}: the read-only box took what was typed during the outage: "${await box.textContent()}"`);
    if (calls.slice(was).some((c) => c.method !== "GET")) fail(`${viewport}: a call was made for a chat whose server is not connected: ${J(calls.slice(was).filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`))}`);
    if (on(/\/messages/).length) fail(`${viewport}: a message was sent to a chat whose server is not connected`);
    const puts = on(DRAFT, "PUT").length;
    const quiet = calls.length;
    await byTid(page, "chat-head-name").first().click({ force: true }).catch(() => {});
    await page.waitForTimeout(300);
    if (await byTid(page, "chat-name-input").count()) fail(`${viewport}: a chat shown as it was can be renamed`);
    if (writes(quiet).length) fail(`${viewport}: a call was made for a chat whose server is not connected: ${J(writes(quiet))}`);
    // back: the thread there has grown meanwhile
    await back(`onServer("${STUDIO}", () => { items.c_plain.push({ kind: "user", text: "from the owner" }, say("fine"), { kind: "end" }); versions.c_plain = (versions.c_plain ?? 1) + 1; })`);
    if (!await until(async () => J(await rowsOf(page)) === J(rows), WAIT)) fail(`${viewport}: back, the section does not show the tree again: ${J(await rowsOf(page))}`);
    if (!await until(async () => (await messages(page)).some((m) => m.text.includes("from the owner")), WAIT)) fail(`${viewport}: back, the open chat is not level with its server: the message made there meanwhile is missing`);
    if (!await until(async () => !await bar(page).count(), WAIT)) fail(`${viewport}: back, the warning stays`);
    if (!await until(async () => !await send.isDisabled(), WAIT)) fail(`${viewport}: back, Send stays off`);
    if (!await until(async () => await there("return chats.c_plain.draft?.text;") === typed + more, WAIT)) fail(`${viewport}: back, what was typed is not saved there: ${J(await there("return chats.c_plain.draft;"))}`);
    await until(() => on(DRAFT, "PUT").slice(puts).some((c) => c.status === 200), 5000); // (a call is heard of a moment after it was made)
    const saved = on(DRAFT, "PUT").slice(puts);
    if (saved.length !== 1 || saved[0].status !== 200 || !saved[0].path.includes(`rev=${rev}`) || saved[0].body?.text !== typed + more) fail(`${viewport}: back, the saves were ${J(saved.map((c) => [c.path, c.status, c.body]))}, not one PUT …/draft on the counter ${rev}`);
    if (await there("return chats.c_plain.draftRev;") !== rev + 1) fail(`${viewport}: the draft's counter on Studio Mac is not one further`);
    if ((await box.textContent()) !== typed + more) fail(`${viewport}: back, the box lost what was typed`);
    if (await box.getAttribute("aria-readonly") === "true") fail(`${viewport}: back, the box is still read-only`);
    const owner = (await messages(page)).filter((m) => m.text.includes("from the owner")).length;
    if (owner !== 1) fail(`${viewport}: back, the message made meanwhile is on screen ${owner} times, not once`);
    if (await byTid(page, "chat-head").first().getAttribute("data-frozen") === "true") fail(`${viewport}: back, the header still shows the chat as it was`);
    if (!await until(async () => { await byTid(page, "chat-head-name").first().click().catch(() => {}); return await byTid(page, "chat-name-input").count(); }, 5000)) fail(`${viewport}: back, the chat cannot be renamed`);
    await page.keyboard.press("Escape");
    if (calls.some((c) => c.server === "local" && /^\/api\/chats\/c_plain/.test(c.path))) fail(`${viewport}: a call for the section's chat went to this computer's chat with the same id`);

    // deleted there meanwhile: the view says so
    await drop();
    if (!await says(page, "remote-bar-text", AWAY)) fail(`${viewport}: the chat, dropped again: the warning does not show`);
    await back(`await elsewhere("${STUDIO}", "DELETE", "/chats/c_plain")`);
    if (!await says(page, "remote-bar-text", "This chat is no longer on Studio Mac.")) fail(`${viewport}: a chat deleted while its server was away: the warning says "${await textOf(page, "remote-bar-text")}"`);
    if (await bar(page).first().getAttribute("data-kind") !== "gone") fail(`${viewport}: the warning of a chat that is no longer there is not of the kind "gone"`);
    if (await byTid(page, "remote-servers").count()) fail(`${viewport}: the view of a chat that is no longer on its server offers "Servers…"`);
    if (!await send.isDisabled()) fail(`${viewport}: Send is on for a chat that was deleted while its server was away`);
    if ((await rowsOf(page)).some((l) => l.includes("Render queue is stuck"))) fail(`${viewport}: the chat deleted meanwhile has a row again`);
    const left = J((await messages(page)).map((m) => m.text));
    if (!thread.every((m) => left.includes(J(m.text).slice(1, -1)))) fail(`${viewport}: the thread of the chat deleted meanwhile is not on screen`);
    await ctx.close();
  }

  // ---- a chat that is left during the outage is closed, and cannot be opened until the server is back
  {
    await seed(url, "SEC");
    const { page, ctx } = await open({ sel: { chat: `${STUDIO}~c_night` }, wait: '[data-testid="chat-head"]' });
    await threadShown(page);
    await drop();
    if (!await says(page, "remote-bar-text", AWAY)) fail(`${viewport}: a second chat, its server dropped: the warning does not show`);
    await openChat(page, "c_plain");
    if (!await until(async () => !await bar(page).count() && !await byTid(page, "chat-head-server").count(), WAIT)) fail(`${viewport}: after another chat was opened, the view of the section's chat stays`);
    await noRows("the chat left", page);
    const sel = await page.evaluate(() => localStorage.getItem("aiwb.sel"));
    if (sel.includes(STUDIO)) fail(`${viewport}: the selection still names the chat that was left: ${sel}`);
    await page.reload(); await byTid(page, IDS.chatHead).last().waitFor({ state: "visible", timeout: WAIT }); // (the chat of this computer that was opened instead)
    if (await bar(page).count() || await byTid(page, "chat-head-server").count()) fail(`${viewport}: after a reload during the outage a chat of the section is on screen`);
    await back();
    await openChat(page, `${STUDIO}~c_night`);
    if (!await says(page, "chat-head-server", "Studio Mac")) fail(`${viewport}: the chat opened again once the server is back: its header says "${await textOf(page, "chat-head-server")}"`);
    if (!await until(async () => (await byTid(page, "msg", { role: "user" }).count()) > 0, WAIT) || await bar(page).count()) fail(`${viewport}: back, the chat does not open as usual`);
    await ctx.close();
  }
}, { viewports, page: false });
