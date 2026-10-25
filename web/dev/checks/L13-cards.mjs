// L13 (new in the app, package S6): the rows of the tool card and the permission card that no browser check proved on the page (parity inventory,
// area B: B-PM-01 to 08, B-TC-08, B-TC-29), at desktop, tablet and phone. It has no old check to port; A5.2, A5.3, A5.4 prove the rest of the cards.
//   The permission card (B-PM-01 to 03, 05): "Allow Bash?" with the agent's description and what it asks for in a block, Allow and Don't while it
//     waits; a card asked by a subagent says "Asked by subagent · <its description>" above its title; a press on Allow or Don't makes one POST
//     …/permission naming the request (and the subagent when one asked: the id alone repeats between a chat's agent and its subagents); the card
//     stays as it is until the server says it was decided, and then it has no buttons and says "Approved" or "Denied" (B-PM-04: a card answered
//     elsewhere is decided with no reload).
//   A failed answer (B-PM-06): the server's sentence is under the card, and the card stays pending, with its buttons.
//   Where it cannot be answered (B-PM-07, 08): an archived chat's request has no buttons and no line; one in the part of a fork that was copied has
//     no buttons and says "Closed: it was asked in the thread this was copied from".
//   Show (B-TC-08): a card of a board tool that names a board that exists has "Show", which opens that board; not while the call runs, and not for a
//     board that is archived.
//   Colour (B-TC-29): a command of up to 20,000 characters shown whole is coloured, a longer one is drawn as it is.
// On the phone (package T2) the permission card says its words differently, and the half of the check that reads them expects the phone's:
//   the card is "Claude wants to run a command" (a subagent's: "Subagent “<description>” wants to use the board", in the place of "Asked by
//   subagent · …"), the agent's own title ("Remove the copied fonts"; none when it gave none, there is no "Allow Bash?"), the whole command in a
//   box, and Deny and Allow (48 pt); an answered card is one line, "Allowed · <title or who>" / "Denied · …", which a tap opens to the card with its
//   "Approved" or "Denied". A press sends the same POST. The cards that cannot be answered have the same words as on the wide layouts.
//   Colour moved: the phone's step draws a command whole in a plain box with Copy (it is not coloured as code; there is no Show all), so the
//   bound of 20,000 characters is proved on the phone as "a command of either length is drawn whole and uncoloured".
import { callMatcher, callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { byTid, openChat, press } from "./sel.mjs";
import { cardAt, permAt, permCards, toolCards } from "./cards.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const J = JSON.stringify;
const WAIT = 15000;
const REFUSED = "The server refused.";
/** In the mock: a chat with these items (and subagents), shown to the page. */
const make = (id, o, list, subList = []) => `chats.${id} = chat(${J(id)}, ${J({ name: id, group: "g_shop", ...o })}); items.${id} = ${J(list)}; subs.${id} = ${J(subList)}; send({ type: "snapshot", ...snapshot() });`;
/** In the mock: this item of the chat is now this one, told to the page. */
const put = (id, at, item) => `items.${id}[${at}] = ${J(item)}; send({ type: "chat_items", chat: ${J(id)}, branch: "main", version: (versions.${id} = (versions.${id} ?? 1) + 1), updates: [{ index: ${at}, item: items.${id}[${at}] }] });`;
const bash = (command) => ({ kind: "tool", toolId: "t1", name: "Bash", input: { command, description: "Run it" }, result: "ok" });

await check("L13 permission cards and tool cards: the answers, the closed ones, Show, colour", async ({ url, viewport, open, fail, note }) => {
  await seed(url, "A1");
  const say = (line) => fail(line);
  const ASK = { kind: "perm", requestId: "q1", toolName: "Bash", input: { command: "rm -rf dist/fonts", description: "Remove the copied fonts" } };
  const phone = viewport === "phone";
  const BUTTONS = phone ? ["Deny", "Allow"] : ["Allow", "Don't"];
  const SUB = { kind: "perm", requestId: "q1", toolName: "mcp__board__apply", input: { file_path: "/Users/demo/a.go" }, subagent: "s1" };
  const subs = [{ id: "s1", tool: "s0", description: "Review the sum", prompt: "Review.", kind: "claude", model: "sonnet", effort: "medium", status: "running", started: 1, tokens: 0, window: 200000, toolUses: 0 }];
  await mockEval(make("c_perm", {}, [{ kind: "user", text: "Fix the build." }, ASK, SUB, { kind: "perm", requestId: "q2", toolName: "Bash", input: { command: "git push" }, decided: "allow" }, { kind: "perm", requestId: "q3", toolName: "Edit", input: { file_path: "/a.go" }, decided: "deny" }], subs), url);

  // ---- the cards, and a press on Allow and on Don't
  {
    const { page, ctx } = await open({ sel: { chat: "c_perm" }, wait: '[data-testid="chat-head"]' });
    const calls = callsOf(page), asked = () => calls.filter((c) => c.method === "POST" && /\/permission/.test(c.path));
    try {
      if (!await until(async () => (await permCards(page))?.length === 4, WAIT)) fail(`${viewport}: ${(await permCards(page))?.length} permission cards, not 4`);
      const [own, sub, ok, no] = await permCards(page);
      if (phone) {
        if (own.state !== "pending" || own.who !== "Claude wants to run a command" || own.title !== "Remove the copied fonts" || own.what !== "rm -rf dist/fonts" || J(own.buttons) !== J(BUTTONS) || own.sub || own.reason) fail(`${viewport}: the waiting request is drawn as ${J(own)}`);
        if (sub.who !== "Subagent “Review the sum” wants to use the board" || sub.title !== "" || sub.what !== "/Users/demo/a.go" || sub.sub) fail(`${viewport}: the request of a subagent is drawn as ${J(sub)}`);
        if (ok.state !== "allow" || !ok.folded || !/^✓Allowed · Claude wants to run a command(\d+:\d\d)?git push$/.test(ok.foldedText) || ok.buttons.length || no.state !== "deny" || !no.folded || !/^✕Denied · Claude wants to edit a file(\d+:\d\d)?\/a\.go$/.test(no.foldedText) || no.buttons.length) fail(`${viewport}: the decided requests are drawn as ${J([ok, no])}`);
        // (a tap on the folded line opens the card, which says it as the wide one does)
        await press(page, byTid(await permAt(page, 2), "perm-folded"));
        if (!await until(async () => (await permCards(page))[2].done === "Approved", WAIT)) fail(`${viewport}: the answered request opened by a tap says "${(await permCards(page))[2].done}", not "Approved"`);
      } else {
        if (own.state !== "pending" || own.title !== "Allow Bash?" || own.reason !== "Remove the copied fonts" || own.what !== "rm -rf dist/fonts" || J(own.buttons) !== J(BUTTONS) || own.sub) fail(`${viewport}: the waiting request is drawn as ${J(own)}`);
        if (sub.sub !== "Asked by subagent · Review the sum" || sub.title !== "Allow apply?" || sub.what !== "/Users/demo/a.go") fail(`${viewport}: the request of a subagent is drawn as ${J(sub)}`);
        if (ok.state !== "allow" || ok.done !== "Approved" || ok.buttons.length || no.state !== "deny" || no.done !== "Denied" || no.buttons.length) fail(`${viewport}: the decided requests are drawn as ${J([ok, no])}`);
      }

      // a press on Allow: the chat's own request, named by its id alone
      await press(page, byTid(await permAt(page, 0), "perm-allow"));
      if (!await until(() => asked().length === 1, WAIT)) fail(`${viewport}: Allow made no call`);
      else if (J(asked()[0].body) !== J({ requestId: "q1", allow: true })) fail(`${viewport}: Allow sent ${J(asked()[0].body)}`);
      // the subagent's: the same id and the subagent named
      await press(page, byTid(await permAt(page, 1), "perm-deny"));
      if (!await until(() => asked().length === 2, WAIT)) fail(`${viewport}: Don't made no call`);
      else if (J(asked()[1].body) !== J({ requestId: "q1", allow: false, subagent: "s1" })) fail(`${viewport}: Don't of the subagent's request sent ${J(asked()[1].body)}`);
      // (nothing changes until the server says so)
      if ((await permCards(page))[0].state !== "pending") fail(`${viewport}: the request was decided before the server said so`);
      // decided elsewhere, with no reload
      await mockEval(put("c_perm", 1, { ...ASK, decided: "allow" }), url);
      // (on the phone it is folded to one line: "Allowed · …"; a tap shows "Approved")
      if (phone && !await until(async () => (await permCards(page))[0].folded, WAIT)) fail(`${viewport}: a request answered elsewhere is not folded: ${J((await permCards(page))[0])}`);
      if (phone) await press(page, byTid(await permAt(page, 0), "perm-folded"));
      if (!await until(async () => (await permCards(page))[0].done === "Approved" && !(await permCards(page))[0].buttons.length, WAIT)) fail(`${viewport}: a request answered elsewhere does not show as approved: ${J((await permCards(page))[0])}`);
    } catch (e) { say(`${viewport}: the permission cards: ${e.message.split("\n")[0]}`); }
    await ctx.close();
  }

  // ---- an answer that fails: the error under the card, the card still pending
  {
    await mockEval(make("c_perm", {}, [{ kind: "user", text: "Fix the build." }, ASK]), url);
    const { page, ctx } = await open({ sel: { chat: "c_perm" }, wait: '[data-testid="chat-head"]' });
    try {
      const refuse = callMatcher(/^POST \/api\/chats\/c_perm\/permission/);
      await page.route((u) => refuse(u), (route) => route.fulfill({ status: 409, contentType: "application/json", body: J({ error: REFUSED, code: "refused" }) }));
      await byTid(page, "perm-allow").first().waitFor({ state: "visible", timeout: WAIT });
      await press(page, byTid(page, "perm-allow").first());
      if (!await until(async () => (await permCards(page))[0].error === REFUSED, WAIT)) fail(`${viewport}: a refused answer shows "${(await permCards(page))[0].error}" under the card, not "${REFUSED}"`);
      const [c] = await permCards(page);
      if (c.state !== "pending" || J(c.buttons) !== J(BUTTONS)) fail(`${viewport}: after a refused answer the card is ${c.state} with ${J(c.buttons)}`);
    } catch (e) { say(`${viewport}: a refused answer: ${e.message.split("\n")[0]}`); }
    await ctx.close();
  }

  // ---- where it cannot be answered: an archived chat, a chat of an agent that is gone, the copied part of a fork
  {
    const list = [{ kind: "user", text: "Fix the build." }, ASK];
    await mockEval(make("c_perm", { archived: true }, list) + make("c_perm_old", { instructionsSent: true }, list), url);
    for (const id of ["c_perm", "c_perm_old"]) {
      const { page, ctx } = await open({ sel: { chat: id }, wait: '[data-testid="chat-head"]' });
      try {
        await byTid(page, "perm").first().waitFor({ state: "visible", timeout: WAIT });
        const [c] = await permCards(page);
        if (c.buttons.length || c.done) fail(`${viewport}: the request of ${id === "c_perm" ? "an archived chat" : "a disabled chat"} has ${J(c.buttons)} and says "${c.done}": it has no buttons and no line`);
      } catch (e) { say(`${viewport}: ${id}: ${e.message.split("\n")[0]}`); }
      await ctx.close();
    }
    await mockEval(make("c_perm_fork", { forkedFrom: "c_plain", forkedFromTitle: "A plain chat", forkedBranch: "main", forkedAt: 2 }, [{ kind: "user", text: "Fix the build." }, ASK, { kind: "user", text: "And then?" }, { ...ASK, requestId: "q9" }]), url);
    const { page, ctx } = await open({ sel: { chat: "c_perm_fork" }, wait: '[data-testid="chat-head"]' });
    try {
      if (!await until(async () => (await permCards(page))?.length === 2, WAIT)) fail(`${viewport}: ${(await permCards(page))?.length} permission cards in the fork, not 2`);
      const [copied, own] = await permCards(page);
      if (copied.buttons.length || copied.done !== "Closed: it was asked in the thread this was copied from" || !copied.closed) fail(`${viewport}: the request in the copied part is ${J(copied)}`);
      if (J(own.buttons) !== J(BUTTONS)) fail(`${viewport}: the request after the copied part has ${J(own.buttons)}`);
    } catch (e) { say(`${viewport}: the fork: ${e.message.split("\n")[0]}`); }
    await ctx.close();
  }

  // ---- Show on a card of a board tool
  {
    const apply = (id, board, result) => ({ kind: "tool", toolId: id, name: "mcp__board__apply", input: { board, ops: [] }, ...(result === undefined ? {} : { result }) });
    await mockEval(`boards.b_gone = { id: "b_gone", name: "Old", group: "g_shop", archived: true, created: new Date(T0).toISOString() };` + make("c_show", {}, [{ kind: "user", text: "Draw it." }, apply("a1", "b_arch", "{\"added\":1}"), apply("a2", "b_arch"), apply("a3", "b_gone", "{\"added\":1}"), apply("a4", "b_nowhere", "{\"added\":1}")]), url);
    const { page, ctx } = await open({ sel: { chat: "c_show" }, wait: '[data-testid="chat-head"]' });
    try {
      if (!await until(async () => (await toolCards(page))?.length === 4, WAIT)) fail(`${viewport}: ${(await toolCards(page))?.length} tool cards, not 4`);
      const shows = await page.evaluate(() => [...document.querySelectorAll('[data-testid="tool-card"]')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).map((c) => !!c.querySelector('[data-testid="tool-show"]')));
      if (J(shows) !== J([true, false, false, false])) fail(`${viewport}: the cards of a board tool have Show as ${J(shows)}: only a finished call that names a board that exists and is not archived was to have it ([true,false,false,false])`);
      await press(page, byTid(page, "tool-show").first());
      if (!await until(async () => await byTid(page, "board-bar").count() > 0 || await byTid(page, "board-canvas").count() > 0, WAIT)) fail(`${viewport}: Show did not open the board`);
    } catch (e) { say(`${viewport}: Show: ${e.message.split("\n")[0]}`); }
    await ctx.close();
  }

  // ---- a command of 20,000 characters is coloured, one that is longer is drawn as it is
  {
    const LINE = "echo 1\n", fits = LINE.repeat(2857), over = LINE.repeat(2858); // (19,999 and 20,006 characters)
    await mockEval(make("c_long", {}, [{ kind: "user", text: "Run." }, bash(fits), { ...bash(over), toolId: "t2" }]), url);
    const { page, ctx } = await open({ sel: { chat: "c_long" }, wait: '[data-testid="chat-head"]' });
    try {
      if (!await until(async () => (await toolCards(page))?.length === 2, WAIT)) fail(`${viewport}: ${(await toolCards(page))?.length} tool cards, not 2`);
      if (phone) {
        // (a step draws its command whole in a plain box: each is open to be read, there is no Show all and no colour)
        for (const n of [0, 1]) await press(page, byTid(await cardAt(page, n), "tool-row").first());
        if (!await until(async () => (await toolCards(page)).every((c) => c.parts.some((p) => p.title === "Command")), WAIT)) fail(`${viewport}: the long commands did not open`);
        const drawn = (await toolCards(page)).map((c) => { const cmd = c.parts.find((p) => p.title === "Command"); return [cmd.text.join("").length, cmd.coloured > 0]; }).sort((a, b) => a[0] - b[0]);
        if (J(drawn) !== J([[fits.length, false], [over.length, false]])) fail(`${viewport}: a command is drawn whole as [its length, coloured] ${J(drawn)}, not ${J([[fits.length, false], [over.length, false]])}`);
        if (await byTid(page, "tool-show-all").count()) fail(`${viewport}: a command has Show all: the step draws it whole`);
      } else {
        const coloured = [];
        for (const n of [0, 1]) {
          const card = byTid(page, "tool-card").nth(n);
          await press(page, byTid(card, "tool-row").first());
          await byTid(card, "tool-show-all").first().waitFor({ state: "visible", timeout: WAIT });
          // (the cards are read by their command's text: the thread's order is the page's)
          await press(page, byTid(card, "tool-show-all").first());
          await until(async () => (await toolCards(page)).some((c) => c.parts.some((p) => p.part === "text" && p.title === "Command" && p.text[0]?.length > 19000)), WAIT);
        }
        for (const c of await toolCards(page)) { const cmd = c.parts.find((p) => p.title === "Command"); if (cmd) coloured.push([cmd.text.join("").length, cmd.coloured > 0]); }
        coloured.sort((a, b) => a[0] - b[0]);
        if (J(coloured) !== J([[fits.length, true], [over.length, false]])) fail(`${viewport}: a command shown whole is [its length, coloured] ${J(coloured)}, not ${J([[fits.length, true], [over.length, false]])}`);
      }
    } catch (e) { say(`${viewport}: colour: ${e.message.split("\n")[0]}`); }
    await ctx.close();
  }
  note(`permission cards (the words, Allow and Don't naming their request, decided elsewhere, a refusal, archived, disabled, the copy of a fork), Show on a board tool's card, the colour's bound of 20,000 characters`);
}, { viewports, page: false });
