// P7.4 ported (AD-80; package K5): the plain-chat half of dev/checks/P7.4-keys.mjs, ⌘L as it was — the quote of the text selected in a message —
// at desktop (mouse) and tablet (touch, with a hardware keyboard). The board half is P7.4-board.mjs (B4) and P7.4-keys.mjs (K1).
//   A plain chat. ⌘L with nothing selected says to select text; with text of one reply selected it quotes that text (its box opens inside the
//   window with the focus in its comment field, and Enter adds it: the count in the composer, the quote and its comment in the chat's saved
//   draft); with text of two messages selected it says to stay within one. ⌘⇧L does nothing there. The composer fits its box with the count and
//   with the notice. Beside the sidebar and beside the rail of a hidden one.
// Same seed, same words, same assertions as the old check. What changed: the old pane of 300 px "beside the sidebar" cannot be made (a window under
// 700 px is the phone layout, AD-72, whose way to quote is the sheet: L17), so the windows are the layouts' own; the readers are over testIDs.
// Added to the old assertions: the quote's stored position is the place of the words in the message's displayed text (start 15, end 29 for
// "font copy step" in "Because of the font copy step…"), and the passage is marked in the thread while the quote is in the draft.
import { check, mockEval, seed, until } from "../shot.mjs";
import { measureComposer } from "./composer.mjs";
import { seen, select } from "./quote.mjs";
import { byTid, tidSel } from "./sel.mjs";

export const viewports = ["desktop", "tablet"];

const CHAT = "c_A2_move";
const QUOTE = "font copy step", COMMENT = "which step?";

await check("P7.4 ⌘L quotes the text selected in a message, and says what to select", async ({ url, open, fail, note, viewport }) => {
  const key = (page, shift) => page.keyboard.press(shift ? "ControlOrMeta+Shift+l" : "ControlOrMeta+l");
  const read = (page) => page.evaluate(seen);
  const frame = (page) => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok()))));
  /** Waits for the page to show what `want` says of it; fails with what it shows. */
  const shows = async (page, name, want) => {
    let s;
    if (!await until(async () => want((s = await read(page))), 10000)) fail(`${name}: the page shows ${JSON.stringify(s)}`);
    return s;
  };
  const fits = async (page, name) => {
    await frame(page);
    const m = (await measureComposer(page)).find((c) => !c.none);
    if (!m || m.past || m.send !== "ok" || m.docScroll > 0) fail(`${name}: the composer does not fit: ${JSON.stringify(m && { past: m.past, over: m.over, send: m.send, docScroll: m.docScroll })}`);
  };

  for (const hidden of [false, true]) {
    const beside = hidden ? "beside the rail" : "beside the sidebar";
    await seed(url, "A2"); // (anew: the chats' drafts are as seeded)
    const name = `a plain chat ${beside}`;
    const { page } = await open({ sel: { chat: CHAT }, ls: hidden ? { "aiwb.side": "hidden" } : {} });
    try {
      await byTid(page, "msg", { role: "assistant" }).first().waitFor({ state: "visible", timeout: 15000 });
      await byTid(page, "composer-input").first().waitFor({ state: "visible", timeout: 15000 });
      if ((await read(page)).hidden !== hidden) fail(`${beside}: the page opened with the sidebar ${hidden ? "shown" : "hidden"}`);
      await key(page, false);
      await shows(page, `${name}, ⌘L with nothing selected`, (s) => s.note === "Select text in a message to quote it" && !s.count);
      await fits(page, `${name}, the notice up`);
      await key(page, true);
      await frame(page);
      const idle = await read(page);
      if (idle.picking || idle.lit || idle.count || idle.chips.length) fail(`${name}, ⌘⇧L: a chat with no board shows ${JSON.stringify(idle)}`);

      if (await page.evaluate(select, [QUOTE, true]) === QUOTE) fail(`${name}: the check's selection across two messages is of one`);
      await key(page, false);
      await shows(page, `${name}, ⌘L with text of two messages selected`, (s) => s.note === "Select text within one message" && !s.count);

      if (await page.evaluate(select, [QUOTE, false]) !== QUOTE) fail(`${name}: the check did not select "${QUOTE}" in the reply`);
      await key(page, false);
      // the quote's box: over the thread, inside the window, its comment field with the focus; Enter adds the quote
      const f = (await shows(page, `${name}, ⌘L with "${QUOTE}" selected`, (x) => !!x.float && !x.note)).float;
      if (f && (!f.quote.includes(QUOTE) || !f.focused || !f.inside)) fail(`${name}: the quote's box says "${f.quote}", its comment field ${f.focused ? "has" : "has not"} the focus, and it ${f.inside ? "lies" : "does not lie"} inside the window`);
      if (!await until(async () => (await read(page)).marked > 0, 5000)) fail(`${name}: the passage being quoted is not marked in the thread`);
      await page.keyboard.type(COMMENT);
      await page.keyboard.press("Enter");
      await shows(page, `${name}, Enter in the quote's box`, (x) => !x.float && /^❝ 1 comment/.test(x.count));
      const draft = await until(async () => { const d = await mockEval(`return chats.${CHAT}.draft?.references ?? null;`, url); return d?.length ? d : null; }, 10000);
      if (!draft || draft.length !== 1 || draft[0].quote !== QUOTE || draft[0].comment !== COMMENT) fail(`${name}: the chat's saved draft has the quotes ${JSON.stringify(draft)}, not "${QUOTE}" alone with "${COMMENT}"`);
      else if (draft[0].item !== 1 || draft[0].start !== 15 || draft[0].end !== 29) fail(`${name}: the saved quote points at item ${draft[0].item} from ${draft[0].start} to ${draft[0].end}, not item 1 from 15 to 29 (its place in the displayed text)`);
      if (!await until(async () => (await read(page)).marked > 0, 5000)) fail(`${name}: the quote in the draft is not marked in the thread`);
      await fits(page, `${name}, one quote`);
    } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    await page.context().close();
    note(`${beside}: ⌘L quoted the selected text, said what to select, ⌘⇧L did nothing`);
  }
}, { viewports, page: false });
