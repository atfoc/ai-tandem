// Proves A4.3: a control that does nothing during a wait is disabled and says why. While a branch send waits for its
// answer (its POST is held in the mock): Back in the banner, the header's "Error on…" and "Approval needed on…", in the
// tree opening a row and "Branch and edit", on a message "Branch" and "Branch and edit", the model and effort pickers,
// Send and Enter. Typing still works. Fork, "Fork and edit", Label, Stop (the composer's and a branch's in the tree) and
// "N other branches working" stay live, and a fork asked for meanwhile holds its own controls and ends by itself. The
// same picture shows after another chat was opened and this one again. While a fork is being made, Fork and "Fork and
// edit" of that chat are disabled with the reason, on a message and in the tree, and nothing else is.
import { callOfRequest, check, holds, mockEval, openPage, release, seed, startMove, until, waitsSeen } from "../shot.mjs";

const T = "c_A4_turns", TWO = "c_A4_two";
const SEND_HELD = "Your message is being sent: this works again once the server has answered";
const FORK_HELD = "A fork of this chat is being made: this works again once it is there";

/** In the page: the open tree popup. rows: its message rows, with whether each is marked as disabled (its text, which
 *  is what a double click opens: the row's Stop stays a live control) and its title; menu: the items of its right-click
 *  menu; stops: its Stop buttons; foot: the line under the rows. */
function treeInPage() {
  const text = (e) => (e?.textContent ?? "").replace(/\s+/g, " ").trim();
  const nav = document.querySelector(".fk-nav");
  if (!nav) return null;
  return {
    rows: [...nav.querySelectorAll(".fk-row:not(.fk-fork-row)")].map((r) => ({ text: text(r.querySelector(".fk-text")), disabled: r.classList.contains("held") && r.querySelector(".fk-text")?.getAttribute("aria-disabled") === "true", title: r.getAttribute("title") ?? "" })),
    menu: [...nav.querySelectorAll(".fk-ctx .menu-item")].map((b) => ({ text: text(b), disabled: b.disabled, title: b.getAttribute("title") ?? "" })),
    stops: [...nav.querySelectorAll(".fk-stop")].map((b) => ({ disabled: b.disabled })),
    foot: text(nav.querySelector(".fk-nav-foot")),
  };
}

