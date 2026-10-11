// Proves, on the build that has all six goals, that ⌘L and ⌘⇧L are as they were: the two shortcuts of the goals'
// "Must stay as it is" that live in the composer, which goals 2 and 4 changed, and that no other check presses (⌘N
// and ⌘J are A1.3's, ⌘⇧B is A1.4's). Beside the sidebar and beside the rail of a hidden one, in a pane of 300 px.
//   A plain chat. ⌘L with nothing selected says to select text; with text of one reply selected it quotes that text
//   (its box opens inside the window with the focus in its comment field, and Enter adds it: the count in the
//   composer, the quote and its comment in the chat's saved draft); with text of two messages selected it says to
//   stay within one. ⌘⇧L does nothing there. The composer fits its box with the count and with the notice.
//   A chat beside a board whose canvas can be edited. ⌘L with shapes selected puts them into the message as one
//   reference; with none selected it says to select something first. ⌘⇧L waits for a point on the board (the
//   crosshair's layer over the canvas, the composer's control lit), ⌘⇧L again or Esc ends that, and a click on the
//   board puts the point into the message. The key does not reach the canvas, whose own ⌘⇧L locks the selected
//   shapes: after it no shape of the stored drawing is locked. The check's own proof: with the chat panel away (⌘J)
//   the canvas hears the key, and the stored drawing has its shapes locked.
import { act, check, measureComposer, mockEval, openPage, paneSize, seed, until } from "../shot.mjs";

const RAIL = 40, SIDE = 264, HEIGHT = 640, CHAT = "c_A2_move", BOARD = "b_ui", ON_BOARD = "c_A2_sketch";
const QUOTE = "font copy step", COMMENT = "which step?";

/** In the page: what the composer shows of a quote, a notice and a reference; whether a point is waited for. */
function seen() {
  const text = (e) => (e?.textContent ?? "").replace(/\s+/g, " ").trim(), c = document.querySelector(".composer");
  return { count: text(c?.querySelector(".qcount")), note: text(c?.querySelector(".ctx-note")), chips: [...(c?.querySelectorAll(".composer-input .ref-chip") ?? [])].map((r) => `${[...r.classList].filter((k) => k !== "ref-chip").join(" ")}: ${text(r)}`),
    picking: !!document.querySelector(".pick-layer"), lit: !!c?.querySelector(".ctx-act.on"), hidden: !!document.querySelector(".app > .side-rail"),
    float: (() => { const f = document.querySelector(".qfloat"), r = f?.getBoundingClientRect(); return f ? { quote: text(f.querySelector(".qfloat-quote")), focused: document.activeElement === f.querySelector(".qfloat-comment"), inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && r.width > 0 } : null; })() };
}

/** In the page: selects `quote` in the first reply that has it, or with `across` from there into the next message. */
function select([quote, across]) {
  const msgs = [...document.querySelectorAll(".thread > .msg")], msg = msgs.find((m) => m.matches(".assistant") && m.textContent.includes(quote));
  const node = (root) => { const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue.trim()) return n; return null; };
  const w = document.createTreeWalker(msg, NodeFilter.SHOW_TEXT);
  let from = null;
  for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue.includes(quote)) { from = n; break; }
  const r = document.createRange(), at = from.nodeValue.indexOf(quote);
  r.setStart(from, at);
  if (across) { const next = node(msgs[msgs.indexOf(msg) + 1]); r.setEnd(next, Math.min(3, next.nodeValue.length)); } else r.setEnd(from, at + quote.length);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  return String(sel);
}

