// L23 (new; package rn-sw-gaps-c): the composer and the thread of a chat that is shown as it was, in the cases no check looked at: its server drops
// while a list is open or the chat is archived, the chat is deleted on its server, a refusal's sentence is under the box when the server comes back.
// On the SEC seed (the server "Studio Mac" of the sections), at desktop, tablet and phone.
//   C-MN-09  the @ list of a board chat: open with the server connected; as the server drops it is gone, and Enter and the arrows pick no board
//   C-RO-07  an archived chat of a section: "Archived — unarchive to continue" and the button; its server dropped, "Archived." and the reason with
//            no button and no sentence under it; back, the button
//   C-IM-25  a chat its server no longer has: the attach button is off, and its title is the gone sentence ("This chat is no longer on Studio Mac.")
//   C-RO-03  an empty chat deleted on its server: no suggestion to send, the gone sentence in the thread's place (a live empty chat offers suggestions)
//   C-RO-10, C-CH-22  a refusal's sentence under the composer goes when its server is connected again (a Send refused: "Too many turns run at once")
//   C-RO-12  a Send answered 404 "not_found" marks the chat as no longer on its server: the bar of a chat that is gone, Send off
//   C-RO-01  the box of a chat shown as it was says why in its place: "<server> is not connected" / the gone sentence
// The choices that clear that sentence (model, effort…) are L16's.
import { callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { byTid, press } from "./sel.mjs";
import { WAIT, textOf } from "./chat.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const J = JSON.stringify;
const STUDIO = "s_studio", AWAY = "Studio Mac is not connected", GONE = "This chat is no longer on Studio Mac.";
const key = (id) => `${STUDIO}~${id}`;

await check("L23 a chat shown as it was: the @ list, the archived bar, the attach button, an empty thread, a refusal's sentence", async ({ url, viewport, open, fail, note }) => {
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
  const text = async (page) => (await box(page).textContent()) ?? "";

  // ---- C-MN-09: the @ list is open, the server drops
  {
    await fresh();
    const { page, ctx } = await on({ board: key("b_loose"), chat: key("c_on_floor") });
    const calls = callsOf(page), pop = byTid(page, "mention-pop");
    await press(page, box(page));
    await page.keyboard.type("@");
    if (!await until(() => pop.count(), 10000)) fail('"@" in a board chat of a section opened no list of boards');
    else {
      await drop();
      if (!await until(async () => !await pop.count(), WAIT)) fail("the @ list stays open when the chat's server drops");
      if (!await until(async () => (await box(page).getAttribute("data-placeholder")) === AWAY, WAIT)) fail(`the box of a chat whose server dropped says ${J(await box(page).getAttribute("data-placeholder"))} when empty, not ${J(AWAY)}`);
      const was = calls.length;
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Tab");
      await page.waitForTimeout(500);
      if (await text(page) !== "@") fail(`a board was picked, or the box took a key, while the server is away: the box holds ${J(await text(page))}`);
      if (await byTid(page, "ctx-chip", { ref: true }).count()) fail("a board was mentioned while the server is away");
      // (the "@" typed just before the drop may still be saved: that is the draft's own save, which SEC.7 proves)
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
      if (!(await bar.first().textContent()).startsWith("Archived — unarchive to continue") || !await byTid(page, "unarchive").count()) fail(`connected, the bar of an archived chat of a section says ${J(await bar.first().textContent())} and has ${await byTid(page, "unarchive").count()} Unarchive`);
      await drop();
      if (!await until(async () => (await bar.first().textContent().catch(() => "")).startsWith("Archived. "), WAIT)) fail(`its server dropped, the bar says ${J(await bar.first().textContent().catch(() => ""))}, not "Archived." and the reason`);
      else if (!(await bar.first().textContent()).includes(AWAY)) fail(`its server dropped, the bar does not name the server: ${J(await bar.first().textContent())}`);
      if (await byTid(page, "unarchive").count()) fail("its server dropped, the bar offers Unarchive");
      if (await byTid(page, "composer-err").count() || await box(page).count()) fail("its server dropped, an archived chat draws a sentence under its bar or a box");
      await back();
      if (!await until(async () => (await byTid(page, "unarchive").count()) === 1 && (await bar.first().textContent()).startsWith("Archived — unarchive to continue"), WAIT)) fail(`back, the bar is ${J(await bar.first().textContent())} with ${await byTid(page, "unarchive").count()} Unarchive`);
    }
    await ctx.close();
  }

  // ---- C-IM-25: a chat its server no longer has: the attach button says so
  {
    await fresh();
    const { page, ctx } = await on({ chat: key("c_plain") });
    const attach = byTid(page, "attach-btn").first();
    if (!await until(async () => await attach.count() && !await attach.isDisabled(), WAIT)) fail("the attach button of a live chat of a section is off");
    else if (await attach.getAttribute("title") !== "Add images") fail(`the attach button of a live chat says ${J(await attach.getAttribute("title"))}`);
    await mockEval(`await elsewhere("${STUDIO}", "DELETE", "/chats/c_plain")`, url);
    if (!await until(async () => (await byTid(page, "remote-bar").first().getAttribute("data-kind").catch(() => "")) === "gone", WAIT)) fail("the view of a chat deleted on its server does not say so");
    else if (await box(page).getAttribute("data-placeholder") !== GONE && !await until(async () => (await box(page).getAttribute("data-placeholder")) === GONE, WAIT)) fail(`the box of a chat its server no longer has says ${J(await box(page).getAttribute("data-placeholder"))} when empty, not ${J(GONE)}`);
    if (!await until(async () => await attach.isDisabled(), WAIT) || await attach.getAttribute("title") !== GONE) fail(`the attach button of a chat its server no longer has is ${await attach.isDisabled() ? "off" : "on"} and says ${J(await attach.getAttribute("title"))}, not ${J(GONE)}`);
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
    if (!await until(async () => (await textOf(page, "empty-reason").catch(() => "")) === GONE, WAIT)) fail(`an empty chat its server no longer has says ${J(await textOf(page, "empty-reason").catch(() => ""))} in its thread, not ${J(GONE)}`);
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
    if (!await until(async () => (await byTid(page, "remote-bar").first().getAttribute("data-kind").catch(() => "")) === "gone", WAIT)) fail("a Send answered 404 not_found did not mark the chat as no longer on its server");
    else {
      if (await textOf(page, "remote-bar-text") !== GONE) fail(`the bar of that chat says ${J(await textOf(page, "remote-bar-text"))}, not ${J(GONE)}`);
      if (!await byTid(page, "send").first().isDisabled()) fail("Send is on for a chat its server no longer has");
    }
    await mockEval(`delete flags.send;`, url);
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
    await byTid(page, "remote-bar").first().waitFor({ state: "attached", timeout: WAIT });
    await back();
    if (!await until(async () => !await byTid(page, "remote-bar").count(), WAIT)) fail("back, the warning stays");
    if (!await until(async () => !await err.count(), WAIT)) fail(`back, the refusal's sentence stays under the composer: ${J(await err.first().textContent().catch(() => ""))}`);
    if (await text(page) !== "will be refused") fail(`the refused text is not in the box: ${J(await text(page))}`);
    await ctx.close();
  }
  note("the @ list goes with the server, the archived bar's two forms, the attach button and the empty thread of a chat its server no longer has, a refusal's sentence cleared by the server's return");
}, { viewports, page: false });
