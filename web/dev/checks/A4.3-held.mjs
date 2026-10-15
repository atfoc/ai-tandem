// Proves A4.3: a control that does nothing during a wait is disabled and says why. While a branch send waits for its
// answer (its POST is held in the mock): Back in the banner, the header's "Error on…" and "Approval needed on…", in the
// tree opening a row and "Branch and edit", on a message "Branch" and "Branch and edit", the model and effort pickers,
// Send and Enter. Typing still works. Fork, "Fork and edit", Label, Stop (the composer's and a branch's in the tree) and
// "N other branches working" stay live, and a fork asked for meanwhile holds its own controls and ends by itself. The
// same picture shows after another chat was opened and this one again. While a fork is being made, Fork and "Fork and
// edit" of that chat are disabled with the reason, on a message and in the tree, and nothing else is.
// Ports dev/checks/A4.3-held.mjs (S8) at desktop, tablet and phone: same seeds and knobs, same assertions and words, the page read over testIDs
// (checks/fork.mjs). Deviations: a message's actions are read one message at a time, the way the viewport shows them (a mouse hovers the message, a
// finger opens its "⋯" menu, where a disabled action has its reason under it); a row of the tree opens by a double click with a mouse and by a tap on the
// picked row with a finger, and its menu by a right click and by a long press; the foot says "Tap a message twice" for a finger.
// The composer is the real one (K3): the message is typed in the box and sent with Enter, and what is read of it is the model and effort pickers disabled
// with the reason, Send disabled with its spinner, Stop live, a press on the pickers, what is typed while the message is on its way and Enter sending
// nothing, the box after the answer.
import { callOfRequest, check, holds, mockEval, release, seed, until } from "../shot.mjs";
import { byTid, openChat, press } from "./sel.mjs";
import { actsSeen, closeTree, firstMsg, menuOfRow, notice, openRow, openTree, pressAct, send as sendMsg, startMove, treeRow, treeSeen, waitsSeen as seenNow, endRow } from "./fork.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const T = "c_A4_turns", TWO = "c_A4_two";
const SEND_HELD = "Your message is being sent: this works again once the server has answered";
const FORK_HELD = "A fork of this chat is being made: this works again once it is there";
const MSG = '[data-testid="msg"]';

