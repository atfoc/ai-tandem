// L23 (new; package rn-sw-gaps-c): the composer and the thread of a chat that is shown as it was, in the cases no check looked at: its server drops
// while a list is open or the chat is archived, the chat is deleted on its server, a refusal's sentence is under the box when the server comes back.
// On the SEC seed (the server "Studio Mac" of the sections), at desktop, tablet and phone.
//   C-MN-09  the box of a board chat with text typed: as the server drops it takes no key, and Enter and the arrows send and change nothing
//   C-RO-07  an archived chat of a section: "Archived — unarchive to continue" and the button; its server dropped, "Archived." and the reason with
//            no button and no sentence under it; back, the button
//   C-IM-25  a chat its server no longer has: the attach button is off, and its title is the gone sentence ("This chat is no longer on Studio Mac.")
//   C-RO-03  an empty chat deleted on its server: no suggestion to send, the gone sentence in the thread's place (a live empty chat offers suggestions)
//   C-RO-10, C-CH-22  a refusal's sentence under the composer goes when its server is connected again (a Send refused: "Too many turns run at once")
//   C-RO-12  a Send answered 404 "not_found" marks the chat as no longer on its server: the bar of a chat that is gone, Send off
//   C-RO-01  the box of a chat shown as it was says why in its place: "<server> is not connected" / the gone sentence
// The phone (V1, goal 3.7.1) says each of these once, by the composer's block (`composer-block`, dataSet `kind` and `place`): a chat that is gone or whose
// server is offline in the toolbar's place inside the box (read-only, no placeholder), an archived chat in the box's place with a full-width Unarchive; the
// attach button is the "+", off when the chat is gone.
// The choices that clear that sentence (model, effort…) are L16's.
import { callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { byTid, press } from "./sel.mjs";
import { WAIT, textOf } from "./chat.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const J = JSON.stringify;
const STUDIO = "s_studio", AWAY = "Studio Mac is not connected", GONE = "This chat is no longer on Studio Mac.";
const key = (id) => `${STUDIO}~${id}`;

await check("L23 a chat shown as it was: the box as the server drops, the archived bar, the attach button, an empty thread, a refusal's sentence", async ({ url, viewport, layout, open, fail, note }) => {
  const phone = layout === "phone";
  const drop = () => mockEval(`setServerState("${STUDIO}", "unreachable", { detail: "connection refused" });`, url);
  const back = () => mockEval(`setServerState("${STUDIO}", "connected");`, url);
  const fresh = async () => {
    await seed(url, "SEC");
    // an empty chat of the section, a started one in the thread's place of nothing: the cases below need one that has no message
    await mockEval(`onServer("${STUDIO}", () => { chats.c_L23_empty = chat("c_L23_empty", { cwd: "/Users/studio/work", group: UNGROUPED, locked: false, usage: { ...usage, ctxIn: 0, ctxOut: 0, turns: 0 } }); items.c_L23_empty = []; }); resync();`, url);
  };
  const on = async (sel) => {
    const o = await open({ sel, wait: '[data-testid="chat-head"]' });
    await byTid(o.page, "composer-input").first().or(byTid(o.page, "archived-bar").first()).waitFor({ state: "visible", timeout: WAIT });
    return o;
  };
  const box = (page) => byTid(page, "composer-input").first();
  // On the phone nothing is drawn under the thread (T3-5, goal 3.5: no top banner, offline said once, in the composer's place): what the bar says on the
  // wide layouts the composer's block says, in the toolbar's place, with no placeholder in the box (V1: said once), and the bar is not there.
  const BLOCKED = (kind) => (kind === "gone" ? "gone" : "offline");
  const blockText = (page) => textOf(page, "composer-block", { place: "toolbar" }); // (a refused send's card above the box is a block too)
  const said = async (page, kind) => phone
    ? (await byTid(page, "remote-bar").count()) === 0 && (await byTid(page, "composer-block", { kind: BLOCKED(kind), place: "toolbar" }).count()) === 1
      && ((await box(page).getAttribute("data-placeholder").catch(() => "")) ?? "") === ""
      && (kind === "gone" ? (await blockText(page)).includes(GONE) : /^Studio Mac is offline/.test(await blockText(page)) && (await blockText(page)).includes("Your draft is kept until it's back."))
    : (await byTid(page, "remote-bar").first().getAttribute("data-kind").catch(() => "")) === kind;
  const text = async (page) => (await box(page).textContent()) ?? "";

  // ---- C-MN-09: text in the box, the server drops
  {
    await fresh();
    const { page, ctx } = await on({ board: key("b_loose"), chat: key("c_on_floor") });
    const calls = callsOf(page);
    await press(page, box(page));
    await page.keyboard.type("hi");
    if (!await until(async () => (await text(page)) === "hi", 10000)) fail(`the box of a board chat of a section holds ${J(await text(page))}, not the text typed`);
    else {
      await drop();
      if (phone) { if (!await until(() => said(page, "off"), WAIT)) fail(`the composer of a chat whose server dropped says ${J(await blockText(page))} in the toolbar's place (${await byTid(page, "composer-block").count()} blocks), with the placeholder ${J(await box(page).getAttribute("data-placeholder"))}`); }
      else if (!await until(async () => (await box(page).getAttribute("data-placeholder")) === AWAY, WAIT)) fail(`the box of a chat whose server dropped says ${J(await box(page).getAttribute("data-placeholder"))} when empty, not ${J(AWAY)}`);
      const was = calls.length;
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Tab");
      await page.waitForTimeout(500);
      if (await text(page) !== "hi") fail(`the box took a key while the server is away: it holds ${J(await text(page))}`);
      // (the text typed just before the drop may still be saved: that is the draft's own save, which SEC.7 proves)
      const calling = calls.slice(was).filter((c) => c.method !== "GET" && !(c.method === "PUT" && /\/draft\?/.test(c.path)));
      if (calling.length) fail(`a call was made for a box that takes nothing: ${J(calling.map((c) => `${c.method} ${c.path}`))}`);
    }
    await ctx.close();
  }

  // ---- C-RO-07: an archived chat of a section, its server dropped
  {
    await fresh();
    const { page, ctx } = await on({ chat: key("c_arch") });
    const bar = byTid(page, "archived-bar");
    if (!await until(() => bar.count(), WAIT)) fail("an archived chat of a section has no bar");
    else {
      // (the phone's bar: "This chat is archived." and what to do, a full-width Unarchive; its server dropped, the reason in the second line and no button)
      const connected = (t) => phone ? t.startsWith("This chat is archived.") && t.includes("Unarchive it to send a message.") : t.startsWith("Archived — unarchive to continue");
      const away = (t) => phone ? t.startsWith("This chat is archived.") && t.includes("Studio Mac is offline") : t.startsWith("Archived. ");
      if (!connected(await bar.first().textContent()) || !await byTid(page, "unarchive").count()) fail(`connected, the bar of an archived chat of a section says ${J(await bar.first().textContent())} and has ${await byTid(page, "unarchive").count()} Unarchive`);
      if (phone) {
        const b = await bar.first().boundingBox(), u = await byTid(page, "unarchive").first().boundingBox();
        if (!b || !u || u.height < 44 - 0.5 || u.width < b.width - 40) fail(`the phone's Unarchive is ${u && Math.round(u.width)}x${u && Math.round(u.height)} in a bar ${b && Math.round(b.width)} wide, not full width and 44 pt high`);
        if (await byTid(page, "composer-block", { kind: "archived", place: "box" }).count() !== 1) fail("the archived bar is not the composer's block of kind archived in the box's place");
      }
      await drop();
      if (!await until(async () => away(await bar.first().textContent().catch(() => "")), WAIT)) fail(`its server dropped, the bar says ${J(await bar.first().textContent().catch(() => ""))}, not "${phone ? "This chat is archived." : "Archived."}" and the reason`);
      else if (!(await bar.first().textContent()).includes(phone ? "Studio Mac is offline" : AWAY)) fail(`its server dropped, the bar does not name the server: ${J(await bar.first().textContent())}`);
      if (await byTid(page, "unarchive").count()) fail("its server dropped, the bar offers Unarchive");
      if (await byTid(page, "composer-err").count() || await box(page).count()) fail("its server dropped, an archived chat draws a sentence under its bar or a box");
      await back();
      if (!await until(async () => (await byTid(page, "unarchive").count()) === 1 && connected(await bar.first().textContent()), WAIT)) fail(`back, the bar is ${J(await bar.first().textContent())} with ${await byTid(page, "unarchive").count()} Unarchive`);
    }
    await ctx.close();
  }

  // ---- C-IM-25: a chat its server no longer has: the attach button says so
  {
    await fresh();
    const { page, ctx } = await on({ chat: key("c_plain") });
    // (the phone's attach button is the "+" and the Files row of its sheet, C1; as R3.12 reads it: the row's note is what the wide button's title is. A "+" that
    // is off has no sheet to open, and the reason is the one the composer's primary button gives, Send's aria-label or Talk's title.)
    const attach = async () => {
      if (!phone) { const b = byTid(page, "attach-btn").first(); return await b.count() ? { off: await b.isDisabled(), title: await b.getAttribute("title") } : null; }
      const plus = byTid(page, "composer-plus").first();
      if (!await plus.count()) return null;
      if (await plus.evaluate((e) => e.disabled || e.getAttribute("aria-disabled") === "true"))
        return { off: true, title: await page.evaluate(() => { const b = document.querySelector('[data-testid="composer"] [data-testid="send"], [data-testid="composer"] [data-testid="composer-talk"]'); return b?.getAttribute("aria-label") || b?.getAttribute("title") || ""; }) };
      await press(page, plus);
      const row = byTid(page, "action-row", { action: "files" });
      await row.waitFor({ state: "visible", timeout: 8000 });
      const label = await row.innerText(), off = await row.evaluate((e) => e.disabled || e.getAttribute("aria-disabled") === "true");
      await page.keyboard.press("Escape");
      await until(async () => !await byTid(page, "plus-sheet").count(), 5000);
      return { off, title: label.replace(/^Files\s*/, "").trim() };
    };
    const ADD = phone ? "Images from this computer" : "Add images";
    if (!await until(async () => (await attach())?.off === false, WAIT)) fail(`the attach button of a live chat of a section is ${J(await attach())}`);
    else if ((await attach()).title !== ADD) fail(`the attach button of a live chat says ${J((await attach()).title)}, not ${J(ADD)}`);
    await mockEval(`await elsewhere("${STUDIO}", "DELETE", "/chats/c_plain")`, url);
    if (!await until(() => said(page, "gone"), WAIT)) fail(phone ? `the composer of a chat deleted on its server says ${J(await box(page).getAttribute("data-placeholder"))}, with ${await byTid(page, "remote-bar").count()} bar` : "the view of a chat deleted on its server does not say so");
    else if (!phone && await box(page).getAttribute("data-placeholder") !== GONE && !await until(async () => (await box(page).getAttribute("data-placeholder")) === GONE, WAIT)) fail(`the box of a chat its server no longer has says ${J(await box(page).getAttribute("data-placeholder"))} when empty, not ${J(GONE)}`);
    // (the phone's toolbar of a chat that is gone is the block's place: its "+" is not drawn, or is off)
    if (!await until(async () => { const a = await attach(); return phone ? (a === null || a.off === true) : a?.off === true; }, WAIT) || (!phone && (await attach()).title !== GONE)) fail(`the attach button of a chat its server no longer has is ${J(await attach())}, not off and saying ${J(GONE)}`);
    // (the phone's "+" that is off has no sheet, and its primary button is Talk with its own words: the sentence is the box's placeholder, read just above)
    await ctx.close();
  }

  // ---- C-RO-03: an empty chat deleted on its server offers nothing to send
  {
    await fresh();
    const { page, ctx } = await on({ chat: key("c_L23_empty") });
    const calls = callsOf(page);
    await byTid(page, "empty-thread").first().waitFor({ state: "visible", timeout: WAIT });
    if (!await byTid(page, "suggestion").count()) fail("a live empty chat of a section offers no suggestion to send");
    if (await byTid(page, "empty-reason").count()) fail(`a live empty chat of a section says ${J(await textOf(page, "empty-reason"))} in its thread`);
    await mockEval(`await elsewhere("${STUDIO}", "DELETE", "/chats/c_L23_empty")`, url);
    if (phone) {
      // (the phone says it once, in the composer's place: the block of kind gone, and the empty thread does not repeat it)
      if (!await until(() => said(page, "gone"), WAIT)) fail(`an empty chat its server no longer has: the composer's block is ${J(await blockText(page).catch(() => ""))} (${await byTid(page, "composer-block", { kind: "gone", place: "toolbar" }).count()} of kind gone in the toolbar's place), not ${J(GONE)}`);
      if (await byTid(page, "empty-reason").count()) fail(`an empty chat its server no longer has repeats ${J(await textOf(page, "empty-reason"))} in its thread (the block says it)`);
    } else if (!await until(async () => (await textOf(page, "empty-reason").catch(() => "")) === GONE, WAIT)) fail(`an empty chat its server no longer has says ${J(await textOf(page, "empty-reason").catch(() => ""))} in its thread, not ${J(GONE)}`);
    if (await byTid(page, "suggestion").count()) fail("an empty chat its server no longer has offers a suggestion to send");
    if (calls.some((c) => c.method === "POST" && /\/messages/.test(c.path))) fail("a message was sent to a chat its server no longer has");
    await ctx.close();
  }

  // ---- C-RO-12: a Send answered "not_found" marks the chat as no longer on its server
  {
    await fresh();
    const { page, ctx } = await on({ chat: key("c_L23_empty") });
    await mockEval(`flags.send = { refuse: { status: 404, code: "not_found", error: "no such chat" } };`, url);
    await press(page, box(page));
    await page.keyboard.type("to a chat that is gone");
    await press(page, byTid(page, "send").first());
    if (!await until(() => said(page, "gone"), WAIT)) fail(`a Send answered 404 not_found did not mark the chat as no longer on its server (${J(await page.evaluate(() => [...document.querySelectorAll('[data-testid="composer-block"]')].map((e) => [e.dataset.kind, e.dataset.place, e.textContent])))}, ${await byTid(page, "remote-bar").count()} bar)`);
    else {
      if (!phone && await textOf(page, "remote-bar-text") !== GONE) fail(`the bar of that chat says ${J(await textOf(page, "remote-bar-text"))}, not ${J(GONE)}`);
      // (the phone's toolbar is the block's place: no Send is drawn, or it is off)
      if (await byTid(page, "send").count() && !await byTid(page, "send").first().isDisabled()) fail("Send is on for a chat its server no longer has");
    }
    await mockEval(`delete flags.send;`, url);
    await ctx.close();
  }

  // ---- the thread's place when the app holds none of the chat (T3-5, phone only): the sentence, the server's word and since when, a 44 pt
  // Servers that opens the server's detail (S2's pushed screen, whose body `srv-facts` carries the server's entry id), and no bar
  if (phone) {
    await fresh();
    await mockEval("flags.items = { delay: 600000 };", url);
    const { page, ctx } = await on({ chat: key("c_plain") });
    await drop();
    const off = byTid(page, "remote-off").first();
    await off.waitFor({ state: "visible", timeout: WAIT });
    if (await byTid(page, "remote-bar").count()) fail("a bar is drawn on the phone under a chat whose server dropped");
    if (!(await textOf(page, "remote-off-text")).includes("Studio Mac is not connected. This chat shows again when it is back.")) fail(`the place of the thread says ${J(await textOf(page, "remote-off-text"))}`);
    const stateText = await textOf(page, "remote-off-state");
    if (!/Unreachable/.test(stateText) || !/since \d{1,2}:\d{2}/.test(stateText)) fail(`the place of the thread says ${J(stateText)} of the server, not its word and "since 14:02"`);
    const servers = byTid(page, "remote-servers").first(), size = await servers.boundingBox();
    if (!size || size.height < 44 - 0.5) fail(`the Servers button is ${size?.height} pt high, not 44`);
    await press(page, servers);
    if (!await until(() => byTid(page, "srv-facts", { place: "screen", server: STUDIO }).count(), WAIT)) fail("Servers opened no server detail");
    await mockEval("delete flags.items;", url);
    await ctx.close();
  }

  // ---- C-RO-10, C-CH-22: a refusal's sentence goes when the server is connected again
  {
    await fresh();
    const { page, ctx } = await on({ chat: key("c_L23_empty") });
    const err = byTid(page, "composer-err");
    await mockEval(`flags.send = { refuse: { status: 429, code: "cap", error: "Too many turns run at once" } };`, url);
    await press(page, box(page));
    await page.keyboard.type("will be refused");
    await press(page, byTid(page, "send").first());
    if (!await until(async () => (await err.first().textContent().catch(() => "")).includes("Too many turns run at once"), WAIT)) fail(`a refused Send of a chat of a section says ${J(await err.first().textContent().catch(() => ""))} under the composer`);
    await mockEval(`delete flags.send;`, url);
    await page.waitForTimeout(700);
    if (!await err.count()) fail("the refusal's sentence went by itself, with the server connected all the while");
    await drop();
    if (phone) { if (!await until(() => said(page, "off"), WAIT)) fail("the server dropped: the composer does not say so, or a bar is drawn on the phone"); }
    else await byTid(page, "remote-bar").first().waitFor({ state: "attached", timeout: WAIT });
    await back();
    if (!await until(async () => !await byTid(page, "remote-bar").count() && (await box(page).getAttribute("data-placeholder").catch(() => "")) !== AWAY, WAIT)) fail("back, the warning stays");
    if (!await until(async () => !await err.count(), WAIT)) fail(`back, the refusal's sentence stays under the composer: ${J(await err.first().textContent().catch(() => ""))}`);
    if (await text(page) !== "will be refused") fail(`the refused text is not in the box: ${J(await text(page))}`);
    await ctx.close();
  }
  note("the box takes no key once the server is gone, the archived bar's two forms, the attach button and the empty thread of a chat its server no longer has, a refusal's sentence cleared by the server's return");
}, { viewports, page: false });
