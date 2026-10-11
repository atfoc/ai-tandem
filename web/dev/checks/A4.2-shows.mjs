// Proves A4.2: each wait of the fork flows shows something, at once and for as long as it lasts. The calls are held in
// the mock (a knob's `hold`) and let go by the check, so the page is read while a wait is on, whatever the machine's
// speed. In turn: a branch send until its answer (the thread up to the point, the message in the pending look, the
// line that the agent is starting, a spinner in Send, the banner), at 300 px too, and on another server its "Sending
// to …"; from the answer until the new branch's list is here (the same history and the message, read-only, never an
// empty thread in any frame, no control held); a branch switch whose list is not here (a loading line); a branch
// opened for a move from the tree (a line at the foot of the thread shown); a fork being made (a line at the foot of
// the source's thread); a model and an effort pick on a fresh fork of each agent kind (the model chip and Send say
// what the agent starts on, and the thread that it starts); the first Send to a fresh fork (the text after the copied
// history, with "Starting the agent…").
import { check, holds, measureComposer, mockEval, openPage, paneSize, release, sampleFrames, seed, startMove, until, waitsSeen } from "../shot.mjs";

const T = "c_A4_turns", TWO = "c_A4_two", REMOTE = "c_A4_remote", LAB = "lab-gpu-box.tailnet-1234.ts.net";
const ASK = "Why is the build slow?", ANSWER = "Because of the font copy step. It copies every font file on each build.";
const SENDING = "Your message is being sent";

/** A probe for sampleFrames: the thread's messages in one frame. bad: a thread with no message, or one that shows
 *  the second turn of the branch that was left ("Fix it."), which a branch send never does. */
function threadProbe() {
  const thread = document.querySelector(".thread:not(.read-only)");
  if (!thread) return null;
  const msgs = [...thread.querySelectorAll(":scope > .msg")].map((m) => m.textContent.trim().slice(0, 12));
  return { bad: !msgs.length || msgs.some((t) => t.startsWith("Fix it.")), n: msgs.length, sending: !!thread.querySelector(":scope > .msg.sending"), msgs };
}