await check("A4.3 what a wait holds is disabled and says why", async ({ url, viewport, open, fail, note }) => {
  const knob = (code) => mockEval(code, url);
  const frame = (page) => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok()))));
  const openAt = async (chat) => open({ sel: { chat }, wait: MSG });
  const expect = (name, ok, got) => { if (!ok) fail(`${name}: got ${JSON.stringify(got)}`); };
  const held = async (name, k, n = 1) => { if (!await until(async () => await holds(url, k) === n)) fail(`${name}: the mock holds ${await holds(url, k)} calls of ${k}, not ${n}`); };
  const waitsSeen = (page) => seenNow(page, { composer: true });
  /** What the page shows, with the actions of every message (the old `waitsSeen`). */
  const view = async (page) => ({ ...await waitsSeen(page), acts: await actsSeen(page) });
  const when = async (page, name, sign, withActs = false) => {
    let seen;
    if (!await until(async () => sign((seen = withActs ? await view(page) : await waitsSeen(page))))) fail(`${name}: the page did not come to show it. It shows ${JSON.stringify(seen)}`);
    return seen;
  };
  const act = (seen, i, kind) => seen.acts.filter((a) => a.kind === kind)[i];
  const tree = (page) => treeSeen(page);
  const item = (menu, label) => menu.find((m) => m.text === label);
  /** The menu of a row of the open tree. */
  const menuOf = async (page, kind, has) => { await menuOfRow(page, treeRow(page, kind, has)); return (await tree(page)).menu; };
  const closeMenu = async (page) => { await page.keyboard.press("Escape"); await until(async () => !(await byTid(page, "menu").count()), 4000); };
  const posts = (page, part) => { const seen = []; page.on("request", (r) => { const c = callOfRequest(r); if (c?.method === "POST" && c.path.includes(part)) seen.push(c.path); }); return seen; };
  const sendOf = (page, chat, text) => sendMsg(page, chat, text, { composer: true });

  // ---- a branch send that waits for its answer. main, the branch the message leaves, is in a turn; alt ended in an
  // error; a third branch works.
  {
    const name = "during a branch send", said = "Try it another way";
    await seed(url, "A4");
    await knob(`groups.find((g) => g.id === "g_A4").collapsed = false;
      addBranch("${TWO}", "main", 3, { status: "thinking" }, "wrk"); setSession("${TWO}", "wrk", { status: "thinking" });
      setSession("${TWO}", "alt", { status: "error", error: "the agent ended with an error" }); setSession("${TWO}", "main", { status: "thinking" });
      flags.send = { chat: "${TWO}", hold: true, noReply: true }; flags.fork = { chat: "${TWO}", hold: true };`);
    const { page, ctx } = await openAt(TWO);
    const stopped = posts(page, "/interrupt");
    await startMove(page);
    let seen = await view(page);
    expect(`before the Send nothing is held: Back, the alerts, the message's actions`, !seen.back.disabled && seen.alerts.length === 2 && seen.alerts.every((a) => !a.disabled) && seen.acts.every((a) => !a.disabled), seen);
    expect(`before the Send the thread says what the branch it is cut from does`, JSON.stringify(seen.typing) === '["Thinking…"]', seen.typing);
    await sendOf(page, TWO, said);
    await held(name, "send");
    seen = await when(page, name, (s) => s.msgs.some((m) => m.sending), true);

    expect(`${name}: Back is disabled and says why`, seen.back?.disabled && seen.back.title === SEND_HELD, seen.back);
    expect(`${name}: "Error on…" is disabled and says why, and "1 other branch working" is live`,
      /^Error on/.test(seen.alerts[0]?.text) && seen.alerts[0].disabled && seen.alerts[0].title === SEND_HELD && /other branch working/.test(seen.alerts[1]?.text) && !seen.alerts[1].disabled, seen.alerts);
    for (const kind of ["branch", "branchEdit"]) expect(`${name}: a message's "${kind}" is disabled and says why`, act(seen, 0, kind)?.disabled && act(seen, 0, kind).title === SEND_HELD, seen.acts);
    for (const kind of ["fork", "forkEdit", "label"]) expect(`${name}: a message's "${kind}" is live`, act(seen, 0, kind) && !act(seen, 0, kind).disabled && act(seen, 0, kind).title !== SEND_HELD, seen.acts);
    // (a picker the toolbar has no room for is in the "more" popup, which is closed: it is then not read)
    expect(`${name}: the model picker is disabled and says why`, seen.model ? seen.model.disabled && !seen.fixed && seen.model.title.endsWith(SEND_HELD) : seen.more, seen.model);
    expect(`${name}: the effort picker is disabled and says why`, seen.effort ? seen.effort.disabled && seen.effort.title.endsWith(SEND_HELD) : seen.more, seen.effort);
    expect(`${name}: Send is disabled, shows a spinner and says why`, seen.send?.disabled && seen.send.spin && seen.send.title === "Your message is being sent", seen.send);
    expect(`${name}: the thread has the line of the message, and not the status of the branch it leaves`, JSON.stringify(seen.lines) === '[["send","Starting the agent…"]]' && !seen.typing.length, [seen.lines, seen.typing]);
    expect(`${name}: Stop is drawn and live`, seen.stop, seen.stop);

    // what the disabled controls would do is not done
    await press(page, byTid(page, "fk-back").first(), { force: true });
    await frame(page);
    expect(`${name}: a press on Back changes nothing: the banner stays`, !!(await waitsSeen(page)).banner, (await waitsSeen(page)).banner);

    // Stop stops the branch that is left, as before (the composer's Stop: K3's)
    let base = stopped.length;
    await press(page, byTid(page, "stop").first());
    if (!await until(() => stopped.length === base + 1)) fail(`${name}: a press on the composer's Stop sent ${stopped.length - base} interrupts, not one`);
    base = stopped.length;

    // Label opens its field
    await pressAct(page, await firstMsg(page), "label");
    expect(`${name}: Label opens its field`, await until(() => byTid(page, "fk-label-field").count()), "no field");
    await page.keyboard.press("Escape");
    await until(async () => !(await byTid(page, "fk-label-field").count()));

    // "N other branches working" opens the tree; there a press on a row opens nothing, and "Branch and edit" is disabled
    await press(page, byTid(page, "fk-alert", { kind: "quiet" }).first());
    await byTid(page, "fk-row").first().waitFor({ state: "visible", timeout: 15000 });
    let t = await tree(page);
    expect(`${name}, the tree: every row is marked as disabled and says why, and so does the popup's foot`, t.rows.length >= 4 && t.rows.every((r) => r.disabled && r.title === SEND_HELD) && t.foot.startsWith(SEND_HELD), t);
    await openRow(page, endRow(page, "alt"));
    await openRow(page, treeRow(page, "user", "Is there a faster way?"));
    await frame(page);
    seen = await waitsSeen(page);
    expect(`${name}, the tree: opening a row opens nothing, and the popup stays`, !!await tree(page) && /is being sent/.test(seen.banner) && seen.msgs.some((m) => m.sending), [!!await tree(page), seen.banner]);
    let menu = await menuOf(page, "user", "Is there a faster way?");
    expect(`${name}, the tree: "Branch and edit" is disabled and says why; "Fork and edit" and Label are live`,
      item(menu, "Branch and edit")?.disabled && item(menu, "Branch and edit").title === SEND_HELD && item(menu, "Fork and edit") && !item(menu, "Fork and edit").disabled && item(menu, "Label") && !item(menu, "Label").disabled, menu);
    await closeMenu(page);
    menu = await menuOf(page, "text", "Yes: skip the copy");
    expect(`${name}, the tree: "Fork to new chat" is live`, item(menu, "Fork to new chat") && !item(menu, "Fork to new chat").disabled, menu);
    await closeMenu(page);
    expect(`${name}, the tree: a working branch's Stop is live`, t.stops.length >= 1 && t.stops.every((s) => !s.disabled), t.stops);
    await press(page, byTid(page, "fk-stop").first());
    if (!await until(() => stopped.length === base + 1)) fail(`${name}, the tree: a branch's Stop sent no interrupt`);
    await closeTree(page);

    // Fork stays live: a fork asked for now is a wait of its own
    await pressAct(page, await firstMsg(page), "fork");
    await held(`${name}: Fork`, "fork");
    seen = await when(page, `${name}, a fork asked for`, (s) => s.lines.length === 2, true);
    expect(`${name}, a fork asked for: both lines at the thread's foot`, JSON.stringify(seen.lines) === '[["send","Starting the agent…"],["fork","Making a fork of this chat…"]]', seen.lines);
    expect(`${name}, a fork asked for: Fork says that a fork is being made, Branch that the message is being sent`, act(seen, 0, "fork").disabled && act(seen, 0, "fork").title === FORK_HELD && act(seen, 0, "forkEdit").disabled && act(seen, 0, "forkEdit").title === FORK_HELD
      && act(seen, 0, "branch").title === SEND_HELD && seen.back.title === SEND_HELD, seen.acts);
    const picture = (s) => JSON.stringify({ ...s, lines: s.lines.filter((l) => l[0] !== "fork"), acts: s.acts.filter((a) => !a.kind.startsWith("fork")) });
    const during = picture(seen);

    // another chat is opened, and this one again: the same picture
    await openChat(page, T);
    await when(page, `${name}: another chat is opened`, (s) => !s.banner && s.msgs.length === 4);
    await openChat(page, TWO);
    seen = await when(page, `${name}: back in the chat`, (s) => !!s.banner && s.msgs.some((m) => m.sending) && s.msgs.length === 3);
    await frame(page);
    seen = await view(page);
    expect(`${name}: after another chat was opened and this one again, the page shows the same`, picture(seen) === during, { now: JSON.parse(picture(seen)), before: JSON.parse(during) });
    expect(`${name}, back in the chat: the fork's line and its held controls too`, seen.lines.some((l) => l[0] === "fork") && act(seen, 0, "fork").disabled && act(seen, 0, "fork").title === FORK_HELD, [seen.lines, seen.acts]);

    // the fork fails: its wait ends by itself, the send's goes on
    await release(url, "fork", `flags.fork.refuse = { status: 409, code: "busy", error: "the agent is still working; wait for it to finish or stop it" }`);
    const title = await notice(page);
    expect(`${name}: the fork that failed shows its notice`, title === "Couldn't fork the chat", title);
    seen = await when(page, `${name}, the fork failed`, (s) => s.lines.length === 1, true);
    expect(`${name}, the fork failed: Fork is live again, and the message is still on its way with its controls held`, !act(seen, 0, "fork").disabled && !act(seen, 0, "forkEdit").disabled && seen.back.disabled && act(seen, 0, "branch").disabled
      && JSON.stringify(seen.lines) === '[["send","Starting the agent…"]]', seen);

    // the answer: nothing is held any more
    await release(url, "send");
    seen = await when(page, `${name}, answered`, (s) => !s.banner && s.msgs.length === 3 && s.msgs.every((m) => m.live), true);
    expect(`${name}, answered: the message is in the thread once, and nothing is held`, seen.msgs[2].text === said && seen.acts.every((a) => !a.disabled), seen);
    note(`${name}: Back, "Error on…", Branch, Branch and edit and the tree's rows were disabled with "${SEND_HELD}"`);
    await knob(`delete flags.send; delete flags.fork;`);
    await ctx.close();
  }

  // ---- "Approval needed on…" is held the same way
  {
    const name = "during a branch send, another branch asks for approval";
    await seed(url, "A4");
    await knob(`setSession("${TWO}", "alt", { status: "approval" }); flags.send = { chat: "${TWO}", hold: true, noReply: true };`);
    const { page, ctx } = await openAt(TWO);
    await startMove(page);
    let seen = await waitsSeen(page);
    expect(`before the Send "Approval needed on…" is live`, seen.alerts.length === 1 && /^Approval needed on/.test(seen.alerts[0].text) && !seen.alerts[0].disabled, seen.alerts);
    await sendOf(page, TWO, "Try it another way");
    await held(name, "send");
    seen = await when(page, name, (s) => s.msgs.some((m) => m.sending));
    expect(`${name}: "Approval needed on…" is disabled and says why`, seen.alerts.length === 1 && /^Approval needed on/.test(seen.alerts[0].text) && seen.alerts[0].disabled && seen.alerts[0].title === SEND_HELD, seen.alerts);
    await press(page, byTid(page, "fk-alert", { kind: "asks" }).first(), { force: true });
    await frame(page);
    expect(`${name}: a press on it leaves the chat where it is`, /is being sent/.test((await waitsSeen(page)).banner), (await waitsSeen(page)).banner);
    await release(url, "send");
    await when(page, `${name}, answered`, (s) => !s.banner && s.msgs.every((m) => m.live));
    await knob(`delete flags.send;`);
    await ctx.close();
  }

  // ---- a fork being made: Fork and "Fork and edit" of that chat, on a message and in the tree
  {
    const name = "while a fork is being made";
    await seed(url, "A4");
    await knob(`groups.find((g) => g.id === "g_A4").collapsed = false; flags.fork = { chat: "${TWO}", hold: true };`);
    const { page, ctx } = await openAt(TWO);
    await pressAct(page, await firstMsg(page), "fork");
    await held(name, "fork");
    let seen = await when(page, name, (s) => s.lines.length > 0, true);
    const forks = seen.acts.filter((a) => a.kind === "fork" || a.kind === "forkEdit"), rest = seen.acts.filter((a) => a.kind !== "fork" && a.kind !== "forkEdit");
    expect(`${name}: every Fork and "Fork and edit" of the thread is disabled and says why`, forks.length >= 4 && forks.every((a) => a.disabled && a.title === FORK_HELD), forks);
    expect(`${name}: Branch, "Branch and edit" and Label are live`, rest.length >= 4 && rest.every((a) => !a.disabled), rest);
    expect(`${name}: the composer is as it was: no banner`, !seen.banner, seen.banner);
    expect(`${name}: Send is as it was`, !seen.send.spin && seen.send.title === "Send (Enter)", seen.send);
    await pressAct(page, await firstMsg(page), "fork", { force: true });
    await frame(page);
    expect(`${name}: a press on Fork asks for no second fork`, await holds(url, "fork") === 1, await holds(url, "fork"));
    await openTree(page);
    const t = await tree(page);
    expect(`${name}, the tree: its rows open as always`, t.rows.every((r) => !r.disabled && !r.title) && /^(Double-click|Tap a message twice)/.test(t.foot), t);
    let menu = await menuOf(page, "user", "Fix it.");
    expect(`${name}, the tree: "Fork and edit" is disabled and says why, "Branch and edit" is live`, item(menu, "Fork and edit")?.disabled && item(menu, "Fork and edit").title === FORK_HELD && !item(menu, "Branch and edit")?.disabled, menu);
    await closeMenu(page);
    menu = await menuOf(page, "text", "Done: the fonts are copied once.");
    expect(`${name}, the tree: "Fork to new chat" is disabled and says why`, item(menu, "Fork to new chat")?.disabled && item(menu, "Fork to new chat").title === FORK_HELD, menu);
    await closeMenu(page);
    await closeTree(page);
    // another chat's Fork is its own
    await openChat(page, T);
    seen = await when(page, `${name}: another chat`, (s) => s.msgs.length === 4 && s.msgs.every((m) => m.live), true);
    expect(`${name}: the Fork of another chat is live, and its thread has no line`, seen.acts.length > 0 && seen.acts.every((a) => !a.disabled) && !seen.lines.length, seen);
    // made: the fork opens, as before
    await release(url, "fork");
    if (!await until(async () => ((await byTid(page, "chat-head-name").first().textContent().catch(() => "")) ?? "").includes("Two branches (fork)"))) fail(`${name}: the fork did not open when it was made`);
    await knob(`delete flags.fork;`);
    await ctx.close();
  }
}, { viewports, page: false });
