// L15 (new in the app, package S8): the rows of the fork screens that no browser check proved on the page (parity inventory: B-FK-22 to B-FK-26, B-TR-02,
// B-TR-03, B-TR-11, B-TR-15 to B-TR-19, B-LB-01 to B-LB-03, B-LB-06, B-LB-07, B-FK-04), at desktop, tablet and phone. It has no old check to port.
//   Actions (B-FK-01, B-FK-04): a mouse sees none until it is over the message, a finger has a "⋯" on each; an archived chat's messages offer only Label.
//   Header (B-FK-23 to B-FK-25): the branch's name after the status ("⑂ Fix it."), the Tree button's count, "Approval needed on…" puts the chat on that branch;
//     the marker "Branch 1 of 2" on a message at a split opens the tree on that message (B-FK-22).
//   Tree (B-TR-02, 03, 11, 15 to 18): the head, the filters and the search (nothing matches, Labeled shows only what is labelled), Esc clears the search and then
//     closes, the tree that cannot be loaded says so with Retry, the marks on the rows a branch ends at (needs approval, working, error with its text), a fork's
//     link opening that chat, the foot's words for a mouse, a finger and a chat to be read, the folder hint.
//   Labels (B-LB-01 to 03, 06, 07): Label opens the field (200 characters at most, the placeholder), Enter saves, Esc cancels, an empty text removes; the label
//     is under its message and a tag on its row in the tree, and the button then says "Label ✓"; a label that cannot be set shows "Couldn't set the label"; a
//     label being typed when the server drops goes. The mock cannot set a label (its header says so): the page's PUT …/label is answered here, as the server does.
import { callMatcher, callsOf, check, hostCall, mockEval, seed, until } from "../shot.mjs";
import { byTid, openChat, press, touchNow } from "./sel.mjs";
import { actsIn, actsSeen, closeTree, firstMsg, menuOfRow, notice, openActs, openRow, openTree, pressAct, treeRow, treeSeen, endRow } from "./fork.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const T = "c_A4_turns", TWO = "c_A4_two", REMOTE = "c_A4_remote";
const MSG = '[data-testid="msg"]';
const LABEL = callMatcher(/^PUT \/api\/chats\/[^/]+\/label/);

