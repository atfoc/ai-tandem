// Proves A4.4: every wait of the fork flows ends, and leaves the page as the goal says. A branch send that is refused,
// fails, times out with an unknown result or loses its connection: the message leaves the thread, the text is back in
// the box with the error under it, the pending move stays, and the controls are live again (the next Send goes
// through). The new branch's list that fails to load: the wait ends, and the thread shows what a failed load shows.
// A fork that fails, a pick and a first message on a fresh fork whose agent fails to start, a branch being opened or
// switched to that fails to load: the notice there was, and nothing stays held. A snapshot during the wait, before and
// after the answer: the wait survives it, with no frame of an empty thread. The chat deleted or archived meanwhile: the
// page shows nothing more of the wait.
import { callMatcher, callOfRequest, check, holds, hostCall, mockEval, openPage, release, sampleFrames, seed, startMove, until, waitsSeen } from "../shot.mjs";

const T = "c_A4_turns", TWO = "c_A4_two";
const MESSAGES = callMatcher(/^POST \/api\/chats\/[^/]+\/messages/); // (the page's call, which the browser cuts)
const ASK = "Why is the build slow?", ANSWER = "Because of the font copy step. It copies every font file on each build.";

/** A probe for sampleFrames: bad for a frame whose thread has no message. */
function threadProbe() {
  const thread = document.querySelector(".thread:not(.read-only)");
  if (!thread) return null;
  const n = thread.querySelectorAll(":scope > .msg").length;
  return { bad: !n, n, sending: !!thread.querySelector(":scope > .msg.sending") };
}

