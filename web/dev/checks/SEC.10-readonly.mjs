// Proves, on the new build, that a chat which is shown as it was is read-only in every control of its view that the chat view draws
// (SEC.10; plans/remote-server-sections-goal.md, 3.8: "nothing can be sent, stopped or changed"; 3.5 for a chat that was deleted on its
// server; B-RO-01, B-RO-03, B-RO-04, B-RO-06). SEC.7 proves the warning and what happens when the server is back; this goes on from it
// with what stands around the thread.
// With the server connected the chat can be renamed by its header. Its server dropped: the warning names the server, the header has no
// status and no rename, and the page makes no call that changes anything however the header is pressed. Back: it can be renamed again. Deleted
// on its server while it is open: the same as under the outage, with the sentence that it is no longer there and no "Servers…".
// Ports dev/checks/SEC.10-readonly.mjs (S4) at desktop, tablet and phone, every part of it: the messages' Branch, Fork and Label (checks/fork.mjs), the
// permission request's Allow and Don't, the tree opened to be read, the composer's keys (Esc stops nothing, ⌘P opens no insert popup, the Insert button is off),
// the quotes. Same seed (the chat has two turns and a permission request that waits), same words.
// Added in the sweep (rn-sw-webtest), from web/test/sectionviews.test.ts "an archived chat shown as it was is not unarchived from its composer: the bar says why" (C-RO-07):
// an archived chat of the section (the seed's c_arch) has Unarchive when connected; its server dropped, its bar has none and says why; back, the button is there.
// The phone half (T3-8) reads the phone's screens, with the same meaning: the header's title opens Chat info, whose Name row has Rename (off, with the reason as the row's
// second line, when the chat takes no call; Rename closes Chat info and the name field opens); a hold on a message opens the message sheet, whose Quote row is faded with the
// reason and which offers no fork action; the chat tree is a full-height sheet whose rows open nothing and whose row sheet has every item faded with the reason.
import { callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { byTid, hover, press, touchNow } from "./sel.mjs";
import { actsSeen, closeTree, openActs, openRow, openTree, startMove, menuOfRow } from "./fork.mjs";
import { WAIT, composerBlock, says, textOf } from "./chat.mjs";
import { hold } from "./quote.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const J = JSON.stringify;
const STUDIO = "s_studio", KEY = `${STUDIO}~c_plain`;
const WHY = "Studio Mac is not connected";
const WHY_FULL = "Studio Mac is not connected: nothing can be sent or changed until it is back."; // what the tree's foot and Back's title say
const GONE = "This chat is no longer on Studio Mac.";
const WHY_ALL = "Studio Mac is not connected: nothing can be sent or changed until it is back."; // (the words in the place of the permission request's buttons)

await check("SEC.10 every control of a chat that is shown as it was is off, and none makes a call", async ({ url, viewport, touch, open, fail, note }) => {
  const drop = () => mockEval(`setServerState("${STUDIO}", "unreachable", { detail: "connection refused" });`, url);
  const back = () => mockEval(`setServerState("${STUDIO}", "connected");`, url);
  await seed(url, "SEC");
  // the chat has two turns that ended at a point, and its agent waits for a permission
  await mockEval(`onServer("${STUDIO}", () => {
    items.c_plain.splice(0, Infinity, { kind: "user", text: "Why is the render queue stuck?" }, say("Two jobs hold the GPU lock."), { kind: "end", point: "p_1" },
      { kind: "user", text: "Free it." }, { kind: "perm", requestId: "q_1", toolName: "Bash", input: { command: "kill -9 4242" } });
    Object.assign(chats.c_plain, { status: "approval", working: 1 });
  });`, url);
  const { page, ctx } = await open({ sel: { chat: KEY }, wait: '[data-testid="chat-head"]' });
  const calls = callsOf(page);
  const writes = (from) => calls.slice(from).filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`);
  const bar = byTid(page, "remote-bar");
  // On the phone nothing is drawn under the thread (T3-5, goal 3.5/3.7.1: a block is said once): the warning is the header's sub-line ("● <server> · offline",
  // `chat-head` data-frozen) and V1's `composer-block` in the toolbar's place (kind offline: "<Server> is offline since …"; kind gone: the gone sentence), and the empty
  // box has NO placeholder saying it (V1, goal 3.7.1: the old reading of the placeholder as the warning is replaced by reading the block and asserting the placeholder is empty).
  // `warned`: whether the chat is shown as it was.
  const box = byTid(page, "composer-input").first();
  const warned = async () => viewport === "phone" ? (await byTid(page, "chat-head").first().getAttribute("data-frozen")) === "true" : await bar.count() > 0;
  const placeholder = async () => (await box.getAttribute("data-placeholder").catch(() => "")) ?? "";
  /** The warning's words: the bar's text, or on the phone the composer's block (kind offline: the server named; kind gone: the gone sentence), with no placeholder saying it. */
  // (X2: a chat deleted on a server that is connected is not offline: the sub-line gives its place, with no state word, headline.ts)
  const subSays = async (want) => { const sub = await textOf(page, "chat-head-sub"); return want === GONE ? !sub.includes("offline") && !sub.includes("Needs your approval") && sub.length > 0 : sub.includes("offline"); };
  const blockSays = async (want) => {
    const blk = await composerBlock(page);
    return want === GONE ? blk?.kind === "gone" && blk.text === GONE : blk?.kind === "offline" && blk.text.includes("Studio Mac is offline");
  };
  const warning = (want) => viewport === "phone"
    ? until(async () => await blockSays(want) && await subSays(want) && !await placeholder(), 10000)
    : says(page, "remote-bar-text", want);
  const warningNow = async () => viewport === "phone" ? `${J(await composerBlock(page))} / placeholder "${await placeholder()}" / ${await textOf(page, "chat-head-sub")}` : await textOf(page, "remote-bar-text");
  await byTid(page, "perm").first().waitFor({ state: "visible", timeout: WAIT });
  const name = byTid(page, "chat-head-name").first(), input = byTid(page, "chat-name-input");

  /** The permission request Allow and Don't while the chat takes calls; while it takes none, no buttons and `why` in their place. */
  const asks = async (when, why) => {
    const perm = byTid(page, "perm").first(), buttons = byTid(perm, "perm-actions");
    if (why === undefined) {
      if (!await until(async () => await buttons.locator('[role="button"]').count() === 2, WAIT)) fail(`${viewport}: ${when}: the permission request has no Allow and Don't`);
    } else {
      if (!await until(async () => await buttons.count() === 0, WAIT)) fail(`${viewport}: ${when}: the permission request can still be answered`);
      const said = await textOf(page, "perm-done");
      if (said !== why) fail(`${viewport}: ${when}: the permission request says "${said}", not why it cannot be answered`);
    }
  };

  const phone = viewport === "phone";
  /** Closes a sheet by its backdrop: the finger that held something may still count as down for a moment, and a press on the backdrop in that grace closes nothing. */
  const closeSheet = async (id) => {
    await until(async () => {
      if (!await byTid(page, id).count()) return true;
      await press(page, byTid(page, "overlay-backdrop").last(), { position: { x: 4, y: 4 } });
      await page.waitForTimeout(300);
      return !await byTid(page, id).count();
    }, 8000);
  };
  /** The phone's Chat info as the last `renames` found it when Rename was off: the Name, Archive and Delete rows, each with its words and whether it is faded. */
  let info = null;
  /** The phone's Chat info of a chat that takes no call: Rename, Archive and Delete are faded, each with the reason (`want`) as its second line. */
  const infoOff = (when, want) => {
    if (!phone) return;
    for (const row of ["name", "archive", "delete"]) {
      if (!info?.[row]?.off || !info[row].words.includes(want)) fail(`${viewport}: ${when}: the ${row} row of Chat info is ${J(info?.[row])}, not faded with "${want}"`);
    }
  };
  /** The header's name: a press opens the field to rename the chat (Esc leaves it) when the chat takes calls, and does nothing else. On the phone the title opens
   *  Chat info, and the chat is renamed by its Name row's Rename, which closes Chat info and opens the field. */
  const renames = async () => {
    if (phone) {
      await press(page, name);
      await byTid(page, "chat-info").first().waitFor({ state: "visible", timeout: 5000 });
      const rename = byTid(page, "chat-info-rename").first();
      const rowOf = async (row) => { const r = byTid(page, "chat-info-row", { row }).first(); return { words: (await r.textContent().catch(() => "")).replace(/\s+/g, " ").trim(), off: (await r.getAttribute("data-disabled").catch(() => null)) === "true" }; };
      if (await rename.getAttribute("aria-disabled") === "true") {
        info = { name: await rowOf("name"), archive: await rowOf("archive"), delete: await rowOf("delete") };
        await closeSheet("chat-info");
        return false;
      }
      await press(page, rename);
      // (H2's Rename sheet, `rename-sheet` with its field `rename-input`, takes the place of the header's in-place field; the name is unchanged, so its backdrop closes it with no question)
      const opened = !!await until(() => byTid(page, "rename-input").count(), 3000);
      if (opened) await closeSheet("rename-sheet");
      if (await byTid(page, "chat-info").count()) fail(`${viewport}: Rename left Chat info open`);
      return opened;
    }
    await name.click({ force: true }).catch(() => {});
    const opened = !!await until(() => input.count(), 1500);
    if (opened) { await page.keyboard.press("Escape"); await until(async () => !await input.count(), 3000); }
    return opened;
  };

  /** Quotes the first reply: the browser's selection and ⌘L (a finger holds it and takes the Quote sheet's "Quote whole message" on the phone). `connected`: the
   *  comment field opens and Enter adds it; else what is said in the place of the field comes back. */
  const reply = byTid(page, "msg", { role: "assistant" }).first();
  const tapWord = viewport === "phone" || touch ? "tap" : "click";
  const quoteReply = async (connected, want = "Studio Mac is not connected", typing = "") => {
    if (viewport === "phone") {
      // (a hold opens the message sheet; its Quote row opens the Quote sheet, whose "Quote whole message" takes the passage. While the chat takes no call the Quote row
      // is faded with the reason as its second line and nothing opens)
      await hold(page, reply, (line) => fail(`${viewport}: ${line}`));
      await byTid(page, "msg-sheet").waitFor({ state: "visible", timeout: 10000 });
      const quote = byTid(page, "msg-sheet").locator('[data-testid="action-row"][data-action="quote"]').first();
      if (!connected) {
        const label = await quote.getAttribute("aria-label"), off = await quote.getAttribute("aria-disabled") === "true";
        await page.waitForTimeout(700); // (a press on the dimmed page closes nothing for a moment after the sheet opens)
        await press(page, quote, { force: true }).catch(() => {});
        await page.waitForTimeout(300);
        const opened = await byTid(page, "quote-sheet").count();
        await closeSheet("msg-sheet");
        return { said: off ? label : "", buttons: opened, float: await byTid(page, "qfloat").count() };
      }
      await press(page, quote);
      await byTid(page, "quote-sheet").waitFor({ state: "visible", timeout: 10000 });
      await press(page, byTid(page, "quote-whole").first());
      await byTid(page, "qfloat-comment").waitFor({ state: "visible", timeout: 5000 });
      if (typing) { await byTid(page, "qfloat-comment").first().fill(typing); return null; } // (the comment is left being typed)
      await press(page, byTid(page, "qfloat-save").first());
      return null;
    }
    await page.evaluate(() => {
      const md = document.querySelector('[data-testid="msg"][data-role="assistant"] [data-testid="md"]');
      const r = document.createRange(); r.selectNodeContents(md); getSelection().removeAllRanges(); getSelection().addRange(r);
    });
    await page.keyboard.press("ControlOrMeta+l");
    if (connected) {
      await byTid(page, "qfloat-comment").waitFor({ state: "visible", timeout: 5000 });
      if (typing) { await byTid(page, "qfloat-comment").first().fill(typing); return null; } // (the comment is left being typed)
      await page.keyboard.press("Enter");
      return null;
    }
    const said = await until(async () => { const t = await textOf(page, "ctx-note"); return t.includes(want) ? t : null; }, 5000);
    return { said: said || await textOf(page, "ctx-note"), float: await byTid(page, "qfloat").count() };
  };
  /** The list of the draft's quotes: opened, read (how many can be removed, the hint, and whether a press on one opens its comment), closed.
   *  The phone's is the sheet "Quoted in this message" (C1): a card for each quote with its trash (remove), the hint "Press and hold a reply to quote more." under
   *  the cards (read-only: no hint), and the comment on the card itself (an editable field, or "+ Add a comment"), so the comment's `float` is the count of the
   *  comment fields the cards let be typed in; no floating field opens. */
  const quotes = async () => {
    await press(page, byTid(page, "qcount").first());
    if (phone) {
      await byTid(page, "quote-card").first().waitFor({ state: "visible", timeout: 5000 });
      const removable = await byTid(page, "quote-remove").count(), hint = await textOf(page, "quotes-hint");
      const editable = await byTid(page, "quote-add-comment").count() + await byTid(page, "quote-comment").evaluateAll((els) => els.filter((e) => !e.readOnly && !e.disabled).length);
      const float = await byTid(page, "qfloat").count();
      await press(page, byTid(page, "quotes-done").first());
      await until(async () => !await byTid(page, "quotes-sheet").count(), 5000);
      return { removable, hint, float: editable + float };
    }
    await byTid(page, "qlist-item").first().waitFor({ state: "visible", timeout: 5000 });
    const removable = await byTid(page, "qlist-x").count(), hint = await textOf(page, "qlist-hint");
    await press(page, byTid(page, "qlist-item").first());
    await page.waitForTimeout(150);
    const float = await byTid(page, "qfloat").count();
    await page.keyboard.press("Escape");
    await until(async () => !await byTid(page, "qfloat").count() && !await byTid(page, "qlist").count(), 3000);
    return { removable, hint, float };
  };
  const quotesHint = (canEdit) => phone ? (canEdit ? "Press and hold a reply to quote more." : "") : `${tapWord} one to ${canEdit ? "edit" : "show"} it`;

  /** What the chat offers while it takes calls: a reply offers Branch, a message Label (B-FK-01), the tree opens with rows that open. */
  const live = async (when) => {
    let acts = [];
    await until(async () => (acts = await actsSeen(page)).some((a) => a.kind === "branch"), 5000);
    if (!acts.some((a) => a.kind === "branch")) fail(`${viewport}: ${when}: a reply offers no Branch`);
    if (!acts.some((a) => a.kind === "label")) fail(`${viewport}: ${when}: a message offers no Label`);
  };
  /** What it offers while it takes none, saying `why`: no action on a message; the tree is opened, read and closed (B-FK-04, B-TR-21). */
  const off = async (when, why) => {
    const first = byTid(page, "msg").first();
    if (phone) {
      // the message sheet: Copy, Read aloud and Select text need no server and stay; Quote stays faded with the reason; no Branch, Fork or Label
      const opened = await openActs(page, first);
      const rows = await opened.scope.locator('[data-testid="action-row"]').evaluateAll((els) => els.map((e) => ({ id: e.dataset.action, off: e.getAttribute("aria-disabled") === "true", label: e.getAttribute("aria-label") ?? "" })));
      await opened.close();
      const live = rows.filter((r) => !r.off).map((r) => r.id);
      if (live.some((id) => !["copy", "read", "select"].includes(id))) fail(`${viewport}: ${when}: the message sheet offers ${J(live)}, not Copy, Read aloud and Select text alone`);
      if (!live.includes("copy") || !live.includes("select")) fail(`${viewport}: ${when}: the message sheet has lost Copy or Select text: ${J(rows)}`);
      const q = rows.find((r) => r.id === "quote");
      if (!q?.off || !q.label.includes(why === GONE ? GONE : WHY)) fail(`${viewport}: ${when}: the Quote row is ${J(q)}, not faded with the reason`);
    } else {
      await hover(page, first);
      await page.waitForTimeout(150);
      // (Read aloud, voice's, needs no server: it stays, last, and is the only one; on a finger it is behind the "⋯")
      const offered = await page.locator('[data-testid="fk-act"]:not([data-kind="read"])').evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
      if (offered.length) fail(`${viewport}: ${when}: a message still offers ${J(offered)}`);
      if (await touchNow(page) && await byTid(page, "fk-more").count()) {
        await press(page, byTid(page, "fk-more").first());
        const kinds = await byTid(page, "menu").last().locator('[data-testid="fk-act"]').evaluateAll((els) => els.map((e) => e.dataset.kind));
        await page.keyboard.press("Escape");
        if (kinds.some((k) => k !== "read")) fail(`${viewport}: ${when}: the menu of a message offers ${J(kinds)}, not Read aloud alone`);
      }
    }
    // the tree: it opens, and is to be read only
    await openTree(page);
    const rows = await byTid(page, "fk-row").filter({ hasNot: page.locator('[data-kind="fork"]') }).count(), held = await page.locator('[data-testid="fk-row"][data-held="true"]').count();
    if (!rows || rows !== held) fail(`${viewport}: ${when}: ${held} of the tree's ${rows} rows are held`);
    if (await byTid(page, "fk-stop").count()) fail(`${viewport}: ${when}: a branch of the tree has a Stop`);
    if (phone) {
      // (the sheet has no foot: a hold on a row opens the row's sheet, whose every item is faded and says why; a tap on a row opens nothing)
      await menuOfRow(page, byTid(page, "fk-row").first());
      const items = await byTid(page, "fk-row-sheet").last().locator('[data-testid="action-row"]').evaluateAll((els) => els.map((e) => ({ id: e.dataset.action, off: e.getAttribute("aria-disabled") === "true", words: (e.textContent ?? "").replace(/\s+/g, " ") })));
      if (!items.length || items.some((i) => !i.off || !i.words.includes(why === GONE ? GONE : WHY))) fail(`${viewport}: ${when}: the sheet of a row of the tree offers ${J(items)}, not every item faded with the reason`);
      await closeSheet("fk-row-sheet");
      if (!await until(async () => await byTid(page, "fk-nav").count() > 0, 5000)) fail(`${viewport}: ${when}: the tree does not come back after the sheet of a row`);
      await openRow(page, byTid(page, "fk-row").first());
      await page.waitForTimeout(150);
      if (await byTid(page, "fk-row-more").count()) fail(`${viewport}: ${when}: a row of the tree has a button for its menu`);
    } else {
      if (await textOf(page, "fk-held") !== why) fail(`${viewport}: ${when}: the tree's foot says "${await textOf(page, "fk-nav-foot")}"`);
      await openRow(page, byTid(page, "fk-row").first());
      if (await touchNow(page)) { if (await byTid(page, "fk-row-more").count()) fail(`${viewport}: ${when}: a row of the tree has a button for its menu`); }
      else await byTid(page, "fk-row").first().click({ button: "right" });
      await page.waitForTimeout(150);
    }
    if (!await byTid(page, "fk-nav").count()) fail(`${viewport}: ${when}: opening a row of the tree closed it and opened the chat there`);
    if (await byTid(page, "menu").count()) fail(`${viewport}: ${when}: a row of the tree has a menu`);
    if (phone) await closeTree(page); else await page.keyboard.press("Escape");
    if (!await until(async () => !await byTid(page, "fk-nav").count(), 5000)) fail(`${viewport}: ${when}: the tree does not close`);
    if (await byTid(page, "fk-back").count() && !await byTid(page, "fk-back").first().isDisabled()) fail(`${viewport}: ${when}: a pending move's Back is on`);
  };

  // ---- connected: the header offers the rename
  if (!await renames()) fail(`${viewport}: connected, the header of the chat does not offer to rename it`);
  if (await warned()) fail(`${viewport}: connected, the chat has a warning`);
  await live("connected");
  await asks("connected");
  if (!await until(() => byTid(page, "stop").count(), WAIT)) fail(`${viewport}: connected, an agent that waits for a permission has no Stop`);
  // a quote is taken into the draft, and saved with it
  await quoteReply(true);
  if (!await until(() => calls.some((c) => c.method === "PUT" && /\/chats\/c_plain\/draft\?/.test(c.path) && c.status === 200 && c.body?.references?.length === 1), 10000)) fail(`${viewport}: connected, the quote was not saved with the draft`);
  const q = await quotes();
  if (J(q) !== J({ removable: 1, hint: quotesHint(true), float: 1 })) fail(`${viewport}: connected, the draft's quote can be removed and commented on: ${J(q)}`);

  // a comment being typed as the server drops is kept in the draft's quote, and the field goes (C-QT-24)
  await quoteReply(true, undefined, "typed as it drops"); // (the passage is in the draft: its field opens to edit it)
  if (!await byTid(page, "qfloat-comment").count()) fail(`${viewport}: connected, the quote's field did not stay open for the comment`);
  // ---- its server drops
  await drop();
  if (!await until(async () => !await byTid(page, "qfloat").count(), WAIT)) fail(`${viewport}: its server dropped, the quote's field stays open`);
  await press(page, byTid(page, "qcount").first());
  let typed;
  if (phone) {
    await byTid(page, "quote-card").first().waitFor({ state: "visible", timeout: 5000 });
    typed = await byTid(page, "quote-comment").evaluateAll((els) => els.map((e) => e.value));
    await press(page, byTid(page, "quotes-done").first());
    await until(async () => !await byTid(page, "quotes-sheet").count(), 5000);
  } else {
    await byTid(page, "qlist-item").first().waitFor({ state: "visible", timeout: 5000 });
    typed = await byTid(page, "qlist-comment").allTextContents();
    await page.keyboard.press("Escape");
    await until(async () => !await byTid(page, "qlist").count(), 3000);
  }
  if (!typed.some((x) => x.includes("typed as it drops"))) fail(`${viewport}: its server dropped, the comment being typed was not kept: the draft's quotes say ${J(typed)}`);
  await page.waitForTimeout(900); // (the comment kept is a draft typed before the drop: the save of it is made once, after the draft's own delay; SEC.7 proves the draft's saves)
  if (!await until(warned, WAIT)) fail(`${viewport}: the warning does not show`);
  let quiet = calls.length;
  await asks("its server dropped", WHY_ALL);
  if (await renames()) fail(`${viewport}: its server dropped: the header offers to rename the chat`);
  infoOff("its server dropped", "Studio Mac is offline");
  if (!await warning(WHY)) fail(`${viewport}: its server dropped: the warning says "${await warningNow()}"`);
  if (!await byTid(page, "perm").count()) fail(`${viewport}: its server dropped: the permission request is gone from the thread`);
  // the keys: Esc stops nothing, ⌘P opens nothing, the Insert button is off, and the composer has no Stop
  await byTid(page, "composer-input").first().click({ force: true }).catch(() => {});
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+p");
  // (a read-only box takes no focus, so a key never reaches it: ⌘P is handed to its element, as the box would hear it)
  await byTid(page, "composer-input").first().evaluate((el) => { const mac = /Mac|iPhone|iPad/.test(navigator.platform); el.dispatchEvent(new KeyboardEvent("keydown", { key: "p", code: "KeyP", metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true })); });
  await page.waitForTimeout(150);
  if (await byTid(page, "insert-popup").count()) fail(`${viewport}: its server dropped: the insert popup opened for a box that takes nothing`);
  const insert = byTid(page, "insert-btn");
  if (await insert.count() && !await insert.first().isDisabled()) fail(`${viewport}: its server dropped: the composer's Insert button is on`);
  if (await byTid(page, "stop").count()) fail(`${viewport}: its server dropped: the composer has a Stop`);
  // a quote is not taken, the one the draft has stays, to be read: no remove, no comment
  const r = await quoteReply(false);
  if (viewport === "phone" ? !r.said.includes("Studio Mac is not connected") || r.buttons : !r.said.includes("Studio Mac is not connected")) fail(`${viewport}: its server dropped: a quote asked for says ${J(r)}`);
  if (r.float) fail(`${viewport}: its server dropped: a quote was taken into a draft that cannot be saved`);
  await page.evaluate(() => getSelection().removeAllRanges());
  const kept = await quotes();
  if (J(kept) !== J({ removable: 0, hint: quotesHint(false), float: 0 })) fail(`${viewport}: its server dropped: the draft's quote is ${J(kept)}`);
  if (await textOf(page, "qcount") === "") fail(`${viewport}: its server dropped: the draft lost its quote`);
  await off("its server dropped", WHY_FULL);
  await page.waitForTimeout(600);
  if (writes(quiet).length) fail(`${viewport}: its server dropped: the page made ${J(writes(quiet))}`);

  // ---- back: it can be renamed again
  await back();
  if (!await until(async () => !await warned(), WAIT)) fail(`${viewport}: back, the warning stays`);
  if (!await until(renames, WAIT)) fail(`${viewport}: back, the header does not offer to rename the chat again`);
  await live("back");

  // ---- a pending move, then the drop: Back is off; back, it works
  await startMove(page);
  await drop();
  if (!await until(warned, WAIT)) fail(`${viewport}: the warning does not show the second time`);
  quiet = calls.length;
  const banner = byTid(page, "fk-back").first();
  // (the reason is Back's hover title; the phone has no hover title (ux-improvements 3.1.3), where Button's accessible name is the same words)
  const backSays = await banner.getAttribute("title") ?? await banner.getAttribute("aria-label");
  if (!await banner.isDisabled() || backSays !== WHY_FULL) fail(`${viewport}: a pending move's Back is ${await banner.isDisabled() ? "off" : "on"} and says "${backSays}" while the chat's server is not connected`);
  await press(page, banner, { force: true }).catch(() => {});
  if (!await byTid(page, "fk-banner").count()) fail(`${viewport}: Back undid the move of a chat that is shown as it was`);
  if (writes(quiet).length) fail(`${viewport}: with a move pending, the page made ${J(writes(quiet))}`);
  await back();
  if (!await until(async () => !await warned() && !await banner.isDisabled().catch(() => true), WAIT)) fail(`${viewport}: back, a pending move's Back stays off`);
  await press(page, banner);
  if (!await until(async () => !await byTid(page, "fk-banner").count(), 5000)) fail(`${viewport}: back, Back does not undo the move`);
  await asks("back");

  // ---- deleted on its server while it is open
  await mockEval(`await elsewhere("${STUDIO}", "DELETE", "/chats/c_plain")`, url);
  if (!await until(async () => viewport === "phone" ? await warned() && await blockSays(GONE) : await bar.count() > 0 && (await bar.first().getAttribute("data-kind")) === "gone", WAIT)) fail(`${viewport}: the view of a chat deleted on its server does not say so`);
  quiet = calls.length;
  await asks("deleted on its server", GONE);
  if (!await warning(GONE)) fail(`${viewport}: deleted on its server: the warning says "${await warningNow()}", not "${GONE}"`);
  if (await renames()) fail(`${viewport}: deleted on its server: the header offers to rename the chat`);
  infoOff("deleted on its server", GONE);
  // a quote asked for says that the chat is gone, not that the server is away; the draft's quote is kept, to be read (C-QT-24)
  await page.evaluate(() => getSelection().removeAllRanges());
  const gone = await quoteReply(false, GONE);
  if (!gone.said.includes(GONE) || gone.float || (viewport === "phone" && gone.buttons)) fail(`${viewport}: deleted on its server: a quote asked for says ${J(gone)}, not ${J(GONE)} with no field and no button`);
  await page.evaluate(() => getSelection().removeAllRanges());
  await off("deleted on its server", GONE);
  if (await byTid(page, "remote-servers").count()) fail(`${viewport}: deleted on its server: the warning offers "Servers…"`);
  await page.waitForTimeout(600);
  if (writes(quiet).length) fail(`${viewport}: deleted on its server: the page made ${J(writes(quiet))}`);

  // ---- an archived chat that is shown as it was (web/test/sectionviews.test.ts, C-RO-07): its bar offers no Unarchive and says why; back, the button is there
  {
    await ctx.close(); // (the mock has one stream for one page: the window above is closed before the next one opens)
    const archived = await open({ sel: { chat: `${STUDIO}~c_arch` }, ls: { "aiwb.archived": "1" }, wait: '[data-testid="chat-head"]' });
    const barOf = byTid(archived.page, "archived-bar").first();
    await barOf.waitFor({ state: "visible", timeout: WAIT });
    if (!await byTid(archived.page, "unarchive").count()) fail(`${viewport}: connected, the bar of an archived chat has no Unarchive`);
    await drop();
    if (!await until(async () => !await byTid(archived.page, "unarchive").count(), WAIT)) fail(`${viewport}: its server dropped: the bar of an archived chat still offers Unarchive`);
    // (the phone's bar, V1's archived block, says the server is offline: "This chat is archived. <Server> is offline since …."; the wide bar says WHY)
    if (!(await barOf.textContent()).includes(viewport === "phone" ? "Studio Mac is offline" : WHY)) fail(`${viewport}: its server dropped: the bar of an archived chat says "${await barOf.textContent()}", not why`);
    await back();
    if (!await until(async () => await byTid(archived.page, "unarchive").count() > 0, WAIT)) fail(`${viewport}: back, the bar of an archived chat has no Unarchive`);
    await archived.ctx.close();
  }

  note(`connected and back, the header renames the chat; dropped and deleted: the warning names the server (or says the chat is gone), no rename, and no call that changes anything; an archived chat's bar has no Unarchive while its server is away`);
}, { viewports, page: false });
