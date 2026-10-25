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
// Ports dev/checks/A4.2-shows.mjs (S8) at desktop, tablet and phone: same seeds and knobs, same assertions and words, the page read over testIDs
// (checks/fork.mjs `waitsSeen`). Deviations: a message's actions are opened the way the viewport does (a mouse hovers the message, a finger taps
// its "⋯"); the tree's row is opened by a double click with a mouse and by a tap on the picked row with a finger; the 300 px page is the
// desktop's. The composer is the real one (K3): the message is typed in the box and sent with Enter, and what is read of it is the loading line of a branch
// whose events come late (the page's move draft), Send's spinner and its title, the empty box, the pickers (the model pick on a fresh fork of each kind,
// the effort pick: B-FK-19) and Send while the agent starts.
import { check, holds, mockEval, paneSize, release, sampleFrames, seed, until } from "../shot.mjs";
import { byTid, press, tidSel } from "./sel.mjs";
import { actsSeen, firstMsg, openRow, openTree, endRow, pressAct, send as sendMsg, startMove, treeRow, waitsSeen as seenNow } from "./fork.mjs";
import { closeChoice, openChoice, openSheetKind, phoneChip } from "./composer.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const T = "c_A4_turns", TWO = "c_A4_two", REMOTE = "c_A4_remote", LAB = "lab-gpu-box.tailnet-1234.ts.net";
const ASK = "Why is the build slow?", ANSWER = "Because of the font copy step. It copies every font file on each build.";
const SENDING = "Your message is being sent";
const MSG = '[data-testid="msg"]';

/** A probe for sampleFrames: the thread's messages in one frame. bad: a thread with no message, or one that shows
 *  the second turn of the branch that was left ("Fix it."), which a branch send never does. */
function threadProbe() {
  const thread = document.querySelector('[data-testid="thread"]');
  if (!thread) return null;
  const msgs = [...thread.querySelectorAll('[data-testid="msg"]')].map((m) => (m.textContent ?? "").trim().slice(0, 12));
  return { bad: !msgs.length || msgs.some((t) => t.startsWith("Fix it.")), n: msgs.length, sending: !!thread.querySelector('[data-testid="msg"][data-sending]'), msgs };
}