await check("A4.4 every wait of the fork flows ends", async ({ url, browser, fail, note }) => {
  const knob = (code) => mockEval(code, url);
  const frame = (page) => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok()))));
  const open = async (chat, wait = ".thread .msg.assistant") => { const errors = []; return { ...await openPage({ url, browser, sel: { chat }, errors, wait }), errors }; };
  const close = async ({ ctx, errors }, name) => { for (const e of errors) fail(`${name}: page error: ${e}`); await ctx.close(); };
  const expect = (name, ok, got) => { if (!ok) fail(`${name}: got ${JSON.stringify(got)}`); };
  const held = async (name, k, n = 1) => { if (!await until(async () => await holds(url, k) === n)) fail(`${name}: the mock holds ${await holds(url, k)} calls of ${k}, not ${n}`); };
  const when = async (page, name, sign) => {
    let seen;
    if (!await until(async () => sign((seen = await waitsSeen(page))))) fail(`${name}: the page did not come to show it. It shows ${JSON.stringify(seen)}`);
    return seen;
  };
  const texts = (seen) => seen.msgs.map((m) => `${m.who}${m.sending ? " (sending)" : ""}${m.live ? "" : " (not an item)"}: ${m.text}`);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const type = async (page, text) => { await page.locator(".composer .composer-input").click(); await page.keyboard.type(text); };
  const branchSend = async (page, text) => { await startMove(page); await type(page, text); await page.keyboard.press("Enter"); };
  /** The notice of a failed call: its title, read and closed. */
  const notice = async (page) => { await page.waitForSelector(".dialog .dialog-title"); const t = await page.locator(".dialog .dialog-title").textContent(); await page.locator(".dialog .dialog-actions .btn").click(); return t; };
  const snapshot = () => fetch(url + "/mock/snapshot", { method: "POST" });
  const CUT = [`user: ${ASK}`, `agent: ${ANSWER}`];

  // ---- a branch send that does not arrive
  const ENDS = [
    ["is refused", `flags.send.refuse = { status: 429, code: "cap", error: "this chat already has 4 branches working; wait for one to finish or stop one" }`, /already has 4 branches working/],
    ["fails", `flags.send.refuse = { status: 500, code: "", error: "the agent did not start" }`, /the agent did not start/],
    ["times out with an unknown result", `flags.send.unknown = true`, /not known whether the message arrived/],
    ["loses its connection", null, /./],
  ];
  for (const [how, answer, says] of ENDS) {
    const name = `a branch send that ${how}`, said = "Try it another way";
    await seed(url, "A4");
    await knob(`flags.send = { chat: "${T}", hold: true };`);
    const p = await open(T), { page } = p;
    // (the connection is cut by the browser: the call waits at the page's door, and is then aborted)
    let cut = () => {}, waiting = 0;
    if (!answer) await page.route(MESSAGES, async (route) => { waiting++; await new Promise((ok) => { cut = ok; }); await route.abort("connectionreset"); });
    await branchSend(page, said);
    if (answer) await held(name, "send"); else if (!await until(() => waiting === 1)) fail(`${name}: the page sent no message`);
    let seen = await when(page, name, (s) => s.msgs.some((m) => m.sending));
    expect(`${name}: while it is on its way the message is in the thread and the controls are held`, seen.send.spin && seen.back.disabled && seen.box === "" && same(seen.lines, [["send", "Starting the agent…"]]), seen);
    if (answer) await release(url, "send", answer); else cut();
    // (the wait ends with the call; the composer draws the error and its own Send a moment later: the sign is the last of them)
    seen = await when(page, `${name}, ended`, (s) => !s.msgs.some((m) => m.sending) && s.box !== "" && !s.send.disabled);
    expect(`${name}: the message has left the thread, which is the cut one again, with no line`, same(texts(seen), CUT) && !seen.lines.length, [texts(seen), seen.lines]);
    expect(`${name}: the text is back in the box, with the error under it`, seen.box === said && says.test(seen.err), [seen.box, seen.err]);
    expect(`${name}: the pending move stays: the banner tells of the new branch again`, /your message starts it/.test(seen.banner), seen.banner);
    expect(`${name}: the controls are live again: Back, Send, the pickers, the message's actions`,
      !seen.back.disabled && !seen.send.disabled && !seen.send.spin && seen.send.title === "Send (Enter)" && !seen.model.disabled && !seen.effort.disabled && seen.acts.length > 0 && seen.acts.every((a) => !a.disabled), seen);
    if (answer) {
      // the next Send goes through, from the same point
      await knob(`delete flags.send;`);
      await page.locator(".composer .composer-input").click();
      await page.keyboard.press("Enter");
      seen = await when(page, `${name}: the next Send`, (s) => !s.banner && s.msgs.length >= 3 && s.msgs.every((m) => m.live));
      expect(`${name}: the next Send goes through, and its message is in the new branch's thread once`, seen.msgs.filter((m) => m.text === said).length === 1 && same(texts(seen).slice(0, 2), CUT), texts(seen));
    } else {
      // Back takes the move back
      await page.unroute(MESSAGES);
      await page.locator(".fk-banner button").click();
      seen = await when(page, `${name}: Back`, (s) => !s.banner);
      expect(`${name}: Back works again: the whole thread, and the box as before the move`, seen.msgs.length === 4 && seen.msgs.every((m) => m.live), texts(seen));
    }
    await knob(`delete flags.send;`);
    await close(p, name);
  }

  // ---- the new branch's list fails to load
  {
    const name = "the new branch's list fails to load", said = "Try it another way";
    await seed(url, "A4");
    await knob(`groups.find((g) => g.id === "g_A4").collapsed = false; flags.send = { chat: "${T}", hold: true, noReply: true };`);
    const p = await open(T), { page } = p;
    await branchSend(page, said);
    await held(name, "send");
    await knob(`flags.items = { chat: "${T}", hold: true };`);
    await release(url, "send");
    await held(name, "items");
    let seen = await when(page, `${name}, while it is fetched`, (s) => !s.banner && s.msgs.some((m) => m.sending));
    expect(`${name}, while it is fetched: the history and the message`, seen.msgs.length === 3, texts(seen));
    await release(url, "items", `flags.items.fail = 500`);
    seen = await when(page, `${name}, failed`, (s) => !s.msgs.some((m) => m.sending));
    expect(`${name}: the wait has ended, and the thread shows what a failed load shows: no message, no line, nothing held`, !seen.msgs.length && !seen.lines.length && !seen.banner && !seen.send.spin, seen);
    // selecting the chat again brings the thread back
    await knob(`delete flags.items;`);
    await page.locator('.side-row[title^="Branch send —"]').first().click();
    seen = await when(page, `${name}: the chat selected again`, (s) => s.msgs.length === 3 && s.msgs.every((m) => m.live));
    expect(`${name}: selecting the chat again brings the new branch's thread, with the message`, same(texts(seen), [...CUT, `user: ${said}`]), texts(seen));
    await knob(`delete flags.send;`);
    await close(p, name);
  }

  // ---- a fork that fails
  {
    const name = "a fork that fails";
    await seed(url, "A4");
    await knob(`flags.fork = { chat: "${T}", hold: true };`);
    const p = await open(T), { page } = p;
    await page.locator(".thread .msg.assistant").first().hover();
    await page.locator(".thread .msg.assistant .fk-act.k-fork").first().click();
    await held(name, "fork");
    await when(page, name, (s) => s.lines.length > 0);
    await release(url, "fork", `flags.fork.refuse = { status: 409, code: "busy", error: "the agent is still working; wait for it to finish or stop it" }`);
    expect(`${name}: the notice`, await notice(page) === "Couldn't fork the chat", "another title");
    const seen = await when(page, `${name}, ended`, (s) => !s.lines.length);
    expect(`${name}: the line is gone and Fork is live again, in the same chat`, seen.acts.length > 0 && seen.acts.every((a) => !a.disabled) && seen.msgs.length === 4, seen);
    await knob(`delete flags.fork;`);
    await close(p, name);
  }

  // ---- a fresh fork whose agent fails to start: on a pick, and on its first message
  {
    const name = "a pick on a fresh fork whose agent fails to start", id = "c_A4_fork_pi";
    await seed(url, "A4");
    await knob(`flags.configure = { chat: "${id}", hold: true };`);
    const p = await open(id, ".composer .model-pick > button.tchip"), { page } = p;
    const before = await waitsSeen(page);
    await page.locator(".composer .model-pick > button.tchip").click();
    await page.locator('.composer .model-pick .menu-item[data-model-id="gpt-5.4"]').click();
    await held(name, "configure");
    await when(page, name, (s) => s.fixed);
    await release(url, "configure", `flags.configure.refuse = { status: 409, code: "window", error: "the model's context window is too small for this conversation" }`);
    const seen = await when(page, `${name}, ended`, (s) => !s.fixed && !s.model?.disabled);
    expect(`${name}: the server's sentence under the composer`, /context window is too small/.test(seen.err), seen.err);
    expect(`${name}: the picker is back on the model it had, and Send, the pickers and the thread are as before the pick`, seen.model.text === before.model.text && !seen.model.disabled && !seen.effort.disabled && seen.send.title === before.send.title && !seen.lines.length, [seen.model, seen.send, seen.lines]);
    await knob(`delete flags.configure;`);
    await close(p, name);
  }
  {
    const name = "the first message to a fresh fork whose agent fails to start", id = "c_A4_fork_claude", said = "Go on from here";
    await seed(url, "A4");
    await knob(`flags.send = { chat: "${id}", hold: true };`);
    const p = await open(id), { page } = p;
    await type(page, said);
    await page.keyboard.press("Enter");
    await held(name, "send");
    let seen = await when(page, name, (s) => s.msgs.some((m) => m.sending));
    expect(`${name}: while it is on its way the text is after the copied history`, same(texts(seen), [...CUT, `user (sending) (not an item): ${said}`]) && seen.send.spin, [texts(seen), seen.send]);
    await release(url, "send", `flags.send.refuse = { status: 500, code: "", error: "the agent did not start" }`);
    seen = await when(page, `${name}, ended`, (s) => !s.msgs.some((m) => m.sending) && s.box !== "" && !s.send.disabled);
    expect(`${name}: the message has left the thread, the text is back in the box with the error under it, and Send is live`, same(texts(seen), CUT) && seen.box === said && /the agent did not start/.test(seen.err) && !seen.send.disabled && !seen.send.spin, seen);
    await knob(`delete flags.send;`);
    await close(p, name);
  }

  // ---- a branch that fails to load: switched to, and opened for a move from the tree
  {
    const name = "a branch switch whose list fails to load";
    await seed(url, "A4");
    await knob(`flags.items = { chat: "${TWO}", branch: "alt", hold: true };`);
    const p = await open(TWO), { page } = p;
    await page.locator(".chat-head .fk-tree-btn").click();
    await page.locator('.fk-nav .fk-row[data-end="alt"]').dblclick();
    await held(name, "items");
    await when(page, name, (s) => same(s.lines, [["load", "Loading…"]]));
    await release(url, "items", `flags.items.fail = 500`);
    expect(`${name}: the notice`, await notice(page) === "Couldn't open that branch", "another title");
    const seen = await when(page, `${name}, ended`, (s) => !s.lines.length && s.msgs.length === 4);
    expect(`${name}: the chat is on the branch it was on, with no line`, seen.msgs.some((m) => m.text === "Fix it.") && seen.msgs.every((m) => m.live), texts(seen));
    await knob(`delete flags.items;`);
    await close(p, name);
  }
  {
    const name = "a branch opened for a move that fails to load";
    await seed(url, "A4");
    await knob(`setCurrent("${TWO}", "alt"); flags.items = { chat: "${TWO}", branch: "main", hold: true };`);
    const p = await open(TWO), { page } = p;
    await when(page, `${name}: the chat opens on the other branch`, (s) => s.msgs.some((m) => m.text === "Is there a faster way?"));
    await page.locator(".chat-head .fk-tree-btn").click();
    await page.locator(".fk-nav .fk-row.k-text", { hasText: "Because of the font copy step" }).first().dblclick();
    await held(name, "items");
    await when(page, name, (s) => same(s.lines, [["open", "Opening the branch…"]]));
    await release(url, "items", `flags.items.fail = 500`);
    expect(`${name}: the notice`, await notice(page) === "Couldn't open that branch", "another title");
    const seen = await when(page, `${name}, ended`, (s) => !s.lines.length);
    expect(`${name}: the thread shown is as it was, with no line and no move`, seen.msgs.length === 4 && seen.msgs.some((m) => m.text === "Is there a faster way?") && !seen.banner && seen.acts.every((a) => !a.disabled), seen);
    await knob(`delete flags.items;`);
    await close(p, name);
  }

  // ---- the page reads its whole state again during the wait: before the answer, and between the answer and the list
  {
    const name = "a snapshot during a branch send", said = "Try it another way";
    await seed(url, "A4");
    await knob(`flags.send = { chat: "${T}", hold: true, noReply: true };`);
    const p = await open(T), { page } = p;
    await branchSend(page, said);
    await held(name, "send");
    const before = await when(page, name, (s) => s.msgs.some((m) => m.sending) && s.msgs.length === 3);
    const frames = await sampleFrames(page, threadProbe);
    const lists = []; page.on("requestfinished", (r) => { const c = callOfRequest(r); if (c?.method === "GET" && c.path.includes("/items")) lists.push(c.path); });
    await snapshot();
    if (!await until(() => lists.length >= 1)) fail(`${name}: the page did not read its list again after the snapshot`);
    await frame(page);
    let seen = await when(page, `${name}, read again`, (s) => s.msgs.length === 3 && /after/.test(s.banner));
    expect(`${name}: the wait survives it: the same thread, banner, lines and held controls`, same({ ...seen, err: "" }, { ...before, err: "" }), { now: seen, before });
    // between the answer and the list
    await knob(`flags.items = { chat: "${T}", hold: true };`);
    await release(url, "send");
    await held(name, "items");
    await when(page, `${name}, answered`, (s) => !s.banner && s.msgs.some((m) => m.sending));
    await snapshot();
    await held(`${name}: the list read again after the second snapshot`, "items", 2);
    await frame(page);
    seen = await waitsSeen(page);
    expect(`${name}, after the answer: the history and the message stay while the list is read again`, same(texts(seen), [`user (not an item): ${ASK}`, `agent (not an item): ${ANSWER}`, `user (sending) (not an item): ${said}`]), texts(seen));
    await release(url, "items");
    seen = await when(page, `${name}, the list is here`, (s) => s.msgs.length === 3 && s.msgs.every((m) => m.live));
    expect(`${name}: it ends with the list: the branch's own thread, the message once, no line`, same(texts(seen), [...CUT, `user: ${said}`]) && !seen.lines.length, [texts(seen), seen.lines]);
    const f = await frames.stop();
    if (f.bad.length) fail(`${name}: ${f.bad.length} of ${f.values.length} frames showed a thread with no message`);
    else note(`${name}: ${f.values.length} frames across two snapshots, none with an empty thread`);
    await knob(`delete flags.send; delete flags.items;`);
    await close(p, name);
  }

  // ---- the chat goes meanwhile
  {
    const name = "the chat is deleted during a branch send";
    await seed(url, "A4");
    await knob(`flags.send = { chat: "${T}", hold: true };`);
    const p = await open(T), { page } = p;
    await branchSend(page, "Try it another way");
    await held(name, "send");
    await when(page, name, (s) => s.msgs.some((m) => m.sending));
    await hostCall(url, "DELETE", `/api/chats/${T}`);
    if (!await until(() => page.evaluate(() => !document.querySelector(".thread .msg, .wait-line, .fk-banner")))) fail(`${name}: the page still shows the chat's thread, a line or the banner`);
    await release(url, "send");
    await frame(page); await frame(page);
    expect(`${name}: the wait went with the chat: no message, no line, and no notice when the call ends`, await page.evaluate(() => !document.querySelector(".msg.sending, .wait-line, .dialog")), "something of it is left");
    await knob(`delete flags.send;`);
    await close(p, name);
  }
  {
    const name = "the chat is archived during a branch send";
    await seed(url, "A4");
    await knob(`flags.send = { chat: "${T}", hold: true };`);
    const p = await open(T), { page } = p;
    await branchSend(page, "Try it another way");
    await held(name, "send");
    await when(page, name, (s) => s.msgs.some((m) => m.sending));
    await hostCall(url, "POST", `/api/chats/${T}/archive`);
    await page.waitForSelector(".composer .archived-bar");
    let seen = await waitsSeen(page);
    expect(`${name}: the page shows nothing more of the message: no pending message and no line`, !seen.msgs.some((m) => m.sending) && !seen.lines.length, seen);
    await release(url, "send"); // the mock refuses it, as the server does
    if (!await until(async () => await holds(url, "send") === 0)) fail(`${name}: the call was not let go`);
    await frame(page); await frame(page);
    seen = await waitsSeen(page);
    expect(`${name}, the call ended: still nothing of it`, !seen.msgs.some((m) => m.sending) && !seen.lines.length && await page.locator(".composer .archived-bar").count() === 1, seen);
    await knob(`delete flags.send;`);
    await close(p, name);
  }
});
