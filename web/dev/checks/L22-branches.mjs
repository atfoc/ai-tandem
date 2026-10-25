// L22 (new in the app, package rn-sw-gaps-ab): what belongs to one branch of a chat, on a chat with two branches that share their first turn (a tool
// call among it), at desktop, tablet and phone. It has no old check to port: the rows were `none`, covered by the paid script only, or `yes, unshown`.
//   B-TH-18  A tool card the user opened in the shared part of the thread is closed on the other branch (the thread is built anew per branch).
//   B-TH-12  (the branch's wording) The thread of a branch marks where the part it shares with its source ends: "Shared with the branch this started from up to here".
//   B-SA-19  The subagent rows follow the branch: main's thread has the row of its subagent, the branch cut before it has none.
//   B-TR-26  The menu of a tree row stays inside the window when its row is at the foot of it (a popover pulled back inside, a sheet on the phone).
//   B-SA-17  The drawer of a subagent started in the part a fork copied is read-only: the permission card in its thread acts on nothing; the drawer of
//            one started after the copy answers.
//   B-FK-17  "Fork and edit" on a message makes the new chat with that message in its box, copied up to the point before the message.
//   B-FK-25  (the quiet alert) "1 other branch working" in the header opens the tree.
//   B-FK-29  Two branches work at once: viewing one makes no call, Stop sends the interrupt of the branch shown only, the other still has its Stop and
//            its own, and the result of a subagent told to main while the branch is shown lands in main's thread and not in the branch's.
// The chat is made in the mock: main has two turns, the branch `alt` is cut after the first one and has a turn of its own; the page moves to a
// branch through the tree (the end row of the branch, a double click or two taps: fork.mjs `openRow`).
import { callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { byTid, press } from "./sel.mjs";
import { closeTree, composerSeen, endRow, menuOfRow, openRow, openTree, pressAct } from "./fork.mjs";
import { rowOfCard, toolCards } from "./cards.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const J = JSON.stringify;
const WAIT = 15000;
const CHAT = "c_br";
/** In the mock: the chat with two branches. Main: a turn with a tool call, a second turn. alt: the first turn, then a turn of its own. */
const MAKE = `chats.${CHAT} = chat(${J(CHAT)}, { name: "Two branches", group: "g_shop" });
  items.${CHAT} = [{ kind: "user", text: "List the files" }, { kind: "tool", toolId: "t_ls", name: "Bash", input: { command: "ls", description: "List the files" }, result: "a.txt\\nb.txt" },
    { kind: "text", text: "Two files.", done: true }, { kind: "end", point: "p1" }, { kind: "user", text: "Check the fonts" },
    { ...tool("t_sp", "mcp__board__spawn_subagent", { description: "Check the fonts", prompt: "Check the fonts." }, "Started."), subagent: "sa_x" },
    { kind: "text", text: "Checking.", done: true }, { kind: "end", point: "p2" }];
  subs.${CHAT} = [{ id: "sa_x", description: "Check the fonts", prompt: "Check the fonts.", kind: "claude", model: "sonnet", effort: "medium", window: 200000, tool: "t_sp", status: "running", started: T0 - 5 * MIN, tokens: 1000, toolUses: 1 }];
  const alt = addBranch(${J(CHAT)}, "main", 4, {}, "alt");
  alt.items.push({ kind: "user", text: "Something else" }, { kind: "text", text: "Else.", done: true }, { kind: "end", point: "q2" });
  send({ type: "snapshot", ...snapshot() });`;

await check("L22 what belongs to one branch of a chat", async ({ url, viewport, layout, open, fail }) => {
  await seed(url, "A1");
  await mockEval(MAKE, url);
  const say = (line) => fail(`${viewport}: ${line}`);
  // (the phone draws a subagent's result as the report row of its card, T2: `sub-report-row`; the wide layouts as the `sub-result` row)
  const RESULT = viewport === "phone" ? "sub-report-row" : "sub-result";

  // ---- B-TH-18: an open tool card of the shared part is closed on the other branch
  {
    const { page, ctx } = await open({ sel: { chat: CHAT }, wait: '[data-testid="chat-head"]' });
    const opened = async () => (await toolCards(page))?.map((c) => c.open) ?? [];
    const onBranch = (text) => page.waitForFunction((t) => [...document.querySelectorAll('[data-testid="msg"][data-role="user"]')].some((m) => (m.textContent ?? "").includes(t)), text, { timeout: WAIT });
    await byTid(page, "tool-card").first().waitFor({ state: "visible", timeout: WAIT });
    if (J(await opened()) !== J([false])) say(`main's thread has the tool cards ${J(await opened())}, not one closed`);
    await press(page, await rowOfCard(page, 0));
    if (!await until(async () => J(await opened()) === J([true]), WAIT)) say("the tool card of main did not open");
    await openTree(page);
    await openRow(page, endRow(page, "alt"));
    await onBranch("Something else");
    if (!await until(async () => J(await opened()) === J([false]), WAIT)) say(`the tool card of the shared part is ${J(await opened())} on the other branch: it carries its state over from main, not closed`);
    // (B-TH-12) the branch's thread marks where it stops sharing the first turn, in its own words, after that turn
    const mark = byTid(page, "prefix-end").first();
    if (!await until(() => mark.count(), WAIT)) say("the branch's thread has no line where the shared part ends");
    else if ((await mark.textContent())?.trim() !== "Shared with the branch this started from up to here") say(`the line where the shared part of a branch ends says "${await mark.textContent()}"`);
    await ctx.close();
  }

  // ---- B-SA-19: the subagent rows of main are not in the branch cut before the subagent started
  {
    const { page, ctx } = await open({ sel: { chat: CHAT }, wait: '[data-testid="chat-head"]' });
    const rows = () => byTid(page, "sub-row").count();
    if (!await until(async () => (await rows()) === 1, WAIT)) say(`main's thread has ${await rows()} subagent rows, not the one of its subagent`);
    await openTree(page);
    await openRow(page, endRow(page, "alt"));
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="msg"][data-role="user"]')].some((m) => (m.textContent ?? "").includes("Something else")), null, { timeout: WAIT });
    if (!await until(async () => (await rows()) === 0, WAIT)) say(`the other branch's thread shows ${await rows()} subagent rows: the subagent of main`);
    if (await byTid(page, RESULT).count()) say("the other branch's thread shows a result row of main's subagent");
    await openTree(page);
    await openRow(page, endRow(page, "main"));
    if (!await until(async () => (await rows()) === 1, WAIT)) say(`back on main its thread has ${await rows()} subagent rows, not 1`);
    await ctx.close();
  }

  // ---- B-TR-26: the menu of the lowest message row of the tree, in a window 240 high (the popup's list is 30 points tall, its row at the foot, 70 below
  // it): the menu of three items (92 points) does not fit below the row, and is put above it, inside the window. The window's width is the device's own;
  // on the phone the menu is a sheet.
  {
    const { page, ctx } = await open({ sel: { chat: CHAT }, wait: '[data-testid="chat-head"]' });
    const width = page.viewportSize().width;
    await openTree(page);
    if (viewport !== "phone") { await page.setViewportSize({ width, height: 240 }); await page.waitForTimeout(300); }
    const last = byTid(page, "fk-row", { kind: "user" }).last();
    await last.scrollIntoViewIfNeeded();
    await menuOfRow(page, last);
    if (viewport === "phone" && (await byTid(page, "fk-row-sheet").count() !== 1 || await byTid(page, "fk-nav").count())) say("the held row's action sheet is not alone: the tree is drawn under it, or the sheet is missing");
    const box = await byTid(page, "menu").last().boundingBox(), size = page.viewportSize(), row = viewport === "phone" ? null : await last.boundingBox(); // (the phone's tree is not drawn while the row's sheet is open)
    if (!box) say("the menu of a tree row has no box");
    else if (box.x < 0 || box.y < 0 || box.x + box.width > size.width + 0.5 || box.y + box.height > size.height + 0.5) say(`the menu of the lowest row of the tree is at ${J(box)} in a window of ${J(size)}: it leaves the window`);
    else if (viewport !== "phone" && box.y + box.height > row.y + row.height) say(`the menu of the row at the foot of a low window is at ${J(box)}, below its row at ${J(row)}: it is not put above it`);
    await ctx.close();
  }

  // ---- B-SA-17: a fork of the chat, made after the first subagent was started: that subagent's drawer is read-only, the fork's own is not
  {
    const ask = (sid) => ({ kind: "perm", requestId: "q1", toolName: "Bash", input: { command: "rm -rf dist" }, subagent: sid });
    const subOf = (id, tool, description) => ({ id, description, prompt: `${description}.`, kind: "claude", model: "sonnet", effort: "medium", window: 200000, tool, status: "completed", started: 1000, ended: 61000, tokens: 1000, toolUses: 1 });
    await mockEval(`chats.c_fk = chat("c_fk", { name: "Fork of two", group: "g_shop", forkedFrom: ${J(CHAT)}, forkedFromTitle: "Two branches", forkedBranch: "main", forkedAt: 8, locked: true });
      items.c_fk = [...clone(items.${CHAT}.slice(0, 8)), { kind: "user", text: "Check the colours" }, { ...tool("t_own", "mcp__board__spawn_subagent", { description: "Check the colours", prompt: "Check the colours." }, "Started."), subagent: "sa_y" },
        { kind: "text", text: "Checking.", done: true }, { kind: "end", point: "r2" }];
      subs.c_fk = ${J([subOf("sa_x", "t_sp", "Check the fonts"), subOf("sa_y", "t_own", "Check the colours")])};
      subItems["c_fk/sa_x"] = ${J([ask("sa_x")])}; subItems["c_fk/sa_y"] = ${J([ask("sa_y")])};
      send({ type: "snapshot", ...snapshot() });`, url);
    const { page, ctx } = await open({ sel: { chat: "c_fk" }, wait: '[data-testid="chat-head"]' });
    const LEFT = { position: { x: 24, y: 10 } };
    const drawer = byTid(page, "sub-drawer");
    const opened = async (sid, from) => {
      // (the phone's neighbour bar names its buttons "sub-screen-next" and "sub-screen-prev", T2)
      if (from) await press(page, byTid(drawer, viewport === "phone" ? "sub-screen-next" : "sub-next").first()); // (the drawer covers the rows on a narrow window: the next subagent is one press away)
      else await press(page, byTid(page, "sub-row", { sub: sid }).first(), LEFT);
      await drawer.first().waitFor({ state: "visible", timeout: WAIT });
      // (changed with T2, again with X2: the phone's subagent screen folds the steps of a subagent that ended, "N steps" -- these two ended. A request that can
      // still be answered is never inside the fold (X2): sa_y's live card stands under the fold's row, so it is NOT opened with the fold first. sa_x is read-only,
      // its request is closed and cannot be answered, so it stays folded: the fold is pressed for it only if the card is not drawn)
      if (viewport === "phone") {
        await until(async () => (await byTid(drawer, "sub-screen").first().getAttribute("data-sub").catch(() => null)) === sid, WAIT);
        const live = !!from; // (the first call is sa_x, read-only; the second, reached by "next", is sa_y)
        if (live) {
          if (!await until(async () => await byTid(drawer, "perm").count() === 1, WAIT)) say(`the live permission card of ${sid} is not drawn without the fold being pressed`);
          if (await byTid(drawer, "sub-steps", { open: "true" }).count()) say(`the fold of ${sid} was opened: the live card should stand outside it`);
        } else {
          const fold = byTid(drawer, "sub-steps", { open: "false" }).first();
          if (await until(async () => await fold.count() > 0, 3000)) await press(page, fold);
        }
      }
      if (!await until(async () => (await drawer.first().getAttribute("data-sub")) === sid && await byTid(drawer, "perm").count() === 1, WAIT)) say(`the drawer of ${sid} did not show its permission card`);
      return { readonly: await drawer.first().getAttribute("data-readonly"), buttons: await byTid(drawer, "perm-allow").count(), closed: await byTid(drawer, "perm").first().getAttribute("data-closed") };
    };
    const inCopy = await opened("sa_x");
    if (inCopy.readonly !== "true" || inCopy.buttons !== 0 || inCopy.closed !== "true") say(`the drawer of a subagent started in the copied part is ${J(inCopy)}, not read-only with a closed permission card`);
    const own = await opened("sa_y", "sa_x");
    if (own.readonly !== "false" || own.buttons !== 1) say(`the drawer of a subagent the fork started is ${J(own)}, not live with its Allow button`);
    await ctx.close();
  }

  // ---- B-FK-17: "Fork and edit" on the second message: the fork is cut before it, and its box holds the message
  {
    const { page, ctx } = await open({ sel: { chat: CHAT }, wait: '[data-testid="chat-head"]' });
    const calls = callsOf(page);
    const asked = () => calls.filter((c) => c.method === "POST" && /\/chats\/c_br\/fork/.test(c.path));
    const msg = byTid(page, "msg", { item: 4 }).first();
    await msg.waitFor({ state: "visible", timeout: WAIT });
    await pressAct(page, msg, "forkEdit");
    if (!await until(() => asked().length === 1, WAIT)) say("Fork and edit made no fork call");
    else if (asked()[0].body?.at !== 4 || asked()[0].body?.message !== 4) say(`Fork and edit asked for ${J(asked()[0].body)}, not a fork at the point before the message (4) with that message (4)`);
    if (!await until(async () => (await composerSeen(page)).box === "Check the fonts", WAIT)) say(`the box of the new chat holds ${J((await composerSeen(page)).box)}, not the message "Check the fonts"`);
    const usersNow = () => page.evaluate(() => [...document.querySelectorAll('[data-testid="msg"][data-role="user"]')].map((m) => (m.textContent ?? "").trim()));
    await until(async () => (await usersNow()).length > 0, WAIT); // (the new chat's thread is drawn a moment after its box)
    const users = await usersNow();
    if (users.length !== 1 || !users[0].includes("List the files")) say(`the new chat's thread has the user messages ${J(users)}: the copy is not the first turn alone`);
    const name = (await byTid(page, "chat-head-name").first().textContent().catch(() => "")) ?? "";
    if (!name.includes("(fork)")) say(`the chat that is open after Fork and edit is "${name}", not the fork`);
    await ctx.close();
  }

  // ---- B-FK-29: two branches work at once; Stop is of the branch shown; viewing sends nothing; a result goes to the branch that started it
  {
    await mockEval(`setSession(${J(CHAT)}, "main", { status: "thinking" }); setSession(${J(CHAT)}, "alt", { status: "tool", statusTool: "Bash" });`, url);
    const { page, ctx } = await open({ sel: { chat: CHAT }, wait: '[data-testid="chat-head"]' });
    const calls = callsOf(page);
    const writes = () => calls.filter((c) => c.method !== "GET");
    const interrupts = () => calls.filter((c) => c.method === "POST" && /\/interrupt/.test(c.path)).map((c) => c.path.replace(/^.*\/interrupt/, ""));
    const stop = byTid(page, "stop");
    const alert = async () => (await byTid(page, "fk-alert", { kind: "quiet" }).first().textContent().catch(() => "")) ?? "";
    const onBranch = (text) => page.waitForFunction((t) => [...document.querySelectorAll('[data-testid="msg"][data-role="user"]')].some((m) => (m.textContent ?? "").includes(t)), text, { timeout: WAIT });
    await stop.first().waitFor({ state: "visible", timeout: WAIT });
    if (layout === "phone") {
      // (the content bar has no quiet pill: the Tree's count says that the chat has split, and the Tree is the way to the other branch)
      const tree = byTid(page, "chat-tree").first();
      if (await tree.getAttribute("data-count") !== "2") say(`with alt working too, the Tree button counts ${await tree.getAttribute("data-count")}, not 2 branches`);
      await openTree(page);
    } else {
      if (!await until(async () => (await alert()).includes("1 other branch working"), WAIT)) say(`on main, with alt working too, the header says "${await alert()}", not "1 other branch working"`);
      // (B-FK-25) the alert names the other branches that work and opens the tree
      await press(page, byTid(page, "fk-alert", { kind: "quiet" }).first());
      await byTid(page, "fk-row").first().waitFor({ state: "visible", timeout: WAIT });
    }
    if (layout === "phone") { // (the row a working branch ends at: its mark says so in a word, and its Stop is a 44 pt target)
      const box = await byTid(page, "fk-stop").first().boundingBox();
      if (!box || box.height < 44 || box.width < 44) say(`the Stop of the phone's tree is ${J(box)}, not a 44 pt target`);
      if (!/working|tool|Bash/i.test(await byTid(page, "fk-mark").first().textContent().catch(() => "") ?? "")) say("the working branch's row has no word for what it does");
    }
    await closeTree(page);
    if (!await until(async () => !(await byTid(page, "fk-nav").count()), WAIT)) say("the tree did not close");
    const w0 = writes().length;
    // alt is shown: viewing makes no call, its Stop is there, and a press on it interrupts alt and nothing else
    await openTree(page);
    await openRow(page, endRow(page, "alt"));
    await onBranch("Something else");
    if (!await until(async () => (await stop.count()) === 1, WAIT)) say("the working branch that is shown has no Stop");
    if (writes().length !== w0) say(`viewing the other branch made the calls ${J(writes().slice(w0).map((c) => `${c.method} ${c.path}`))}`);
    await press(page, stop.first());
    if (!await until(() => interrupts().length === 1, WAIT)) say(`Stop on the branch shown made ${interrupts().length} interrupt calls, not 1`);
    else if (interrupts()[0] !== "?branch=alt") say(`Stop on the branch alt sent the interrupt ${J(interrupts()[0])}, not of that branch`);
    // a result told to main while alt is shown reaches main's thread, not alt's
    await mockEval(`const list = items.${CHAT}; list.push({ kind: "subresult", subagent: "sa_x" }); send({ type: "chat_items", chat: ${J(CHAT)}, branch: "main", version: (versions.${CHAT} = (versions.${CHAT} ?? 1) + 1), updates: [{ index: list.length - 1, item: list[list.length - 1] }] });`, url);
    await page.waitForTimeout(300);
    if (await byTid(page, RESULT).count()) say("the result of main's subagent shows in the thread of the branch that is shown");
    // main is still working, with its own Stop, and shows the result
    await openTree(page);
    await openRow(page, endRow(page, "main"));
    await onBranch("Check the fonts");
    if (!await until(async () => (await byTid(page, RESULT).count()) === 1, WAIT)) say(`main's thread has ${await byTid(page, RESULT).count()} result rows of its subagent, not 1`);
    if (!await until(async () => (await stop.count()) === 1, WAIT)) say("main, still working after the Stop on the other branch, has no Stop");
    else {
      await press(page, stop.first());
      if (!await until(() => interrupts().length === 2, WAIT)) say(`Stop on main made ${interrupts().length - 1} interrupt calls of its own, not 1`);
      else if (interrupts()[1] !== "?branch=main") say(`Stop on main sent the interrupt ${J(interrupts()[1])}, not of main`);
    }
    await ctx.close();
  }
}, { viewports, page: false });
