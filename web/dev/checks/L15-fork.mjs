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

await check("L15 the fork screens: actions, header, tree, labels", async ({ url, viewport, layout, open, fail, note }) => {
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
    // (the phone has no "⋯" on a message: a hold opens its sheet, which openActs presses)
    if (layout === "phone") { if (await byTid(first, "fk-more").count()) say("a message on the phone has the floating ⋯: its actions are the sheet's rows"); }
    else if (await touch(page) && !await byTid(first, "fk-more").count()) say("a finger has no button for the message's actions");
    const opened = await openActs(page, first);
    const kinds = (await actsIn(page, opened.scope)).map((a) => a.kind);
    await opened.close();
    if (!kinds.includes("branch") || !kinds.includes("fork") || !kinds.includes("label")) say(`the first reply offers ${JSON.stringify(kinds)}, not Branch, Fork to new and Label`);
    // (the phone's header says one line of words, not the branch: what names the branch there is the Tree it opens)
    const head = await textOf(page, "chat-head-sub");
    if (layout !== "phone" && !/Fix it\./.test(head)) say(`the header's second line says "${head}": it does not name the branch the chat is on ("Fix it.")`);
    const count = await byTid(page, layout === "phone" ? "chat-tree" : "fk-tree-btn").first().getAttribute("data-count");
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
    // (the phone's marker is a pill, "‹ Branch 1 of 2 ›": the arrows switch the branch in place, the middle opens the tree — which the press above did, at the middle)
    if (layout === "phone" && await marker.count()) {
      const data = (id, name) => byTid(page, id).first().getAttribute(name);
      const branch = () => byTid(page, "thread").first().getAttribute("data-branch");
      const box = await marker.boundingBox();
      if (Math.round(box.height) !== 36) say(`the branch pill is ${box.height} pt high, not 36`);
      if (await data("fk-marker-prev", "aria-label") !== "Previous branch" || await data("fk-marker-next", "aria-label") !== "Next branch") say("the pill's arrows are not labelled Previous branch and Next branch");
      if (!/^Branch 1 of 2, open the chat tree$/.test(await data("fk-marker-open", "aria-label") ?? "")) say(`the pill's middle says "${await data("fk-marker-open", "aria-label")}"`);
      if (await data("fk-marker-prev", "data-disabled") !== "true" || await data("fk-marker-next", "data-disabled") !== "false") say("on branch 1 of 2 the pill's ‹ is not disabled and › live");
      const was = await branch();
      await press(page, byTid(page, "fk-marker-next").first());
      if (!await until(async () => (await data("fk-marker", "data-n")) === "2", 15000)) say(`› did not show branch 2: the pill says branch ${await data("fk-marker", "data-n")}`);
      else {
        if (await branch() === was) say("› left the thread on the same branch");
        if (await data("fk-marker-next", "data-disabled") !== "true" || await data("fk-marker-prev", "data-disabled") !== "false") say("on branch 2 of 2 the pill's › is not disabled and ‹ live");
        if (!await byTid(page, "fk-marker").first().isVisible() || !(await byTid(page, "fk-marker").first().boundingBox())) say("the message with the pill is not on screen after ›");
        await press(page, byTid(page, "fk-marker-prev").first());
        if (!await until(async () => (await data("fk-marker", "data-n")) === "1" && await branch() === was, 15000)) say("‹ did not bring the first branch back");
      }
    }
    // "Approval needed on…" puts the chat on that branch
    await knob(`setSession("${TWO}", "alt", { status: "approval" });`);
    if (layout === "phone") { // (no pill in the content bar: the Tree's count turns amber and its label says that a branch waits; the Tree is the way to that branch)
      const tree = byTid(page, "chat-tree").first();
      if (!await until(async () => /a branch needs your approval/.test(await tree.getAttribute("aria-label") ?? ""), 15000)) say(`the Tree button says "${await tree.getAttribute("aria-label")}" of a branch that waits for approval`);
    } else {
      const pill = byTid(page, "fk-alert", { kind: "asks" }).first();
      await pill.waitFor({ state: "visible", timeout: 15000 });
      if (!/^Approval needed on/.test(await pill.textContent() ?? "")) say(`the header's pill says "${await pill.textContent()}"`);
      await press(page, pill);
      if (!await until(async () => /Is there a faster way\?/.test(await textOf(page, "chat-head-sub")), 10000)) say(`a press on "Approval needed on…" left the chat on a branch the header names "${await textOf(page, "chat-head-sub")}"`);
    }
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
    if (layout === "phone") { // (no foot on the phone: the row's action sheet offers Label alone)
      if (await byTid(page, "fk-nav-foot").count()) say("the phone's tree has a foot");
      await menuOfRow(page, byTid(page, "fk-row", { kind: "user" }).first());
      const kinds = await byTid(page, "action-row").evaluateAll((els) => els.map((e) => e.dataset.action));
      if (kinds.join() !== "label") say(`a row of an archived chat's tree offers ${JSON.stringify(kinds)}, not Label alone`);
    } else {
      const t = await treeSeen(page);
      const want = (await touch(page)) ? "Press and hold a message to label it." : "Right-click a message to label it.";
      if (t.foot.split("●")[0].trim().slice(0, want.length) !== want) say(`an archived chat's tree says "${t.foot}" at its foot, not "${want}"`);
    }
    await ctx.close();
  }

  // ---- the tree: head, filters, search, Esc, the foot, marks, a fork's link
  {
    await seed(url, "A4");
    await knob(`groups.find((g) => g.id === "g_A4").collapsed = false;
      setSession("${TWO}", "alt", { status: "error", error: "the agent ended with an error" });`);
    const { page, ctx } = await openAt(TWO);
    await openTree(page);
    if (!/Chat tree/.test(await textOf(page, layout === "phone" ? "tree-popup" : "fk-nav"))) say("the tree has no title");
    const sub = await textOf(page, "fk-nav-sub");
    if (sub !== "Two branches · 2 branches") say(`the tree's head says "${sub}", not "Two branches · 2 branches"`);
    if (await byTid(page, "fk-filter").count() !== 2) say("the tree has not two filters");
    if (layout === "phone") { // (the filters are the sheet's 32 pt control, the search a 44 pt field with a clear button; Labeled has no count while nothing is labelled)
      const box = async (id) => (await byTid(page, id).first().boundingBox()) ?? { height: 0 };
      if (Math.round((await box("fk-filters")).height) !== 32) say(`the phone's filters are ${(await box("fk-filters")).height} pt high, not 32`);
      if (Math.round((await box("fk-search")).height) !== 44) say(`the phone's search is ${(await box("fk-search")).height} pt high, not 44`);
      if (await byTid(page, "fk-search").first().getAttribute("placeholder") !== "Search this chat") say("the phone's search does not say \"Search this chat\"");
      if (await byTid(page, "fk-row").first().evaluate((e) => Math.round(e.getBoundingClientRect().height)) !== 48) say("a row of the phone's tree is not 48 pt high");
      if (!/^Labeled$/.test(await textOf(page, "fk-filter", { id: "labeled" }))) say(`the Labeled filter says "${await textOf(page, "fk-filter", { id: "labeled" })}" while nothing is labelled`);
      if (await byTid(page, "fk-row-more").count()) say("a row of the phone's tree has a ⋯");
      if (await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "fk-search")) say("the phone's search has the focus when the sheet opens");
    }
    const rows = () => byTid(page, "fk-row").count();
    const all = await rows();
    if (all !== 6) say(`the tree has ${all} rows, not 6`);
    if (!await touch(page) && !await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "fk-search")) say("the search box has not the focus when the popup opens");
    // the marks: the branch that ended in an error says so with its text
    const mark = byTid(page, "fk-mark", { mark: "error" }).first();
    if (!await mark.count()) say("the row the failed branch ends at has no mark");
    else if (!/error/.test(await mark.textContent() ?? "")) say(`the mark of the failed branch says "${await mark.textContent()}"`);
    // the foot: the words of the pointer, and the folder hint (the phone's sheet has neither: no hint line, no other chats' agents line)
    if (layout === "phone") {
      if (await byTid(page, "fk-nav-foot").count() || await byTid(page, "fk-foot-text").count() || await byTid(page, "fk-folder-agents").count()) say("the phone's tree has a foot or a folder hint");
    } else {
      const foot = await textOf(page, "fk-foot-text");
      const words = (await touch(page)) ? /^Tap a message twice to open the chat there/ : /^Double-click a message to open the chat there/;
      if (!words.test(foot)) say(`the tree's foot says "${foot}"`);
      if (!/agents working in shop/.test(await textOf(page, "fk-folder-agents"))) say(`the folder hint says "${await textOf(page, "fk-folder-agents")}"`);
    }
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
    if (layout === "phone") { // (Done closes the sheet; the search is cleared by its own ✕, which a phone has instead of Esc)
      await search.fill("faster");
      await press(page, byTid(page, "search-clear").first());
      if (await search.inputValue() !== "") say("the search's ✕ did not clear it");
      await closeTree(page);
    } else {
      // Esc: the search first, then the popup
      await search.fill("faster");
      await search.focus();
      await page.keyboard.press("Escape");
      if (!await until(async () => (await search.inputValue()) === "", 5000)) say("Esc did not clear the search");
      if (!await byTid(page, "fk-nav").count()) say("the first Esc closed the popup while the search had text");
      await page.keyboard.press("Escape");
      if (!await until(async () => !await byTid(page, "fk-nav").count(), 5000)) say("the second Esc did not close the popup");
    }
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
    await press(page, byTid(page, layout === "phone" ? "chat-tree" : "fk-tree-btn").first());
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
    // (the phone's sheet words the row "Label…" whether or not the message has a label: the mockup's row; the label itself is the tag under the message, checked above)
    if (!kinds.some((a) => a.kind === "label" && a.text === (layout === "phone" ? "Label…" : "Label ✓"))) say(`the button of a labelled message says ${JSON.stringify(kinds.filter((a) => a.kind === "label").map((a) => a.text))}, not "${layout === "phone" ? "Label…" : "Label ✓"}"`);
    // in the tree: a tag on its row, and Relabel in the row's menu; the Labeled filter shows it
    await openTree(page);
    if (!/Slow build/.test(await textOf(page, "fk-tag"))) say(`the tree's row has no tag with the label ("${await textOf(page, "fk-tag")}")`);
    await press(page, byTid(page, "fk-filter", { id: "labeled" }).first());
    if (!await until(async () => await byTid(page, "fk-row").count() === 1, 5000)) say(`the Labeled filter shows ${await byTid(page, "fk-row").count()} rows, not the 1 labelled`);
    if (layout === "phone" && !/^Labeled · 1$/.test(await textOf(page, "fk-filter", { id: "labeled" }))) say(`the Labeled filter says "${await textOf(page, "fk-filter", { id: "labeled" })}", not "Labeled · 1"`);
    await press(page, byTid(page, "fk-filter", { id: "default" }).first());
    await menuOfRow(page, treeRow(page, "text", "Because of the font copy step"));
    const menu = (await treeSeen(page)).menu;
    const relabel = layout === "phone" ? "Relabel…" : "Relabel";
    if (!menu.some((m) => m.text === relabel)) say(`a labelled row's menu has ${JSON.stringify(menu.map((m) => m.text))}, not "${relabel}"`);
    // the label typed in the row: an empty text removes it (on the phone a form: the tree steps aside, the field holds the label, Save is off until it changes)
    await press(page, layout === "phone" ? byTid(page, "action-row", { action: "label" }).first() : byTid(page, "fk-ctx-item", { kind: "label" }).first());
    const rowInput = byTid(page, "fk-label-input").first();
    await rowInput.waitFor({ state: "visible", timeout: 10000 });
    if (layout === "phone") {
      if (await byTid(page, "fk-label-form").count() !== 1) say("the phone's Label is no form (fk-label-form)");
      if (await byTid(page, "fk-nav").count()) say("the tree is drawn under the Label form: two sheets at once");
      if (await rowInput.inputValue() !== "Slow build") say(`the Label form holds "${await rowInput.inputValue()}", not the current label`);
      if (await byTid(page, "sheet-right").last().getAttribute("aria-disabled") !== "true") say("Save is on while the label is unchanged");
      if (await rowInput.evaluate((e) => Math.round(e.getBoundingClientRect().height)) !== 44) say("the Label field is not 44 pt high");
    }
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
  if (layout === "phone") {
    // the pill's arrows are held while the chat takes no call (its server went away: useOffWhy; a message on its way holds them the same, heldReason "open"):
    // disabled, the reason is the pill's hint; the middle stays live, for the tree opens read only
    await seed(url, "A4");
    await knob(`onServer("s_lab", () => { const b = addBranch("${REMOTE}", "main", 3, {}, "alt"); b.items.push({ kind: "user", text: "Faster?" }, { kind: "text", text: "Yes.", done: true }, { kind: "end", point: "q2" }); });`);
    const { page, ctx } = await openAt(`s_lab~${REMOTE}`);
    await press(page, byTid(page, "chat-tree").first());
    await byTid(page, "fk-row").first().waitFor({ state: "visible", timeout: 15000 });
    await press(page, page.locator('[data-testid="fk-row"][data-end]').nth(1));
    await byTid(page, "fk-marker").first().waitFor({ state: "visible", timeout: 15000 });
    const flag = (id) => byTid(page, id).first().getAttribute("data-disabled");
    if (await flag("fk-marker-prev") !== "false" || await byTid(page, "fk-marker").first().getAttribute("data-held")) say("the pill's arrows are held while the chat's server is connected");
    await mockEval(`setServerState("s_lab", "unreachable", { detail: "connection refused" });`, url);
    if (!await until(async () => (await flag("fk-marker-prev")) === "true" && (await flag("fk-marker-next")) === "true", 15000)) say("the pill's arrows are live while the chat's server is not connected");
    else if (!/not connected/.test(await byTid(page, "fk-marker").first().getAttribute("data-held") ?? "")) say(`the pill says "${await byTid(page, "fk-marker").first().getAttribute("data-held")}" of why its arrows are held`);
    if (await byTid(page, "fk-marker-open").first().isDisabled()) say("the pill's middle is held while the chat's server is not connected: it opens the tree");
    await ctx.close();
  }
  note("actions by hover and by the ⋯ button; crumb, count, marker, the approval pill; an archived chat; the tree's head, filters, search, Esc, marks, foot, folder hint and a fork's link; labels set, cancelled, removed and refused; the phone's branch pill: its arrows, its middle, its held state");
}, { viewports, page: false, allowConsole: [/the mock failed this read|tree/i] });
