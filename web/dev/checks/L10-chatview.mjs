// L10 (new in the app, package S4): the chat view's rows that no browser check proved on the page (parity inventory, area B: B-TH-02 to 05,
// B-TH-09 to 16, B-HD-01 to 05, B-HD-07, B-RO-07, B-RO-14), at desktop, tablet and phone. It has no old check to port.
//   Header (B-HD-01, 03, 04, 05, 07): the agent's name, the folder with "~", the status; a press on the name opens the field with the name
//     selected, Enter commits it (one PATCH with the new name), Esc cancels, leaving the field commits, the same name asks nothing; a section's
//     server that refuses the rename is said ("Couldn't rename the chat"); a board's chat has × (wide layouts) that hides the panel.
//   Empty thread (B-TH-14, 15, 16): the agent's name and the line of its kind, the hint to pick what is still open, the suggestions (2 for a
//     plain chat, 3 for a board's) and a press on one sends it as the first message; an archived chat has no suggestion and no hint; a chat that
//     takes no message says why in place of its line and offers none (its server drops, the chat is gone from its server; no agent and a server
//     away from the start are P0.3's words).
//   Notes and what is not drawn (B-TH-05, 06): a note is a line in its tone; a note with no text, the mark that ends a turn and an item the
//     app does not know draw nothing, and the thread goes on.
//   A message's parts (B-TH-03, 04): a message of quotes alone draws no words, one with words draws them under its quotes; each quote is a card
//     with its comment; a message with nothing at all is still there.
//   Lines at the foot (B-TH-10, 11): "Thinking…" and a tool's verb as the header says them, with dots; nothing while the agent writes or asks;
//     an idle chat that waits on subagents says so; a chat that waits for its background work says "Waiting for background work" in the header and
//     at the foot (the still waiting row, not the typing line with dots), shows Stop and blocks Send, and a press on Stop sends the interrupt; a chat whose agent is retried after a temporary error says
//     "Retrying in … · 1 of 4" in the header, shows Stop, does not block Send, and a press on Stop sends the interrupt.
//   No thread kept (B-RO-07): a load that failed while connected says so with "Try again"; a chat whose server went away before the thread came
//     says that it shows again when the server is back, with the state's word and "Servers…".
//     (sweep, rn-sw-webtest: a chat the server answers 404 not_found for says that it is no longer there, with neither "Servers…" nor "Try again".)
//   A fork (B-TH-12, 13): the note that it was forked, its title opening the source chat while that exists and plain once it is gone, and the line
//     where the copied part ends, after the last message of the copy.
import { callMatcher, callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { byTid, press } from "./sel.mjs";
import { WAIT, messages, textOf } from "./chat.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const J = JSON.stringify;
const CHAT = (id) => `chats.${id} = chat(${J(id)}, { name: ${J(id)}, group: "g_shop" });`;
/** In the mock: a chat with these items, shown to the page. */
const make = (id, o, list) => `chats.${id} = chat(${J(id)}, ${J({ name: id, group: "g_shop", ...o })}); items.${id} = ${J(list)}; send({ type: "snapshot", ...snapshot() });`;
const status = (id, st, tool) => `chats.${id}.status = ${J(st)}; ${tool ? `chats.${id}.statusTool = ${J(tool)};` : ""} send({ type: "chat", chat: chats.${id} });`;

await check("L10 the chat view: header, empty thread, notes, quotes, status lines, a fork", async ({ url, viewport, layout, open, fail }) => {
  void CHAT;
  await seed(url, "A1", "A4", "SEC");
  const say = (line) => fail(`${viewport}: ${line}`);

  // ---- an empty plain chat: its line, the hint and the suggestions; a suggestion is sent as the first message
  {
    const cwd = await mockEval("return chats.c_new.cwd;", url);
    const { page, ctx } = await open({ sel: { chat: "c_new" }, wait: '[data-testid="chat-head"]' });
    const calls = callsOf(page);
    const empty = byTid(page, "empty-thread").first();
    await empty.waitFor({ state: "visible", timeout: WAIT });
    const said = (await empty.textContent()) ?? "";
    const folder = String(cwd).split("/").filter(Boolean).pop();
    if (!said.includes(`The same session you get in a terminal, started in ${folder}.`)) say(`an empty plain chat says "${said.slice(0, 160)}", not the line of a terminal session in ${folder}`);
    if (!said.includes("Claude Code")) say("an empty chat does not name its agent");
    const suggestions = await byTid(page, "suggestion").allTextContents();
    if (J(suggestions) !== J(["What is this project?", "What changed in the last few commits?"])) say(`an empty plain chat offers ${J(suggestions)}`);
    if (await byTid(page, "config-hint").count() !== 1) say(`an empty chat that has not started has ${await byTid(page, "config-hint").count()} hints of what is still to pick, not 1`);
    await press(page, byTid(page, "suggestion").first());
    if (!await until(() => calls.some((c) => c.method === "POST" && /\/chats\/c_new\/messages/.test(c.path) && c.body?.text === "What is this project?"), WAIT)) say(`a press on a suggestion did not send it as the first message: ${J(calls.filter((c) => c.method !== "GET").map((c) => [c.method, c.path, c.body]))}`);
    if (!await until(async () => (await messages(page)).some((m) => m.role.startsWith("user") && m.text.includes("What is this project?")), WAIT)) say("the suggestion that was sent is not in the thread");
    if (await byTid(page, "empty-thread").count()) say("the empty state stays after the first message");
    await ctx.close();
  }

  // ---- an empty board chat
  {
    const { page, ctx } = await open({ sel: { board: "b_arch", chat: "c_board_new" }, wait: '[data-testid="chat-head"]' });
    const empty = byTid(page, "empty-thread").first();
    await empty.waitFor({ state: "visible", timeout: WAIT });
    const said = (await empty.textContent()) ?? "", board = await mockEval("return boards.b_arch.name;", url);
    if (!said.includes(`Ask about or change ${board}. Type @ to point at other boards.`)) say(`an empty board chat says "${said.slice(0, 160)}", not the line about ${board}`);
    const suggestions = await byTid(page, "suggestion").allTextContents();
    if (J(suggestions) !== J(["Sketch a 3-tier web architecture here", "Summarize what's on this board", "Tidy up the selected shapes into a row"])) say(`an empty board chat offers ${J(suggestions)}`);
    const sub = await textOf(page, "chat-head-sub");
    if (!sub.includes(board) || !sub.includes("Claude Code")) say(`the header of a board's chat says "${sub}": it does not name the board and the agent`);
    // × hides the chat panel (wide layouts); the phone's chat is a screen of its own and has none
    if (layout === "phone") { if (await byTid(page, "chat-hide").count()) say("the phone's chat screen has the × that hides a panel"); }
    else {
      await press(page, byTid(page, "chat-hide").first());
      if (!await until(async () => !await byTid(page, "board-panel").count(), WAIT)) say("the × of a board chat's header did not hide the panel");
    }
    await ctx.close();
  }

  // ---- an archived chat takes no suggestion, no hint and no rename
  {
    await mockEval(make("c_arch", { archived: true, fresh: true, locked: false }, []), url);
    const { page, ctx } = await open({ sel: { chat: "c_arch" }, wait: '[data-testid="chat-head"]' });
    await byTid(page, "empty-thread").first().waitFor({ state: "visible", timeout: WAIT });
    if (await byTid(page, "suggestion").count() || await byTid(page, "config-hint").count()) say("an archived chat offers suggestions or a hint");
    if (!(await textOf(page, "chat-head-sub")).includes("Archived")) say(`the header of an archived chat says "${await textOf(page, "chat-head-sub")}", not "Archived"`);
    await byTid(page, "chat-head-name").first().click({ force: true }).catch(() => {});
    await page.waitForTimeout(300);
    if (await byTid(page, "chat-name-input").count()) say("an archived chat can be renamed");
    await ctx.close();
  }

  // ---- an empty chat that takes no message says why, and offers no suggestion (B-TH-16): its server drops, and the chat is no longer on its
  // server. (A chat with no agent, and a chat of a server that is not connected from the start, are P0.3's: A2.plain-noagent, -noagent-installed, -off-new.)
  {
    await mockEval(`onServer("s_studio", () => { for (const id of ["c_blank", "c_blank2"]) { chats[id] = chat(id, { name: id, group: "g_shop", fresh: true }); items[id] = []; } });`, url);
    const reasonOf = async (page) => (await byTid(page, "empty-reason").count() ? await textOf(page, "empty-reason") : "");
    const wait = async (page, want, what) => { if (!await until(async () => (await reasonOf(page)) === want, WAIT)) say(`${what}: the empty thread says "${await reasonOf(page)}", not "${want}"`); };
    for (const [id, what, change, want, back] of [
      ["c_blank", "a chat that its server no longer has", 'elsewhere("s_studio", "DELETE", "/chats/c_blank");', "This chat is no longer on Studio Mac.", ""],
      ["c_blank2", "a chat whose server dropped", 'setServerState("s_studio", "unreachable", { detail: "connection refused" });', "Studio Mac is not connected: nothing can be sent or changed until it is back.", 'setServerState("s_studio", "connected");'],
    ]) {
      const { page, ctx } = await open({ sel: { chat: `s_studio~${id}` }, wait: '[data-testid="chat-head"]' });
      await byTid(page, "empty-thread").first().waitFor({ state: "visible", timeout: WAIT });
      if (await reasonOf(page)) say(`${what}, before it changed: the empty thread of a chat that takes a message says "${await reasonOf(page)}"`);
      if (await byTid(page, "suggestion").count() !== 2) say(`${what}, before it changed: the empty thread offers ${await byTid(page, "suggestion").count()} suggestions, not 2`);
      await mockEval(change, url);
      await wait(page, want, what);
      if (await byTid(page, "suggestion").count()) say(`${what}: the empty thread still offers suggestions`);
      if (back) await mockEval(back, url);
      await ctx.close();
    }
  }

  // ---- notes, and what is not drawn
  {
    await mockEval(make("c_notes", {}, [
      { kind: "user", text: "Hello" }, { kind: "note", text: "The agent was interrupted.", tone: "muted" }, { kind: "note", text: "The agent ended with an error.", tone: "error" },
      { kind: "note", text: "" }, { kind: "end" }, { kind: "from_the_future", text: "never drawn" }, null, { kind: "text", done: true, text: "Done." },
    ]), url);
    const { page, ctx } = await open({ sel: { chat: "c_notes" }, wait: '[data-testid="chat-head"]' });
    await byTid(page, "msg", { role: "assistant" }).first().waitFor({ state: "visible", timeout: WAIT });
    const notes = await page.evaluate(() => [...document.querySelectorAll('[data-testid="note"]')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).map((e) => [e.dataset.tone, e.textContent]));
    if (J(notes) !== J([["muted", "The agent was interrupted."], ["error", "The agent ended with an error."]])) say(`the notes of the thread are ${J(notes)}: a note with no text, the end mark and an unknown item draw nothing, a note has its tone`);
    const msgs = (await messages(page)).map((m) => m.role);
    if (J(msgs) !== J(["user", "assistant"])) say(`the thread has the messages ${J(msgs)}, not a message of the user and the reply`);
    if (await page.getByText("never drawn").count()) say("an item the app does not know was drawn");
    await ctx.close();
  }

  // ---- a message's parts: quotes, images and words
  {
    const refs = [{ quote: "font copy step", comment: "which step exactly?", item: 1, start: 15, end: 29 }, { quote: "copies every font", comment: "", item: 1, start: 34, end: 51 }];
    await mockEval(make("c_parts", {}, [
      { kind: "user", text: "Why is it slow?" }, { kind: "text", done: true, text: "Because of the font copy step. It copies every font on each build." }, { kind: "end" },
      { kind: "user", text: "Is that right?", references: refs }, { kind: "user", text: "", references: refs.slice(0, 1) }, { kind: "user", text: "" },
    ]), url);
    const { page, ctx } = await open({ sel: { chat: "c_parts" }, wait: '[data-testid="chat-head"]' });
    await byTid(page, "sent-quotes").first().waitFor({ state: "visible", timeout: WAIT });
    const users = byTid(page, "msg", { role: "user" });
    if (!await until(async () => await users.count() === 4, WAIT)) say(`${await users.count()} messages of the user are on screen, not 4: a message with nothing at all must be there`);
    const parts = await page.evaluate(() => [...document.querySelectorAll('[data-testid="msg"][data-role="user"]')]
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
      .map((m) => { const q = [...m.querySelectorAll('[data-testid="sent-quote-card"]')], md = m.querySelector('[data-testid="md"]'), h = m.getBoundingClientRect().height;
        return { cards: q.map((c) => c.textContent), words: !!md && !!(md.textContent ?? "").trim(), above: !!md && q.length > 0 && q[q.length - 1].getBoundingClientRect().bottom <= md.getBoundingClientRect().top + 1, h: Math.round(h) }; }));
    const [plain, words, quotes, empty] = parts;
    if (plain.cards.length || !plain.words) say(`a plain message is ${J(plain)}`);
    if (words.cards.length !== 2 || !words.words || !words.above) say(`a message with words and two quotes is ${J(words)}: the quotes are cards above the words`);
    if (!words.cards[0]?.includes("font copy step") || !words.cards[0]?.includes("which step exactly?")) say(`the first quote's card says "${words.cards[0]}": the quote and its comment`);
    if (words.cards[1]?.includes("which step") || !words.cards[1]?.includes("copies every font")) say(`the second quote's card says "${words.cards[1]}": its quote, no comment`);
    if (quotes.cards.length !== 1 || quotes.words) say(`a message of a quote alone is ${J(quotes)}: it draws no words`);
    if (empty.cards.length || empty.words || empty.h < 10) say(`a message with nothing at all is ${J(empty)}: it is still there`);
    await ctx.close();
  }

  // ---- the lines at the foot of the thread
  {
    await mockEval(make("c_status", { usage: { ctxIn: 1, ctxOut: 1, ctxWindow: 100, turns: 2 } }, [{ kind: "user", text: "Go." }]), url);
    const { page, ctx } = await open({ sel: { chat: "c_status" }, wait: '[data-testid="chat-head"]' });
    await byTid(page, "msg").first().waitFor({ state: "visible", timeout: WAIT });
    const typing = () => byTid(page, "typing");
    const header = () => textOf(page, "chat-head-sub");
    for (const [st, tool, line] of [["thinking", "", "Thinking…"], ["tool", "Bash", ""], ["writing", "", null], ["approval", "", null], ["ready", "", null]]) {
      await mockEval(status("c_status", st, tool), url);
      if (line === null) {
        await page.waitForTimeout(400);
        if (await typing().count()) say(`${st}: the thread has a status line, "${await typing().first().textContent()}": the text (or the card) is the sign`);
        continue;
      }
      if (!await until(async () => await typing().count() > 0, WAIT)) { say(`${st}: the thread's foot says nothing of what goes on`); continue; }
      const said = ((await typing().first().textContent()) ?? "").trim();
      if (line && said !== line) say(`${st}: the line says "${said}", not "${line}"`);
      if (!said.endsWith("…")) say(`${st}: the line says "${said}": a status that goes on ends in three dots`);
      if (!await byTid(page, "dots").count()) say(`${st}: the line has no dots`);
      if (!(await header()).includes(said)) say(`${st}: the header says "${await header()}", not the line "${said}"`);
    }
    await ctx.close();
  }
  {
    const { page, ctx } = await open({ sel: { chat: "c_nested" }, wait: '[data-testid="chat-head"]' });
    if (!await until(async () => ((await byTid(page, "typing").first().textContent().catch(() => "")) ?? "").includes("Waiting on 3 subagents"), WAIT)) say(`an idle chat that waits on subagents says "${await byTid(page, "typing").first().textContent().catch(() => "")}" at its foot, not "Waiting on 3 subagents"`);
    await ctx.close();
  }

  // ---- a chat that waits for its background work (a shell or a Monitor): its turn has ended, the agent is not busy with it, and the chat takes no message
  {
    const WAITING = "Waiting for background work";
    const { page, ctx } = await open({ sel: { chat: "c_plain" }, wait: '[data-testid="chat-head"]' });
    const calls = callsOf(page);
    await byTid(page, "msg").first().waitFor({ state: "visible", timeout: WAIT });
    await mockEval(status("c_plain", "waiting"), url);
    try {
      if (!await until(async () => (await textOf(page, "chat-head-sub")).includes(WAITING), WAIT)) say(`a chat that waits for background work: the header says "${await textOf(page, "chat-head-sub")}", not "${WAITING}"`);
      if (!await until(async () => ((await byTid(page, "typing").first().textContent().catch(() => "")) ?? "").trim() === WAITING, WAIT)) say(`a chat that waits for background work: the foot of the thread says "${await byTid(page, "typing").first().textContent().catch(() => "")}", not "${WAITING}"`);
      if (await byTid(page, "typing").count() !== 1) say(`a chat that waits for background work has ${await byTid(page, "typing").count()} lines at the foot, not 1`);
      if (await byTid(page, "dots").count()) say("a chat that waits for background work has the dots of a typing line: it is the still waiting row");
      const send = byTid(page, "send").first(), stop = byTid(page, "stop").first();
      if (!await stop.count()) say("a chat that waits for background work has no Stop");
      if (!await send.isDisabled()) say("Send of a chat that waits for background work is on");
      else if (await send.getAttribute("title") !== "The agent is working") say(`Send of a chat that waits for background work says "${await send.getAttribute("title")}"`);
      const from = calls.length;
      await press(page, stop);
      if (!await until(() => calls.slice(from).some((c) => c.method === "POST" && /\/chats\/c_plain\/interrupt/.test(c.path)), WAIT)) say("a press on Stop of a chat that waits for background work made no interrupt call");
    } finally {
      await mockEval(status("c_plain", "ready"), url); // (put back: the checks below read this chat as idle)
      await ctx.close();
    }
  }

  // ---- a chat whose agent is retried after a temporary error: the header says when the next attempt is, Stop shows and cancels the retry, and a message is still taken
  {
    const { page, ctx } = await open({ sel: { chat: "c_plain" }, wait: '[data-testid="chat-head"]' });
    const calls = callsOf(page);
    await byTid(page, "msg").first().waitFor({ state: "visible", timeout: WAIT });
    await mockEval(`chats.c_plain.retry = { attempt: 1, of: 4, at: Date.now() + 20000, kind: "login" }; ${status("c_plain", "retrying")}`, url);
    try {
      // (the header counts the wait down from the clock: 20 s when it was drawn at once, less when the machine was slow to draw it)
      if (!await until(async () => /Retrying in (1\d|20) s · 1 of 4/.test(await textOf(page, "chat-head-sub")), WAIT)) say(`a chat whose agent is retried: the header says "${await textOf(page, "chat-head-sub")}", not "Retrying in … · 1 of 4"`);
      const send = byTid(page, "send").first(), stop = byTid(page, "stop").first();
      if (!await stop.count()) say("a chat whose agent is retried has no Stop");
      // (Send is off for an empty draft whatever the status: a message has to be typed for it to be taken)
      const box = byTid(page, "composer-input").first();
      await press(page, box); await page.keyboard.type("a message between attempts");
      if (!await until(async () => !(await send.isDisabled()), WAIT)) say("Send of a chat whose agent is retried is off with a message typed: a message is taken, and starts the turn in place of the retry");
      await page.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a"); await page.keyboard.press("Backspace"); // (the draft is put back: empty)
      const from = calls.length;
      await press(page, stop);
      if (!await until(() => calls.slice(from).some((c) => c.method === "POST" && /\/chats\/c_plain\/interrupt/.test(c.path)), WAIT)) say("a press on Stop of a chat whose agent is retried made no interrupt call");
    } finally {
      await mockEval(`delete chats.c_plain.retry; ${status("c_plain", "ready")}`, url); // (put back: the checks below read this chat as idle)
      await ctx.close();
    }
  }

  // ---- a fork: its note, its source, and where the copy ends
  {
    const { page, ctx } = await open({ sel: { chat: "c_A4_fork_claude" }, wait: '[data-testid="chat-head"]' });
    const note = byTid(page, "forked-from").first();
    await note.waitFor({ state: "visible", timeout: WAIT });
    const said = ((await note.textContent()) ?? "").replace(/\s+/g, " ").trim();
    if (!said.endsWith("Forked from Branch send. The history below was copied; this chat has its own agent session.")) say(`the note of a fork says "${said}"`);
    if (!await byTid(page, "forked-from-link").count()) say("the title of the source chat, which exists, is not a link");
    const mark = byTid(page, "prefix-end").first();
    await mark.waitFor({ state: "visible", timeout: WAIT });
    if ((await mark.textContent())?.trim() !== "Copied from the chat this was forked from up to here") say(`the mark of the copy's end says "${await mark.textContent()}"`);
    const order = await page.evaluate(() => {
      const top = (e) => e.getBoundingClientRect().top, marks = document.querySelector('[data-testid="prefix-end"]');
      return [...document.querySelectorAll('[data-testid="msg"]')].map((m) => top(m) < top(marks));
    });
    if (!order.length || !order.every(Boolean)) say(`the mark is not after the last message of the copy: ${J(order)}`);
    await press(page, byTid(page, "forked-from-link").first());
    if (!await until(async () => (await byTid(page, "chat-head").last().getAttribute("data-chat")) === "c_A4_turns", WAIT)) say("the title of the source chat did not open it");
    await ctx.close();
    // the source is gone: its title is plain
    await mockEval("delete chats.c_A4_turns; delete items.c_A4_turns; send({ type: \"snapshot\", ...snapshot() });", url);
    const again = await open({ sel: { chat: "c_A4_fork_claude" }, wait: '[data-testid="chat-head"]' });
    await byTid(again.page, "forked-from").first().waitFor({ state: "visible", timeout: WAIT });
    if (await byTid(again.page, "forked-from-link").count()) say("the title of a source chat that is gone is a link");
    if (!((await textOf(again.page, "forked-from")).includes("Forked from Branch send."))) say("the note of a fork whose source is gone does not name it");
    await again.ctx.close();
  }

  // ---- no thread of the chat kept (B-RO-07): a load that failed while connected says so with "Try again"; a server that went away before the
  // thread came says that this chat shows again when it is back, with the state's word and "Servers…"
  {
    await mockEval("flags.items = { fail: 500 };", url);
    const { page, ctx } = await open({ sel: { chat: "c_plain" }, wait: '[data-testid="chat-head"]' });
    const off = byTid(page, "remote-off").first();
    await off.waitFor({ state: "visible", timeout: WAIT });
    if (await off.getAttribute("data-kind") !== "failed") say(`a thread whose load failed while connected is of the kind "${await off.getAttribute("data-kind")}", not "failed"`);
    if (!((await textOf(page, "remote-off-text")) ?? "").trim()) say("a thread whose load failed says nothing of why");
    await mockEval("delete flags.items;", url);
    await press(page, byTid(page, "remote-retry").first());
    if (!await until(async () => await byTid(page, "msg", { role: "user" }).count() > 0 && !await byTid(page, "remote-off").count(), WAIT)) say(`"Try again" did not bring the thread: ${await byTid(page, "remote-off").count()} warnings, ${await byTid(page, "msg").count()} messages`);
    await ctx.close();
    // the server does not have the chat any more (the read is answered 404 not_found): the thread's place says that it is no longer there, with no "Servers…" and no
    // retry (web/test/sectionviews.test.ts "a section's chat that could not be read because it is gone there says so in place of its thread", A-ST-11)
    await mockEval("flags.items = { fail: 404 };", url);
    const gone = await open({ sel: { chat: "s_studio~c_plain" }, wait: '[data-testid="chat-head"]' });
    const goneOff = byTid(gone.page, "remote-off").first();
    await goneOff.waitFor({ state: "visible", timeout: WAIT });
    if (await goneOff.getAttribute("data-kind") !== "gone") say(`a thread whose read is answered not_found is of the kind "${await goneOff.getAttribute("data-kind")}", not "gone"`);
    if (!(await textOf(gone.page, "remote-off-text")).includes("This chat is no longer on Studio Mac.")) say(`the place of the thread of a chat that is gone says "${await textOf(gone.page, "remote-off-text")}"`);
    if (await byTid(gone.page, "remote-servers").count() || await byTid(gone.page, "remote-retry").count()) say("the place of the thread of a chat that is gone offers Servers… or Try again");
    await mockEval("delete flags.items;", url);
    await gone.ctx.close();
    // the server goes away before the thread came
    await mockEval('flags.items = { delay: 600000 };', url);
    const held = await open({ sel: { chat: "s_studio~c_plain" }, wait: '[data-testid="chat-head"]' });
    await mockEval('setServerState("s_studio", "unreachable", { detail: "connection refused" });', url);
    const away = byTid(held.page, "remote-off").first();
    await away.waitFor({ state: "visible", timeout: WAIT });
    if (await away.getAttribute("data-kind") !== "unreachable") say(`the thread of a chat whose server is away is of the kind "${await away.getAttribute("data-kind")}", not "unreachable"`);
    if (!(await textOf(held.page, "remote-off-text")).includes("Studio Mac is not connected. This chat shows again when it is back.")) say(`the place of the thread says "${await textOf(held.page, "remote-off-text")}"`);
    if (!(await textOf(held.page, "remote-off-state")).includes("Unreachable")) say(`the place of the thread says "${await textOf(held.page, "remote-off-state")}" of the server's state, not "Unreachable"`);
    if (!await byTid(held.page, "remote-servers").count()) say('the place of the thread has no "Servers…"');
    await mockEval('delete flags.items; setServerState("s_studio", "connected");', url);
    if (!await until(async () => await byTid(held.page, "msg", { role: "user" }).count() > 0 && !await byTid(held.page, "remote-off").count(), WAIT)) say("back, the chat does not show its thread");
    await held.ctx.close();
  }

  // ---- the name: a press opens the field; Enter, leaving it, Esc and the same name
  {
    const { page, ctx } = await open({ sel: { chat: "c_plain" }, wait: '[data-testid="chat-head"]' });
    const calls = callsOf(page), patches = () => calls.filter((c) => c.method === "PATCH" && /\/chats\/c_plain$/.test(c.path));
    const input = byTid(page, "chat-name-input"), name = byTid(page, "chat-head-name").first();
    const title = await mockEval("return chats.c_plain.name;", url);
    const openField = async () => { await press(page, name); await input.waitFor({ state: "visible", timeout: WAIT }); };
    const sub = await textOf(page, "chat-head-sub");
    if (!sub.includes("Claude Code") || !sub.includes("~/projects/shop")) say(`the header's line says "${sub}": the agent and the folder, with ~`);
    await openField();
    if (await input.inputValue() !== title) say(`the field has "${await input.inputValue()}", not the chat's name "${title}"`);
    if (!await input.evaluate((el) => el.selectionStart === 0 && el.selectionEnd === el.value.length)) say("the name is not selected when the field opens");
    await page.keyboard.press("Enter"); // the same name: nothing is asked
    await page.waitForTimeout(400);
    if (await input.count() || patches().length) say(`Enter on the same name left the field open or made a call: ${J(patches().map((c) => c.body))}`);
    await openField();
    await page.keyboard.type("x");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    if (await input.count() || patches().length) say(`Esc left the field open or made a call: ${J(patches().map((c) => c.body))}`);
    await openField();
    await input.fill("A new name");
    await page.keyboard.press("Enter");
    if (!await until(() => patches().length === 1 && patches()[0].body?.name === "A new name", WAIT)) say(`Enter did not rename the chat by one call: ${J(patches().map((c) => c.body))}`);
    if (!await until(async () => (await textOf(page, "chat-head-name")).trim() === "A new name" && !await input.count(), WAIT)) say(`after the rename the header says "${await textOf(page, "chat-head-name")}"`);
    await openField();
    await input.fill("Left behind");
    await page.evaluate(() => document.activeElement?.blur()); // (leaving the field: a tap elsewhere, or the keyboard's Done)
    if (!await until(() => patches().length === 2 && patches()[1].body?.name === "Left behind", WAIT)) say(`leaving the field did not rename the chat: ${J(patches().map((c) => c.body))}`);
    await ctx.close();
  }

  // ---- a section's server that refuses the rename is said
  {
    const { page, ctx } = await open({ sel: { chat: "s_studio~c_plain" }, wait: '[data-testid="chat-head"]' });
    await byTid(page, "msg").first().waitFor({ state: "visible", timeout: WAIT });
    const refuse = callMatcher(/^PATCH \/api\/chats\/c_plain/, "s_studio");
    await page.route((u) => refuse(u), (route) => route.fulfill({ status: 409, contentType: "application/json", body: J({ error: "The server refused.", code: "refused" }) }));
    await press(page, byTid(page, "chat-head-name").first());
    const input = byTid(page, "chat-name-input");
    await input.waitFor({ state: "visible", timeout: WAIT });
    await input.fill("Refused");
    await page.keyboard.press("Enter");
    if (!await until(async () => ((await textOf(page, "confirm-dialog")) ?? "").includes("Couldn't rename the chat"), WAIT)) say(`a rename that the server refused shows "${await textOf(page, "confirm-dialog")}", not "Couldn't rename the chat"`);
    await ctx.close();
  }
}, { viewports, page: false, allowConsole: [/The server refused/] }); // (the rename that the server refuses is logged, as the page logs it)
