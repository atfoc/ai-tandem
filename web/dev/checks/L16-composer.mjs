// L16 (new; package K3): the composer's behaviours that no old check proved (the inventory's `none` rows of area C and the rows only a test of
// the whole box reaches), on the real composer of the new build at the three viewports.
//   C-TX-01  the box's placeholder: "Ask Claude Code…" in a plain chat, "Ask or tell… (@ to mention a board)" in a board chat; it goes with the first text
//   C-TX-03/04  Enter sends and Shift+Enter is a line break (the box's text has "\n" for it); the message that goes is the text as typed
//   C-TX-05/06/07  Send is off with a blank box (white space too), on with text; the text is trimmed; at Send the box is empty and the draft with it
//   C-TX-08  a Send that is refused puts its text back into the empty box and says why under the composer (C-RO-09); `cap` does not read the chat again (C-CH-06)
//   C-TX-10/15/16  a busy chat: Send off and says "The agent is working", Enter sends nothing and typing goes on; Stop stops it, and so does Esc
//   C-TX-19  the box has room for three lines at least (the phone: one line, growing to six), grows with its text and then scrolls inside
//   C-TX-20, C-NC-12  the box has the focus a moment after a chat is opened and after a new chat is made (the desktop's: a keyboard)
//   C-MN-01/02/03/04/06  "@" in a board chat opens the list of the other boards of its server (six at most), by what follows; "a@b" opens none; a plain chat
//            has none; the arrows move the highlight, Enter and Tab pick, Esc closes and leaves the text, a press on an option picks it and the box keeps the
//            focus; a pick makes "@Name " and the context row shows the mentioned board; the same name again replaces the pick
//   C-CH-12/14  the model's list searches ("Search models"), its arrows and Enter pick; the effort follows the model
//   C-RO-07/08  an archived chat draws no box but its bar ("Archived — unarchive to continue", Unarchive), and a chat of the old board connection its own bar
//   C-RO-14  the note beside the context row goes by itself after 2.5 s
//   (sweep, rn-sw-webtest) the folder of a chat that has not started, changed from elsewhere, is the composer's at once (web/test/sectionviews.test.ts)
// Keys are the desktop's (a hardware keyboard on a tablet has them too: the tablet runs them, the phone the parts a finger does).
// At the phone (ux-improvements C1) the composer is the phone's: the empty box shows Talk (`composer-talk`) and no Send, Send comes with text, Stop
// while the agent works (Send beside it once something is typed); Enter is a line break and Ctrl+Enter sends; the controls have no `title`, so their
// words are read from `aria-label`; the @ list is the dock above the composer (`mention-dock`, four rows at most, names without "@"); the context row's
// chips are `ctx-chip` with `data-kind` (board: "Open the board <name>"; ref: the name and a "Remove <name> from the message" ×).
import { atRest, callMatcher, callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { MORE, POP, chip, closeChoice, frame, openAt, openChoice, openState, phoneChip, placesOf } from "./composer.mjs";
import { byTid, openChat, press, tidSel } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const J = JSON.stringify;
const POST = /\/chats\/(\w+)\/messages(\?|$)/;

await check("L16 the composer: Enter, trim, refusals, growth, focus, the @ list, the model's search, the bars", async ({ url, viewport, layout, open, fail, note }) => {
  const keys = viewport !== "phone"; // (a hardware keyboard: the desktop's, and a tablet's)
  const phone = !keys;
  let states = await seed(url, "A2");
  const state = (id) => states.find((s) => s.id === id);
  /** A state's page on a seed made anew: what an earlier section sent or changed is not there. */
  const fresh = async (id, o = {}) => { states = await seed(url, "A2"); return openState(open, state(id), layout, 0, o); };
  const box = (page) => byTid(page, "composer-input").first();
  const text = async (page) => (await box(page).textContent()) ?? "";
  const send = (page) => byTid(page, "send").first();
  const talk = (page) => byTid(page, "composer-talk").first();
  /** What a primary control says: its title (the wide layouts), its aria-label (the phone has no hover titles). */
  const says = (loc) => loc.getAttribute(phone ? "aria-label" : "title");
  /** The phone's empty box: Talk and no Send (a blank box is one with no text). */
  const talking = async (page) => (await talk(page).isVisible()) && !await byTid(page, "send").count();
  /** Send is "off": at the wide layouts a disabled button, at the phone no Send at all while the box is blank (Talk is there). */
  const sendOff = async (page) => phone ? await talking(page) : await send(page).isDisabled();
  const popOf = (page) => byTid(page, phone ? "mention-dock" : "mention-pop");
  const posts = (calls, from = 0) => calls.slice(from).filter((c) => c.method === "POST" && POST.test(c.path));
  /** The phone's folder path as the user reads it: its text without the embedding marks that keep its characters in order. */
  const pathText = async (page) => ((await byTid(page, "dir-path").first().textContent()) ?? "").replace(/[\u202A-\u202E]/g, "");
  /** The effort's chip, wherever the toolbar's fit puts it: in the row in a wide page, in the "more" popup at the tablet's width, where voice's pair
   *  keeps the room and Effort leaves early (core's LEAVING). The popup is opened when the chip is not in the row, and stays open through a pick. */
  const effortChipOf = async (page) => {
    if (await chip(page, "effort").count() && !await chip(byTid(page, "more-pop"), "effort").count()) return chip(page, "effort").first();
    if (!await page.locator(POP).count()) {
      if (!await page.locator(MORE).count()) return fail("the effort's chip is neither in the toolbar's row nor behind a \"more\" chip"), null;
      await press(page, page.locator(MORE));
      if (!await until(() => page.locator(POP).count(), 5000)) return fail("the \"more\" chip did not open its popup"), null;
    }
    return chip(byTid(page, "more-pop"), "effort").first();
  };
  const type = async (page, s) => { await press(page, box(page)); await page.keyboard.type(s); };

  // ---- the box: placeholder, Enter, Shift+Enter, trim, Send's state, the draft
  {
    const { page, ctx } = await fresh("plain-new");
    const calls = callsOf(page);
    const ph = () => box(page).evaluate((b) => ({ text: b.getAttribute("data-placeholder"), empty: b.classList.contains("is-empty") }));
    if ((await ph()).text !== "Ask Claude Code…" || !(await ph()).empty) fail(`a plain chat's box says ${J(await ph())}, not "Ask Claude Code…" when empty`);
    if (!await until(() => sendOff(page), 10000)) fail(phone ? "the empty box does not show Talk without a Send" : "Send is on with a blank box");
    await type(page, "   ");
    if (!await sendOff(page)) fail(phone ? "a box of white space only does not show Talk without a Send" : "Send is on with a box of white space only");
    await page.keyboard.press("Backspace"); await page.keyboard.press("Backspace"); await page.keyboard.press("Backspace");
    await type(page, "  first line");
    if ((await ph()).empty) fail("the placeholder stays when text is typed");
    if (phone && await talk(page).count()) fail("Talk stays beside text in the box: the primary is Send once something is typed");
    if (await send(page).isDisabled()) fail("Send is off with text in the box");
    if (keys) {
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.type("second line  ");
      if (!(await text(page)).includes("\n") && !/first line\s*second line/.test(await text(page))) fail(`Shift+Enter made no line break: ${J(await text(page))}`);
      if (posts(calls).length) fail("Shift+Enter sent the message");
      const from = calls.length;
      await page.keyboard.press("Enter");
      const sent = await until(() => posts(calls, from)[0], 10000);
      if (!sent) fail("Enter did not send the message");
      else if (sent.body?.text !== "first line\nsecond line") fail(`the message sent is ${J(sent.body?.text)}, not "first line\\nsecond line" (trimmed, a line break as "\\n")`);
    } else {
      // (the phone: Enter is a line break and sends nothing, Send is the button; Ctrl+Enter sends too, below)
      await page.keyboard.press("Enter");
      await page.keyboard.type("second line  ");
      await page.waitForTimeout(300);
      if (posts(calls).length) fail("Enter sent the message at the phone: it is a line break there");
      if (!/first line\s*\n\s*second line/.test(await text(page))) fail(`Enter made no line break at the phone: ${J(await text(page))}`);
      const from = calls.length;
      await press(page, send(page));
      const sent = await until(() => posts(calls, from)[0], 10000);
      if (!sent) fail("a press on Send did not send the message");
      else if (sent.body?.text !== "first line\nsecond line") fail(`the message sent is ${J(sent.body?.text)}, not "first line\nsecond line" (trimmed, a line break as "\n")`);
    }
    if (!await until(async () => (await text(page)) === "", 5000)) fail(`after Send the box holds ${J(await text(page))}`);
    if (!await until(() => sendOff(page), 5000)) fail(phone ? "after Send, with the box empty, the primary is not Talk" : "after Send, with the box empty, Send is on");
    await ctx.close();
  }
  if (phone) { // Ctrl+Enter sends at the phone (a keyboard on it), Enter does not; the box is empty after it
    const { page, ctx } = await fresh("plain-new");
    const calls = callsOf(page);
    await type(page, "by the keys");
    const from = calls.length;
    await page.keyboard.press("Control+Enter");
    const sent = await until(() => posts(calls, from)[0], 10000);
    if (!sent) fail("Ctrl+Enter did not send the message at the phone");
    else if (sent.body?.text !== "by the keys") fail(`Ctrl+Enter sent ${J(sent.body?.text)}, not "by the keys"`);
    if (!await until(async () => (await text(page)) === "", 5000)) fail(`after Ctrl+Enter the box holds ${J(await text(page))}`);
    await ctx.close();
  }
  { // a board chat's placeholder
    const { page, ctx } = await fresh("board-new");
    const t = await box(page).getAttribute("data-placeholder");
    if (t !== "Ask or tell… (@ to mention a board)") fail(`a board chat's box says "${t}"`);
    await ctx.close();
  }

  // ---- a Send that is refused: the text comes back, the line under the composer says why, `cap` does not read the chat again
  {
    const { page, ctx } = await fresh("plain-new");
    const calls = callsOf(page);
    await mockEval(`flags.send = { refuse: { status: 429, code: "cap", error: "Too many turns run at once" } };`, url);
    await type(page, "will be refused");
    const from = calls.length;
    await press(page, send(page));
    if (!await until(() => byTid(page, "composer-err").count(), 10000)) fail("a refused Send said nothing under the composer");
    else if (!(await byTid(page, "composer-err").first().textContent()).includes("Too many turns run at once")) fail(`the line under the composer says "${await byTid(page, "composer-err").first().textContent()}"`);
    if (!await until(async () => (await text(page)) === "will be refused", 5000)) fail(`a refused Send did not put its text back: the box holds ${J(await text(page))}`);
    if (calls.slice(from).some((c) => c.method === "GET" && /^\/api\/chats\/c_A2_new(\?|$)/.test(c.path))) fail("a `cap` refusal read the chat again (it leaves the message in the box)");
    await mockEval(`delete flags.send;`, url);
    // the sentence stays while nothing changes, and goes with a choice of the chat: its model, then (refused again) its effort (C-RO-10, C-CH-22)
    await page.waitForTimeout(700);
    if (!await byTid(page, "composer-err").count()) fail("the refusal's sentence went by itself");
    const pickOther = async (kind) => {
      await atRest(page, 12);
      if (phone) { // (the model sheet: a model's row without the ✓, or the effort control's other segment; Done closes it)
        const sheet = await openChoice(page, "model");
        const other = kind === "model" ? byTid(sheet, "picker-row").filter({ hasNot: page.locator(tidSel("picker-check")) }).first() : byTid(byTid(sheet, "effort-seg"), "segment", { on: "false" }).first();
        if (!await until(() => other.count(), 5000)) { fail(`the ${kind}'s sheet has no other ${kind === "model" ? "row" : "segment"} to pick`); await closeChoice(page); return false; }
        const from = calls.length;
        await press(page, other);
        const saved = await until(() => calls.slice(from).some((c) => c.method === "PATCH" && /\/chats\/c_A2_new/.test(c.path) && (c.body?.[kind])), 10000);
        if (!saved) fail(`a pick of the ${kind} made no PATCH`);
        await closeChoice(page);
        return saved;
      }
      if (!await chip(page, kind).first().isVisible()) await press(page, byTid(page, "more-chip").first());
      await press(page, chip(page, kind).first());
      const rows = byTid(page, "pick-row"), other = rows.and(page.locator('[aria-selected="false"]')).first();
      if (!await until(() => other.count(), 5000)) { fail(`the ${kind}'s list has no other row to pick`); return false; }
      const from = calls.length;
      await press(page, other);
      if (!await until(() => calls.slice(from).some((c) => c.method === "PATCH" && /\/chats\/c_A2_new/.test(c.path) && (c.body?.[kind])), 10000)) { fail(`a pick of the ${kind} made no PATCH`); return false; }
      if (await byTid(page, "more-pop").count()) { await page.keyboard.press("Escape"); await until(async () => !await byTid(page, "more-pop").count(), 5000); } // (the popup that held the chip stays open under a pick)
      return true;
    };
    if (await pickOther("model")) {
      if (!await until(async () => !await byTid(page, "composer-err").count(), 5000)) fail(`a model chosen left the refusal's sentence: "${await byTid(page, "composer-err").first().textContent()}"`);
      if ((await text(page)) !== "will be refused") fail(`a model chosen took the text from the box: ${J(await text(page))}`);
      // (a pick clears the sentence by its own success; what the chat's own record says, from the server, clears it too: a change made in
      // another window, and the chat starting)
      const refused = async (when) => {
        await mockEval(`flags.send = { refuse: { status: 429, code: "cap", error: "Too many turns run at once" } };`, url);
        await press(page, send(page));
        const shown = await until(() => byTid(page, "composer-err").count(), 10000);
        if (!shown) fail(`${when}: a refused Send said nothing under the composer`);
        await mockEval(`delete flags.send;`, url);
        return shown;
      };
      if (await refused("after a model was chosen")) {
        await mockEval(`chats.c_A2_new.effort = chats.c_A2_new.effort === "low" ? "high" : "low"; send({ type: "chat", chat: chats.c_A2_new });`, url);
        if (!await until(async () => !await byTid(page, "composer-err").count(), 5000)) fail(`an effort changed in another window left the refusal's sentence: "${await byTid(page, "composer-err").first().textContent()}"`);
      }
      if (await refused("after the effort changed")) {
        await mockEval(`chats.c_A2_new.locked = true; send({ type: "chat", chat: chats.c_A2_new });`, url);
        if (!await until(async () => !await byTid(page, "composer-err").count(), 5000)) fail(`the chat starting left the refusal's sentence: "${await byTid(page, "composer-err").first().textContent()}"`);
      }
    }
    // a pick that works clears the sentence: the agent's chip is a choice on a new chat; here a press on Send again goes through
    const again = calls.length;
    await press(page, send(page));
    if (!await until(() => posts(calls, again)[0], 10000)) fail("the text that was put back was not sent again");
    await ctx.close();
  }

  // ---- a Send that fails is put back, unless the draft it sent was removed on the server meanwhile (another window sent it): then it is not (C-TX-09)
  for (const removed of [false, true]) {
    states = await seed(url, "A2");
    await mockEval(`delete chats.c_plain.draft; delete chats.c_plain.draftRev;`, url); // (the seed leaves this chat as it was: the text of the round before is not its draft)
    const { page, ctx } = await openState(open, state("plain-started"), layout, 0);
    const calls = callsOf(page);
    const draft = () => mockEval(`return chats.c_plain.draft?.text ?? null;`, url);
    await type(page, "sent from two windows");
    if (!await until(async () => (await draft()) === "sent from two windows", 10000)) fail(`the draft was not saved before the Send: ${J(await draft())}`);
    // (the answer is held, then it is "not known whether the message arrived": a refusal that says nothing of the draft)
    await mockEval(`flags.send = { hold: true, refuse: { status: 504, code: "send_unknown", error: "it is not known whether the message arrived" } };`, url);
    const from = calls.length;
    await press(page, send(page));
    if (!await until(async () => (await text(page)) === "" && posts(calls, from)[0], 10000)) fail(`a Send did not empty the box and call: ${J(await text(page))}`);
    if (removed) {
      await mockEval(`setSession("c_plain", curOf(chats.c_plain), { draft: undefined, draftRev: (chats.c_plain.draftRev ?? 0) + 1 });`, url);
      await page.waitForTimeout(1000); // (the news of the removal reaches the page before the answer does)
    }
    await mockEval(`release("send"); delete flags.send;`, url);
    if (removed) {
      await page.waitForTimeout(1000); // (the answer has come)
      if (await text(page) !== "") fail(`a Send that failed, whose draft was removed on the server meanwhile, put its text back: the box holds ${J(await text(page))}`);
      if (await draft() !== null) fail(`a Send that failed, whose draft was removed meanwhile, saved its text as a draft again: ${J(await draft())}`);
    } else if (!await until(async () => (await text(page)) === "sent from two windows", 10000)) fail(`a Send that failed put nothing back: the box holds ${J(await text(page))}`);
    await ctx.close();
  }

  // ---- a refused Send: the message stays in the box whatever the refusal; only a 409 that is no state of the chat's own reads the chat again (C-CH-06, C-RO-13)
  for (const [status, code, error, rereads] of [[409, "agent_missing", "Claude Code is not installed on this computer", false], [409, "no_agent", "This chat has no agent", false],
    [409, "window", "The model's context window is too small for this conversation", false], [409, "busy", "The agent is working", true]]) {
    const { page, ctx } = await fresh("plain-started");
    const calls = callsOf(page);
    await mockEval(`delete chats.c_plain.draft; delete chats.c_plain.draftRev; flags.send = { refuse: { status: ${status}, code: ${J(code)}, error: ${J(error)} } };`, url);
    await type(page, `refused with ${code}`);
    const from = calls.length;
    await press(page, send(page));
    if (!await until(async () => (await byTid(page, "composer-err").first().textContent().catch(() => "")).includes(error), 10000)) fail(`${code}: the refusal says ${J(await byTid(page, "composer-err").first().textContent().catch(() => ""))} under the composer, not ${J(error)}`);
    if (!await until(async () => (await text(page)) === `refused with ${code}`, 5000)) fail(`${code}: a refused Send did not leave its text in the box: it holds ${J(await text(page))}`);
    await page.waitForTimeout(600);
    const read = calls.slice(from).some((c) => c.method === "GET" && /^\/api\/chats\/c_plain(\?|$)/.test(c.path));
    if (read !== rereads) fail(`${code}: the chat was ${read ? "" : "not "}read again after the refusal, which ${rereads ? "tells it is stale" : "is no state of the chat's own"}`);
    await mockEval(`delete flags.send; delete chats.c_plain.draft; delete chats.c_plain.draftRev;`, url);
    await ctx.close();
  }

  // ---- a busy chat: Send is off with its reason, Enter sends nothing and typing goes on; Stop and Esc stop it
  {
    const { page, ctx } = await fresh("plain-busy");
    const calls = callsOf(page);
    if (phone && (!await byTid(page, "stop").count() || await byTid(page, "send").count())) fail("at the phone a busy chat with an empty box shows Stop alone (no Send, no Talk)");
    if (phone && await talk(page).count()) fail("at the phone a busy chat shows Talk: the primary is Stop");
    await type(page, "while it works");
    if ((await text(page)) !== "while it works") fail(`typing in a busy chat gave ${J(await text(page))}`);
    if (!await send(page).isDisabled() || await says(send(page)) !== "The agent is working") fail(`Send of a busy chat is ${await send(page).isDisabled() ? "off" : "on"} and says "${await says(send(page))}"`);
    if (keys) { await page.keyboard.press("Enter"); await page.waitForTimeout(300); if (posts(calls).length) fail("Enter sent a message to a busy chat"); }
    const stop = byTid(page, "stop").first();
    const stopSays = phone ? "Stop" : "Stop (Esc)"; // (no keyboard hint at the phone)
    if (await says(stop) !== stopSays) fail(`Stop says "${await says(stop)}", not "${stopSays}"`);
    if (phone && (!await send(page).count() || !await stop.count())) fail("at the phone a busy chat with text typed shows Stop and Send together"); // (the primary's states: Stop, and Send beside it once something is typed)
    const from = calls.length;
    await press(page, stop);
    if (!await until(() => calls.slice(from).some((c) => c.method === "POST" && /\/chats\/c_A2_busy\/interrupt/.test(c.path)), 10000)) fail("a press on Stop made no interrupt call");
    if (keys) {
      await mockEval(`Object.assign(chats.c_A2_busy, { status: "tool", statusTool: "Bash" }); send({ type: "chat", chat: chats.c_A2_busy });`, url);
      await press(page, box(page));
      const was = calls.length;
      await page.keyboard.press("Escape");
      if (!await until(() => calls.slice(was).some((c) => c.method === "POST" && /\/chats\/c_A2_busy\/interrupt/.test(c.path)), 10000)) fail("Esc in the box made no interrupt call while the agent works");
    }
    await ctx.close();
  }
  { // an idle chat: Esc stops nothing
    const { page, ctx } = await fresh("plain-started");
    const calls = callsOf(page);
    if (keys) { await press(page, box(page)); await page.keyboard.press("Escape"); await page.waitForTimeout(300); if (calls.some((c) => /interrupt/.test(c.path))) fail("Esc in an idle chat's box made an interrupt call"); }
    await ctx.close();
  }

  // ---- a chat with no agent: the box says so, Send is off with the reason, the empty thread offers nothing to send (C-CH-05)
  for (const [id, holder, why] of [["plain-noagent", "Choose an agent…", "Choose an agent to send a message."],
    ["plain-noagent-installed", "No agent is installed", "No agent is installed on Bare box. Install Claude Code, Cursor or pi on that machine."]]) {
    const blockedBox = phone && id === "plain-noagent-installed"; // (the phone's block replaces the box: there is no composer-input to wait for)
    const { page, ctx } = await fresh(id, blockedBox ? { wait: '[data-testid="composer-block"]' } : {});
    const calls = callsOf(page);
    if (blockedBox) {
      // (the phone says it once, in the box's place: the block of kind noagent replaces the box, the toolbar and Send, and the empty thread does not repeat it)
      const block = byTid(page, "composer-block", { kind: "noagent", place: "box" });
      if (await block.count() !== 1 || !(await block.first().textContent()).includes(why.slice(0, why.indexOf(". ") + 1))) fail(`${id}: the phone's composer block is ${J(await byTid(page, "composer-block").allTextContents())}, not the noagent block in the box's place saying ${J(why)}`);
      if (await box(page).count() || await send(page).count()) fail(`${id}: the phone draws the box or Send beside the noagent block`);
      if (await byTid(page, "empty-reason").count()) fail(`${id}: the phone's empty thread repeats the block as ${J(await byTid(page, "empty-reason").allTextContents())}`);
      if (await byTid(page, "suggestion").count()) fail(`${id}: the empty thread of a chat with no agent offers a suggestion to send`);
      await ctx.close();
      continue;
    }
    const t = await box(page).getAttribute("data-placeholder");
    if (t !== holder) fail(`${id}: the box says ${J(t)}, not ${J(holder)}`);
    await type(page, "no one to hear it");
    if (!await send(page).isDisabled() || await says(send(page)) !== why) fail(`${id}: Send is ${await send(page).isDisabled() ? "off" : "on"} and says ${J(await says(send(page)))}, not off with ${J(why)}`);
    if (keys) { await page.keyboard.press("Enter"); await page.waitForTimeout(300); }
    if (posts(calls).length) fail(`${id}: Enter sent a message to a chat with no agent`);
    if (await byTid(page, "empty-reason").count() !== 1 || (await byTid(page, "empty-reason").first().textContent()) !== why) fail(`${id}: the empty thread says ${J(await byTid(page, "empty-reason").allTextContents())}, not ${J(why)}`);
    if (await byTid(page, "suggestion").count()) fail(`${id}: the empty thread of a chat with no agent offers a suggestion to send`);
    await ctx.close();
  }

  // ---- the box grows from three lines to six (or 40% of the window), then scrolls
  {
    const { page, ctx } = await fresh("plain-new");
    const h = () => box(page).evaluate((b) => ({ h: b.getBoundingClientRect().height, scroll: b.scrollHeight > b.clientHeight + 1, line: parseFloat(getComputedStyle(b).lineHeight), win: innerHeight }));
    const empty = await h();
    // (the phone's box starts at one line and grows to six: goal 3.6; the wide layouts keep room for three lines)
    const rows = phone ? 1 : 3;
    if (empty.h < rows * empty.line) fail(`the empty box is ${empty.h} px high: room for ${rows} line${rows > 1 ? "s" : ""} is ${rows * empty.line}`);
    await press(page, box(page));
    for (let i = 0; i < 5; i++) { await page.keyboard.type("line " + i); await page.keyboard.press("Shift+Enter"); }
    const some = await h();
    if (some.h <= empty.h) fail(`the box did not grow with six lines: ${empty.h} then ${some.h} px`);
    for (let i = 0; i < 30; i++) { await page.keyboard.type("more " + i); await page.keyboard.press("Shift+Enter"); }
    const many = await h();
    const cap = phone ? 6 * many.line : Math.max(6 * many.line, 0.4 * many.win); // (the phone: six lines, then it scrolls)
    if (many.h > cap + (phone ? 24 : 8) || !many.scroll) fail(`with thirty-five lines the box is ${many.h} px high and ${many.scroll ? "" : "does not "}scroll${many.scroll ? "s" : ""}: it stops at six lines${phone ? "" : " or 40% of the window"} (${cap} px) and scrolls`);
    await ctx.close();
  }

  // ---- the focus: after a chat is opened (a keyboard's viewport), and after a new chat is made
  if (viewport === "desktop") {
    const { page, ctx } = await fresh("plain-new");
    await openChat(page, "c_plain");
    if (!await until(() => page.evaluate(() => document.activeElement?.dataset?.testid === "composer-input"), 5000)) fail(`a moment after a chat was opened the focus is on ${await page.evaluate(() => document.activeElement?.dataset?.testid ?? document.activeElement?.tagName)}, not the box`);
    await ctx.close();
    const home = await open({ sel: {}, wait: tidSel("home") });
    await press(home.page, byTid(home.page, "home-new-chat").first());
    if (!await until(() => home.page.evaluate(() => document.activeElement?.dataset?.testid === "composer-input"), 10000)) fail("a new chat opened with the focus elsewhere than in its box");
    await home.ctx.close(); // (the mock's host face has one stream: a page left open takes it from the next one every time the browser retries)
  }

  // ---- the @ list of a board chat
  {
    const { page, ctx } = await fresh("board-new");
    const pop = () => popOf(page);
    const items = () => byTid(page, "mention-item").allTextContents();
    await press(page, box(page));
    await page.keyboard.type("@");
    if (!await until(() => pop().count(), 5000)) fail('"@" in a board chat opened no list of boards');
    const all = await items();
    if (!all.length || all.length > (phone ? 4 : 6) || (!phone && all.some((x) => !x.startsWith("@")))) fail(`the list of boards is ${J(all)}: ${phone ? "board names (the dock shows no \"@\"), four rows at most" : 'boards named with "@", six at most'}`);
    if (all.some((x) => /pipeline/.test(x))) note("(the chat's own board is in its list: a board may be named in its own chat)");
    await page.keyboard.type("sk");
    const narrowed = await until(async () => { const i = await items(); return i.length && i.every((x) => /sk/i.test(x)) ? i : null; }, 5000);
    if (!narrowed) fail(`"@sk" lists ${J(await items())}: boards whose name contains "sk"`);
    if (keys) {
      const hi = () => byTid(page, "mention-item").evaluateAll((els) => els.findIndex((e) => e.getAttribute("aria-selected") === "true"));
      if (await hi() !== 0) fail(`the first board is not highlighted: ${await hi()}`);
      await page.keyboard.press("Escape");
      if (await pop().count() || (await text(page)) !== "@sk") fail(`Esc left the list ${await pop().count() ? "open" : "closed"} and the text ${J(await text(page))}`);
      await page.keyboard.press("Backspace");
      await page.keyboard.type("k");
      if (!await until(() => pop().count(), 5000)) fail("the list did not open again with a typed character");
      await page.keyboard.press("Enter");
      if (!await until(async () => (await text(page)).startsWith("@") && (await text(page)).endsWith(" ") && !await pop().count(), 5000)) fail(`Enter picked nothing: the box holds ${J(await text(page))}`);
    } else {
      await press(page, byTid(page, "mention-item").first());
      if (!await until(async () => (await text(page)).endsWith(" ") && !await pop().count(), 5000)) fail(`a press on an option picked nothing: the box holds ${J(await text(page))}`);
    }
    const picked = (await text(page)).trim();
    if (!/^@\S+$/.test(picked)) fail(`the pick made ${J(picked)}, not "@Name "`);
    // the context row names the board that was mentioned (at the phone the ref chip is the name and its ×, "Remove <name> from the message")
    const refs = phone ? byTid(page, "ctx-chip", { kind: "ref" }) : byTid(page, "ctx-chip", { ref: true });
    if (!await until(async () => (await refs.allTextContents()).some((x) => x.trim() === (phone ? picked.slice(1) : picked)), 5000)) fail(`the context row has no chip for ${picked}: ${J(await byTid(page, "ctx-chip").allTextContents())}`);
    if (phone) {
      if (await refs.first().locator(tidSel("ctx-chip-remove")).getAttribute("aria-label").then((t) => t !== `Remove ${picked.slice(1)} from the message`).catch(() => true)) fail(`the × of the chip of a mentioned board says ${J(await refs.first().locator(tidSel("ctx-chip-remove")).getAttribute("aria-label").catch(() => null))}, not "Remove ${picked.slice(1)} from the message"`);
    } else if (await refs.first().getAttribute("title").then((t) => !/^Referenced board/.test(t ?? "")).catch(() => true)) fail("the chip of a mentioned board has no tooltip \"Referenced board\"");
    // the chat's own board is a chip of the context row, with its tooltip (C-MN-06); at the phone its words are "Open the board <name>"
    const own = phone ? byTid(page, "ctx-chip", { kind: "board" }).first() : byTid(page, "ctx-chip").and(page.locator(":not([data-ref])")).first();
    const ownSays = phone ? "Open the board " : "Every message names this board to the agent";
    if (!(await own.getAttribute("aria-label").catch(() => "") ?? "").startsWith(ownSays)) fail(`the chip of the chat's own board says ${J(await own.getAttribute("aria-label").catch(() => null))}, not "${ownSays} …"`);
    // the same name again replaces the pick: one chip for it, not two (C-MN-04)
    const chipsNow = () => refs.count();
    const one = await chipsNow();
    await page.keyboard.type("@sk");
    if (!await until(() => pop().count(), 5000)) fail('"@sk" typed after a pick opened no list');
    else {
      if (keys) await page.keyboard.press("Enter"); else await press(page, byTid(page, "mention-item").first());
      if (!await until(async () => (await text(page)).trim().split(/\s+/).length === 2 && !await pop().count(), 5000)) fail(`the same name picked again: the box holds ${J(await text(page))}`);
      else if (await chipsNow() !== one) fail(`the same name picked again made ${await chipsNow()} chips for it, not ${one}`);
      // (the chip is one board either way: what the pick adds to the draft's mentions, which the message carries, is told apart)
      const mentions = () => mockEval(`return (chats.c_A2_board_new.draft?.mentions ?? []).length;`, url);
      if (!await until(async () => (await mentions()) > 0, 10000) || !await until(async () => (await mentions()) === 1, 3000)) fail(`the same name picked again: the saved draft names ${await mentions()} mentions, not 1`);
    }
    // "a@b" opens none; white space after a name closes the list
    await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.press("Backspace");
    await page.keyboard.type("a@b");
    await page.waitForTimeout(300);
    if (await pop().count()) fail('"a@b" opened a list');
    await page.keyboard.press("Backspace"); await page.keyboard.press("Backspace"); await page.keyboard.press("Backspace");
    await page.keyboard.type("@s ");
    await page.waitForTimeout(300);
    if (await pop().count()) fail("white space after the name did not close the list");
    await ctx.close();
  }
  { // a plain chat has no list
    const { page, ctx } = await fresh("plain-new");
    await type(page, "@");
    await page.waitForTimeout(400);
    if (await popOf(page).count()) fail('"@" in a plain chat opened a list');
    await ctx.close();
  }

  // ---- the model's list: it searches, the arrows and Enter pick, the effort follows the model
  if (phone) { // the model sheet: the kit's search field comes only past 8 models, the plain chat's catalog has fewer (UX.C2 proves it with the pi seed's many); the rows are the catalog's; the effort is its control, not a second list
    const { page, ctx } = await fresh("plain-new");
    const calls = callsOf(page);
    const sheet = await openChoice(page, "model");
    if (await byTid(sheet, "picker-search").count()) fail("the model sheet of a catalog of four models has a search field: it comes past 8");
    const rows = await byTid(sheet, "picker-row").evaluateAll((els) => els.map((e) => e.dataset.value));
    if (J(rows) !== J(["opus", "sonnet", "haiku", "long"])) fail(`the model sheet lists ${J(rows)}, not the catalog's ["opus","sonnet","haiku","long"]`);
    if (await byTid(sheet, "picker-row").filter({ has: page.locator(tidSel("picker-check")) }).count() !== 1) fail("the model sheet does not tick the chosen model alone");
    const from = calls.length;
    await press(page, byTid(sheet, "picker-row", { value: "sonnet" }));
    if (!await until(() => calls.slice(from).some((c) => c.method === "PATCH" && /\/chats\/c_A2_new/.test(c.path) && c.body?.model === "sonnet"), 10000)) fail("a press on a model's row made no PATCH with the model");
    if (!await byTid(page, "model-sheet").count()) fail("the model sheet closed with a model pick: it stays open for the effort (Done closes it)");
    // the effort follows the model: it keeps the effort the new model offers, else its default
    const on = await until(async () => (await byTid(byTid(sheet, "effort-seg"), "segment", { on: "true" }).evaluateAll((els) => els.map((e) => e.dataset.value)))[0] ?? null, 5000);
    if (!on) fail("after a model pick the effort control has no segment on: this model offers efforts");
    await closeChoice(page);
    if (!((await phoneChip(page, "model").textContent()) ?? "").includes("Sonnet 5.5")) fail(`the model chip says ${J(await phoneChip(page, "model").textContent())} after Sonnet 5.5 was picked`);
    await ctx.close();
  }
  if (keys) {
    const { page, ctx } = await fresh("plain-new");
    const calls = callsOf(page);
    await press(page, chip(page, "model").first());
    const search = byTid(page, "picker-search").first();
    if (!await until(() => search.count(), 5000)) fail("the model's list has no search field");
    else {
      if (await search.getAttribute("placeholder") !== "Search models") fail(`the search says "${await search.getAttribute("placeholder")}", not "Search models"`);
      await search.fill("zzz");
      if (!await until(async () => (await byTid(page, "picker").first().textContent()).includes("No matching models"), 5000)) fail('a search that matches nothing does not say "No matching models"');
      await search.fill("son");
      const rows = await until(async () => { const r = await byTid(page, "pick-row").allTextContents(); return r.length && r.every((x) => /son/i.test(x)) ? r : null; }, 5000);
      if (!rows) fail(`the search "son" lists ${J(await byTid(page, "pick-row").allTextContents())}`);
      const from = calls.length;
      await page.keyboard.press("Enter");
      if (!await until(() => calls.slice(from).some((c) => c.method === "PATCH" && /\/chats\/c_A2_new/.test(c.path) && c.body?.model), 10000)) fail("Enter in the search picked no model");
      if (!await until(() => byTid(page, "picker").count().then((n) => !n), 5000)) fail("the list stays open after a pick");
      // the effort follows the model: it keeps the effort the new model offers, else its default
      const at = await effortChipOf(page);
      const effort = at && await until(async () => (await at.textContent().catch(() => "")) || null, 5000);
      if (!effort) fail("after a model pick the toolbar has no effort chip: this model offers efforts");
    }
    await ctx.close();
  }

  // ---- the effort's list has no search field: the arrows, Enter and Esc act on it from the keyboard (C-CH-25); the arrows go around the ends (C-CH-12)
  if (phone) { // the model sheet's effort control: no search, the chosen segment alone is on, a press on another saves it and the sheet stays open
    const { page, ctx } = await fresh("plain-new");
    const calls = callsOf(page);
    const sheet = await openChoice(page, "model"), seg = byTid(sheet, "effort-seg");
    const state = () => byTid(seg, "segment").evaluateAll((els) => ({ ids: els.map((e) => e.dataset.value), on: els.map((e, i) => (e.dataset.on === "true" ? i : -1)).filter((i) => i >= 0) }));
    if (await byTid(seg, "picker-search").count() || await byTid(sheet, "picker-search").count()) fail("the effort control has a search field");
    const st = await state();
    if (st.ids.length < 3 || st.on.length !== 1) fail(`the effort control is ${J(st)}: it has three segments at least and the chosen one alone is on`);
    else for (const want of [st.ids[(st.on[0] + 1) % st.ids.length], st.ids[st.on[0]]]) { // (the next one, then back to the chosen one)
      const from = calls.length;
      await press(page, byTid(seg, "segment", { value: want }));
      const got = await until(() => calls.slice(from).filter((c) => c.method === "PATCH" && /\/chats\/c_A2_new/.test(c.path) && c.body?.effort).map((c) => c.body.effort)[0], 10000);
      if (got !== want) fail(`a press on the effort ${want} saved ${J(got)}`);
      else if (!await until(async () => J((await state()).on) === J([st.ids.indexOf(want)]), 5000)) fail(`after a press on ${want} the segments are ${J(await state())}: it alone is on`);
      if (!await byTid(page, "model-sheet").count()) fail("the model sheet closed with an effort pick: Done closes it");
    }
    await closeChoice(page);
    await ctx.close();
  }
  if (keys) {
    const { page, ctx } = await fresh("plain-new");
    const calls = callsOf(page);
    const picks = (from) => calls.slice(from).filter((c) => c.method === "PATCH" && /\/chats\/c_A2_new/.test(c.path) && c.body?.effort).map((c) => c.body.effort);
    const listGone = () => until(() => byTid(page, "pick-row").count().then((c) => !c), 5000);
    /** Opens the effort's list: the ids of its rows, the chosen one (which is ticked, alone), or null. */
    const open = async () => {
      const at = await effortChipOf(page);
      if (!at) return null;
      await press(page, at);
      if (!await until(() => byTid(page, "pick-row").count(), 5000)) { fail("the effort's chip opened no list"); return null; }
      if (await byTid(page, "picker-search").count()) fail("the effort's list has a search field");
      // (the list starts its highlight on the chosen row a moment after it opens, drawn as a ring: the keys are pressed once it is there)
      if (!await until(() => byTid(page, "pick-row").evaluateAll((els) => els.some((e) => getComputedStyle(e).boxShadow !== "none")), 5000)) fail("the effort's list highlights no row when it opens");
      const st = await byTid(page, "pick-row").evaluateAll((els) => ({ ids: els.map((e) => e.dataset.optionId), on: els.findIndex((e) => e.getAttribute("aria-selected") === "true"), ticks: els.map((e) => e.textContent.includes("✓")) }));
      if (st.ticks.filter(Boolean).length !== 1 || !st.ticks[st.on]) fail(`the effort's list ticks ${J(st.ticks)}: the chosen row alone, ${st.on}`);
      return st;
    };
    /** An arrow and Enter in the list: the pick is the row after (or before) the chosen one, around the ends. */
    const stepBy = async (arrow) => {
      const now = await open();
      if (!now || now.on < 0 || now.ids.length < 3) { fail(`the effort's list is ${J(now)}: it has no chosen row, or fewer than three rows to move over`); return false; }
      const want = now.ids[(now.on + (arrow === "ArrowDown" ? 1 : -1) + now.ids.length) % now.ids.length], from = calls.length;
      await page.keyboard.press(arrow);
      await page.keyboard.press("Enter");
      const got = await until(() => picks(from)[0], 10000);
      if (!got) fail(`${arrow}, Enter in the effort's list picked nothing (the list is ${J(now.ids)}, ${now.ids[now.on]} chosen)`);
      else if (got !== want) fail(`${arrow}, Enter in the effort's list picked ${got}, not ${want}, the row ${arrow === "ArrowDown" ? "after" : "before"} ${now.ids[now.on]} in ${J(now.ids)}`);
      if (!await listGone()) fail("the effort's list stays open after a pick by Enter");
      return !!got;
    };
    // (the list opens on the chosen row: down, down from the last row to the first, up from the first to the last, up)
    if (await stepBy("ArrowDown") && await stepBy("ArrowDown") && await stepBy("ArrowUp") && await stepBy("ArrowUp")) {
      // Esc closes the list and picks nothing
      if (await open()) {
        const from = calls.length;
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Escape");
        if (!await listGone()) fail("Esc did not close the effort's list");
        await page.waitForTimeout(400);
        if (picks(from).length) fail(`Esc in the effort's list picked ${J(picks(from))}`);
      }
    }
    await ctx.close();
  }

  // ---- the folder browser: one listing is asked for per Enter, and the listing asked for last is the one shown (an answer that comes late is not)
  {
    const { page, ctx } = await fresh("plain-remote-new");
    const calls = callsOf(page);
    const slow = new Map(); // the listings the page asks for -> how long the mock holds its answer
    // (only the listings pass through the route)
    await page.route((u) => u.pathname === "/host/call" && /^\/api\/dirs/.test(u.searchParams.get("path") ?? ""), async (route) => {
      const ms = slow.get(decodeURIComponent((new URL(route.request().url()).searchParams.get("path") ?? "").replace(/^\/api\/dirs\?path=/, "")));
      if (ms) await new Promise((ok) => setTimeout(ok, ms));
      await route.continue().catch(() => {});
    });
    const listings = (from) => calls.slice(from).filter((c) => c.method === "GET" && /^\/api\/dirs/.test(c.path));
    const c = phone ? phoneChip(page, "folder") : chip(page, "folder").first();
    if (!phone && !await c.count()) await press(page, byTid(page, "more-chip").first());
    if (!await until(() => c.count(), 5000)) fail("the toolbar has no folder chip, in its row or in the popup of the more chip");
    else {
      await press(page, c);
      // (at the phone the sheet shows the path as a button: a tap on it types one, and Enter lists the typed path and shows the button again)
      const input = byTid(page, phone ? "folder-sheet" : "dirs").first().locator(tidSel("dir-input")).first(), use = byTid(page, "dir-use").first();
      const typing = async () => { if (phone && !await input.count()) await press(page, byTid(page, "dir-path").first()); return until(() => input.count(), 5000); };
      if (!await until(() => (phone ? byTid(page, "dir-path") : input).count(), 5000)) fail("a press on the folder's chip opened no browser");
      else if (!await typing()) fail("a press on the folder's path typed no path");
      else {
        const shows = async (name) => await until(async () => (await use.textContent().catch(() => "")) === `Use ${name}`, 5000);
        const type = async (path) => { await typing(); await input.fill(path); await input.press("Enter"); };
        /** What the field holds: the field itself, or at the phone (it shows the button once a path is listed) the button's path. */
        const held = async () => (await input.count()) ? input.inputValue() : (await pathText(page)).trim();
        await shows("shop"); // (the chat's own folder, listed when the browser opens)
        let from = calls.length;
        await type("~/projects");
        if (!await shows("projects")) fail(`Enter in the folder's field did not list the folder: the button says "${await use.textContent()}"`);
        await page.waitForTimeout(500);
        if (listings(from).length !== 1) fail(`one Enter in the folder's field asked for ${listings(from).length} listings: ${J(listings(from).map((x) => x.path))}`);
        // a listing whose answer is late is not shown after the answer of a later one
        slow.set("~/projects/shop", 2500);
        await type("~/projects/shop");
        await type("~/projects/scratch");
        if (!await shows("scratch")) fail(`the listing asked for last is not shown: the button says "${await use.textContent()}"`);
        await page.waitForTimeout(3500); // (the late answer has come)
        if (await use.textContent() !== "Use scratch") fail(`an answer that came late replaced the listing asked for last: the button says "${await use.textContent()}"`);
        if (!(await held()).endsWith(phone ? "scratch" : "/projects/scratch")) fail(`an answer that came late replaced what the field holds: "${await held()}"`);
        // a listing's answer does not take what is being typed from the field
        slow.set("~/projects/shop", 1500);
        await type("~/projects/shop");
        await typing();
        await input.fill("~/projects/sh");
        await shows("shop");
        await page.waitForTimeout(500);
        if (await input.inputValue() !== "~/projects/sh") fail(`the answer of a listing replaced what was typed after it was asked for: the field holds "${await input.inputValue()}"`);
      }
    }
    await ctx.close();
  }

  // ---- the folder browser's contents: its head (by server), where it starts, the parent and the sub-folders, "No subfolders", a refusal, the recent
  // folders, and this computer's list kept on the device (C-CH-09, C-CH-11)
  {
    const { page, ctx } = await fresh("plain-new");
    const calls = callsOf(page);
    const folder = phone ? phoneChip(page, "folder") : chip(page, "folder").first();
    // (the phone's folder sheet: no ".." row (the Up button before the path), the path is a button that a tap turns into the field, and no Recent list: it opens in the chat's folder)
    const sheet = () => byTid(page, "folder-sheet").first();
    const opens = async () => {
      await atRest(page, 12); // (the toolbar fits its chips to the width: the folder's is in the row or in the "more" popup once it has)
      if (phone) { await press(page, folder); return !!await until(() => byTid(page, "dir-path").count(), 5000); }
      if (!await folder.isVisible()) await press(page, byTid(page, "more-chip").first());
      await press(page, folder);
      return !!await until(() => byTid(page, "dir-input").count(), 5000);
    };
    const head = () => phone ? byTid(sheet(), "sheet-title").first().textContent() : byTid(page, "dirs").first().locator(tidSel("menu-head")).first().textContent();
    const use = () => byTid(page, "dir-use").first().textContent();
    const names = async () => phone ? byTid(page, "dir-item").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label"))) : (await byTid(page, "dir-item").allTextContents()).map((x) => x.trim().replace(/^↰/, ""));
    const browser = async () => phone ? (await pathText(page)) + " " + (await byTid(page, "dir-browser").first().textContent()) : byTid(page, "dir-browser").first().textContent(); // (the path button holds the folder shown; the list holds the rest)
    const up = ".."; // (the wide list's first row, at the phone the Up button before the path)
    const into = async (label) => { await press(page, label === up && phone ? byTid(page, "dir-up").first() : byTid(page, "dir-item").and(page.locator(`[aria-label=${J(label)}]`)).first()); };
    const closePopup = async () => { if (!phone && await byTid(page, "more-pop").count()) { await page.keyboard.press("Escape"); await until(async () => !await byTid(page, "more-pop").count(), 5000); } };
    const dismiss = async () => { if (phone) await closeChoice(page); else await page.keyboard.press("Escape"); };
    /** Types a path into the browser and lists it: the field is there already at the wide layouts, the phone's path button turns into it with a tap. */
    const typePath = async (path) => {
      if (phone && !await byTid(page, "dir-input").count()) await press(page, byTid(page, "dir-path").first());
      const input = byTid(page, "dir-input").first();
      await input.fill(path); await input.press("Enter");
    };
    if (!await opens()) fail("a press on the folder's chip opened no browser");
    else {
      if (await head() !== "Start the agent in") fail(`the browser of this computer's folders is headed ${J(await head())}, not "Start the agent in"`);
      if (!await until(async () => (await use()) === "Use shop", 5000)) fail(`the browser starts at ${J(await use())}, not at the chat's own folder`);
      const subs = ["docs", "web", "storefront-monorepo-with-a-very-long-folder-name"];
      if (J(await names()) !== J(phone ? subs : ["..", ...subs])) fail(`the chat's folder lists ${J(await names())}, not ${phone ? "its sub-folders (the phone has no \"..\" row: Up is the button before the path)" : '"..", then its sub-folders'}`);
      if (!(await browser()).includes("~/projects/shop")) fail(`the browser does not name the folder it shows with "~": ${J(await browser())}`);
      if ((await browser()).includes("Recent")) fail("the browser lists recent folders though none was used");
      if (phone && await byTid(page, "dir-up").first().getAttribute("aria-label") !== "Up to projects") fail(`the Up button says ${J(await byTid(page, "dir-up").first().getAttribute("aria-label"))}, not "Up to projects"`);
      await into(up);
      if (!await until(async () => (await use()) === "Use projects" && J(await names()) === J(phone ? ["empty-repo", "scratch", "shop"] : ["..", "empty-repo", "scratch", "shop"]), 5000)) fail(`".." did not list the parent: ${J(await use())}, ${J(await names())}`);
      await into("empty-repo");
      if (!await until(async () => (await use()) === "Use empty-repo", 5000) || !(await browser()).includes("No subfolders") || J(await names()) !== J(phone ? [] : [".."])) fail(`a folder with no sub-folder shows ${J(await names())} and ${(await browser()).includes("No subfolders") ? "" : "not "}"No subfolders"`);
      if (phone && !await byTid(page, "dir-empty").count()) fail("an empty folder has no dir-empty text at the phone");
      // a path that is not a folder is refused in the browser, and the folder shown stays
      await typePath("~/nowhere");
      if (!await until(() => byTid(page, "dir-err").count(), 5000)) fail("a path that is no folder said nothing in the browser");
      else if (!(await byTid(page, "dir-err").first().textContent()).includes("is not a directory")) fail(`the refusal in the browser says ${J(await byTid(page, "dir-err").first().textContent())}`);
      if (await use() !== "Use empty-repo") fail(`a refused path changed the folder shown: ${J(await use())}`);
      // a folder is used: the chat gets it (PATCH), and the browser lists it among the recent ones the next time
      await typePath("~/notes");
      if (!await until(async () => (await use()) === "Use notes", 5000)) fail(`a "~" path was not listed: ${J(await use())}`);
      const from = calls.length;
      await press(page, byTid(page, "dir-use").first());
      if (!await until(() => calls.slice(from).some((c) => c.method === "PATCH" && /\/chats\/c_A2_new/.test(c.path) && c.body?.cwd === "/Users/demo/notes"), 10000)) fail("Use notes made no PATCH with the folder");
      await until(async () => !await byTid(page, phone ? "folder-sheet" : "dirs").count(), 5000); // (the pick closes the browser; at the phone the sheet)
      await closePopup();
      if (!await opens()) fail("the browser did not open again");
      else {
        await into(up);
        if (!await until(async () => (await use()) === "Use Demo" || (await use()) === "Use demo", 5000)) fail(`".." from "notes" lists ${J(await use())}`);
        const b = await browser();
        if (phone) { if (b.includes("Recent") || (await names()).some((x) => x.startsWith("~"))) fail(`the phone's folder sheet lists recent folders: ${J(await names())} (none, goal 3.6: it opens in the chat's folder)`); }
        else if (!b.includes("Recent") || !(await names()).includes("~/notes")) fail(`the browser does not list the folder used as a recent one: ${J(await names())}`);
        await dismiss();
      }
      await closePopup();
      const kept = await page.evaluate(() => localStorage.getItem("aiwb.dirs"));
      if (kept !== J(["/Users/demo/notes"])) fail(`this computer's recent folders in the app's storage are ${J(kept)}, not ["/Users/demo/notes"]`);
      await page.reload();
      await box(page).waitFor({ state: "visible", timeout: 30000 }); // (the phone empty box shows Talk, not Send)
      if (!await opens()) fail("after a reload the folder's chip opened no browser");
      else {
        await into(up);
        if (phone) { // (the list is kept on the device (above) but the phone's sheet shows none)
          await page.waitForTimeout(500);
          if ((await names()).some((x) => x.startsWith("~")) || (await browser()).includes("Recent")) fail(`after a reload the phone's folder sheet lists recent folders: ${J(await names())}`);
        } else if (!await until(async () => (await names()).includes("~/notes"), 5000)) fail(`after a reload the recent folders are ${J((await names()))}: this computer's list is not kept on the device`);
        await dismiss();
      }
    }
    await ctx.close();
  }
  { // another server's browser: headed by the server, and nothing of it kept on this device
    const { page, ctx } = await fresh("plain-remote-new");
    const folder = phone ? phoneChip(page, "folder") : chip(page, "folder").first();
    await atRest(page, 12);
    if (!phone && !await folder.isVisible()) await press(page, byTid(page, "more-chip").first());
    await press(page, folder);
    // (the phone: the sheet's sub-line names the server (its title is "Start the agent in"), the path is a button, and no Recent list is drawn)
    const field = phone ? "dir-path" : "dir-input";
    if (!await until(() => byTid(page, field).count(), 5000)) fail("a press on the folder's chip of a chat of a section opened no browser");
    else {
      const head = phone ? await byTid(page, "folder-sheet").first().locator(tidSel("sheet-sub")).first().textContent() : await byTid(page, "dirs").first().locator(tidSel("menu-head")).first().textContent();
      if (head !== (phone ? "lab-gpu-box.tailnet-1234.ts.net" : "Folder on lab-gpu-box.tailnet-1234.ts.net")) fail(`the browser of a section's folders is headed ${J(head)}, not ${phone ? "the server's name" : '"Folder on <server>"'}`);
      if (!await until(async () => (await byTid(page, "dir-use").first().textContent()) === "Use shop", 5000)) fail(`the section's browser starts at ${J(await byTid(page, "dir-use").first().textContent())}`);
      if (!((phone ? await pathText(page) : await byTid(page, "dir-browser").first().textContent()) ?? "").includes("~/projects/shop")) fail("the section's browser does not shorten the folder with that server's home");
      // a folder used there is listed as a recent one for as long as the app runs (the phone's sheet lists none), and nothing of it is kept on this device
      if (phone) await press(page, byTid(page, "dir-path").first());
      const input = byTid(page, "dir-input").first();
      await input.fill("/home/dev/projects"); await input.press("Enter"); // (the mock expands "~" with this computer's home alone)
      if (!await until(async () => (await byTid(page, "dir-use").first().textContent()) === "Use projects", 5000)) fail(`a path of the section's server was not listed: ${J(await byTid(page, "dir-use").first().textContent())}`);
      await press(page, byTid(page, "dir-use").first());
      await until(async () => !await byTid(page, phone ? "folder-sheet" : "dirs").count(), 5000);
      if (await byTid(page, "more-pop").count()) { await page.keyboard.press("Escape"); await until(async () => !await byTid(page, "more-pop").count(), 5000); }
      await atRest(page, 12);
      if (!phone && !await folder.isVisible()) await press(page, byTid(page, "more-chip").first());
      await press(page, folder);
      await byTid(page, field).first().waitFor({ state: "visible", timeout: 5000 });
      if (phone) { // the sheet opens in the chat's folder, "projects"; no recent folder is listed under it
        await until(async () => (await byTid(page, "dir-use").first().textContent()) === "Use projects", 5000);
        await press(page, byTid(page, "dir-item").and(page.locator('[aria-label="shop"]')).first());
        await until(async () => (await byTid(page, "dir-use").first().textContent()) === "Use shop", 5000);
        const listed = await byTid(page, "dir-item").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
        if (listed.some((x) => x.startsWith("~")) || (await byTid(page, "folder-sheet").first().textContent()).includes("Recent")) fail(`the phone's folder sheet lists recent folders after one was used: ${J(listed)}`);
      } else {
      await press(page, byTid(page, "dir-item").and(page.locator('[aria-label="shop"]')).first());
      if (!await until(async () => (await byTid(page, "dir-item").allTextContents()).some((x) => x.trim() === "~/projects"), 5000)) fail(`the section's browser lists no recent folder after one was used: ${J(await byTid(page, "dir-item").allTextContents())}`);
      }
      const stored = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith("aiwb.dirs")).map((k) => [k, localStorage.getItem(k)])));
      if (J(stored).includes("/home/dev")) fail(`the folders of the section's server are in this device's storage: ${J(stored)}`);
      if (phone) await closeChoice(page); else await page.keyboard.press("Escape");
    }
    await ctx.close();
  }

  { // a chat whose folder is gone: the browser starts at the server's default folder, with nothing said of the folder that cannot be read
    const { page, ctx } = await fresh("plain-new");
    await mockEval(`chats.c_A2_new.cwd = "/gone/dir"; send({ type: "chat", chat: chats.c_A2_new });`, url);
    const folder = phone ? phoneChip(page, "folder") : chip(page, "folder").first();
    await mockEval(`chats.c_A2_new.folderMissing = true; send({ type: "chat", chat: chats.c_A2_new });`, url);
    await until(async () => (await folder.textContent().catch(() => "")).includes("dir"), 5000); // (the chip names the folder that is gone)
    await atRest(page, 12);
    if (!phone && !await folder.isVisible()) await press(page, byTid(page, "more-chip").first());
    await press(page, folder);
    if (!await until(() => byTid(page, phone ? "dir-path" : "dir-input").count(), 5000)) fail("a press on the folder's chip of a chat whose folder is gone opened no browser");
    else {
      // (the chip is in the row or in the "more" popup: it is read where it is; the phone has no hover title: its chip is red (data-missing) and says "Folder: dir")
      if (phone) {
        if (await folder.getAttribute("data-missing") !== "true" || await folder.getAttribute("aria-label") !== "Folder: dir") fail(`the folder chip of a chat whose folder is gone is data-missing=${J(await folder.getAttribute("data-missing"))}, aria-label ${J(await folder.getAttribute("aria-label"))}, not missing and "Folder: dir"`);
      } else if (!(await folder.getAttribute("title").catch(() => "") ?? "").startsWith("Folder not found: /gone/dir")) fail(`the folder chip of a chat whose folder is gone says ${J(await folder.getAttribute("title").catch(() => null))}, not "Folder not found: /gone/dir"`);
      if (!await until(async () => (await byTid(page, "dir-use").first().textContent().catch(() => "")) === "Use shop", 5000)) fail(`the browser of a chat whose folder is gone starts at ${J(await byTid(page, "dir-use").first().textContent().catch(() => ""))}, not at the server's default folder`);
      await page.waitForTimeout(300);
      if (await byTid(page, "dir-err").count()) fail(`the browser of a chat whose folder is gone says ${J(await byTid(page, "dir-err").first().textContent())} though it listed the default folder`);
    }
    await ctx.close();
  }

  // ---- the bars: an archived chat has no box, a chat of the old board connection no composer
  {
    const { page, ctx } = await fresh("plain-started");
    const calls = callsOf(page);
    await mockEval(`chats.c_plain.archived = true; send({ type: "chat", chat: chats.c_plain });`, url);
    if (!await until(() => byTid(page, "archived-bar").count(), 10000)) fail("an archived chat has no bar");
    else {
      if (await box(page).count()) fail("an archived chat draws a box");
      // (the phone's block, V1: the title, what to do and a full-width Unarchive, in the box's place)
      const barWant = phone ? "This chat is archived." : "Archived — unarchive to continue";
      if (!(await byTid(page, "archived-bar").first().textContent()).startsWith(barWant) || (phone && !(await byTid(page, "archived-bar").first().textContent()).includes("Unarchive it to send a message."))) fail(`the bar says "${await byTid(page, "archived-bar").first().textContent()}"`);
      // an Unarchive the server refuses: its sentence stands under the bar, the bar stays (C-RO-07)
      const refuse = callMatcher(/^POST \/api\/chats\/c_plain\/unarchive/);
      await page.route(refuse, (route) => route.fulfill({ status: 409, contentType: "application/json", body: J({ error: "Cannot unarchive: its board is archived", code: "board_archived" }) }));
      await press(page, byTid(page, "unarchive").first());
      if (!await until(async () => (await byTid(page, "composer-err").first().textContent().catch(() => "")).includes("Cannot unarchive: its board is archived"), 10000)) fail(`a refused Unarchive said nothing under the bar: "${await byTid(page, "composer-err").first().textContent().catch(() => "")}"`);
      if (!await byTid(page, "archived-bar").count() || await box(page).count()) fail("a refused Unarchive took the bar away or drew a box");
      await page.unroute(refuse);
      const from = calls.length;
      await press(page, byTid(page, "unarchive").first());
      if (!await until(() => calls.slice(from).some((c) => c.method === "POST" && /\/chats\/c_plain\/unarchive/.test(c.path)), 10000)) fail("Unarchive made no call");
      if (!await until(async () => !await byTid(page, "archived-bar").count() && await box(page).count(), 10000)) fail("after Unarchive the bar stays or the box does not come back");
    }
    await ctx.close();
  }
  { // a chat of the old board connection: its bar, no composer, nothing to unarchive (C-RO-08)
    const { page, ctx } = await fresh("plain-started");
    await mockEval(`chats.c_plain.instructionsSent = true; send({ type: "chat", chat: chats.c_plain });`, url);
    const bar = byTid(page, "archived-bar", { legacy: true });
    if (!await until(() => bar.count(), 10000)) fail("a chat of the old board connection has no bar");
    else {
      const said = (await bar.first().textContent()).trim();
      // (the phone's block: the title and, under it, what to do — no button on a chat that is not a board's)
      if (phone ? said !== "This chat used the old board connection.Start a new chat on this board to go on." : said !== "This chat used the old board connection — start a new chat to continue") fail(`the bar of a chat of the old board connection says ${J(said)}`);
      if (await box(page).count() || await send(page).count() || await byTid(page, "composer-tools").count()) fail("a chat of the old board connection draws a box, a Send or a toolbar");
      if (await byTid(page, "unarchive").count()) fail("a chat of the old board connection offers Unarchive");
    }
    await ctx.close();
  }

  // ---- the settings of a chat that has not started, changed from elsewhere, are the composer's: the folder and the model (web/test/sectionviews.test.ts "what another
  // client or the owner does in a section's chat shows in the open view", its last part; the events are the same for a chat of a section)
  {
    const { page, ctx } = await fresh("plain-new");
    // (the phone's chips are in its own row, `composer-chip-row`, which placesOf does not look into: read the chip itself)
    const label = async (kind) => phone ? (await chip(page, kind).first().textContent({ timeout: 2000 }).catch(() => null))?.replace(/▾/g, "").trim() ?? null : (await placesOf(page))?.chips.find((c) => c.kind === kind)?.label ?? null;
    if (!phone && await label("folder") === null) await press(page, byTid(page, "more-chip").first()); // (a narrow toolbar keeps the folder in the "more" popup)
    const folderWas = await label("folder");
    await mockEval(`Object.assign(chats.c_A2_new, { cwd: "/srv/other-place" }); send({ type: "chat", chat: chats.c_A2_new });`, url);
    if (!await until(async () => ((await label("folder")) ?? "").includes("other-place"), 10000)) fail(`the folder chip of a chat that has not started says "${await label("folder")}" after its folder was changed from elsewhere, not "other-place" (it said "${folderWas}")`);
    await ctx.close();
  }

  // ---- the note beside the context row goes by itself after 2.5 s
  if (keys) {
    const { page, ctx } = await fresh("board-new");
    await press(page, box(page));
    await page.keyboard.press("ControlOrMeta+l");
    if (!await until(() => byTid(page, "ctx-note").count(), 5000)) fail("⌘L with nothing selected said nothing");
    else if (!await until(async () => !await byTid(page, "ctx-note").count(), 8000)) fail("the note did not go by itself");
    await ctx.close();
  }
  void frame; void placesOf;
  note("the box: placeholder, Enter and Shift+Enter, trim, Send's state; a refused Send; a busy chat; growth; the focus; the @ list; the model's search; the bars; the note");
}, { viewports, page: false });
