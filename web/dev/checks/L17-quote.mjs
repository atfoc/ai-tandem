// L17 (new; package K5): quotes — what no old check proved (the inventory's `none` rows B-QS-04, B-QS-05, B-QS-07 and C-QT-03, C-QT-07, C-QT-08, C-QT-12,
// C-QT-16, C-QT-22, and the part of B-QS-01, B-QS-06, B-QS-08, C-QT-01, C-QT-05, C-QT-06, C-QT-11 and C-QT-14 to C-QT-17 that P7.4 and SEC.10 do not reach), on the
// real chat view and composer, with the way a quote is taken on the viewport (AD-64, goal 4.2):
//   phone   the sheet path, which the browser runs as the app does: a long press on a message opens the Quote sheet with the message's displayed text; the
//           words selected in it are quoted with "Quote", the whole message with "Quote whole message"; the comment field is a sheet too (Add, Cancel,
//           Remove; closing it keeps what was typed). A reply still being written says so in the sheet's place; the cards of a sent message's quotes are no
//           part of what its sheet holds.
//   desktop the selection path: the browser's selection and ⌘L, the comment field floating at the passage; the draft's passages marked in the thread, a press
//           on a mark opens its field; Esc drops what was typed (with the subagent drawer open it closes the field first and the drawer
//           on the next Esc: B-SA-16), a press elsewhere keeps it; words beside a message's own (its fork actions, the cards of its
//           quotes) are left out of a quote, and a selection of them alone is no quote.
// On both: the quote's stored position is the place of its words in the message's displayed text (screens/markdown/displayed.ts), across the blocks of a message
// (a list, a code block whose header is no part of the text); a passage already in the draft opens for editing; several passages of one message each with their
// own comment; the count and its list (a press on a quote opens its field, the × removes it); a message of quotes alone is sent; its card shows where it is from
// (the thread is scrolled to the passage, which is marked for a moment) even when the message is far above the window.
import { callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { byTid, press } from "./sel.mjs";
import { hold as holdOn, laidOut, marks, select, selectBetween, seen } from "./quote.mjs";

export const viewports = ["desktop", "phone"];

const CHAT = "c_A2_move", LONG = "c_A2_move_long";
const J = JSON.stringify;
const REPLY = "Because of the font copy step. It copies every font file on each build.\n\n- one fast item\n- two slow items\n\n```js\nconst fonts = 1;\n```\n\nThen ship it, so the second paragraph has words to quote.";
const POST = /\/chats\/[\w]+\/messages(\?|$)/;
const squash = (s) => s.replace(/\s+/g, "");

/** The displayed text of a message, as the app counts a quote's position in it (screens/markdown/displayed.ts). */
async function displayed(text, user = false) {
  const { shownText } = await import("../../../app/src/screens/markdown/displayed.ts");
  return shownText(text, user).text;
}

await check("L17 quotes: the Quote sheet, the float, the marks, the count and its list", async ({ url, viewport, open, fail, note }) => {
  const sheetPath = viewport === "phone";
  const shown = await displayed(REPLY);
  await seed(url, "A2");
  await mockEval(`items.${CHAT}.splice(0, Infinity,
    { kind: "user", text: "Why is the build slow?" },
    say(${J(REPLY)}),
    { kind: "user", text: "Fix it.", references: [{ quote: "font copy step", comment: "which step?", item: 1, start: 15, end: 29 }] },
    say("Working on the fix", false));`, url);
  const { page, ctx } = await open({ sel: { chat: CHAT } });
  const calls = callsOf(page);
  const msg = (item) => byTid(page, "msg", { item }).first();
  const reply = msg(1);
  await reply.waitFor({ state: "visible", timeout: 15000 });
  const read = () => page.evaluate(seen);
  const saved = () => mockEval(`return chats.${CHAT}.draft?.references ?? [];`, url);
  const shows = async (name, want) => {
    let s;
    if (!await until(async () => want((s = await read())), 10000)) fail(`${name}: the page shows ${J(s)}`);
    return s;
  };
  const draftIs = async (name, want) => {
    let d;
    if (!await until(async () => want((d = await saved())), 10000)) fail(`${name}: the saved draft has ${J(d)}`);
    return d;
  };
  const countIs = (n) => (s) => !s.float && new RegExp(`^❝ ${n}( comments?)?$`).test(s.count.replace(/ ▾$/, ""));
  const key = (k) => page.keyboard.press(k);
  const hold = (loc) => holdOn(page, loc, fail);
  /** Takes the words `from` … `to` of the reply (item 1) and opens the comment field on them: in the Quote sheet on the phone, by ⌘L on the desktop. */
  const take = async (from, to = from, how = "words") => {
    if (sheetPath) {
      await hold(reply);
      const text = byTid(page, "quote-text");
      await text.waitFor({ state: "visible", timeout: 10000 });
      if (how === "whole") await press(page, byTid(page, "quote-whole").first());
      else {
        const a = shown.indexOf(from), b = shown.indexOf(to, a) + to.length;
        await text.evaluate((el, [x, y]) => { el.focus(); el.setSelectionRange(x, y); }, [a, b]);
        await key("Shift"); // (a key up in the box: the browser tells React the selection changed, as a finger's handles do)
        if (!await until(async () => !(await byTid(page, "quote-selection").first().isDisabled()), 5000)) fail(`"Quote" stays off with "${from}" selected in the sheet`);
        await press(page, byTid(page, "quote-selection").first());
      }
    } else {
      const got = await page.evaluate(selectBetween, [1, from, to, false]);
      if (!squash(got).startsWith(squash(from))) fail(`the check selected "${got}", not "${from}" …`);
      await key("ControlOrMeta+l");
    }
    await byTid(page, "qfloat-comment").waitFor({ state: "visible", timeout: 10000 });
  };
  /** Ends the comment field: `add` (Enter / Add), `esc` (Esc / Cancel), `elsewhere` (a press on the page / the dimmed page). */
  const end = async (how) => {
    if (how === "add") { if (sheetPath) await press(page, byTid(page, "qfloat-save").first()); else await key("Enter"); }
    else if (how === "esc") { if (sheetPath) await press(page, byTid(page, "qfloat-cancel").first()); else await key("Escape"); }
    else if (sheetPath) await press(page, byTid(page, "overlay-backdrop").last());
    else await page.mouse.click(5, 5);
  };
  const type = async (text) => { if (sheetPath) await byTid(page, "qfloat-comment").fill(text); else { await key("ControlOrMeta+a"); await page.keyboard.type(text); } }; // (replaces what the field holds)
  const placed = (d, at, quote) => d.start === shown.indexOf(at) && d.end === shown.indexOf(quote ?? at, shown.indexOf(at)) + (quote ?? at).length;

  // ---- the first quote: its words, its place in the displayed text
  await take("font copy step");
  const said = (await byTid(page, "qfloat-quote").textContent()) ?? "";
  if (!said.includes("font copy step")) fail(`the comment field quotes "${said}", not "font copy step"`);
  if (sheetPath && await byTid(page, "quote-sheet").count()) fail("the Quote sheet stays open under the comment sheet");
  await type("which step?");
  await end("add");
  await shows("Add on the first passage", countIs(1));
  await draftIs("the first quote", (d) => d.length === 1 && d[0].quote === "font copy step" && d[0].comment === "which step?" && d[0].item === 1 && d[0].start === 15 && d[0].end === 29);

  // ---- a passage across the blocks (the list, the code block whose header is no text, the paragraph after it); no comment (C-QT-06)
  await take("two slow items", "Then ship it");
  await end("add");
  await shows("Enter with an empty comment", countIs(2));
  const d2 = await draftIs("the quote across the blocks", (d) => d.length === 2);
  const across = d2?.[1];
  if (across) {
    if (!placed(across, "two slow items", "Then ship it")) fail(`the quote across the blocks stands at ${across.start} to ${across.end}, not at the place of its words in the displayed text (${shown.indexOf("two slow items")} to ${shown.indexOf("Then ship it") + 12})`);
    if (squash(shown.slice(across.start, across.end)) !== squash(across.quote)) fail(`the words of the quote across the blocks are ${J(across.quote)}, the displayed text at its place ${J(shown.slice(across.start, across.end))}`);
    if (/Copy|js/.test(across.quote.replace(/ship it, so/, ""))) fail(`the quote across the blocks takes the code block's header: ${J(across.quote)}`);
    if (across.comment !== undefined) fail(`a quote with an empty comment has the comment ${J(across.comment)}`);
  }

  // ---- a comment typed and then a press elsewhere keeps it (C-QT-08); an empty one is not added
  await take("second paragraph");
  await type("kept");
  await end("elsewhere");
  await shows("a press elsewhere with a comment typed", countIs(3));
  await draftIs("the quote kept by a press elsewhere", (d) => d.length === 3 && d[2].quote === "second paragraph" && d[2].comment === "kept");
  await take("words to quote");
  await end("elsewhere");
  await shows("a press elsewhere with no comment", countIs(3));
  // Esc (Cancel on the phone) drops what was typed (C-QT-07)
  await take("fast item");
  await type("dropped");
  await end("esc");
  await shows("Esc / Cancel with a comment typed", countIs(3));
  if ((await saved()).length !== 3) fail(`Esc / Cancel put a quote in the draft: ${J(await saved())}`);

  // ---- a passage that is in the draft opens for editing, with its comment and a Remove (C-QT-11); the whole message is a quote too (phone)
  await take("font copy step");
  const f = await read();
  const edit = await byTid(page, "qfloat-comment").inputValue();
  if (edit !== "which step?") fail(`quoting "font copy step" again opens a field with ${J(edit)}, not its comment "which step?"`);
  if (!await byTid(page, "qfloat-remove").count()) fail("a quote in the draft has no Remove in its field");
  if ((await byTid(page, "qfloat-save").first().textContent())?.trim() !== "Save") fail("the field of a quote in the draft has no Save");
  if (!sheetPath && !/save/.test((await byTid(page, "qfloat-hint").textContent()) ?? "")) fail("the float of a quote in the draft has no hint that Enter saves it");
  void f;
  await type("which step exactly?");
  await end("add");
  await shows("Save on a quote in the draft", countIs(3));
  await draftIs("the edited comment", (d) => d.length === 3 && d[0].comment === "which step exactly?");

  // ---- the draft's passages are marked in the thread (web, B-QS-07, C-QT-16) and a press on a mark opens its field
  if (!sheetPath) {
    const m = () => page.evaluate(marks, "aiwb-pending");
    if (!await until(async () => (await m()).length >= 3, 5000)) fail(`the draft has three quotes and the thread marks ${J((await m()).map((x) => x.text))}`);
    const at = (await m()).find((x) => /second paragraph/.test(x.text));
    if (!at) fail("the passage kept by the press elsewhere is not marked in the thread");
    else {
      await page.mouse.click(at.x, at.y);
      const s = await shows("a press on a marked passage", (x) => !!x.float);
      void s;
      if (await byTid(page, "qfloat-comment").inputValue() !== "kept") fail("a press on a marked passage opens a field without its comment");
      await key("Escape");
      await shows("Esc on the field of a marked passage", (x) => !x.float);
    }
  }

  // ---- the list the count opens: every quote with its comment or "No comment", the hint, a press on one opens its field, the × removes
  await press(page, byTid(page, "qcount").first());
  await byTid(page, "qlist-item").first().waitFor({ state: "visible", timeout: 10000 });
  const items = await byTid(page, "qlist-item").count();
  const lines = await byTid(page, "qlist-comment").allTextContents();
  if (items !== 3 || J(lines) !== J(["which step exactly?", "No comment", "kept"])) fail(`the list has ${items} quotes with the comments ${J(lines)}, not three with ["which step exactly?","No comment","kept"]`);
  const hint = await byTid(page, "qlist-hint").textContent();
  if (hint !== (sheetPath ? "tap one to edit it" : "click one to edit it")) fail(`the list's hint reads ${J(hint)}`);
  if (await byTid(page, "qlist-x").count() !== 3) fail(`the list has ${await byTid(page, "qlist-x").count()} remove controls, not 3`);
  await press(page, byTid(page, "qlist-item").nth(2));
  await byTid(page, "qfloat-comment").waitFor({ state: "visible", timeout: 10000 });
  if (await byTid(page, "qlist-item").count()) fail("the list stays open after a press on one of its quotes");
  if (await byTid(page, "qfloat-comment").inputValue() !== "kept") fail("a press on a quote of the list opens a field without its comment");
  await end("esc");
  await press(page, byTid(page, "qcount").first());
  await byTid(page, "qlist-item").first().waitFor({ state: "visible", timeout: 10000 });
  await press(page, byTid(page, "qlist-x").nth(1));
  await shows("the × of the quote across the blocks", () => true);
  await draftIs("the list's ×", (d) => d.length === 2 && d.every((q) => q.quote !== across?.quote));
  await press(page, byTid(page, "qlist-x").nth(1));
  await draftIs("the list's × again", (d) => d.length === 1);
  if (await byTid(page, "qlist-item").count() !== 1) fail("the list does not stay open, with the last quote, after the × of the one before it");
  await press(page, byTid(page, "qlist-x").first());
  await draftIs("the × of the last quote", (d) => d.length === 0);
  if (await byTid(page, "qlist-item").count()) fail("the list stays open after the × of its last quote");
  await shows("the last quote removed", (s) => !s.count);

  // ---- the quote of the whole message (phone: "Quote whole message"; desktop: select it all), and a Remove in its field
  await take(REPLY.slice(0, 12), "words to quote.", sheetPath ? "whole" : "words");
  const whole = await draftIs("not yet", () => true);
  void whole;
  await end("add");
  const w = await draftIs("the whole message", (d) => d.length === 1);
  if (w[0] && (w[0].start !== 0 || w[0].end !== shown.length || squash(w[0].quote) !== squash(shown))) fail(`the whole message is quoted as ${w[0].start} to ${w[0].end} (${J(w[0].quote.slice(0, 30))}…), not from 0 to ${shown.length}`);
  await take("font copy step");
  await type("one more");
  await end("add");
  await draftIs("a second passage of the same message", (d) => d.length === 2 && d[1].comment === "one more");

  // ---- a message of quotes alone is sent (C-QT-22), its cards are drawn and the thread keeps the cards' words
  const before = calls.length;
  await press(page, byTid(page, "send").first());
  const sent = await until(() => calls.slice(before).find((c) => c.method === "POST" && POST.test(c.path)), 10000);
  if (!sent) fail("a message of quotes alone was not sent");
  else if (sent.body?.text !== "" || sent.body?.references?.length !== 2 || sent.body.references[1].comment !== "one more" || "comment" in (sent.body.references[0] ?? {})) fail(`the message of quotes alone went out as ${J(sent.body).slice(0, 300)}`);
  await shows("after the send", (s) => !s.count);
  // the server answers the send: the message is a row of the thread (item 4) and the list puts its rows in order, which would collapse a selection made in them
  await msg(4).waitFor({ state: "visible", timeout: 10000 });
  await laidOut(page, fail);

  // ---- what cannot be quoted
  if (sheetPath) {
    // a reply still being written says so in the sheet's place (C-QT-03, B-QS-04)
    await hold(msg(3));
    await byTid(page, "quote-why").waitFor({ state: "visible", timeout: 10000 });
    if ((await byTid(page, "quote-why").textContent()) !== "Wait for the reply to finish, then quote it" || await byTid(page, "quote-selection").count()) fail("the sheet of a reply being written does not say to wait");
    await page.waitForTimeout(700); // (a press on the dimmed page closes nothing for a moment after the sheet opens: the finger that held the message may still click)
    await press(page, byTid(page, "overlay-backdrop").last());
    if (!await until(async () => !(await byTid(page, "quote-sheet").count()), 5000)) fail("a press on the dimmed page did not close the Quote sheet");
    // the cards of a sent message's quotes are no part of what its sheet holds (B-QS-05)
    await hold(msg(2));
    const text = byTid(page, "quote-text");
    await text.waitFor({ state: "visible", timeout: 10000 });
    if (await text.inputValue() !== "Fix it.") fail(`the sheet of a message with quote cards holds ${J(await text.inputValue())}, not "Fix it."`);
    await press(page, byTid(page, "quote-cancel").first());
    if (!await until(async () => !(await byTid(page, "quote-sheet").count()), 5000)) fail("Cancel did not close the Quote sheet");
  } else {
    await page.evaluate(select, ["Working", false]).catch(() => {});
    const w2 = await page.evaluate(() => { const m = document.querySelector('[data-testid="msg"][data-item="3"]'); const n = document.createTreeWalker(m, NodeFilter.SHOW_TEXT).nextNode(); const r = document.createRange(); r.setStart(n, 0); r.setEnd(n, 7); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return String(s); });
    if (w2 !== "Working") fail(`the check selected "${w2}" in the reply being written`);
    await key("ControlOrMeta+l");
    await shows("⌘L on a reply being written", (s) => s.note === "Wait for the reply to finish, then quote it" && !s.float);
    // words beside a message's own are no quote: a card of its quotes
    const card = await page.evaluate(() => { const c = document.querySelector('[data-testid="msg"][data-item="2"] [data-testid="sent-quote"]'); const n = document.createTreeWalker(c, NodeFilter.SHOW_TEXT).nextNode(); const r = document.createRange(); r.selectNodeContents(n); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return String(s); });
    if (!card) fail("the check selected nothing in a quote card");
    await key("ControlOrMeta+l");
    await shows("⌘L on a quote card's words", (s) => s.note === "Select text within one message" && !s.float);
    // the fork actions beside the reply's words are left out of a quote
    await page.mouse.move(0, 0);
    await reply.hover();
    await byTid(page, "fk-acts").first().waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
    const got = await page.evaluate(selectBetween, [1, "Then ship", "", true]).catch((e) => `error: ${e.message}`);
    if (!/^Then ship it/.test(got)) fail(`the check's selection into the fork actions is ${J(got)}`);
    await key("ControlOrMeta+l");
    await byTid(page, "qfloat-comment").waitFor({ state: "visible", timeout: 10000 });
    const q = (await byTid(page, "qfloat-quote").textContent()) ?? "";
    if (!q.includes("Then ship it") || /Branch|Fork|Label/.test(q)) fail(`the quote taken into the fork actions says ${J(q)}`);
    await key("Escape");
  }

  // ---- Esc closes the innermost layer first (B-SA-16): with the subagent drawer open, Esc drops the comment field and leaves the drawer; the
  //      next Esc closes the drawer. The sheet path has no Esc and no drawer beside the thread (the phone's drawer is a screen of its own): the
  //      Cancel of the sheet and the back are what close each there, one at a time by their nature.
  await ctx.close(); // (the mock has one stream: two pages open take it from each other)
  if (!sheetPath) {
    await seed(url, "A2");
    await mockEval(`items.${CHAT}.splice(0, Infinity,
      { kind: "user", text: "Why is the build slow?" }, say(${J(REPLY)}),
      { kind: "tool", toolId: "q1", name: "Agent", input: { description: "Read the fonts", prompt: "Read the fonts." }, result: "Done.", subagent: "qs1" });
      subs.${CHAT} = [{ id: "qs1", tool: "q1", description: "Read the fonts", prompt: "Read the fonts.", kind: "claude", model: "sonnet", effort: "medium", status: "completed", started: 1000, ended: 61000, tokens: 20000, window: 200000, toolUses: 2 }];
      subItems[${J(CHAT + "/qs1")}] = [];
      send({ type: "snapshot", ...snapshot() });`, url);
    const e = await open({ sel: { chat: CHAT } });
    const drawer = () => e.page.locator('[data-testid="sub-drawer"]').count();
    const field = () => byTid(e.page, "qfloat-comment").count();
    const row = byTid(e.page, "sub-row", { sub: "qs1" }).first();
    await row.waitFor({ state: "visible", timeout: 15000 });
    await press(e.page, row, { position: { x: 24, y: 10 } });
    if (!await until(async () => (await drawer()) === 1, 10000)) fail("a press on the subagent's row opened no drawer");
    await e.page.waitForSelector('[data-testid="msg"][data-item="1"]', { timeout: 15000 });
    const got = await e.page.evaluate(selectBetween, [1, "font copy step", "font copy step", false]);
    if (!squash(got).startsWith("fontcopystep")) fail(`the check selected "${got}", not "font copy step" …`);
    await e.page.keyboard.press("ControlOrMeta+l");
    await byTid(e.page, "qfloat-comment").waitFor({ state: "visible", timeout: 10000 });
    await e.page.keyboard.type("typed under the drawer");
    await e.page.keyboard.press("Escape");
    if (!await until(async () => !(await field()), 10000)) fail("Esc with the drawer open left the comment field open");
    if (await drawer() !== 1) fail("the Esc that was for the comment field also closed the drawer");
    if ((await mockEval(`return chats.${CHAT}.draft?.references ?? [];`, url)).length) fail("Esc on the comment field put a quote in the draft");
    await e.page.keyboard.press("Escape");
    if (!await until(async () => (await drawer()) === 0, 10000)) fail("the second Esc did not close the drawer");
    note("Esc with the subagent drawer open: the comment field closes first (nothing is added), the drawer next");
    await e.ctx.close();
  }

  // ---- the card of a sent message shows where it is from, far above the window (B-QS-08): the thread is scrolled to the passage, which is marked for a moment
  await seed(url, "A2");
  const ref = (at, quote, comment) => ({ quote, comment, item: 1, start: shown.indexOf(at), end: shown.indexOf(at) + quote.length });
  await mockEval(`items.${LONG}.splice(0, Infinity,
    { kind: "user", text: "Why is the build slow?" }, say(${J(REPLY)}),
    ...Array.from({ length: 40 }, (_, i) => [{ kind: "user", text: "Filler question " + i }, say("Filler answer " + i + " that is a line or two long, so that the thread has some height to scroll through.")]).flat(),
    { kind: "user", text: "", references: [${J(ref("second paragraph", "second paragraph", "the words"))}, ${J(ref("font copy step", "font copy step", ""))}] });`, url);
  const far = await open({ sel: { chat: LONG } });
  const p2 = far.page;
  await byTid(p2, "sent-quote-card").first().waitFor({ state: "visible", timeout: 15000 });
  await until(async () => (await p2.evaluate(() => document.querySelector('[data-testid="thread-scroll"]')?.scrollTop ?? 0)) > 500, 10000);
  if (await byTid(p2, "msg", { item: 1 }).count()) fail("the reply is drawn although it is far above the window: the check does not test a message the list has not drawn");
  const top0 = await p2.evaluate(() => document.querySelector('[data-testid="thread-scroll"]').scrollTop);
  const cardOf = byTid(p2, "sent-quote").first();
  await cardOf.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await press(p2, cardOf);
  const flash = await until(async () => {
    const m = await p2.evaluate(marks, "aiwb-quote");
    return m.length && m[0].text === "second paragraph" ? m[0] : null;
  }, 15000);
  if (!flash) fail("a press on a quote card marked no passage of the message it points at");
  else {
    const view = await p2.evaluate(() => { const r = document.querySelector('[data-testid="thread-scroll"]').getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
    await until(async () => { const m = (await p2.evaluate(marks, "aiwb-quote"))[0]; return m && m.top >= view.top && m.bottom <= view.bottom; }, 10000);
    const m = (await p2.evaluate(marks, "aiwb-quote"))[0];
    if (!m || m.top < view.top || m.bottom > view.bottom) fail(`the passage the card points at is not in the thread's window after the press (${J(m)}, window ${J(view)})`);
  }
  if (!await until(async () => !(await p2.evaluate(marks, "aiwb-quote")).length, 8000)) fail("the passage a card points at stays marked (it fades after about 3 s)");
  void top0;

  // ---- a quote of the draft's list: a press on it scrolls the thread to its passage, far above the window, and opens its comment (C-QT-15)
  await mockEval(`chats.${LONG}.draft = { text: "", references: [${J(ref("font copy step", "font copy step", "which step?"))}] }; chats.${LONG}.draftRev = (chats.${LONG}.draftRev ?? 0) + 1;`, url);
  await far.ctx.close(); // (the mock has one stream: two pages open take it from each other)
  const list = await open({ sel: { chat: LONG } });
  const p3 = list.page;
  await byTid(p3, "qcount").first().waitFor({ state: "visible", timeout: 15000 });
  await until(async () => (await p3.evaluate(() => document.querySelector('[data-testid="thread-scroll"]')?.scrollTop ?? 0)) > 500, 10000);
  if (await byTid(p3, "msg", { item: 1 }).count()) fail("the quoted reply is drawn although it is far above the window: the check does not test a message the list has not drawn");
  await press(p3, byTid(p3, "qcount").first());
  await byTid(p3, "qlist-item").first().waitFor({ state: "visible", timeout: 5000 });
  await press(p3, byTid(p3, "qlist-item").first());
  const inView = async () => {
    const view = await p3.evaluate(() => { const r = document.querySelector('[data-testid="thread-scroll"]').getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
    const m = (await p3.evaluate(marks, "aiwb-pending")).find((x) => x.text === "font copy step");
    return m && m.top >= view.top && m.bottom <= view.bottom ? m : null;
  };
  if (!await until(inView, 15000)) fail(`a press on a quote of the draft's list did not bring its passage into the thread's window: ${J(await p3.evaluate(marks, "aiwb-pending"))}`);
  if (!await until(() => byTid(p3, "qfloat-comment").count(), 5000)) fail("a press on a quote of the draft's list opened no field for its comment");
  note(`${sheetPath ? "the Quote sheet" : "the selection and ⌘L"}: a press on a quote of the draft's list brought the thread to its passage`);
  await list.ctx.close();
  note(`${sheetPath ? "the Quote sheet" : "the selection and ⌘L"}: quotes taken, edited, listed, removed and sent; a card showed where it is from`);
}, { viewports, page: false });