await check("A4.2 each wait of the fork flows shows something", async ({ url, browser, fail, note }) => {
  const knob = (code) => mockEval(code, url);
  const open = async (chat, wait = ".thread .msg.assistant") => { const errors = []; return { ...await openPage({ url, browser, sel: { chat }, errors, wait }), errors }; };
  const close = async ({ ctx, errors }, name) => { for (const e of errors) fail(`${name}: page error: ${e}`); await ctx.close(); };
  const type = async (page, text) => { await page.locator(".composer .composer-input").click(); await page.keyboard.type(text); };
  const texts = (seen) => seen.msgs.map((m) => `${m.who}${m.sending ? " (sending)" : ""}${m.live ? "" : " (not an item)"}: ${m.text}`);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  /** Reads the page once `sign` holds of what it shows; a sign that does not come within its bound fails the check. */
  const when = async (page, name, sign) => {
    let seen;
    if (!await until(async () => sign((seen = await waitsSeen(page))))) fail(`${name}: the page did not come to show it. It shows ${JSON.stringify(seen)}`);
    return seen;
  };
  const expect = (name, ok, got) => { if (!ok) fail(`${name}: got ${JSON.stringify(got)}`); };
  const held = async (name, k) => { if (!await until(() => holds(url, k))) fail(`${name}: the page's call did not reach the mock`); };

  // ---- a branch send, until the server answers; then until the new branch's list is here
  for (const late of [false, true]) {
    const name = `a branch send${late ? " whose events come after its answer" : ""}`, said = "Try it another way";
    await seed(url, "A4");
    // (the canned reply is left out: the new branch stays as the Send left it. Told late, nothing says that it works.)
    await knob(`flags.send = { chat: "${T}", hold: true, noReply: true${late ? ", eventsAfter: 1e9" : ""} };`);
    const p = await open(T), { page } = p;
    await startMove(page);
    const pending = await waitsSeen(page);
    expect(`${name}: before the Send the banner tells of the new branch and Back is live`, /your message starts it/.test(pending.banner) && pending.back && !pending.back.disabled, pending);
    const frames = await sampleFrames(page, threadProbe);
    await type(page, said);
    await page.keyboard.press("Enter");
    await held(name, "send");
    let seen = await when(page, `${name}, until the answer`, (s) => s.msgs.some((m) => m.sending));
    expect(`${name}, until the answer: the thread up to the point, then the message in the pending look`, same(texts(seen), [`user: ${ASK}`, `agent: ${ANSWER}`, `user (sending) (not an item): ${said}`]), texts(seen));
    expect(`${name}, until the answer: the line that the agent is starting, and no other status line`, same(seen.lines, [["send", "Starting the agent…"]]) && !seen.typing.length, [seen.lines, seen.typing]);
    expect(`${name}, until the answer: Send shows a spinner and says why it takes no press`, seen.send?.disabled && seen.send.spin && seen.send.title === SENDING, seen.send);
    expect(`${name}, until the answer: the banner says that the message is being sent`, /your message is being sent/.test(seen.banner), seen.banner);
    expect(`${name}, until the answer: the box is empty`, seen.box === "", seen.box);
    // the list of the new branch is held too: what the page shows between the answer and that list
    await knob(`flags.items = { chat: "${T}", hold: true };`);
    await release(url, "send");
    seen = await when(page, `${name}, from the answer until the list`, (s) => !s.banner);
    await held(`${name}: the new branch's list`, "items");
    seen = await waitsSeen(page);
    expect(`${name}, from the answer until the list: the same history and the message, read-only`, same(texts(seen), [`user (not an item): ${ASK}`, `agent (not an item): ${ANSWER}`, `user (sending) (not an item): ${said}`]), texts(seen));
    expect(`${name}, from the answer until the list: no fork action is offered on the history kept`, !seen.acts.length, seen.acts);
    if (late) expect(`${name}, from the answer until the list: a loading line, since nothing says yet that the branch works`, same(seen.lines, [["load", "Loading…"]]) && !seen.typing.length, [seen.lines, seen.typing]);
    else expect(`${name}, from the answer until the list: the new branch's own status line`, !seen.lines.length && same(seen.typing, ["Thinking…"]), [seen.lines, seen.typing]);
    expect(`${name}, from the answer until the list: no control is held: no banner, and Send is the new branch's own`, !seen.back && !seen.send?.spin && seen.send?.title !== SENDING, [seen.back, seen.send]);
    await release(url, "items");
    seen = await when(page, `${name}, the list is here`, (s) => s.msgs.length === 3 && s.msgs.every((m) => m.live));
    expect(`${name}, the list is here: the branch's own thread, with the message once`, same(texts(seen), [`user: ${ASK}`, `agent: ${ANSWER}`, `user: ${said}`]) && !seen.lines.length, [texts(seen), seen.lines]);
    const f = await frames.stop();
    if (f.bad.length) fail(`${name}: ${f.bad.length} of ${f.values.length} frames showed an empty thread or the branch that was left, the first ${JSON.stringify(f.bad[0])}`);
    else if (!f.values.some((v) => v.sending)) fail(`${name}: no frame was sampled while the message was on its way`);
    else note(`${name}: ${f.values.length} frames from the Send until the new branch's thread, none empty; ${f.values.filter((v) => v.sending).length} with the message in the pending look`);
    await knob(`delete flags.send; delete flags.items;`);
    await close(p, name);
  }

  // ---- a branch send on a chat page of 300 px: what the wait adds passes no box (the composer's fit is A2.2's)
  {
    const name = "a branch send at 300 px", errors = [];
    await seed(url, "A4");
    await knob(`flags.send = { chat: "${T}", hold: true, noReply: true };`);
    const { ctx, page } = await openPage({ url, browser, sel: { chat: T }, errors, wait: ".thread .msg.assistant", ...paneSize("page", 300) });
    await startMove(page);
    await type(page, "Try it another way, with a sentence long enough to wrap in a narrow thread");
    await page.keyboard.press("Enter");
    await held(name, "send");
    await when(page, name, (s) => s.msgs.some((m) => m.sending) && s.send.spin);
    const fit = (await measureComposer(page)).find((c) => !c.none);
    expect(`${name}: no control of the composer passes its box, Send is where it is, and the page does not scroll sideways`, fit && fit.past === 0 && fit.send === "ok" && fit.docScroll <= 0, fit && { past: fit.past, over: fit.over, send: fit.send, docScroll: fit.docScroll });
    const wide = await page.evaluate(() => { const t = document.querySelector(".thread"), r = t.getBoundingClientRect(); return [...t.querySelectorAll(":scope > .msg.sending, :scope > .wait-line")].map((e) => Math.round(e.getBoundingClientRect().right - r.right)); });
    expect(`${name}: the message on its way and its line end inside the thread`, wide.length === 2 && wide.every((over) => over <= 0), wide);
    await release(url, "send");
    await when(page, `${name}, answered`, (s) => !s.banner && s.msgs.every((m) => m.live));
    await knob(`delete flags.send;`);
    for (const e of errors) fail(`${name}: page error: ${e}`);
    await ctx.close();
  }

  // ---- a branch send in a chat on another server: the line a first message there has
  {
    const name = "a branch send on another server", said = "Try it on the lab box";
    await seed(url, "A4");
    await knob(`flags.send = { chat: "${REMOTE}", hold: true, noReply: true };`);
    const p = await open(REMOTE), { page } = p;
    await startMove(page);
    await type(page, said);
    await page.keyboard.press("Enter");
    await held(name, "send");
    const seen = await when(page, name, (s) => s.msgs.some((m) => m.sending));
    expect(`${name}: the message, and the line that it is being sent there`, same(texts(seen).slice(-1), [`user (sending) (not an item): ${said}`]) && same(seen.lines, [["send", `Sending to ${LAB}…`]]), [texts(seen), seen.lines]);
    expect(`${name}: Send shows a spinner`, seen.send?.disabled && seen.send.spin, seen.send);
    await release(url, "send");
    await when(page, `${name}, answered`, (s) => !s.banner && s.msgs.length === 3 && s.msgs.every((m) => m.live));
    await knob(`delete flags.send;`);
    await close(p, name);
  }

  // ---- a branch switch whose list is not here: a loading line, where the thread was blank
  {
    const name = "a branch switch";
    await seed(url, "A4");
    await knob(`flags.items = { chat: "${TWO}", branch: "alt", hold: true };`);
    const p = await open(TWO), { page } = p;
    await page.locator(".chat-head .fk-tree-btn").click();
    await page.locator('.fk-nav .fk-row[data-end="alt"]').dblclick();
    await held(name, "items");
    let seen = await when(page, name, (s) => s.lines.length > 0);
    expect(`${name} whose list is not here: a loading line, and nothing else in the thread`, same(seen.lines, [["load", "Loading…"]]) && !seen.msgs.length && !seen.empty, seen);
    await release(url, "items");
    seen = await when(page, `${name}, the list is here`, (s) => s.msgs.some((m) => m.text === "Is there a faster way?"));
    expect(`${name}, the list is here: the branch's thread and no line`, !seen.lines.length && seen.msgs.every((m) => m.live), seen);
    await knob(`delete flags.items;`);
    await close(p, name);
  }

  // ---- a branch opened for a move from the tree, its list not here: a line at the foot of the thread shown
  {
    const name = "a point of another branch opened from the tree";
    await seed(url, "A4");
    // (the chat opens on alt: main's list is not kept, and a move to a point of main reads it first)
    await knob(`setCurrent("${TWO}", "alt"); flags.items = { chat: "${TWO}", branch: "main", hold: true };`);
    const p = await open(TWO), { page } = p;
    await when(page, `${name}: the chat opens on the other branch`, (s) => s.msgs.some((m) => m.text === "Is there a faster way?"));
    await page.locator(".chat-head .fk-tree-btn").click();
    await page.locator(".fk-nav .fk-row.k-text", { hasText: "Because of the font copy step" }).first().dblclick(); // the end of main's first turn: no end of a branch
    await held(name, "items");
    let seen = await when(page, name, (s) => s.lines.length > 0);
    expect(`${name}: the thread shown stays, with the line that the branch is being opened at its foot`, same(seen.lines, [["open", "Opening the branch…"]]) && seen.msgs.length === 4 && seen.msgs[2].text === "Is there a faster way?" && !seen.banner, seen);
    await release(url, "items");
    seen = await when(page, `${name}, the list is here`, (s) => !!s.banner);
    expect(`${name}, the list is here: the move is set on that branch, cut at the point, and the line is gone`, !seen.lines.length && same(texts(seen), [`user: ${ASK}`, `agent: ${ANSWER}`]), [seen.lines, texts(seen)]);
    await close(p, name);

    // "Branch and edit" on a message of a branch whose list is not here: the move is set at once, on a thread still to come
    const edit = "Branch and edit on a branch that is not loaded";
    await seed(url, "A4");
    await knob(`flags.items = { chat: "${TWO}", branch: "alt", hold: true };`);
    const q = await open(TWO);
    await q.page.locator(".chat-head .fk-tree-btn").click();
    await q.page.locator(".fk-nav .fk-row.k-user", { hasText: "Is there a faster way?" }).first().dblclick();
    await held(edit, "items");
    seen = await when(q.page, edit, (s) => s.lines.length > 0);
    expect(`${edit}: the banner, and the line that the branch is being opened where its thread will be`, same(seen.lines, [["open", "Opening the branch…"]]) && !seen.msgs.length && !!seen.banner, seen);
    await release(url, "items");
    seen = await when(q.page, `${edit}, the list is here`, (s) => s.msgs.length > 0 && s.box !== "");
    expect(`${edit}, the list is here: the thread cut at the point, the message in the box, no line`, !seen.lines.length && same(texts(seen), [`user: ${ASK}`, `agent: ${ANSWER}`]) && seen.box === "Is there a faster way?", [seen.lines, texts(seen), seen.box]);
    await knob(`delete flags.items;`);
    await close(q, edit);
  }

  // ---- a fork being made: a line at the foot of the source's thread
  {
    const name = "a fork being made";
    await seed(url, "A4");
    await knob(`flags.fork = { chat: "${T}", hold: true };`);
    const p = await open(T), { page } = p;
    await page.locator(".thread .msg.assistant").first().hover();
    await page.locator(".thread .msg.assistant .fk-act.k-fork").first().click();
    await held(name, "fork");
    const seen = await when(page, name, (s) => s.lines.length > 0);
    expect(`${name}: the source's thread as it was, with the line at its foot`, same(seen.lines, [["fork", "Making a fork of this chat…"]]) && seen.msgs.length === 4 && seen.msgs.every((m) => m.live), seen);
    await release(url, "fork");
    if (!await until(() => page.evaluate(() => document.querySelector(".chat-head-name")?.textContent.includes("Branch send (fork)")))) fail(`${name}: the fork did not open when it was made`);
    expect(`${name}, made: the fork's thread has no such line`, !(await waitsSeen(page)).lines.length, (await waitsSeen(page)).lines);
    await knob(`delete flags.fork;`);
    await close(p, name);
  }

  // ---- a model or effort pick on a fresh fork: the model chip and Send say what the agent starts on, for every agent kind
  for (const [kind, model] of [["claude", "sonnet"], ["cursor", "gpt-5.4-nano"], ["pi", "gpt-5.4"]]) {
    const name = `a model pick on a fresh ${kind} fork`, id = `c_A4_fork_${kind}`;
    await seed(url, "A4");
    await knob(`flags.configure = { chat: "${id}", hold: true };`);
    const p = await open(id, ".composer .model-pick > button.tchip"), { page } = p;
    const before = await waitsSeen(page);
    await page.locator(".composer .model-pick > button.tchip").click();
    const row = page.locator(`.composer .model-pick .menu-item[data-model-id="${model}"]`);
    const label = (await row.locator(".menu-label").evaluate((e) => e.firstChild?.textContent ?? e.textContent)).trim();
    await row.click();
    await held(name, "configure");
    let seen = await when(page, name, (s) => s.fixed);
    expect(`${name}: the model is a fixed chip that names ${label} and says that the agent is starting on it`, seen.model?.title === "Starting the agent on this model…" && seen.model.text.includes(label) && !seen.effort, [seen.model, seen.effort]);
    expect(`${name}: Send takes no press and says that the agent is starting on ${label}`, seen.send?.disabled && seen.send.title.startsWith(`The agent is starting on ${label}`) && !seen.send.spin, seen.send);
    // (the fork says so itself once it is told to be working, which a pi fork never is: the line is then the wait's)
    expect(`${name}: the thread says once that the agent is starting`, same([...seen.typing, ...seen.lines.map((l) => l[1])], ["Starting the agent…"]) && seen.lines.every((l) => l[0] === "pick"), [seen.lines, seen.typing]);
    if (kind === "pi" && seen.typing.length) fail(`${name}: the mock told of the start, which pi does not: the page's own wait was not what showed it`);
    await release(url, "configure");
    seen = await when(page, `${name}, started`, (s) => !s.fixed && !!s.model?.text.includes(label));
    expect(`${name}, started: the picker is back on ${label}, and Send is as before the pick`, !seen.model.disabled && seen.send?.title === before.send?.title, [seen.model, seen.send]);
    if (kind === "pi") {
      // an effort pick: the same picture, with the effort in the chip
      const effort = "an effort pick on a fresh pi fork";
      await page.locator('.composer button.tchip[title^="Effort"]').click();
      await page.locator('.composer .menu-item[data-option-id="high"]').click();
      await held(effort, "configure");
      seen = await when(page, effort, (s) => s.fixed);
      expect(`${effort}: the fixed chip names the model and the effort picked, and Send the same`, /High/.test(seen.model?.text ?? "") && seen.model.text.includes(label) && /^The agent is starting on .*High/.test(seen.send?.title ?? "") && seen.send.disabled, [seen.model, seen.send]);
      await release(url, "configure");
      await when(page, `${effort}, started`, (s) => !s.fixed && /High/.test(s.effort?.text ?? ""));
    }
    await knob(`delete flags.configure;`);
    await close(p, name);
  }

  // ---- the first Send to a fresh fork whose agent has to be started: the text after the copied history
  {
    const name = "the first Send to a fresh fork", id = "c_A4_fork_claude", said = "Go on from here";
    await seed(url, "A4");
    await knob(`flags.spawn = { chat: "${id}", hold: true };`);
    const p = await open(id), { page } = p;
    await type(page, said);
    await page.keyboard.press("Enter");
    await held(name, "spawn");
    let seen = await when(page, name, (s) => s.msgs.some((m) => m.sending) && s.typing.length > 0);
    expect(`${name}: the copied history, then the text in the pending look`, same(texts(seen), [`user: ${ASK}`, `agent: ${ANSWER}`, `user (sending) (not an item): ${said}`]), texts(seen));
    expect(`${name}: with the line "Starting the agent…" under it, and no other`, same(seen.typing, ["Starting the agent…"]) && !seen.lines.length, [seen.typing, seen.lines]);
    expect(`${name}: Send shows a spinner, and the box is empty`, seen.send?.disabled && seen.send.spin && seen.box === "", [seen.send, seen.box]);
    await release(url, "spawn");
    seen = await when(page, `${name}, taken`, (s) => s.msgs.some((m) => m.text === said && m.live));
    expect(`${name}, taken: the message is in the thread once, as an item`, seen.msgs.filter((m) => m.text === said).length === 1 && !seen.msgs.some((m) => m.sending), texts(seen));
    await knob(`delete flags.spawn;`);
    await close(p, name);
  }
});
