// Proves, on the new build, what is open when this computer's server drops, and when it is back (app-as-client-goal.md, 3.3, 4.4: "a server
// that stops while the app is open"; plan C7; B-RO-01 to B-RO-03, B-RO-06, B-RO-08, B-RO-09, B-SM-13), with another server of the list
// connected beside it. It goes on from SEC.7, which proves the same for a remote server's section: this computer's is a section like it.
// A chat of this computer: the view stays as the app had it, read-only, under the warning that names "This computer"; a chat of the other
// section opens and reads from its server while this computer is away, with no warning; back, the chat that was left opens level with the
// server (what was made there meanwhile is in it, once), the warning is gone, and the app was not loaded again by any of it. Deleted
// meanwhile, the view says that it is no longer on this computer, and when another chat is opened the warning goes.
// Ports the chat part of dev/checks/AAC.2-localdown.mjs (S1, S4, K3) at desktop, tablet and phone. Same seeds, same words. The sidebar's
// part: this computer's rows go while it is away, Studio Mac's stay, the head says "Unreachable" and then "Connected"; the head's "+" makes
// nothing on this computer while it is away; the rows are the same when it is back. The composer's part: what was typed stays in the box
// (read-only, taking no more), Send is off with its reason, the draft is kept in the browser when the chat is left and saved by one
// PUT …/draft on its counter when back; Studio Mac's chat has a composer that works. (On the phone the sidebar is the stack's first screen,
// under the chat: it stays drawn, and is read where it stands.) On the phone (package H1) the sidebar is Home, a screen under the chat that is not
// read from it: the chat's part first, then Home read (this computer's problem card above its last rows, faded; Studio Mac's rows as they were;
// + New off), and the rows read before the chat was opened. The board parts (a board open and drawn on while the server is away, a
// board never loaded) are B4's, in AAC.2-board.mjs: the same ID, run with this one.
// X2 chunk 1 (goal 3.5 "Header", "Another server, offline or archived", 3.7.1; goal 4.10): the phone has no top banner, so its half no longer reads
// `remote-bar`. It asserts what the phone draws: no `remote-bar` at all; the header's sub-line (`chat-head-sub`) says "● <Server> · offline" while the
// server is away; the composer's block is V1's bar in the toolbar's place (`composer-block`, kind offline | gone, `block-servers` for offline only,
// the box read-only with the draft, Send off or not drawn; v1-design.md section 1) and fails until V1 is merged. The server of a connected chat is read from
// Chat info's Server row. Everything that is not drawing (the draft's PUTs, 503, no call, the selection, the reload) is asserted as before.
import { callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { byTid, openChat, press, showHome } from "./sel.mjs";
import { homeOf, sideSeen } from "./side.mjs";
import { WAIT, composerBlock, headSub, messages, says, sendIsOff, serverInInfo, textOf, threadShown } from "./chat.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const J = JSON.stringify;
const STUDIO = "s_studio", AWAY = "This computer is not connected", WHY = `${AWAY}: nothing can be sent or changed until it is back.`;

await check("AAC.2 a chat of this computer that is open when its server drops, and when it is back", async ({ url, viewport, layout, open, fail }) => {
  const phone = layout === "phone";
  /** Home of a server, shown (the phone). */
  const homeOn = async (page, id) => { await showHome(page, id); return homeOf(page); };
  const drop = () => mockEval('setServerState("local", "unreachable", { detail: "connection refused" });', url);
  const back = (first = "") => mockEval(`${first}; setServerState("local", "connected");`, url);
  const bar = (page) => byTid(page, "remote-bar");
  /** Something warns that the chat is away or gone: the wide layouts' banner, the phone's block in the composer. */
  const warned = async (page) => phone ? !!await composerBlock(page) : !!await bar(page).count();
  const here = (code) => mockEval(`return onServer("local", () => { ${code} });`, url);
  const DRAFT = /\/chats\/c_plain\/draft\?/;

  // ---- a chat
  {
    await seed(url, "A1", "SEC");
    const { page, ctx } = await open({ sel: { chat: "c_plain" }, wait: '[data-testid="chat-head"]' });
    await threadShown(page);
    await page.evaluate(() => { window.__mark = "same page"; });
    const thread = await messages(page);
    if (!thread.length) fail(`${viewport}: the chat has no message on screen`);
    const calls = callsOf(page), on = (re, method) => calls.filter((c) => c.server === "local" && re.test(c.path) && (!method || c.method === method));
    const box = byTid(page, "composer-input").first(), send = byTid(page, "send").first(), typed = "half a thought", more = " and more just before", all = typed + more;
    await press(page, box); await page.keyboard.type(typed);
    if (!await until(() => on(DRAFT, "PUT").some((c) => c.status === 200), 10000)) fail(`${viewport}: what was typed in the chat of this computer was not saved`);
    let rows, studio;
    if (phone) { // (Home is read first, then the chat opened again: a back from a chat clears it)
      rows = (await homeOn(page, "local")).outline; studio = (await homeOn(page, STUDIO)).outline;
      await openChat(page, "c_plain");
      await threadShown(page);
    } else { rows = (await sideSeen(page, "local")).outline; studio = (await sideSeen(page, STUDIO)).outline; }
    if (!rows.length || !studio.length) fail(`${viewport}: the seed has no rows in this computer's section or in Studio Mac's`);
    // typed just before the drop, and not yet taken by the server: the draft's save waits a moment after the last key, and the connection ends first
    const rev = await here("return chats.c_plain.draftRev;");
    await press(page, box); await page.keyboard.press("End"); await page.keyboard.type(more);
    await drop();
    if (!await until(() => on(DRAFT, "PUT").some((c) => c.status === 503), 10000)) fail(`${viewport}: the save of what was typed was not refused 503 by the app while the server was away`);
    if (phone) { // (no top banner; the header's sub-line and the composer's block say it)
      if (!await until(async () => (await headSub(page)) === `● This computer · offline`, WAIT)) fail(`${viewport}: this computer's server dropped: the header's sub-line says "${await headSub(page)}", not "● This computer · offline"`);
      if (await bar(page).count()) fail(`${viewport}: the phone draws a top banner (remote-bar) for a chat whose server dropped`);
      if (J(await messages(page)) !== J(thread)) fail(`${viewport}: the thread of the open chat changed when its server dropped`);
      // V1's seam (v1-design.md section 1): fails until V1 is merged
      if (!await until(async () => (await composerBlock(page))?.kind === "offline", WAIT)) fail(`${viewport}: the composer of a chat whose server dropped has no offline block: ${J(await composerBlock(page))}`);
      const blk = await composerBlock(page);
      if (blk && !blk.text.includes("This computer is offline")) fail(`${viewport}: the offline block does not name the server: "${blk.text}"`);
      if (blk && !blk.servers) fail(`${viewport}: the offline block has no "Servers" button`);
      if (!await sendIsOff(page)) fail(`${viewport}: Send of a chat whose server dropped is on`);
    } else {
      if (!await says(page, "remote-bar-text", `${AWAY}. This chat is shown as it was when the connection ended.`)) fail(`${viewport}: a chat, this computer's server dropped: the warning says "${await textOf(page, "remote-bar-text")}"`);
      if (J(await messages(page)) !== J(thread)) fail(`${viewport}: the thread of the open chat changed when its server dropped`);
      if (!await says(page, "remote-bar-state", "Unreachable")) fail(`${viewport}: the warning does not say the server's state: "${await textOf(page, "remote-bar-state")}"`);
      if (!await send.isDisabled() || await send.getAttribute("title") !== WHY) fail(`${viewport}: Send of a chat whose server dropped is ${await send.isDisabled() ? "off" : "on"} and says "${await send.getAttribute("title")}"`);
      if (!await says(page, "agent-reason", WHY)) fail(`${viewport}: the composer of a chat whose server dropped says "${await textOf(page, "agent-reason")}", not "${WHY}"`);
    }
    if ((await box.textContent()) !== all) fail(`${viewport}: the box has "${await box.textContent()}", not what was typed`);
    const outline = async (id) => (await sideSeen(page, id)).outline;
    if (!phone) {
      if (!await until(async () => !(await outline("local")).length, 10000)) fail(`${viewport}: this computer's section still has rows: ${J(await outline("local"))}`);
      if (J(await outline(STUDIO)) !== J(studio)) fail(`${viewport}: Studio Mac's section changed when this computer dropped: ${J(await outline(STUDIO))}`);
      if ((await sideSeen(page, "local")).state !== "Unreachable") fail(`${viewport}: this computer's head says "${(await sideSeen(page, "local")).state}"`);
      if (!await byTid(page, "side-new").first().isDisabled()) fail(`${viewport}: the sidebar's + makes things on this computer while it is away`);
    }
    if (await byTid(page, "tchip").evaluateAll((els) => els.filter((e) => e.dataset.fixed !== "true" && e.dataset.kind !== "more" && e.getAttribute("aria-disabled") !== "true" && !e.disabled).length)) fail(`${viewport}: a choice of the composer is still a choice while the chat's server is not connected`);
    if (await box.getAttribute("aria-readonly") !== "true") fail(`${viewport}: the box of a chat whose server dropped is not marked read-only`);
    const was = calls.length;
    await box.click({ force: true }).catch(() => {}); await page.keyboard.press("End"); await page.keyboard.type(" never");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(700); // (longer than a draft's save waits)
    if ((await box.textContent()) !== all) fail(`${viewport}: the read-only box took what was typed during the outage: "${await box.textContent()}"`);
    if (calls.slice(was).some((c) => c.method !== "GET")) fail(`${viewport}: a call was made for a chat whose server is not connected: ${J(calls.slice(was).filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`))}`);
    if (phone) { // Home, under the chat, read now: this computer's card above its last rows (faded, none live), Studio Mac's as they were, + New off
      const mine = await homeOn(page, "local");
      if (mine.state !== "trouble" || mine.card?.word !== "unreachable" || !mine.stale || J(mine.outline) !== J(rows)) fail(`${viewport}: this computer's Home is ${J([mine.state, mine.card?.word, mine.stale, mine.outline])}, not its problem card above its last rows, faded`);
      if (mine.newEnabled) fail(`${viewport}: + New makes things on this computer while it is away`);
      const theirs = await homeOn(page, STUDIO);
      if (J(theirs.outline) !== J(studio) || theirs.state !== "list" || theirs.stale) fail(`${viewport}: Studio Mac's Home changed when this computer dropped: ${J([theirs.state, theirs.stale, theirs.outline])}`);
    }
    // the other section works meanwhile: its chat opens, reads from its server and has no warning
    await openChat(page, `${STUDIO}~c_night`);
    if (phone) { // (the phone's header has no server line: Chat info's Server row names it; the sub-line is the place line, not "offline")
      await byTid(page, "msg", { role: "user" }).first().waitFor({ state: "visible", timeout: WAIT });
      const named = await serverInInfo(page, fail);
      if (named !== "Studio Mac") fail(`${viewport}: a chat of Studio Mac, this computer away: Chat info's Server row says "${named}"`);
      if ((await headSub(page)).includes("offline")) fail(`${viewport}: a chat of Studio Mac, this computer away: the header's sub-line says "${await headSub(page)}"`);
    } else if (!await says(page, "chat-head-server", "Studio Mac")) fail(`${viewport}: a chat of Studio Mac, this computer away: its header says "${await textOf(page, "chat-head-server")}"`);
    if (!await until(async () => !!(await byTid(page, "msg", { role: "user" }).count()) && !(await bar(page).count()) && !(phone && await composerBlock(page)), WAIT)) fail(`${viewport}: a chat of Studio Mac does not open as usual while this computer is away`);
    if ((await page.evaluate(() => localStorage.getItem("aiwb.sel"))).includes('"c_plain"')) fail(`${viewport}: the selection still names the chat of this computer that was left`);
    const studioBox = byTid(page, "composer-input").first();
    if (phone) {
      if ((await studioBox.getAttribute("aria-readonly")) === "true") fail(`${viewport}: the composer of Studio Mac's chat is read-only because this computer is away`); // (the phone's one primary: Talk while the box is empty, Send once it holds something; `send` is not drawn for an empty box)
      const talk = byTid(page, "composer-talk").first();
      if (!await until(async () => await talk.count() && !await talk.isDisabled(), WAIT)) fail(`${viewport}: Studio Mac's chat, this computer away: the composer's Talk is not there and on`);
      await press(page, studioBox); await page.keyboard.type("hello");
      if (!await until(async () => { const b = byTid(page, "send").first(); return await b.count() && !await b.isDisabled(); }, WAIT)) fail(`${viewport}: Studio Mac's chat, this computer away: Send is not there and on once something is typed`);
      await page.keyboard.press("Control+A"); await page.keyboard.press("Backspace");
    } else if (await byTid(page, "send").first().isDisabled() && (await studioBox.getAttribute("aria-readonly")) === "true") fail(`${viewport}: the composer of Studio Mac's chat is read-only because this computer is away`);
    // the draft stays where the app keeps it, for when the server is back
    const kept = await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith("aiwb.draft.")).map(([k, v]) => [k, v]));
    if (!kept.some(([k, v]) => k.includes("c_plain") && v.includes(more))) fail(`${viewport}: the draft of the chat that was left is not kept: ${J(kept)}`);
    if (await here("return chats.c_plain.draft?.text;") !== typed) fail(`${viewport}: this computer's server got the draft whose save never arrived`);
    const puts = on(DRAFT, "PUT").length;
    // back: the thread there has grown meanwhile
    await back(`onServer("local", () => { items.c_plain.push({ kind: "user", text: "from the owner" }, say("fine"), { kind: "end" }); versions.c_plain = (versions.c_plain ?? 1) + 1; })`);
    if (phone) {
      await showHome(page, "local");
      if (!await until(async () => { const h = await homeOf(page); return h.state === "list" && !h.stale && !h.card && J(h.outline) === J(rows); }, 10000)) fail(`${viewport}: back, this computer's Home does not show the tree again: ${J(await homeOf(page).then((h) => [h.state, h.stale, h.outline]))}`);
      if (!await until(async () => (await homeOf(page)).word === "connected" && (await homeOf(page)).newEnabled, 10000)) fail(`${viewport}: back, this computer's Home does not say Connected with + New on`);
    } else {
      if (!await until(async () => J((await sideSeen(page, "local")).outline) === J(rows), 10000)) fail(`${viewport}: back, this computer's section does not show the tree again: ${J((await sideSeen(page, "local")).outline)}`);
      if (!await until(async () => (await sideSeen(page, "local")).state === "Connected", 10000)) fail(`${viewport}: back, this computer's head does not say Connected`);
    }
    if (!await until(async () => await here("return chats.c_plain.draft?.text;") === all, WAIT)) fail(`${viewport}: back, what was typed is not saved: ${J(await here("return chats.c_plain.draft;"))}`);
    await until(() => on(DRAFT, "PUT").slice(puts).some((c) => c.status === 200), 5000);
    const saved = on(DRAFT, "PUT").slice(puts);
    if (saved.length !== 1 || saved[0].status !== 200 || !saved[0].path.includes(`rev=${rev}`) || saved[0].body?.text !== all) fail(`${viewport}: back, the saves were ${J(saved.map((c) => [c.path, c.status, c.body]))}, not one PUT …/draft on the counter ${rev}`);
    if (!await until(async () => !(await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith("aiwb.draft.") && k.includes("c_plain")))), WAIT)) fail(`${viewport}: back and saved, the app still keeps the draft`);
    await openChat(page, "c_plain");
    if (!await until(async () => (await messages(page)).some((m) => m.text.includes("from the owner")), WAIT)) fail(`${viewport}: back, the chat is not level with its server: the message made there meanwhile is missing`);
    if (await warned(page)) fail(`${viewport}: back, the warning stays`);
    if ((await messages(page)).filter((m) => m.text.includes("from the owner")).length !== 1) fail(`${viewport}: back, the message made there meanwhile is not on screen exactly once`);
    if (await page.evaluate(() => window.__mark) !== "same page") fail(`${viewport}: the page was loaded again`);
    await ctx.close();
  }

  // ---- a chat that is deleted while its server is away
  {
    await seed(url, "A1", "SEC");
    const { page, ctx } = await open({ sel: { chat: "c_plain" }, wait: '[data-testid="chat-head"]' });
    await threadShown(page);
    await drop();
    if (phone) {
      if (!await until(async () => (await headSub(page)) === "● This computer · offline", WAIT)) fail(`${viewport}: the chat, dropped: the header's sub-line says "${await headSub(page)}"`);
    } else if (!await says(page, "remote-bar-text", AWAY)) fail(`${viewport}: the chat, dropped: the warning does not show`);
    await back('await elsewhere("local", "DELETE", "/chats/c_plain")');
    if (phone) { // (V1's block, kind gone, in the toolbar's place, with no Servers button; the server is connected again, so the header does not say it is offline)
      if (!await until(async () => (await composerBlock(page))?.kind === "gone", WAIT)) fail(`${viewport}: a chat deleted while its server was away: the composer's block is ${J(await composerBlock(page))}, not the gone line`);
      const blk = await composerBlock(page);
      if (blk && blk.text !== "This chat is no longer on This computer.") fail(`${viewport}: a chat deleted while its server was away: the block says "${blk.text}"`);
      if (await byTid(page, "composer-plus").count()) fail(`${viewport}: the "+" of a chat that is no longer on its server is still drawn: the gone line (with its reason) takes the toolbar's place`);
      if (blk?.servers || await byTid(page, "block-servers").count()) fail(`${viewport}: the block of a chat that is no longer on its server offers "Servers"`);
      if ((await headSub(page)).includes("offline")) fail(`${viewport}: a chat gone from a server that is connected: the header's sub-line says "${await headSub(page)}"`);
      if (await bar(page).count()) fail(`${viewport}: the phone draws a top banner (remote-bar) for a chat that is no longer on its server`);
    } else {
      if (!await says(page, "remote-bar-text", "This chat is no longer on This computer.")) fail(`${viewport}: a chat deleted while its server was away: the warning says "${await textOf(page, "remote-bar-text")}"`);
      if (await byTid(page, "remote-servers").count()) fail(`${viewport}: the view of a chat that is no longer on its server offers "Servers…"`);
    }
    if (!await sendIsOff(page)) fail(`${viewport}: Send is on for a chat that was deleted while its server was away`);
    if (phone) { // (Home lists the top level; the chat, in a group, is looked for in the group's screens by the rows of its path)
      const h = await homeOn(page, "local");
      if (h.rows.some((r) => r.key === "c_plain" || r.name.includes("build slow"))) fail(`${viewport}: the chat deleted meanwhile has a row again`);
      if (!await until(async () => { const x = await homeOf(page); return x.state === "list" && x.word === "connected" && x.rows.length > 0; }, 10000)) fail(`${viewport}: this computer's Home is not whole again`);
    } else {
      if ((await sideSeen(page, "local")).outline.some((l) => l.includes("build slow"))) fail(`${viewport}: the chat deleted meanwhile has a row again`);
      if (!await until(async () => (await sideSeen(page, "local")).state === "Connected" && (await sideSeen(page, "local")).outline.length > 0, 10000)) fail(`${viewport}: this computer's section is not whole again`);
    }
    // left, it goes
    await openChat(page, `${STUDIO}~c_night`);
    if (!await until(async () => !await warned(page), WAIT)) fail(`${viewport}: after another chat was opened, the view of the chat that was gone stays`);
    await ctx.close();
  }
}, { viewports, page: false });