await check("L15 the fork screens: actions, header, tree, labels", async ({ url, viewport, open, fail, note }) => {
  const say = (line) => fail(line);
  const knob = (code) => mockEval(code, url);
  const textOf = async (page, id, data) => ((await byTid(page, id, data).first().textContent({ timeout: 2000 }).catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
  const openAt = (chat, o = {}) => open({ sel: { chat }, wait: MSG, ...o });
  /** Answers the page's PUT …/label as the server does: the labels it has, blank text removing one. */
  const fakeLabels = async (page, labels = []) => {
    const puts = [];
    await page.route(LABEL, async (route) => {
      const b = JSON.parse(route.request().postData() ?? "{}");
      puts.push(b);
      const at = labels.findIndex((l) => l.branch === b.branch && l.item === b.item);
      if (at >= 0) labels.splice(at, 1);
      if (String(b.text ?? "").trim()) labels.push({ branch: b.branch, item: b.item, text: b.text });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ labels }) });
    });
    return puts;
  };
  const touch = (page) => touchNow(page);

  // ---- a message's actions: shown to a mouse over the message, to a finger by the "⋯"; the header's crumb and count; the marker
  {
    await seed(url, "A4");
    const { page, ctx } = await openAt(TWO);
    const first = await firstMsg(page);
    if (!await touch(page) && await page.locator('[data-testid="fk-act"]').count()) say("a mouse that is over no message sees the actions");
    if (await touch(page) && !await byTid(first, "fk-more").count()) say("a finger has no button for the message's actions");
    const opened = await openActs(page, first);
    const kinds = (await actsIn(page, opened.scope)).map((a) => a.kind);
    await opened.close();
    if (!kinds.includes("branch") || !kinds.includes("fork") || !kinds.includes("label")) say(`the first reply offers ${JSON.stringify(kinds)}, not Branch, Fork to new and Label`);
    const head = await textOf(page, "chat-head-sub");
    if (!/Fix it\./.test(head)) say(`the header's second line says "${head}": it does not name the branch the chat is on ("Fix it.")`);
    const count = await byTid(page, "fk-tree-btn").first().getAttribute("data-count");
    if (count !== "2") say(`the Tree button counts ${count}, not 2 branches`);
    // the marker at the split
    const marker = byTid(page, "fk-marker").first();
    if (!await marker.count()) say("the message at the split has no marker");
    else {
      if (!/Branch 1 of 2/.test(await marker.getAttribute("aria-label") ?? "")) say(`the marker says "${await marker.getAttribute("aria-label")}", not "Branch 1 of 2"`);
      await press(page, marker);
      await byTid(page, "fk-row").first().waitFor({ state: "visible", timeout: 15000 });
      const on = await byTid(page, "fk-row", { on: true }).first().textContent().catch(() => "");
      if (!/Fix it\./.test(on ?? "")) say(`the tree opened from the marker is on the row "${on}", not the message at the split`);
      await closeTree(page);
    }
    // "Approval needed on…" puts the chat on that branch
    await knob(`setSession("${TWO}", "alt", { status: "approval" });`);
    const pill = byTid(page, "fk-alert", { kind: "asks" }).first();
    await pill.waitFor({ state: "visible", timeout: 15000 });
    if (!/^Approval needed on/.test(await pill.textContent() ?? "")) say(`the header's pill says "${await pill.textContent()}"`);
    await press(page, pill);
    if (!await until(async () => /Is there a faster way\?/.test(await textOf(page, "chat-head-sub")), 10000)) say(`a press on "Approval needed on…" left the chat on a branch the header names "${await textOf(page, "chat-head-sub")}"`);
    await ctx.close();
  }

  // ---- an archived chat: only Label; its tree is read with the foot of a chat to be read
  {
    await seed(url, "A4");
    await hostCall(url, "POST", `/api/chats/${TWO}/archive`);
    const { page, ctx } = await openAt(TWO);
    const acts = await actsSeen(page);
    if (!acts.length || acts.some((a) => a.kind !== "label")) say(`an archived chat's messages offer ${JSON.stringify([...new Set(acts.map((a) => a.kind))])}, not Label alone`);
    await openTree(page);
    const t = await treeSeen(page);
    const want = (await touch(page)) ? "Press and hold a message to label it." : "Right-click a message to label it.";
    if (t.foot.split("●")[0].trim().slice(0, want.length) !== want) say(`an archived chat's tree says "${t.foot}" at its foot, not "${want}"`);
    await ctx.close();
  }

  // ---- the tree: head, filters, search, Esc, the foot, marks, a fork's link
  {
    await seed(url, "A4");
    await knob(`groups.find((g) => g.id === "g_A4").collapsed = false;
      setSession("${TWO}", "alt", { status: "error", error: "the agent ended with an error" });`);
    const { page, ctx } = await openAt(TWO);
    await openTree(page);
    if (!/Chat tree/.test(await textOf(page, "fk-nav"))) say("the tree has no title");
    const sub = await textOf(page, "fk-nav-sub");
    if (sub !== "Two branches · 2 branches") say(`the tree's head says "${sub}", not "Two branches · 2 branches"`);
    if (await byTid(page, "fk-filter").count() !== 2) say("the tree has not two filters");
    const rows = () => byTid(page, "fk-row").count();
    const all = await rows();
    if (all !== 6) say(`the tree has ${all} rows, not 6`);
    if (!await touch(page) && !await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "fk-search")) say("the search box has not the focus when the popup opens");
    // the marks: the branch that ended in an error says so with its text
    const mark = byTid(page, "fk-mark", { mark: "error" }).first();
    if (!await mark.count()) say("the row the failed branch ends at has no mark");
    else if (!/error/.test(await mark.textContent() ?? "")) say(`the mark of the failed branch says "${await mark.textContent()}"`);
    // the foot: the words of the pointer, and the folder hint
    const foot = await textOf(page, "fk-foot-text");
    const words = (await touch(page)) ? /^Tap a message twice to open the chat there/ : /^Double-click a message to open the chat there/;
    if (!words.test(foot)) say(`the tree's foot says "${foot}"`);
    if (!/agents working in shop/.test(await textOf(page, "fk-folder-agents"))) say(`the folder hint says "${await textOf(page, "fk-folder-agents")}"`);
    // the search: by text, without regard to case; nothing matches; Labeled shows only what is labelled
    const search = byTid(page, "fk-search").first();
    await search.fill("FASTER");
    if (!await until(async () => await rows() === 1, 5000)) say(`a search for "FASTER" leaves ${await rows()} rows, not the 1 that says it`);
    await search.fill("zzzz");
    if (!await until(async () => /Nothing matches\./.test(await textOf(page, "fk-none")), 5000)) say("a search that matches nothing does not say so");
    await search.fill("");
    await press(page, byTid(page, "fk-filter", { id: "labeled" }).first());
    if (!await until(async () => /Nothing matches\./.test(await textOf(page, "fk-none")), 5000)) say("the Labeled filter shows rows of a chat with no label");
    await press(page, byTid(page, "fk-filter", { id: "default" }).first());
    // Esc: the search first, then the popup
    await search.fill("faster");
    await search.focus();
    await page.keyboard.press("Escape");
    if (!await until(async () => (await search.inputValue()) === "", 5000)) say("Esc did not clear the search");
    if (!await byTid(page, "fk-nav").count()) say("the first Esc closed the popup while the search had text");
    await page.keyboard.press("Escape");
    if (!await until(async () => !await byTid(page, "fk-nav").count(), 5000)) say("the second Esc did not close the popup");
    await ctx.close();
  }
  {
    // a chat that has been forked has the fork as a link in its tree
    await seed(url, "A4");
    await mockEval(`const f = chats.c_A4_fork_claude; f.forkedFrom = "${T}"; f.forkedFromTitle = chats.${T}.name; f.forkedAt = 2; send({ type: "snapshot", ...snapshot() });`, url).catch(() => {});
    const { page, ctx } = await openAt(T);
    await openTree(page);
    const link = byTid(page, "fk-fork-link").first();
    if (!await until(() => link.count(), 5000)) say("a chat forked from this one is no row in its tree");
    else {
      await press(page, link);
      if (!await until(async () => /Branch send \(fork, claude\)/.test(await textOf(page, "chat-head-name")), 10000)) say("a press on the fork's link did not open that chat");
      if (await byTid(page, "fk-nav").count()) say("the tree stays open after the fork's link opened that chat");
    }
    await ctx.close();
  }

  // ---- the tree that cannot be loaded says so, with Retry
  {
    await seed(url, "A4");
    const { page, ctx } = await openAt(T);
    const TREE = callMatcher(/^GET \/api\/chats\/[^/]+\/tree/);
    await page.route(TREE, (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "the tree could not be read" }) }));
    await openChat(page, TWO); // (a chat whose tree the page has not read)
    await press(page, byTid(page, "fk-tree-btn").first());
    const none = byTid(page, "fk-none", { kind: "error" }).first();
    if (!await until(() => none.count(), 15000)) say("a tree that cannot be loaded does not say so");
    else {
      if (!/^Couldn't load the chat tree: /.test(await none.textContent() ?? "")) say(`the tree that cannot be loaded says "${await none.textContent()}"`);
      await page.unroute(TREE);
      await press(page, byTid(page, "fk-retry").first());
      if (!await until(async () => await byTid(page, "fk-row").count() === 6, 15000)) say(`Retry did not bring the tree back: ${await byTid(page, "fk-row").count()} rows`);
    }
    await ctx.close();
  }

  // ---- labels
  {
    await seed(url, "A4");
    const { page, ctx } = await openAt(TWO);
    const puts = await fakeLabels(page);
    const reply = await firstMsg(page);
    // Esc cancels: nothing is sent
    await pressAct(page, reply, "label");
    const input = byTid(page, "fk-label-input").first();
    await input.waitFor({ state: "visible", timeout: 10000 });
    if (await input.getAttribute("placeholder") !== "Label (empty removes it)") say(`the label field's placeholder is "${await input.getAttribute("placeholder")}"`);
    if (await input.getAttribute("maxlength") !== "200") say(`the label field takes ${await input.getAttribute("maxlength")} characters, not 200`);
    await input.fill("Draft label");
    await page.keyboard.press("Escape");
    if (!await until(async () => !await byTid(page, "fk-label-field").count(), 5000)) say("Esc did not close the label field");
    if (puts.length) say("Esc in the label field set a label");
    // Enter saves: the label is under the message and the button says "Label ✓"
    await pressAct(page, reply, "label");
    await byTid(page, "fk-label-input").first().fill("Slow build");
    await page.keyboard.press("Enter");
    if (!await until(() => puts.length === 1, 10000)) say("Enter in the label field set no label");
    else if (puts[0].text !== "Slow build" || puts[0].branch !== "main" || puts[0].item !== 1) say(`the label was set as ${JSON.stringify(puts[0])}`);
    if (!await until(async () => /Slow build/.test(await textOf(page, "fk-label-tag")), 10000)) say(`the label is not under its message: "${await textOf(page, "fk-label-tag")}"`);
    const o = await openActs(page, reply), kinds = await actsIn(page, o.scope);
    await o.close();
    if (!kinds.some((a) => a.kind === "label" && a.text === "Label ✓")) say(`the button of a labelled message says ${JSON.stringify(kinds.filter((a) => a.kind === "label").map((a) => a.text))}, not "Label ✓"`);
    // in the tree: a tag on its row, and Relabel in the row's menu; the Labeled filter shows it
    await openTree(page);
    if (!/Slow build/.test(await textOf(page, "fk-tag"))) say(`the tree's row has no tag with the label ("${await textOf(page, "fk-tag")}")`);
    await press(page, byTid(page, "fk-filter", { id: "labeled" }).first());
    if (!await until(async () => await byTid(page, "fk-row").count() === 1, 5000)) say(`the Labeled filter shows ${await byTid(page, "fk-row").count()} rows, not the 1 labelled`);
    await press(page, byTid(page, "fk-filter", { id: "default" }).first());
    await menuOfRow(page, treeRow(page, "text", "Because of the font copy step"));
    const menu = (await treeSeen(page)).menu;
    if (!menu.some((m) => m.text === "Relabel")) say(`a labelled row's menu has ${JSON.stringify(menu.map((m) => m.text))}, not "Relabel"`);
    // the label typed in the row: an empty text removes it
    await press(page, byTid(page, "fk-ctx-item", { kind: "label" }).first());
    const rowInput = byTid(page, "fk-label-input").first();
    await rowInput.waitFor({ state: "visible", timeout: 10000 });
    await rowInput.fill("");
    await page.keyboard.press("Enter");
    if (!await until(() => puts.length === 2, 10000)) say("an empty label typed in the tree sent nothing");
    else if (puts[1].text !== "") say(`an empty label was sent as ${JSON.stringify(puts[1].text)}`);
    if (!await until(async () => !await byTid(page, "fk-tag").count(), 10000)) say("the tag stays on the row after its label was removed");
    await closeTree(page);
    if (!await until(async () => !await byTid(page, "fk-label-tag").count(), 10000)) say("the label stays under its message after it was removed");
    // a label that cannot be set shows its notice
    await page.unroute(LABEL);
    await page.route(LABEL, (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "the server could not set it" }) }));
    await pressAct(page, reply, "label");
    await byTid(page, "fk-label-input").first().fill("Fails");
    await page.keyboard.press("Enter");
    const title = await notice(page);
    if (title !== "Couldn't set the label") say(`a label that cannot be set shows "${title}"`);
    await ctx.close();
  }
  {
    // a label being typed when the server drops goes: it could not be set
    await seed(url, "A4");
    const { page, ctx } = await openAt(`s_lab~${REMOTE}`);
    const calls = callsOf(page);
    await pressAct(page, await firstMsg(page), "label");
    await byTid(page, "fk-label-input").first().waitFor({ state: "visible", timeout: 10000 });
    await byTid(page, "fk-label-input").first().fill("Half typed");
    await mockEval(`setServerState("s_lab", "unreachable", { detail: "connection refused" });`, url);
    if (!await until(async () => !await byTid(page, "fk-label-field").count(), 10000)) say("a label being typed stays when its server drops");
    if (calls.some((c) => c.method === "PUT" && /label/.test(c.path))) say("a label typed when the server dropped was sent");
    await ctx.close();
  }
  note("actions by hover and by the ⋯ button; crumb, count, marker, the approval pill; an archived chat; the tree's head, filters, search, Esc, marks, foot, folder hint and a fork's link; labels set, cancelled, removed and refused");
}, { viewports, page: false, allowConsole: [/the mock failed this read|tree/i] });
