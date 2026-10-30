// L16 (new; package K3): the composer's behaviours that no old check proved (the inventory's `none` rows of area C and the rows only a test of
// the whole box reaches), on the real composer of the new build at the three viewports.
//   C-TX-01  the box's placeholder: "Ask Claude Code…" in a plain chat, "Ask or tell…" in a board chat; it goes with the first text
//   C-TX-03/04  Enter and Shift+Enter are line breaks (the box's text has "\n" for each) and send nothing; ⌘Enter / Ctrl+Enter send (ControlOrMeta+Enter),
//            at every viewport; each new line keeps the indent of the line before (the box's code-editor editing, ED1); the message that
//            goes is the text as typed; a draft of quotes alone (no text) goes by the key too
//   C-TX-05/06/07  Send is off with a blank box (white space too), on with text; the text sent loses its leading blank lines and its trailing white
//                  space, not the first line's indent (deviation: the old page trimmed it; code-editor editing keeps indents); at Send the box is empty and the draft with it
//   C-TX-08  a Send that is refused puts its text back into the empty box and says why under the composer (C-RO-09); `cap` does not read the chat again (C-CH-06)
//   C-TX-10/15/16  a busy chat: Send off and says "The agent is working", ⌘/Ctrl+Enter sends nothing and typing goes on; Stop stops it, and so does Esc
//   C-TX-19  the box has room for three lines at least (the phone: one line, growing to six), grows with its text and then scrolls inside
//   C-TX-20, C-NC-12  the box has the focus a moment after a chat is opened and after a new chat is made (the desktop's: a keyboard)
//   C-MN-06  a board chat's context row has its own board's chip, with its tooltip; an "@name" typed is text and adds nothing to the row
//   C-CH-12/14  the model and effort menu searches ("Search models"), ↑ ↓ and Tab / Shift+Tab draft, Enter applies, Esc applies nothing; the effort
//            follows the model (the menu of plans/model-effort-menu/design.md: the popover at the wide layouts, the sheet at the phone)
//   C-RO-07/08  an archived chat draws no box but its bar ("Archived — unarchive to continue", Unarchive), and a chat of the old board connection its own bar
//   C-RO-14  the note beside the context row goes by itself after 2.5 s
//   (sweep, rn-sw-webtest) the folder of a chat that has not started, changed from elsewhere, is the composer's at once (web/test/sectionviews.test.ts)
// Keys are the desktop's (a hardware keyboard on a tablet has them too: the tablet runs them, the phone the parts a finger does).
// At the phone (ux-improvements C1) the composer is the phone's: the empty box shows Talk (`composer-talk`) and no Send, Send comes with text, Stop
// while the agent works (Send beside it once something is typed); the controls have no `title`, so their
// words are read from `aria-label`; the context row's chips are `ctx-chip` with `data-kind` (board: "Open the board <name>").
import { atRest, callMatcher, callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { MENU as MENU_SEL, chip, closeChoice, frame, menuOf, openAt, openChoice, openModelMenu, openState, phoneChip, placesOf } from "./composer.mjs";
import { byTid, openChat, press, tidSel } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const J = JSON.stringify;
const POST = /\/chats\/(\w+)\/messages(\?|$)/;

await check("L16 the composer: Enter, trim, refusals, growth, focus, the context row, the model's search, the bars", async ({ url, viewport, layout, open, fail, note }) => {
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
  const posts = (calls, from = 0) => calls.slice(from).filter((c) => c.method === "POST" && POST.test(c.path));
  /** The phone's folder path as the user reads it: its text without the embedding marks that keep its characters in order. */
  const pathText = async (page) => ((await byTid(page, "dir-path").first().textContent()) ?? "").replace(/[\u202A-\u202E]/g, "");
  const type = async (page, s) => { await press(page, box(page)); await page.keyboard.type(s); };

  // ---- the box: placeholder, Enter, Shift+Enter, ⌘/Ctrl+Enter, trim, Send's state, the draft
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
      await page.keyboard.type("second line");
      if (!/first line\s*\n\s*second line/.test(await text(page))) fail(`Shift+Enter made no line break: ${J(await text(page))}`);
    }
    await page.keyboard.press("Enter");
    await page.keyboard.type(keys ? "third line  " : "second line  ");
    await page.waitForTimeout(300);
    if (posts(calls).length) fail(`${keys ? "Shift+Enter or " : ""}Enter sent the message: both are line breaks`);
    const want = keys ? "  first line\n  second line\n  third line" : "  first line\n  second line"; // (each new line keeps the indent of the first: ED1; the first line's indent is sent)
    if (!/line\s*\n\s*(second|third) line\s*$/.test(await text(page))) fail(`Enter made no line break: ${J(await text(page))}`);
    const from = calls.length;
    if (keys) await page.keyboard.press("ControlOrMeta+Enter"); else await press(page, send(page)); // (the phone: the button; the key below)
    const sent = await until(() => posts(calls, from)[0], 10000);
    if (!sent) fail(keys ? "⌘/Ctrl+Enter did not send the message" : "a press on Send did not send the message");
    else if (sent.body?.text !== want) fail(`the message sent is ${J(sent.body?.text)}, not ${J(want)} (the end trimmed, the first line's indent kept, a line break as "\n")`);
    if (!await until(async () => (await text(page)) === "", 5000)) fail(`after Send the box holds ${J(await text(page))}`);
    if (!await until(() => sendOff(page), 5000)) fail(phone ? "after Send, with the box empty, the primary is not Talk" : "after Send, with the box empty, Send is on");
    await ctx.close();
  }
  if (phone) { // ⌘/Ctrl+Enter sends at the phone too (a keyboard on it); the box is empty after it
    const { page, ctx } = await fresh("plain-new");
    const calls = callsOf(page);
    await type(page, "by the keys");
    const from = calls.length;
    await page.keyboard.press("ControlOrMeta+Enter");
    const sent = await until(() => posts(calls, from)[0], 10000);
    if (!sent) fail("Ctrl+Enter did not send the message at the phone");
    else if (sent.body?.text !== "by the keys") fail(`Ctrl+Enter sent ${J(sent.body?.text)}, not "by the keys"`);
    if (!await until(async () => (await text(page)) === "", 5000)) fail(`after Ctrl+Enter the box holds ${J(await text(page))}`);
    await ctx.close();
  }
  { // a draft of quotes alone (no text): ⌘/Ctrl+Enter sends it, at every viewport
    const { page, ctx } = await fresh("plain-quotes");
    const calls = callsOf(page);
    const refs = (await mockEval(`return chats.c_A2_quotes.draft?.references ?? [];`, url)).length;
    if (!refs) fail("the state plain-quotes has no quotes in its draft");
    await press(page, box(page));
    if ((await text(page)).trim()) fail(`the box of a draft of quotes alone holds ${J(await text(page))}`);
    const from = calls.length;
    await page.keyboard.press("ControlOrMeta+Enter");
    const sent = await until(() => posts(calls, from)[0], 10000);
    if (!sent) fail("⌘/Ctrl+Enter did not send a message of quotes alone");
    else if (sent.body?.text !== "" || sent.body?.references?.length !== refs) fail(`the message of quotes alone went out as ${J(sent.body).slice(0, 300)}, not with no text and its ${refs} quotes`);
    await ctx.close();
  }
  { // a board chat's placeholder
    const { page, ctx } = await fresh("board-new");
    const t = await box(page).getAttribute("data-placeholder");
    if (t !== "Ask or tell…") fail(`a board chat's box says "${t}"`);
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
      // (the model and effort menu, the wide layouts' popover and the phone's sheet: a row without data-on, or the effort control's other segment,
      // drafts it, and Done applies it)
      const menu = phone ? await openChoice(page, "model") : await openModelMenu(page);
      const other = kind === "model" ? byTid(menu, "model-menu-row", { on: "false" }).first() : byTid(byTid(menu, "effort-seg"), "segment", { on: "false" }).first();
      if (!await until(() => other.count(), 5000)) { fail(`the menu has no other ${kind === "model" ? "row" : "segment"} to pick`); if (phone) await closeChoice(page); else await page.keyboard.press("Escape"); return false; }
      const from = calls.length;
      await press(page, other);
      await press(page, byTid(menu, "model-menu-done"));
      const saved = await until(() => calls.slice(from).some((c) => c.method === "PATCH" && /\/chats\/c_A2_new/.test(c.path) && (c.body?.[kind])), 10000);
      if (!saved) fail(`a pick of the ${kind} made no PATCH`);
      if (phone) await closeChoice(page);
      if (await byTid(page, "more-pop").count()) { await page.keyboard.press("Escape"); await until(async () => !await byTid(page, "more-pop").count(), 5000); } // (the popup that held the chip stays open under a pick)
      return saved;
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

  // ---- a busy chat: Send is off with its reason, ⌘/Ctrl+Enter sends nothing and typing goes on; Stop and Esc stop it
  {
    const { page, ctx } = await fresh("plain-busy");
    const calls = callsOf(page);
    if (phone && (!await byTid(page, "stop").count() || await byTid(page, "send").count())) fail("at the phone a busy chat with an empty box shows Stop alone (no Send, no Talk)");
    if (phone && await talk(page).count()) fail("at the phone a busy chat shows Talk: the primary is Stop");
    await type(page, "while it works");
    if ((await text(page)) !== "while it works") fail(`typing in a busy chat gave ${J(await text(page))}`);
    if (!await send(page).isDisabled() || await says(send(page)) !== "The agent is working") fail(`Send of a busy chat is ${await send(page).isDisabled() ? "off" : "on"} and says "${await says(send(page))}"`);
    if (keys) { await page.keyboard.press("ControlOrMeta+Enter"); await page.waitForTimeout(300); if (posts(calls).length) fail("⌘/Ctrl+Enter sent a message to a busy chat"); }
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
    if (keys) { await page.keyboard.press("ControlOrMeta+Enter"); await page.waitForTimeout(300); }
    if (posts(calls).length) fail(`${id}: ⌘/Ctrl+Enter sent a message to a chat with no agent`);
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

  // ---- a board chat's context row: its own board's chip; "@" is text like any other and nothing else is named
  {
    const { page, ctx } = await fresh("board-new");
    // the chat's own board is a chip of the context row, with its tooltip (C-MN-06); at the phone its words are "Open the board <name>"
    const own = phone ? byTid(page, "ctx-chip", { kind: "board" }).first() : byTid(page, "ctx-chip").first();
    const ownSays = phone ? "Open the board " : "Every message names this board to the agent";
    if (!await until(async () => (await own.getAttribute("aria-label").catch(() => "") ?? "").startsWith(ownSays), 5000)) fail(`the chip of the chat's own board says ${J(await own.getAttribute("aria-label").catch(() => null))}, not "${ownSays} …"`);
    const chips = await byTid(page, "ctx-chip").count();
    await type(page, "see @sketch ");
    if (!await until(async () => (await text(page)) === "see @sketch ", 5000)) fail(`the box holds ${J(await text(page))}, not the text as typed`);
    await page.waitForTimeout(300);
    if (await byTid(page, "ctx-chip").count() !== chips) fail(`an "@name" typed in a board chat changed the context row: ${J(await byTid(page, "ctx-chip").allTextContents())}`);
    await ctx.close();
  }

  // ---- the model and effort menu (plans/model-effort-menu/design.md): it searches, ↑ ↓ draft a model and Tab / Shift+Tab an effort, Enter or Done
  // applies the draft in one write, Esc applies nothing; the effort follows the drafted model. (ME.1 holds ⌘E and the keys' wrap-around at the desktop.)
  const patches = (calls, from, field) => calls.slice(from).filter((c) => c.method === "PATCH" && /\/chats\/c_A2_new/.test(c.path) && c.body?.[field] !== undefined).map((c) => c.body[field]);
  if (phone) { // the model sheet: the search, the rows of the catalog, the drafted model alone on; a row drafts and Done applies
    const { page, ctx } = await fresh("plain-new");
    const calls = callsOf(page);
    const sheet = await openChoice(page, "model");
    if (!await byTid(sheet, "model-menu-search").count()) fail("the model sheet has no search field (it is always shown)");
    const rows = await byTid(sheet, "model-menu-row").evaluateAll((els) => els.map((e) => e.dataset.model));
    if (J(rows) !== J(["opus", "sonnet", "haiku", "long"])) fail(`the model sheet lists ${J(rows)}, not the catalog's ["opus","sonnet","haiku","long"]`);
    if (await byTid(sheet, "model-menu-row", { on: "true" }).count() !== 1) fail("the model sheet does not mark the chosen model alone");
    const from = calls.length;
    await press(page, byTid(sheet, "model-menu-row", { model: "sonnet" }));
    if (!await until(() => byTid(sheet, "model-menu-row", { model: "sonnet", on: "true" }).count(), 5000)) fail("a press on a model's row did not draft it");
    await page.waitForTimeout(300);
    if (patches(calls, from, "model").length) fail("a press on a model's row wrote at once: it is a draft until Done");
    // the effort follows the model: it keeps the effort the new model offers, else its default
    const on = await until(async () => (await byTid(byTid(sheet, "effort-seg"), "segment", { on: "true" }).evaluateAll((els) => els.map((e) => e.dataset.value)))[0] ?? null, 5000);
    if (!on) fail("after a model was drafted the effort control has no segment on: this model offers efforts");
    await closeChoice(page); // (Done)
    if (!await until(() => patches(calls, from, "model").includes("sonnet"), 10000)) fail("Done made no PATCH with the drafted model");
    if (!await until(async () => ((await phoneChip(page, "model").textContent()) ?? "").includes("Sonnet 5.5"), 5000)) fail(`the model chip says ${J(await phoneChip(page, "model").textContent())} after Sonnet 5.5 was applied`);
    await ctx.close();
  }
  if (keys) {
    const { page, ctx } = await fresh("plain-new");
    const calls = callsOf(page);
    await openModelMenu(page);
    const search = byTid(page, "model-menu-search").first();
    if (!await until(async () => (await menuOf(page))?.focused, 5000)) fail("the menu opened by a click on the chip has no focus in its search field");
    if (await search.getAttribute("placeholder") !== "Search models") fail(`the search says "${await search.getAttribute("placeholder")}", not "Search models"`);
    await search.fill("zzz");
    if (!await until(async () => (await menuOf(page))?.empty, 5000)) fail('a search that matches nothing does not say "No matching models"');
    else {
      if ((await menuOf(page)).done) fail("Done is enabled while the search lists no model");
      const from = calls.length;
      await page.keyboard.press("Enter");
      await page.waitForTimeout(300);
      if (patches(calls, from, "model").length || !await page.locator(MENU_SEL).count()) fail("Enter with no model listed applied something or closed the menu");
    }
    await search.fill("son");
    const rows = await until(async () => { const r = await byTid(page, "model-menu-row").allTextContents(); return r.length && r.every((x) => /son/i.test(x)) ? r : null; }, 5000);
    if (!rows) fail(`the search "son" lists ${J(await byTid(page, "model-menu-row").allTextContents())}`);
    const from = calls.length;
    await page.keyboard.press("Enter");
    if (!await until(() => patches(calls, from, "model")[0], 10000)) fail("Enter in the search applied no model");
    if (!await until(() => page.locator(MENU_SEL).count().then((n) => !n), 5000)) fail("the menu stays open after Enter");
    // the effort follows the model: it keeps the effort the new model offers, else its default; the chip says both
    const said = await until(async () => { const t = (await chip(page, "model").first().textContent().catch(() => "")) ?? ""; return /Sonnet 5\.5 · \S/.test(t) ? t : null; }, 5000);
    if (!said) fail(`after Sonnet 5.5 was applied the model chip says ${J(await chip(page, "model").first().textContent().catch(() => ""))}, not "Sonnet 5.5 · <effort>": this model offers efforts`);
    await ctx.close();
  }

  // ---- the effort: no list of its own; in the menu the segments (a press, at the phone) or Tab / Shift+Tab (the keys) draft it, around the ends;
  // Enter or Done applies it, Esc applies nothing (C-CH-12, C-CH-25)
  if (phone) { // the model sheet's effort control: the drafted segment alone is on, a press on another drafts it, Done applies it
    const { page, ctx } = await fresh("plain-new");
    const calls = callsOf(page);
    const sheet = await openChoice(page, "model"), seg = byTid(sheet, "effort-seg");
    const state = () => byTid(seg, "segment").evaluateAll((els) => ({ ids: els.map((e) => e.dataset.value), on: els.map((e, i) => (e.dataset.on === "true" ? i : -1)).filter((i) => i >= 0) }));
    const st = await state();
    if (st.ids.length < 3 || st.on.length !== 1) fail(`the effort control is ${J(st)}: it has three segments at least and the chosen one alone is on`);
    else {
      const want = st.ids[(st.on[0] + 1) % st.ids.length], from = calls.length;
      await press(page, byTid(seg, "segment", { value: want }));
      if (!await until(async () => J((await state()).on) === J([st.ids.indexOf(want)]), 5000)) fail(`after a press on ${want} the segments are ${J(await state())}: it alone is on`);
      await page.waitForTimeout(300);
      if (patches(calls, from, "effort").length) fail("a press on an effort wrote at once: it is a draft until Done");
      if (!await byTid(page, "model-sheet").count()) fail("the model sheet closed with an effort press: Done closes it");
      await closeChoice(page);
      const got = await until(() => patches(calls, from, "effort")[0], 10000);
      if (got !== want) fail(`Done after a press on the effort ${want} saved ${J(got)}`);
    }
    await ctx.close();
  }
  if (keys) {
    const { page, ctx } = await fresh("plain-new");
    const calls = callsOf(page);
    const gone = () => until(() => page.locator(MENU_SEL).count().then((c) => !c), 5000);
    /** Opens the menu: its efforts and the drafted one, or null. */
    const open = async () => {
      await openModelMenu(page);
      if (!await until(async () => (await menuOf(page))?.focused, 5000)) fail("the menu's search has no focus");
      const m = await menuOf(page);
      return m && { ids: m.efforts, on: m.efforts.indexOf(m.effort) };
    };
    /** Tab (or Shift+Tab) and Enter in the menu: the effort applied is the one after (or before) the chosen one, around the ends. */
    const stepBy = async (key) => {
      const now = await open();
      if (!now || now.on < 0 || now.ids.length < 3) { fail(`the menu's efforts are ${J(now)}: none is chosen, or fewer than three to move over`); return false; }
      const want = now.ids[(now.on + (key === "Tab" ? 1 : -1) + now.ids.length) % now.ids.length], from = calls.length;
      await page.keyboard.press(key);
      if (!await until(async () => (await menuOf(page))?.effort === want, 5000)) fail(`${key} drafted ${J((await menuOf(page))?.effort)}, not ${want}`);
      if (!(await menuOf(page))?.focused) fail(`${key} took the focus out of the search field`);
      await page.keyboard.press("Enter");
      const got = await until(() => patches(calls, from, "effort")[0], 10000);
      if (!got) fail(`${key}, Enter in the menu applied nothing (the efforts are ${J(now.ids)}, ${now.ids[now.on]} chosen)`);
      else if (got !== want) fail(`${key}, Enter in the menu applied ${got}, not ${want}, the one ${key === "Tab" ? "after" : "before"} ${now.ids[now.on]} in ${J(now.ids)}`);
      if (!await gone()) fail("the menu stays open after Enter");
      return !!got;
    };
    // (from the chosen one: on, on from the last to the first, back from the first to the last, back)
    if (await stepBy("Tab") && await stepBy("Tab") && await stepBy("Shift+Tab") && await stepBy("Shift+Tab")) {
      // Esc closes the menu and applies nothing
      if (await open()) {
        const from = calls.length;
        await page.keyboard.press("Tab");
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Escape");
        if (!await gone()) fail("Esc did not close the menu");
        await page.waitForTimeout(400);
        if (calls.slice(from).some((c) => c.method === "PATCH")) fail(`Esc in the menu applied ${J(calls.slice(from).filter((c) => c.method === "PATCH").map((c) => c.body))}`);
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
    // (a narrow toolbar keeps the folder in the "more" popup, and a longer name can send it there: the popup is opened when the chip is not in sight)
    const shown = async (kind) => {
      const now = await label(kind);
      if (now !== null || phone || !await byTid(page, "more-chip").count() || await byTid(page, "more-pop").count()) return now;
      await press(page, byTid(page, "more-chip").first());
      return label(kind);
    };
    const folderWas = await shown("folder");
    await mockEval(`Object.assign(chats.c_A2_new, { cwd: "/srv/other-place" }); send({ type: "chat", chat: chats.c_A2_new });`, url);
    if (!await until(async () => ((await shown("folder")) ?? "").includes("other-place"), 10000)) fail(`the folder chip of a chat that has not started says "${await label("folder")}" after its folder was changed from elsewhere, not "other-place" (it said "${folderWas}")`);
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
  note("the box: placeholder, Enter and Shift+Enter (lines), ⌘/Ctrl+Enter (send, quotes alone too), trim, Send's state; a refused Send; a busy chat; growth; the focus; the context row; the model's search; the bars; the note");
}, { viewports, page: false });