await check("P7.4 ⌘L and ⌘⇧L as they were, beside the sidebar and beside the rail", async ({ url, browser, fail, note }) => {
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
  const locked = () => mockEval(`return scenes.${BOARD}.scene.elements.filter((e) => e.locked && !e.isDeleted).length;`, url);
  const saves = () => mockEval(`return scenes.${BOARD}.rev;`, url);

  for (const hidden of [false, true]) {
    const beside = hidden ? "beside the rail" : "beside the sidebar";
    await seed(url, "A2"); // (anew: the chats' drafts and the board's drawing are as seeded)
    const open = async (kind, sel, wait) => {
      const errors = [], size = paneSize(kind, 300, HEIGHT);
      const p = await openPage({ url, browser, errors, sel, size: [size.size[0] - (hidden ? SIDE - RAIL : 0), HEIGHT], ls: { ...size.ls, ...(hidden ? { "aiwb.side": "hidden" } : {}) }, wait });
      if ((await read(p.page)).hidden !== hidden) fail(`${beside}: the page opened with the sidebar ${hidden ? "shown" : "hidden"}`);
      return { ...p, errors };
    };
    const close = async ({ ctx, errors }, name) => { for (const e of errors) fail(`${name}: page error: ${e}`); await ctx.close(); };

    // ---- a plain chat
    {
      const name = `a plain chat ${beside}`, p = await open("page", { chat: CHAT }, ".thread .msg.assistant"), { page } = p;
      try {
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
        await page.keyboard.type(COMMENT);
        await page.keyboard.press("Enter");
        await shows(page, `${name}, Enter in the quote's box`, (x) => !x.float && /^❝ 1 comment/.test(x.count));
        const draft = await until(async () => { const d = await mockEval(`return chats.${CHAT}.draft?.references ?? null;`, url); return d?.length ? d : null; }, 10000);
        if (!draft || draft.length !== 1 || draft[0].quote !== QUOTE || draft[0].comment !== COMMENT) fail(`${name}: the chat's saved draft has the quotes ${JSON.stringify(draft)}, not "${QUOTE}" alone with "${COMMENT}"`);
        await fits(page, `${name}, one quote`);
      } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
      await close(p, name);
    }

    // ---- a chat beside a board that can be edited
    {
      const name = `a chat on a board ${beside}`, p = await open("panel", { board: BOARD, chat: ON_BOARD }, ".board-panel .composer-box .send"), { page } = p;
      try {
        await page.waitForSelector(".excalidraw:not(.excalidraw--view-mode) canvas.interactive", { timeout: 15000 });
        await key(page, false);
        await shows(page, `${name}, ⌘L with nothing selected`, (s) => s.note === "Select something on the board first" && !s.chips.length);
        await act(page, "select");
        await page.waitForSelector(".composer .ctx-act:not([disabled])", { timeout: 10000 });
        await key(page, false);
        const one = await shows(page, `${name}, ⌘L with three shapes selected`, (s) => s.chips.length === 1);
        if (!/3/.test(one.chips[0] ?? "")) fail(`${name}: the reference of three selected shapes reads "${one.chips[0]}"`);

        // ⌘⇧L: on, off by the key, on, off by Esc, on, and a click on the board
        const rev = await saves();
        for (const [what, press, on] of [["⌘⇧L", () => key(page, true), true], ["⌘⇧L again", () => key(page, true), false], ["⌘⇧L", () => key(page, true), true], ["Esc", () => page.keyboard.press("Escape"), false], ["⌘⇧L", () => key(page, true), true]]) {
          await press();
          await shows(page, `${name}, ${what}: ${on ? "a point is waited for" : "no point is waited for"}`, (s) => s.picking === on && s.lit === on);
        }
        const box = await page.locator(".pick-layer").boundingBox();
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 3);
        const two = await shows(page, `${name}, a click on the board`, (s) => s.chips.length === 2 && !s.picking && !s.lit);
        if (two.chips[0] !== one.chips[0] || two.chips[1] === one.chips[0]) fail(`${name}: after the click the message has ${JSON.stringify(two.chips)}`);
        await fits(page, `${name}, two references`);

        // the canvas did not hear ⌘⇧L: a shape is moved, so that the drawing is stored, and none of it is locked
        await act(page, "select");
        await page.keyboard.press("ArrowRight");
        if (!await until(async () => await saves() > rev, 15000)) fail(`${name}: the drawing was not stored after a shape was moved: the check cannot tell whether the canvas heard the key`);
        if (await locked()) fail(`${name}: ${await locked()} shapes of the stored drawing are locked: the canvas heard ⌘⇧L`);

        if (hidden) {
          // the proof: with the panel away the composer is not there, the canvas hears the key and locks what is selected
          await page.keyboard.press("ControlOrMeta+j");
          if (!await until(async () => !await page.locator(".app > .board-panel").count(), 10000)) fail(`${name}: ⌘J did not hide the panel`);
          await act(page, "select");
          await key(page, true);
          const n = await until(locked, 15000);
          if (!n) fail("the check's proof: with the chat panel away ⌘⇧L locked no shape of the stored drawing: the check would not see a canvas that hears the key");
          else note(`the proof: with the chat panel away the canvas heard ⌘⇧L and ${n} shapes of the stored drawing are locked`);
        }
      } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
      await close(p, name);
    }
    note(`${beside}: ⌘L quoted the selected text, said what to select, and put the board's selection into the message; ⌘⇧L waited for a point, ended by the key and by Esc, took a click, and locked nothing`);
  }
});