await check("A4.3 what a wait holds is disabled and says why", async ({ url, browser, fail, note }) => {
  const knob = (code) => mockEval(code, url);
  const frame = (page) => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok()))));
  const open = async (chat) => { const errors = []; return { ...await openPage({ url, browser, sel: { chat }, errors, wait: ".thread .msg.assistant" }), errors }; };
  const close = async ({ ctx, errors }, name) => { for (const e of errors) fail(`${name}: page error: ${e}`); await ctx.close(); };
  const expect = (name, ok, got) => { if (!ok) fail(`${name}: got ${JSON.stringify(got)}`); };
  const held = async (name, k, n = 1) => { if (!await until(async () => await holds(url, k) === n)) fail(`${name}: the mock holds ${await holds(url, k)} calls of ${k}, not ${n}`); };
  const when = async (page, name, sign) => {
    let seen;
    if (!await until(async () => sign((seen = await waitsSeen(page))))) fail(`${name}: the page did not come to show it. It shows ${JSON.stringify(seen)}`);
    return seen;
  };
  const tree = (page) => page.evaluate(treeInPage);
  const act = (seen, i, kind) => seen.acts.filter((a) => a.kind === kind)[i];
  /** The right-click menu of a row of the open tree. */
  const menuOf = async (page, kind, has) => { await page.locator(`.fk-nav .fk-row.k-${kind}`, { hasText: has }).first().click({ button: "right" }); await page.waitForSelector(".fk-ctx .menu-item"); return (await tree(page)).menu; };
  const item = (menu, label) => menu.find((m) => m.text === label);
  const posts = (page, part) => { const seen = []; page.on("request", (r) => { const c = callOfRequest(r); if (c?.method === "POST" && c.path.includes(part)) seen.push(c.path); }); return seen; };

  // ---- a branch send that waits for its answer. main, the branch the message leaves, is in a turn; alt ended in an
  // error; a third branch works.
  {
    const name = "during a branch send", said = "Try it another way";
    await seed(url, "A4");
    await knob(`groups.find((g) => g.id === "g_A4").collapsed = false;
      addBranch("${TWO}", "main", 3, { status: "thinking" }, "wrk"); setSession("${TWO}", "wrk", { status: "thinking" });
      setSession("${TWO}", "alt", { status: "error", error: "the agent ended with an error" }); setSession("${TWO}", "main", { status: "thinking" });
      flags.send = { chat: "${TWO}", hold: true, noReply: true }; flags.fork = { chat: "${TWO}", hold: true };`);
    const p = await open(TWO), { page } = p;
    const stopped = posts(page, "/interrupt"), sent = posts(page, "/messages");
    await startMove(page);
    let seen = await waitsSeen(page);
    expect(`before the Send nothing is held: Back, the alerts, the message's actions, the pickers`, !seen.back.disabled && seen.alerts.length === 2 && seen.alerts.every((a) => !a.disabled) && seen.acts.every((a) => !a.disabled) && !seen.model.disabled && !seen.effort.disabled, seen);
    expect(`before the Send the thread says what the branch it is cut from does`, JSON.stringify(seen.typing) === '["Thinking…"]', seen.typing);
    await page.locator(".composer .composer-input").click();
    await page.keyboard.type(said);
    await page.keyboard.press("Enter");
    await held(name, "send");
    seen = await when(page, name, (s) => s.msgs.some((m) => m.sending));

    expect(`${name}: Back is disabled and says why`, seen.back?.disabled && seen.back.title === SEND_HELD, seen.back);
    expect(`${name}: "Error on…" is disabled and says why, and "1 other branch working" is live`,
      /^Error on/.test(seen.alerts[0]?.text) && seen.alerts[0].disabled && seen.alerts[0].title === SEND_HELD && /other branch working/.test(seen.alerts[1]?.text) && !seen.alerts[1].disabled, seen.alerts);
    for (const kind of ["branch", "branchEdit"]) expect(`${name}: a message's "${kind}" is disabled and says why`, act(seen, 0, kind)?.disabled && act(seen, 0, kind).title === SEND_HELD, seen.acts);
    for (const kind of ["fork", "forkEdit", "label"]) expect(`${name}: a message's "${kind}" is live`, act(seen, 0, kind) && !act(seen, 0, kind).disabled && act(seen, 0, kind).title !== SEND_HELD, seen.acts);
    expect(`${name}: the model picker is disabled and says why`, seen.model?.disabled && !seen.fixed && seen.model.title.endsWith(SEND_HELD), seen.model);
    expect(`${name}: the effort picker is disabled and says why`, seen.effort?.disabled && seen.effort.title.endsWith(SEND_HELD), seen.effort);
    expect(`${name}: Send is disabled, shows a spinner and says why`, seen.send?.disabled && seen.send.spin && seen.send.title === "Your message is being sent", seen.send);
    expect(`${name}: the thread has the line of the message, and not the status of the branch it leaves`, JSON.stringify(seen.lines) === '[["send","Starting the agent…"]]' && !seen.typing.length, [seen.lines, seen.typing]);
    expect(`${name}: Stop is drawn and live`, seen.stop && await page.locator(".composer .send.stop").isEnabled(), seen.stop);

    // what the disabled controls would do is not done
    await page.locator(".fk-banner button").click({ force: true });
    await page.locator(".composer .model-pick > button.tchip").click({ force: true });
    await page.locator('.composer button.tchip[title^="Effort"]').click({ force: true });
    await frame(page);
    expect(`${name}: a press on Back and on the pickers changes nothing: the banner stays and no list opens`, !!(await waitsSeen(page)).banner && !await page.locator(".composer .menu.up").count(), await page.locator(".composer .menu.up").count());

    // typing still works, and Enter sends nothing
    await page.locator(".composer .composer-input").click();
    await page.keyboard.type("And then?");
    await page.keyboard.press("Enter");
    await frame(page);
    seen = await waitsSeen(page);
    expect(`${name}: what is typed stays in the box, Enter sends nothing, and Send is still held`, seen.box === "And then?" && sent.length === 1 && await holds(url, "send") === 1 && seen.send.disabled && seen.send.spin, [seen.box, sent.length, seen.send]);

    // Stop stops the branch that is left, as before
    await page.locator(".composer .send.stop").click();
    if (!await until(() => stopped.length === 1)) fail(`${name}: Stop sent no interrupt`);

    // Label opens its field
    await page.locator(".thread .msg.assistant").first().hover();
    await page.locator(".thread .msg.assistant .fk-act.k-label").first().click();
    expect(`${name}: Label opens its field`, await until(() => page.locator(".thread .fk-label-float").count()), "no field");
    await page.keyboard.press("Escape");

    // "N other branches working" opens the tree; there a double click opens nothing, and "Branch and edit" is disabled
    await page.locator(".chat-head .fk-alert.quiet").click();
    await page.waitForSelector(".fk-nav .fk-row");
    let t = await tree(page);
    expect(`${name}, the tree: every row is marked as disabled and says why, and so does the popup's foot`, t.rows.length >= 4 && t.rows.every((r) => r.disabled && r.title === SEND_HELD) && t.foot.startsWith(SEND_HELD), t);
    await page.locator('.fk-nav .fk-row[data-end="alt"]').dblclick();
    await page.locator(".fk-nav .fk-row.k-user", { hasText: "Is there a faster way?" }).first().dblclick();
    await frame(page);
    seen = await waitsSeen(page);
    expect(`${name}, the tree: a double click on a row opens nothing, and the popup stays`, !!await tree(page) && /is being sent/.test(seen.banner) && seen.msgs.some((m) => m.sending), [!!await tree(page), seen.banner]);
    let menu = await menuOf(page, "user", "Is there a faster way?");
    expect(`${name}, the tree: "Branch and edit" is disabled and says why; "Fork and edit" and Label are live`,
      item(menu, "Branch and edit")?.disabled && item(menu, "Branch and edit").title === SEND_HELD && item(menu, "Fork and edit") && !item(menu, "Fork and edit").disabled && item(menu, "Label") && !item(menu, "Label").disabled, menu);
    await page.keyboard.press("Escape");
    menu = await menuOf(page, "text", "Yes: skip the copy");
    expect(`${name}, the tree: "Fork to new chat" is live`, item(menu, "Fork to new chat") && !item(menu, "Fork to new chat").disabled, menu);
    await page.keyboard.press("Escape");
    expect(`${name}, the tree: a working branch's Stop is live`, t.stops.length >= 1 && t.stops.every((s) => !s.disabled), t.stops);
    await page.locator(".fk-nav .fk-stop").first().click();
    if (!await until(() => stopped.length === 2)) fail(`${name}, the tree: a branch's Stop sent no interrupt`);
    await page.locator(".fk-nav .icon-btn[title=Close]").click();
    await until(async () => !await tree(page));

    // Fork stays live: a fork asked for now is a wait of its own
    await page.locator(".thread .msg.assistant").first().hover();
    await page.locator(".thread .msg.assistant .fk-act.k-fork").first().click();
    await held(`${name}: Fork`, "fork");
    seen = await when(page, `${name}, a fork asked for`, (s) => s.lines.length === 2);
    expect(`${name}, a fork asked for: both lines at the thread's foot`, JSON.stringify(seen.lines) === '[["send","Starting the agent…"],["fork","Making a fork of this chat…"]]', seen.lines);
    expect(`${name}, a fork asked for: Fork says that a fork is being made, Branch that the message is being sent`, act(seen, 0, "fork").disabled && act(seen, 0, "fork").title === FORK_HELD && act(seen, 0, "forkEdit").disabled && act(seen, 0, "forkEdit").title === FORK_HELD
      && act(seen, 0, "branch").title === SEND_HELD && seen.back.title === SEND_HELD, seen.acts);
    const picture = (s) => JSON.stringify({ ...s, lines: s.lines.filter((l) => l[0] !== "fork"), acts: s.acts.filter((a) => !a.kind.startsWith("fork")) });
    const during = picture(seen);

    // another chat is opened, and this one again: the same picture, the composer's own state gone or not
    await page.locator('.side-row[title^="Branch send —"]').first().click();
    await when(page, `${name}: another chat is opened`, (s) => !s.banner && s.msgs.length === 4);
    await page.locator('.side-row[title^="Two branches —"]').first().click();
    seen = await when(page, `${name}: back in the chat`, (s) => !!s.banner && s.msgs.some((m) => m.sending) && s.msgs.length === 3);
    await frame(page);
    seen = await waitsSeen(page);
    expect(`${name}: after another chat was opened and this one again, the page shows the same`, picture(seen) === during, { now: JSON.parse(picture(seen)), before: JSON.parse(during) });
    expect(`${name}, back in the chat: the fork's line and its held controls too`, seen.lines.some((l) => l[0] === "fork") && act(seen, 0, "fork").disabled && act(seen, 0, "fork").title === FORK_HELD, [seen.lines, seen.acts]);
    await page.keyboard.press("Enter"); // (the box has the focus and its text: Enter must still send nothing)
    await frame(page);
    expect(`${name}, back in the chat: Enter sends nothing`, sent.length === 1 && await holds(url, "send") === 1, sent.length);

    // the fork fails: its wait ends by itself, the send's goes on
    await release(url, "fork", `flags.fork.refuse = { status: 409, code: "busy", error: "the agent is still working; wait for it to finish or stop it" }`);
    await page.waitForSelector(".dialog .dialog-title");
    expect(`${name}: the fork that failed shows its notice`, (await page.locator(".dialog .dialog-title").textContent()) === "Couldn't fork the chat", await page.locator(".dialog .dialog-title").textContent());
    await page.locator(".dialog .dialog-actions .btn").click();
    seen = await when(page, `${name}, the fork failed`, (s) => s.lines.length === 1);
    expect(`${name}, the fork failed: Fork is live again, and the message is still on its way with its controls held`, !act(seen, 0, "fork").disabled && !act(seen, 0, "forkEdit").disabled && seen.back.disabled && act(seen, 0, "branch").disabled && seen.send.spin
      && JSON.stringify(seen.lines) === '[["send","Starting the agent…"]]', seen);

    // the answer: nothing is held any more
    await release(url, "send");
    seen = await when(page, `${name}, answered`, (s) => !s.banner && s.msgs.length === 3 && s.msgs.every((m) => m.live));
    expect(`${name}, answered: the message is in the thread once, and what was typed meanwhile is the new branch's draft`, seen.msgs[2].text === said && seen.box === "And then?" && seen.acts.every((a) => !a.disabled), seen);
    note(`${name}: Back, "Error on…", Branch, Branch and edit, the tree's rows, the pickers and Send were disabled with "${SEND_HELD}"`);
    await knob(`delete flags.send; delete flags.fork;`);
    await close(p, name);
  }

  // ---- "Approval needed on…" is held the same way
  {
    const name = "during a branch send, another branch asks for approval";
    await seed(url, "A4");
    await knob(`setSession("${TWO}", "alt", { status: "approval" }); flags.send = { chat: "${TWO}", hold: true, noReply: true };`);
    const p = await open(TWO), { page } = p;
    await startMove(page);
    let seen = await waitsSeen(page);
    expect(`before the Send "Approval needed on…" is live`, seen.alerts.length === 1 && /^Approval needed on/.test(seen.alerts[0].text) && !seen.alerts[0].disabled, seen.alerts);
    await page.locator(".composer .composer-input").click();
    await page.keyboard.type("Try it another way");
    await page.keyboard.press("Enter");
    await held(name, "send");
    seen = await when(page, name, (s) => s.msgs.some((m) => m.sending));
    expect(`${name}: "Approval needed on…" is disabled and says why`, seen.alerts.length === 1 && /^Approval needed on/.test(seen.alerts[0].text) && seen.alerts[0].disabled && seen.alerts[0].title === SEND_HELD, seen.alerts);
    await page.locator(".chat-head .fk-alert.asks").click({ force: true });
    await frame(page);
    expect(`${name}: a press on it leaves the chat where it is`, /is being sent/.test((await waitsSeen(page)).banner), (await waitsSeen(page)).banner);
    await release(url, "send");
    await when(page, `${name}, answered`, (s) => !s.banner && s.msgs.every((m) => m.live));
    await knob(`delete flags.send;`);
    await close(p, name);
  }

  // ---- a fork being made: Fork and "Fork and edit" of that chat, on a message and in the tree
  {
    const name = "while a fork is being made";
    await seed(url, "A4");
    await knob(`groups.find((g) => g.id === "g_A4").collapsed = false; flags.fork = { chat: "${TWO}", hold: true };`);
    const p = await open(TWO), { page } = p;
    await page.locator(".thread .msg.assistant").first().hover();
    await page.locator(".thread .msg.assistant .fk-act.k-fork").first().click();
    await held(name, "fork");
    let seen = await when(page, name, (s) => s.lines.length > 0);
    const forks = seen.acts.filter((a) => a.kind === "fork" || a.kind === "forkEdit"), rest = seen.acts.filter((a) => a.kind !== "fork" && a.kind !== "forkEdit");
    expect(`${name}: every Fork and "Fork and edit" of the thread is disabled and says why`, forks.length >= 4 && forks.every((a) => a.disabled && a.title === FORK_HELD), forks);
    expect(`${name}: Branch, "Branch and edit" and Label are live`, rest.length >= 4 && rest.every((a) => !a.disabled), rest);
    expect(`${name}: Send and the composer are as they were`, !seen.send.spin && seen.send.title === "Send (Enter)" && !seen.banner, seen.send);
    await page.locator(".thread .msg.assistant .fk-act.k-fork").first().click({ force: true });
    await frame(page);
    expect(`${name}: a press on Fork asks for no second fork`, await holds(url, "fork") === 1, await holds(url, "fork"));
    await page.locator(".chat-head .fk-tree-btn").click();
    await page.waitForSelector(".fk-nav .fk-row");
    const t = await tree(page);
    expect(`${name}, the tree: its rows open as always`, t.rows.every((r) => !r.disabled && !r.title) && /^Double-click/.test(t.foot), t);
    let menu = await menuOf(page, "user", "Fix it.");
    expect(`${name}, the tree: "Fork and edit" is disabled and says why, "Branch and edit" is live`, item(menu, "Fork and edit")?.disabled && item(menu, "Fork and edit").title === FORK_HELD && !item(menu, "Branch and edit")?.disabled, menu);
    await page.keyboard.press("Escape");
    menu = await menuOf(page, "text", "Done: the fonts are copied once.");
    expect(`${name}, the tree: "Fork to new chat" is disabled and says why`, item(menu, "Fork to new chat")?.disabled && item(menu, "Fork to new chat").title === FORK_HELD, menu);
    await page.keyboard.press("Escape");
    await page.locator(".fk-nav .icon-btn[title=Close]").click();
    // another chat's Fork is its own
    await page.locator('.side-row[title^="Branch send —"]').first().click();
    seen = await when(page, `${name}: another chat`, (s) => s.msgs.length === 4 && s.msgs.every((m) => m.live) && s.acts.length > 0);
    expect(`${name}: the Fork of another chat is live, and its thread has no line`, seen.acts.every((a) => !a.disabled) && !seen.lines.length, seen);
    // made: the fork opens, as before
    await release(url, "fork");
    if (!await until(() => page.evaluate(() => document.querySelector(".chat-head-name")?.textContent.includes("Two branches (fork)")))) fail(`${name}: the fork did not open when it was made`);
    await knob(`delete flags.fork;`);
    await close(p, name);
  }
});