await check("A4.2 each wait of the fork flows shows something", async ({ url, viewport, layout, open, fail, note }) => {
  const knob = (code) => mockEval(code, url);
  /** The model sheet after a pick on a fresh fork: it may close by itself as the pick starts the agent again; else Done closes it. */
  const leaveSheet = async (page) => { if (!await until(async () => !(await openSheetKind(page)), 1500)) await closeChoice(page); };
  /** The phone's chip that takes no press (its DOM has no aria-disabled, only its cursor): a press on it opens no sheet. Answers whether one opened (and closes it). */
  const pressOpened = async (page) => {
    await phoneChip(page, "model").click({ force: true });
    const opened = !await until(async () => !(await openSheetKind(page)), 800);
    if (opened) await closeChoice(page);
    return opened;
  };
  const phone = layout === "phone"; // (the phone layout: Talk is the primary while the box is empty, so a Send that waits is not drawn, and the pickers are sheets)
  const openChat = async (chat, wait = MSG) => open({ sel: { chat }, wait });
  const texts = (seen) => seen.msgs.map((m) => `${m.who}${m.sending ? " (sending)" : ""}${m.live ? "" : " (not an item)"}: ${m.text}`);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const waitsSeen = (page) => seenNow(page, { composer: true });
  /** Reads the page once `sign` holds of what it shows; a sign that does not come within its bound fails the check. */
  const when = async (page, name, sign) => {
    let seen;
    if (!await until(async () => sign((seen = await waitsSeen(page))))) fail(`${name}: the page did not come to show it. It shows ${JSON.stringify(seen)}`);
    return seen;
  };
  const expect = (name, ok, got) => { if (!ok) fail(`${name}: got ${JSON.stringify(got)}`); };
  const held = async (name, k) => { if (!await until(() => holds(url, k))) fail(`${name}: the page's call did not reach the mock`); };
  const sendOf = (page, chat, text) => sendMsg(page, chat, text, { composer: true });
  /** A chip of the toolbar by its kind: in the row, or, where the row has no room for it, in the "more" popup (opened for it, and left open). */
  const chipOf = async (page, kind) => {
    if (!await byTid(page, "tchip", { kind }).count() && await byTid(page, "more-chip").count()) { await press(page, byTid(page, "more-chip").first()); await byTid(page, "more-pop").first().waitFor({ state: "visible", timeout: 10000 }); }
    return byTid(page, "tchip", { kind }).first();
  };

  // ---- a branch send, until the server answers; then until the new branch's list is here
  for (const late of [false, true]) {
    const name = `a branch send${late ? " whose events come after its answer" : ""}`, said = "Try it another way";
    await seed(url, "A4");
    // (the canned reply is left out: the new branch stays as the Send left it. Told late, nothing says that it works.)
    await knob(`flags.send = { chat: "${T}", hold: true, noReply: true${late ? ", eventsAfter: 1e9" : ""} };`);
    const { page, ctx } = await openChat(T);
    await startMove(page);
    const pending = await waitsSeen(page);
    expect(`${name}: before the Send the banner tells of the new branch and Back is live`, /your message starts it/.test(pending.banner) && pending.back && !pending.back.disabled, pending);
    const frames = await sampleFrames(page, threadProbe);
    await sendOf(page, T, said);
    await held(name, "send");
    let seen = await when(page, `${name}, until the answer`, (s) => s.msgs.some((m) => m.sending));
    expect(`${name}, until the answer: the thread up to the point, then the message in the pending look`, same(texts(seen), [`user: ${ASK}`, `agent: ${ANSWER}`, `user (sending) (not an item): ${said}`]), texts(seen));
    expect(`${name}, until the answer: the line that the agent is starting, and no other status line`, same(seen.lines, [["send", "Starting the agent…"]]) && !seen.typing.length, [seen.lines, seen.typing]);
    if (phone) expect(`${name}, until the answer: the phone's primary is Talk, with no Send to spin (the box was emptied by the send; the line and the banner tell of the wait)`, !seen.send && !!seen.talk, [seen.send, seen.talk]);
    else expect(`${name}, until the answer: Send shows a spinner and says why it takes no press`, seen.send?.disabled && seen.send.spin && seen.send.title === SENDING, seen.send);
    expect(`${name}, until the answer: the banner says that the message is being sent`, /your message is being sent/.test(seen.banner), seen.banner);
    expect(`${name}, until the answer: the box is empty`, seen.box === "", seen.box);
    // the list of the new branch is held too: what the page shows between the answer and that list
    await knob(`flags.items = { chat: "${T}", hold: true };`);
    await release(url, "send");
    seen = await when(page, `${name}, from the answer until the list`, (s) => !s.banner);
    await held(`${name}: the new branch's list`, "items");
    seen = await waitsSeen(page);
    expect(`${name}, from the answer until the list: the same history and the message, read-only`, same(texts(seen), [`user (not an item): ${ASK}`, `agent (not an item): ${ANSWER}`, `user (sending) (not an item): ${said}`]), texts(seen));
    const acts = await actsSeen(page);
    expect(`${name}, from the answer until the list: no fork action is offered on the history kept`, !acts.length, acts);
    // (with no composer open the move's draft is written to the server at the answer, which makes the mock tell the chat's status: the branch
    // then looks busy before its events come, and the line is the status's: the composer, which sets the draft through itself, is K3's)
    if (late) expect(`${name}, from the answer until the list: a loading line, since nothing says yet that the branch works`, same(seen.lines, [["load", "Loading…"]]) && !seen.typing.length, [seen.lines, seen.typing]);
    else expect(`${name}, from the answer until the list: the new branch's own status line`, !seen.lines.length && same(seen.typing, ["Thinking…"]), [seen.lines, seen.typing]);
    expect(`${name}, from the answer until the list: no control is held: no banner`, !seen.back, seen.back);
    expect(`${name}, from the answer until the list: Send is the new branch's own`, !seen.send?.spin && seen.send?.title !== SENDING, seen.send);
    await release(url, "items");
    seen = await when(page, `${name}, the list is here`, (s) => s.msgs.length === 3 && s.msgs.every((m) => m.live));
    expect(`${name}, the list is here: the branch's own thread, with the message once`, same(texts(seen), [`user: ${ASK}`, `agent: ${ANSWER}`, `user: ${said}`]) && !seen.lines.length, [texts(seen), seen.lines]);
    const f = await frames.stop();
    if (f.bad.length) fail(`${name}: ${f.bad.length} of ${f.values.length} frames showed an empty thread or the branch that was left, the first ${JSON.stringify(f.bad[0])}`);
    else if (!f.values.some((v) => v.sending)) fail(`${name}: no frame was sampled while the message was on its way`);
    else note(`${name}: ${f.values.length} frames from the Send until the new branch's thread, none empty; ${f.values.filter((v) => v.sending).length} with the message in the pending look`);
    await knob(`delete flags.send; delete flags.items;`);
    await ctx.close();
  }

  // ---- a branch send on a chat page of 300 px: what the wait adds passes no box (the composer's fit is A2.2's)
  if (viewport === "desktop") {
    const name = "a branch send at 300 px";
    await seed(url, "A4");
    await knob(`flags.send = { chat: "${T}", hold: true, noReply: true };`);
    const { page, ctx } = await open({ sel: { chat: T }, wait: MSG, ...paneSize("page", 300) });
    await startMove(page);
    await sendOf(page, T, "Try it another way, with a sentence long enough to wrap in a narrow thread");
    await held(name, "send");
    await when(page, name, (s) => s.msgs.some((m) => m.sending));
    const wide = await page.evaluate(() => {
      const t = document.querySelector('[data-testid="thread"]'), r = t.getBoundingClientRect();
      return [...t.querySelectorAll('[data-testid="msg"][data-sending], [data-testid="wait-line"]')].map((e) => Math.round(e.getBoundingClientRect().right - r.right));
    });
    expect(`${name}: the message on its way and its line end inside the thread`, wide.length === 2 && wide.every((over) => over <= 0), wide);
    const side = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(`${name}: the page does not scroll sideways`, side <= 0, side);
    await release(url, "send");
    await when(page, `${name}, answered`, (s) => !s.banner && s.msgs.every((m) => m.live));
    await knob(`delete flags.send;`);
    await ctx.close();
  }

  // ---- a branch send in a chat on another server: the line a first message there has
  {
    const name = "a branch send on another server", said = "Try it on the lab box";
    await seed(url, "A4");
    await knob(`flags.send = { chat: "${REMOTE}", hold: true, noReply: true };`);
    const key = `s_lab~${REMOTE}`; // (the chat is the lab box's: the page names it by both)
    const { page, ctx } = await openChat(key);
    await startMove(page);
    await sendOf(page, key, said);
    await held(name, "send");
    const seen = await when(page, name, (s) => s.msgs.some((m) => m.sending));
    expect(`${name}: the message, and the line that it is being sent there`, same(texts(seen).slice(-1), [`user (sending) (not an item): ${said}`]) && same(seen.lines, [["send", `Sending to ${LAB}…`]]), [texts(seen), seen.lines]);
    if (phone) expect(`${name}: the phone's primary is Talk, with no Send to spin`, !seen.send && !!seen.talk, [seen.send, seen.talk]);
    else expect(`${name}: Send shows a spinner`, seen.send?.disabled && seen.send.spin, seen.send);
    await release(url, "send");
    await when(page, `${name}, answered`, (s) => !s.banner && s.msgs.length === 3 && s.msgs.every((m) => m.live));
    await knob(`delete flags.send;`);
    await ctx.close();
  }

  // ---- a branch switch whose list is not here: a loading line, where the thread was blank
  {
    const name = "a branch switch";
    await seed(url, "A4");
    await knob(`flags.items = { chat: "${TWO}", branch: "alt", hold: true };`);
    const { page, ctx } = await openChat(TWO);
    await openTree(page);
    await openRow(page, endRow(page, "alt"));
    await held(name, "items");
    let seen = await when(page, name, (s) => s.lines.length > 0);
    expect(`${name} whose list is not here: a loading line, and nothing else in the thread`, same(seen.lines, [["load", "Loading…"]]) && !seen.msgs.length && !seen.empty, seen);
    await release(url, "items");
    seen = await when(page, `${name}, the list is here`, (s) => s.msgs.some((m) => m.text === "Is there a faster way?"));
    expect(`${name}, the list is here: the branch's thread and no line`, !seen.lines.length && seen.msgs.every((m) => m.live), seen);
    await knob(`delete flags.items;`);
    await ctx.close();
  }

  // ---- a branch opened for a move from the tree, its list not here: a line at the foot of the thread shown
  {
    const name = "a point of another branch opened from the tree";
    await seed(url, "A4");
    // (the chat opens on alt: main's list is not kept, and a move to a point of main reads it first)
    await knob(`setCurrent("${TWO}", "alt"); flags.items = { chat: "${TWO}", branch: "main", hold: true };`);
    const p = await openChat(TWO), page = p.page;
    await when(page, `${name}: the chat opens on the other branch`, (s) => s.msgs.some((m) => m.text === "Is there a faster way?"));
    await openTree(page);
    await openRow(page, treeRow(page, "text", "Because of the font copy step")); // the end of main's first turn: no end of a branch
    await held(name, "items");
    let seen = await when(page, name, (s) => s.lines.length > 0);
    expect(`${name}: the thread shown stays, with the line that the branch is being opened at its foot`, same(seen.lines, [["open", "Opening the branch…"]]) && seen.msgs.length === 4 && seen.msgs[2].text === "Is there a faster way?" && !seen.banner, seen);
    await release(url, "items");
    seen = await when(page, `${name}, the list is here`, (s) => !!s.banner);
    expect(`${name}, the list is here: the move is set on that branch, cut at the point, and the line is gone`, !seen.lines.length && same(texts(seen), [`user: ${ASK}`, `agent: ${ANSWER}`]), [seen.lines, texts(seen)]);
    await p.ctx.close();

    // "Branch and edit" on a message of a branch whose list is not here: the move is set at once, on a thread still to come
    const edit = "Branch and edit on a branch that is not loaded";
    await seed(url, "A4");
    await knob(`flags.items = { chat: "${TWO}", branch: "alt", hold: true };`);
    const q = await openChat(TWO);
    await openTree(q.page);
    await openRow(q.page, treeRow(q.page, "user", "Is there a faster way?"));
    await held(edit, "items");
    seen = await when(q.page, edit, (s) => s.lines.length > 0);
    expect(`${edit}: the banner, and the line that the branch is being opened where its thread will be`, same(seen.lines, [["open", "Opening the branch…"]]) && !seen.msgs.length && !!seen.banner, seen);
    await release(url, "items");
    seen = await when(q.page, `${edit}, the list is here`, (s) => s.msgs.length > 0 && s.box !== "");
    expect(`${edit}, the list is here: the thread cut at the point, no line`, !seen.lines.length && same(texts(seen), [`user: ${ASK}`, `agent: ${ANSWER}`]), [seen.lines, texts(seen)]);
    expect(`${edit}, the list is here: the message in the box`, seen.box === "Is there a faster way?", seen.box);
    await knob(`delete flags.items;`);
    await q.ctx.close();
  }

  // ---- a fork being made: a line at the foot of the source's thread
  {
    const name = "a fork being made";
    await seed(url, "A4");
    await knob(`flags.fork = { chat: "${T}", hold: true };`);
    const { page, ctx } = await openChat(T);
    await pressAct(page, await firstMsg(page), "fork");
    await held(name, "fork");
    const seen = await when(page, name, (s) => s.lines.length > 0);
    expect(`${name}: the source's thread as it was, with the line at its foot`, same(seen.lines, [["fork", "Making a fork of this chat…"]]) && seen.msgs.length === 4 && seen.msgs.every((m) => m.live), seen);
    await release(url, "fork");
    if (!await until(async () => ((await byTid(page, "chat-head-name").first().textContent().catch(() => "")) ?? "").includes("Branch send (fork)"))) fail(`${name}: the fork did not open when it was made`);
    // (the fork's screen opens as the source's line goes: waited for, so a moment in which both are drawn is not read as the fork's)
    const left = await until(async () => !(await waitsSeen(page)).lines.length, 5000);
    expect(`${name}, made: the fork's thread has no such line`, !!left, (await waitsSeen(page)).lines);
    await knob(`delete flags.fork;`);
    await ctx.close();
  }

  // ---- a model or effort pick on a fresh fork: the model chip and Send say what the agent starts on, for every agent kind
  for (const [kind, model] of [["claude", "sonnet"], ["cursor", "gpt-5.4-nano"], ["pi", "gpt-5.4"]]) {
    const name = `a model pick on a fresh ${kind} fork`, id = `c_A4_fork_${kind}`;
    await seed(url, "A4");
    await knob(`flags.configure = { chat: "${id}", hold: true };`);
    const { page, ctx } = await openChat(id, tidSel("tchip", { kind: "model" }));
    const before = await waitsSeen(page);
    // (the phone: the model sheet's row, which stays open under the pick (Done closes it); the pick is held by the mock, so no ✓ moves yet)
    const row = phone ? byTid(await openChoice(page, "model"), "picker-row", { value: model }) : (await press(page, await chipOf(page, "model")), byTid(page, "pick-row", { optionId: model }));
    const label = ((await row.first().textContent()) ?? "").replace("✓", "").replace(/\d+k context.*$/, "").trim().split("\n")[0]; // (the phone's row has the model's sub-line after its name)
    await press(page, row.first());
    await held(name, "configure");
    if (phone) await leaveSheet(page);
    // (at the phone the chip has no fixed look: it takes no press, and names the pick)
    const picking = phone ? (s) => s.lines.length > 0 || s.typing.length > 0 : (s) => s.fixed; // (the phone: the thread tells that the agent is starting)
    let seen = await when(page, name, picking);
    // (the phone: while the agent starts on the pick the model chip stays in the row, names the pick and takes no press)
    if (phone) expect(`${name}: the model chip stays and names ${label}`, !!seen.model && seen.model.label.includes(label), [seen.model, seen.effort]);
    if (phone) expect(`${name}: a press on the model chip opens no sheet while the agent starts`, !await pressOpened(page), await openSheetKind(page));
    if (!phone) expect(`${name}: the model is a fixed chip that names ${label} and says that the agent is starting on it`, seen.model?.title === "Starting the agent on this model…" && seen.model.text.includes(label) && !seen.effort, [seen.model, seen.effort]);
    if (phone) expect(`${name}: the phone's primary is Talk (the box is empty); no Send that waits`, !seen.send && !!seen.talk, [seen.send, seen.talk]);
    else expect(`${name}: Send takes no press and says that the agent is starting on ${label}`, seen.send?.disabled && seen.send.title.startsWith(`The agent is starting on ${label}`) && !seen.send.spin, seen.send);
    // (the fork says so itself once it is told to be working, which a pi fork never is: the line is then the wait's)
    // (the phone's busy line adds the step's seconds, " · 1 s", once one has passed: goal 3.5)
    const said = [...seen.typing.map((x) => x.replace(/ · \d+ s$/, "")), ...seen.lines.map((l) => l[1])];
    expect(`${name}: the thread says once that the agent is starting`, same(said, ["Starting the agent…"]) && seen.lines.every((l) => l[0] === "pick"), [seen.lines, seen.typing]);
    if (kind === "pi" && seen.typing.length) fail(`${name}: the mock told of the start, which pi does not: the page's own wait was not what showed it`);
    await release(url, "configure");
    seen = await when(page, `${name}, started`, (s) => !s.fixed && !!s.model?.text.includes(label));
    expect(`${name}, started: the picker is back on ${label}, and ${phone ? "the primary" : "Send"} is as before the pick`, (phone || !seen.model.disabled) && (phone ? !seen.send === !before.send && seen.talk?.label === before.talk?.label : seen.send?.title === before.send?.title), [seen.model, seen.send, seen.talk]);
    if (kind === "pi") {
      // an effort pick: the same picture, with the effort in the chip
      const effort = "an effort pick on a fresh pi fork";
      if (phone) await press(page, byTid(byTid(await openChoice(page, "model"), "effort-seg"), "segment", { value: "high" })); // (the effort is the model sheet's control; the pick is held, so its segment does not turn on yet)
      else {
        await press(page, await chipOf(page, "effort"));
        await press(page, byTid(page, "pick-row", { optionId: "high" }).first());
      }
      await held(effort, "configure");
      if (phone) await leaveSheet(page);
      seen = await when(page, effort, picking);
      if (phone) expect(`${effort}: the model chip takes no press and names the model and the effort picked, and the primary is Talk`, /High/.test(seen.model?.text ?? "") && seen.model.text.includes(label) && /High/.test(seen.model.label) && !seen.send && !!seen.talk && !await pressOpened(page), [seen.model, seen.send, seen.talk]);
      else expect(`${effort}: the fixed chip names the model and the effort picked, and Send the same`, /High/.test(seen.model?.text ?? "") && seen.model.text.includes(label) && /^The agent is starting on .*High/.test(seen.send?.title ?? "") && seen.send.disabled, [seen.model, seen.send]);
      await release(url, "configure");
      if (phone) await when(page, `${effort}, started`, (s) => !!s.model && /High/.test(s.model.text)); // (the phone has no effort chip: the model chip says "<model> · High")
      else {
      // (the effort chip is in the "more" popup where voice's pair has no room in the row and brought the chip, which closes with the pick: it is opened to read it)
      await when(page, `${effort}, started: the model chip is the picker again`, (s) => !s.fixed && !!s.model && !s.model.disabled);
      await chipOf(page, "effort");
      await when(page, `${effort}, started`, (s) => !s.fixed && /High/.test(s.effort?.text ?? ""));
      }
    }
    await knob(`delete flags.configure;`);
    await ctx.close();
  }

  // ---- the first Send to a fresh fork whose agent has to be started: the text after the copied history
  {
    const name = "the first Send to a fresh fork", id = "c_A4_fork_claude", said = "Go on from here";
    await seed(url, "A4");
    await knob(`flags.spawn = { chat: "${id}", hold: true };`);
    const { page, ctx } = await openChat(id);
    await sendOf(page, id, said);
    await held(name, "spawn");
    let seen = await when(page, name, (s) => s.msgs.some((m) => m.sending) && s.typing.length > 0);
    expect(`${name}: the copied history, then the text in the pending look`, same(texts(seen), [`user: ${ASK}`, `agent: ${ANSWER}`, `user (sending) (not an item): ${said}`]), texts(seen));
    expect(`${name}: with the line "Starting the agent…" under it, and no other`, same(seen.typing, ["Starting the agent…"]) && !seen.lines.length, [seen.typing, seen.lines]);
    if (phone) expect(`${name}: the phone's primary is Talk, with no Send to spin, and the box is empty`, !seen.send && !!seen.talk && seen.box === "", [seen.send, seen.talk, seen.box]);
    else expect(`${name}: Send shows a spinner, and the box is empty`, seen.send?.disabled && seen.send.spin && seen.box === "", [seen.send, seen.box]);
    await release(url, "spawn");
    seen = await when(page, `${name}, taken`, (s) => s.msgs.some((m) => m.text === said && m.live));
    expect(`${name}, taken: the message is in the thread once, as an item`, seen.msgs.filter((m) => m.text === said).length === 1 && !seen.msgs.some((m) => m.sending), texts(seen));
    await knob(`delete flags.spawn;`);
    await ctx.close();
  }
}, { viewports, page: false });
