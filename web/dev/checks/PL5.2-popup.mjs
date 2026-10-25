// Proves the insert popup in the app (plans/prompt-library.md, section 5; section 10, lines 11 to 16, and lines 19 and
// 22 as far as this popup goes). The text box's own side is PL5.1's; the library popup is PL4.1's.
//   A chat's composer. ⌘P in the text box opens the popup with the focus in its search and
//   every prompt listed with its path, in the order of the tree, the first one highlighted; the page does not get the
//   key (it would print), also not while it is held and not from the popup's button. ⌘P with the cursor elsewhere
//   (nowhere, in a message, in another field) opens nothing and is left to the browser. The arrow keys move the
//   highlight around the ends, typing searches, Tab stays in the popup. Enter puts the highlighted prompt's text
//   where the cursor was: in the middle of typed text, in place of a selection (found by a search) and, by a click, in
//   an empty box; what was before and after is as it was, line breaks are kept, the cursor is right after the text.
//   Esc and a click beside the popup close it with nothing inserted: the box has the focus, its text and its cursor or
//   its selection as they were. The focus stays in the open popup when the chat was picked in the sidebar just before
//   (the composer is given the focus a moment after a pick). The popup has no field but the search and no button but
//   the way to the library, and nothing done in it changes the library. The text is in the draft the server holds, in
//   the box after a reload, and in the message that is sent, as typed.
//   A chat beside a board. A reference chip in the box is the element it was after an insertion beside it, and the
//   saved draft still has its tag; a mention typed afterwards is completed from its list; the message sent has the
//   reference, the mention and the text.
//   An empty library: the popup says so and its button opens the library popup; closed, the box has the focus and
//   its cursor again. The popup's "Edit the library" does the same.
//   Another server (PL4.1 has the library popup's side): its prompts are in the list under its name, and a search for
//   the server's name and a prompt's name finds the prompt; when it drops they stay, marked "not connected", and can
//   be inserted; removed from the list, they are gone. All of it while the popup is open, with no reload.
//   The toolbar. Where a chat's row has the "more" chip and no room for the Insert button, the chip's popup has the
//   entry, which opens the popup for the box; the composer fits its box.
// At the phone (ux-improvements S4) the popup is the Prompt sheet (app/src/screens/library/phone/PromptSheet.tsx) and this check proves the same behaviours through it, with these differences, each
// the sheet's own: the sheet lists the prompts under folder heads ("git", "Top level" for the top of the only library, the server's name with several; `phoneSeen` reads each row's line as the wide popup's
// path and name, so the order of the tree is the same strings), no row is tinted (nor lit by a background) before an arrow is pressed - the first arrow tints the first row, the last one goes round, and a search
// resets it, Enter taking the tinted row or the first; the head's buttons are Cancel and Library (not "Edit the library"; the search's own clear button is the field's, not a button of the sheet), an empty library says
// "The library has no prompts yet." with "Open the library", a search for nothing says "No prompts match “…”"; a press on the dimmed page is a press on the sheet's backdrop; "Library" and "Open the library"
// push the Library screen (the stack's, left with the back button), after which the box is as it was (its text, and a focus given to it finds its cursor where it was; the phone gives no box the focus when a screen is left); Recent (the last inserted prompts, UX.S4.3's) is emptied from the storage before each opening so
// the list is the tree's alone. Tab is kept inside a popup by the wide popup; the phone's sheets are the kit's, whose trap UX.F1 proves, so here the key's reaching the page is proved from the focus on the
// sheet's Cancel button instead. No phone counterpart (as above): a board's ⌘L selection with a mouse, the toolbar's "more" chip beside a board, a box under a dialog.
// Ports dev/checks/PL5.2-popup.mjs (S11) to the new build, at the three viewports (C-PL-20 to C-PL-31, 34; the popup is a dialog at the desktop and the tablet, a sheet on the phone; the keys are a
// keyboard's, which every viewport has here). What changed: the selectors (testIDs; `library.mjs` reads the popup), the presses, and the toolbar's button, which the phone's row does not
// have (its toolbar is "+", the dictation and Talk or Send): there the "+" sheet's "Insert a prompt" is the way in (`viaButton`); the "more" popup's entry, for a wide row too narrow for the button, is
// the last section's, played at the tablet and the desktop in a window from 700 px (a narrower one is the phone layout). A board opens as a reader's: "Edit here" (boarddraw.mjs) comes first. The part "a chat beside a board" needs shapes selected on the canvas (⌘L), which only the
// desktop's mouse does (composer.mjs `playable`: a finger has no select-all, the phone does not show the canvas under the chat), so it is played there alone; the box's chips beside an insertion
// are proved at the tablet by L4-chips. C-PL-34 (a box under the Servers dialog, the library popup or the question of a Delete) is played at the desktop and the tablet alone: on the phone those
// are opened from the list, a screen of the stack other than the chat's, so no box stays under them. The key is handed to the box's element (a dialog draws the focus into itself).

import { check, mockEval, seed, until } from "../shot.mjs";
import { act, back, byTid, press, showList, tidSel } from "./sel.mjs";
import { sideMenu } from "./side.mjs";
import { insertSeen as wideSeen } from "./library.mjs";
import { frame } from "./composer.mjs";
import { editHere } from "./boarddraw.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const KEY = "ControlOrMeta+p";
const COMMIT = "Write a commit message.\n\n- a first line of 60 characters\n- then why", REVIEW = "Review this change.", TODO = "TODO: ";
const LIBRARY = { groups: [{ id: "g_git", name: "git", parent: "" }],
  prompts: [{ id: "p_todo", name: "todo", parent: "", text: TODO }, { id: "p_review", name: "review", parent: "g_git", text: REVIEW }, { id: "p_commit", name: "commit message", parent: "g_git", text: COMMIT }] };
const LINES = ["git/commit message", "git/review", "todo"]; // the order of the tree: a group before the prompts beside it, both by name
const STUDIO = { id: "s_studio", name: "Studio", address: "https://studio.example:4790", state: "connected", version: "dev" };
const THEIRS = { groups: [{ id: "g_team", name: "team", parent: "" }], prompts: [{ id: "p_stand", name: "standup", parent: "g_team", text: "What did you do yesterday?" }] };
/** In the page: what the Prompt sheet shows, as insertSeen reads the wide popup (library.mjs): `rows` are the lines "path/name" of the prompts under the folder heads (Recent apart, in `recent`; "Top level" is no path),
 *  `on` the rows the arrows tinted (aria-selected), `lit` those with a background, `library` the Library screens in the page. */
function phoneSeen() {
  const T = (id) => `[data-testid="${id}"]`;
  const text = (e) => e?.textContent ?? "", pop = document.querySelector(T("insert-popup")), at = document.activeElement;
  let head = "";
  const rows = [];
  for (const e of pop?.querySelectorAll(`${T("insert-section")}, ${T("insert-row")}`) ?? []) {
    if (e.dataset.testid === "insert-section") { head = text(e).trim(); continue; }
    const recent = e.dataset.recent === "true", path = recent || head === "Top level" ? "" : head.split(" › ").join("/"), name = text(e.querySelector(T("lib-pname")));
    rows.push({ line: path ? path + "/" + name : name, name, recent, on: e.getAttribute("aria-selected") === "true", lit: getComputedStyle(e).backgroundColor !== "rgba(0, 0, 0, 0)", off: !!e.querySelector(T("lib-off")) });
  }
  const tree = rows.filter((r) => !r.recent), buttons = pop ? [...pop.querySelectorAll('[role="button"]')].filter((b) => b.dataset.testid !== "insert-search-clear").map((b) => text(b).trim()) : [];
  return {
    open: document.querySelectorAll(T("insert-popup")).length, rows: tree.map((r) => r.line), recent: rows.filter((r) => r.recent).map((r) => r.name), on: rows.filter((r) => r.on).map((r) => (r.recent ? "recent:" : "") + r.line),
    lit: rows.filter((r) => r.lit).map((r) => (r.recent ? "recent:" : "") + r.line), off: tree.filter((r) => r.off).map((r) => r.line),
    fields: pop?.querySelectorAll("input, textarea, select, [contenteditable]").length ?? 0, buttons,
    says: text(pop?.querySelector(T("insert-empty"))) || text(pop?.querySelector(T("insert-none"))),
    focus: !at || at === document.body ? "nothing" : at.matches(T("insert-search")) ? "search" : at.matches(T("composer-input")) ? "box" : at.closest(T("insert-popup")) && at.getAttribute("role") === "button" ? "button"
      : at.tagName.toLowerCase() + "[" + (at.dataset.testid ?? "") + "]",
    selected: String(getSelection()), library: document.querySelectorAll(T("lib-screen")).length,
  };
}
const bare = (v) => v.replace(/\n+$/, ""); // (the break of an empty last line is the browser's)

/** In the page: notes every keydown before anything of the page gets it; prevented() answers which of the ⌘P presses
 *  since the last call were kept from the browser, read after the page has handled them. */
function watchKeys() {
  window.__keys = [];
  window.addEventListener("keydown", (e) => window.__keys.push(e), true);
  window.__pressed = () => window.__keys.splice(0).filter((e) => e.code === "KeyP").map((e) => e.defaultPrevented);
}

await check("PL5.2 the insert popup: ⌘P in a composer, the list, an insertion, Esc, the draft and what is sent", async ({ url, open, fail, note, touch, layout }) => {
  const seeded = await seed(url, "A2");
  const selOf = (id) => seeded.find((s) => s.id === id)?.sel ?? fail(`the seed has no state ${id}`);
  const ph = layout === "phone", seen = ph ? phoneSeen : wideSeen;
  const library = () => mockEval("return JSON.stringify(libraries);", url);
  const setLocal = (lib) => mockEval(`setLibrary("local", ${JSON.stringify(lib)});`, url);
  const servers = (list) => mockEval(`setServers(${JSON.stringify(list)});`, url);
  // (the seed's servers leave the list: this computer's library is the only one until Studio joins)
  await servers([]);
  await setLocal(LIBRARY);
  const start = await library();

  /** A page with one composer. saved(): the box's text as the server holds it in the draft. */
  const openBox = async (name, sel, saved, o = {}) => {
    const p = await open({ sel, wait: tidSel("composer-input"), ...o });
    const { page } = p;
    await page.evaluate(watchKeys);
    const read = () => page.evaluate(seen);
    const box = byTid(page, "composer-input").first();
    /** Waits for the page to show what `want` says; fails with what it shows. */
    const shows = async (what, want) => {
      let s;
      if (!await until(async () => want((s = await read())), 10000)) fail(`${name}, ${what}: the page shows ${JSON.stringify(s)}`);
      return s;
    };
    /** Waits for the server's draft to be `want`; fails with what it holds. */
    const holds = async (what, want) => {
      let v;
      if (!await until(async () => bare((v = await saved()) ?? "") === bare(want), 10000)) fail(`${name}, ${what}: the draft holds ${JSON.stringify(v)}, not ${JSON.stringify(want)}`);
    };
    /** ⌘P in the box: the popup is open with the focus in its search, and the key was kept from the browser. */
    const popup = async (what) => {
      await page.evaluate(() => window.__pressed());
      if (ph) await page.evaluate(() => localStorage.removeItem("aiwb.prompts.recent")); // (the sheet lists the last inserted prompts first: the list here is the tree's alone)
      await page.keyboard.press(KEY);
      const s = await shows(`${what}: ⌘P`, (x) => x.open === 1 && x.focus === "search");
      const kept = await page.evaluate(() => window.__pressed());
      if (kept.length !== 1 || !kept[0]) fail(`${name}, ${what}: ⌘P in the text box was left to the browser, which prints: ${JSON.stringify(kept)}`);
      return s;
    };
    /** After an insertion or a close: the popup is gone and the box has the focus; a mark typed now stands at `at` of the draft. */
    const caret = async (what, text, at) => {
      const s = await shows(`${what}: the popup closed`, (x) => x.open === 0 && x.focus === "box");
      if (s.selected) fail(`${name}, ${what}: ${JSON.stringify(s.selected)} is selected in the box`);
      await page.keyboard.type("‸");
      await holds(`${what}: a mark typed where the cursor is`, text.slice(0, at) + "‸" + text.slice(at));
      await page.keyboard.press("Backspace");
      await holds(`${what}: the mark taken out`, text);
    };
    const empty = async () => { await press(page, box); await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.press("Backspace"); };
    const boxText = () => box.evaluate((e) => e.innerText);
    return { page, p, read, shows, holds, popup, caret, empty, box, boxText };
  };
  /** The Insert button of the toolbar, when the row has room for it; else the entry of the "more" popup; on the phone (which has neither: its row is "+", the dictation and Talk or Send) the
   *  "Insert a prompt" row of the "+" sheet (C1; PL5.1 does the same). Opens the popup for the box. */
  const viaButton = async (c) => {
    const { page } = c;
    if (ph) { await press(page, byTid(page, "composer-plus")); await press(page, byTid(page, "action-row", { action: "prompt" })); return "the \"+\" sheet's Insert a prompt"; }
    if (await byTid(page, "insert-btn").count() === 1) { await press(page, byTid(page, "insert-btn")); return "the Insert button"; }
    await press(page, byTid(page, "more-chip"));
    await press(page, byTid(page, "more-insert"));
    return "the entry of the \"more\" popup";
  };

  // ---- under a dialog the insert popup does not open (C-PL-34); not on the phone, whose dialogs are opened from the list, another screen than the chat's box
  if (layout !== "phone") {
    const name = "a box under a dialog";
    const c = await openBox(name, selOf("plain-started"), () => mockEval("return chats.c_plain.draft?.text ?? '';", url)), { page } = c;
    try {
      const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));
      // (a dialog draws the focus into itself: ⌘P is handed to the box's own element, as the box would hear it if it had kept the focus)
      const toBox = () => c.box.evaluate((el, mac) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "p", code: "KeyP", metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true })), mac);
      const insertBtn = byTid(page, "insert-btn");
      if (await insertBtn.count() && await insertBtn.first().getAttribute("title") !== `Insert a prompt (${mac ? "⌘P" : "Ctrl+P"})`) fail(`${name}: the Insert button's tooltip is ${JSON.stringify(await insertBtn.first().getAttribute("title"))}`);
      await toBox();
      await c.shows("the key handed to the box with no dialog open (the check's own proof that it reaches the box)", (x) => x.open === 1);
      await page.keyboard.press("Escape");
      await c.shows("Esc", (x) => x.open === 0);
      for (const [what, open, dialog] of [
        ["the Servers dialog", async () => { await showList(page); await press(page, byTid(page, "servers-btn").first()); }, "servers-dialog"],
        ["the prompt library popup", async () => { await showList(page); await press(page, byTid(page, "library-btn").first()); }, "library-dialog"],
        ["the question of a chat's Delete", async () => { await showList(page); await sideMenu(page, byTid(page, "side-row", { kind: "chat", key: "c_plain" }).first(), "More", "Delete"); }, "confirm-dialog"],
      ]) {
        await open();
        await byTid(page, dialog).first().waitFor({ state: "visible", timeout: 15000 });
        await toBox();
        await page.waitForTimeout(400);
        const x = await c.read();
        if (x.open) fail(`${name}: ⌘P in a box under ${what} opened the insert popup`);
        await page.keyboard.press("Escape");
        if (!await until(async () => !await byTid(page, dialog).count(), 5000)) fail(`${name}: Esc did not close ${what}`);
      }
      await toBox();
      await c.shows("the key handed to the box once the dialogs are closed", (x) => x.open === 1);
      await page.keyboard.press("Escape");
      note(`${name}: ⌘P handed to a box under the Servers dialog, the library popup and a question opened no insert popup, and opened it with none`);
    } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    await c.p.ctx.close();
  }

  // ---- a chat's composer
  const draftOf = () => mockEval("return chats.c_plain.draft?.text ?? '';", url);
  {
    const name = `a chat's composer`;
    const c = await openBox(name, selOf("plain-started"), draftOf), { page } = c;
    try {
      // (the box is emptied by hand, as a user would)
      await c.empty();
      await page.keyboard.type("Hello world");
      for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
      await c.holds("typed", "Hello world");

      // the popup: the search has the focus, every prompt is listed in the order of the tree, the first is highlighted
      let s = await c.popup("in the middle of typed text");
      const first = ph ? "" : LINES[0]; // (the sheet tints no row before an arrow is pressed; Enter takes the first)
      if (s.rows.join("|") !== LINES.join("|") || s.on.join("|") !== first || (ph && (s.lit.length || s.recent.length))) fail(`${name}: the popup lists ${JSON.stringify(s.rows)} with ${JSON.stringify(s.on)} highlighted${ph ? ` and ${JSON.stringify(s.lit)} tinted, ${JSON.stringify(s.recent)} under Recent, not ${JSON.stringify(LINES)} and none` : `, not ${JSON.stringify(LINES)} with the first`}`);
      if (s.fields !== 1 || s.buttons.join("|") !== (ph ? "Cancel|Library" : "Edit the library")) fail(`${name}: the popup has ${s.fields} fields and the buttons ${JSON.stringify(s.buttons)}: something in it could change the library`);
      // held, the key is the popup's: no press of it reaches the browser, and there is one popup
      await page.keyboard.down("ControlOrMeta");
      for (let i = 0; i < 4; i++) await page.keyboard.down("p");
      await page.keyboard.up("p"); await page.keyboard.up("ControlOrMeta");
      let kept = await page.evaluate(() => window.__pressed());
      if (kept.length !== 4 || kept.some((k) => !k)) fail(`${name}: ⌘P held with the focus in the popup's search was left to the browser: ${JSON.stringify(kept)}`);
      if (!ph) {
        // Tab stays in the popup: from the search to its button and back; the key is the popup's from the button too
        await page.keyboard.press("Tab");
        s = await c.shows("Tab from the search", (x) => x.focus === "button");
        await page.keyboard.press(KEY);
        kept = await page.evaluate(() => window.__pressed());
        if (kept.length !== 1 || !kept[0]) fail(`${name}: ⌘P with the focus on the popup's button was left to the browser: ${JSON.stringify(kept)}`);
        await page.keyboard.press("Tab");
        s = await c.shows("Tab from the popup's last control", (x) => x.focus === "search" && x.open === 1);
      } else {
        // (Tab is the kit's sheet's, UX.F1's: the key is the sheet's from its Cancel button too)
        await page.locator(tidSel("insert-cancel")).focus();
        s = await c.shows("the focus on Cancel", (x) => x.focus === "button");
        await page.keyboard.press(KEY);
        kept = await page.evaluate(() => window.__pressed());
        if (kept.length !== 1 || !kept[0]) fail(`${name}: ⌘P with the focus on the sheet's Cancel button was left to the browser: ${JSON.stringify(kept)}`);
        await page.locator(tidSel("insert-search")).focus();
        s = await c.shows("the focus back in the search", (x) => x.focus === "search" && x.open === 1);
      }
      // the arrow keys move the highlight, around the ends (the sheet starts with none: the first ArrowDown tints the first row)
      for (const [key, want] of ph ? [["ArrowDown", LINES[0]], ["ArrowDown", LINES[1]], ["ArrowDown", LINES[2]], ["ArrowDown", LINES[0]], ["ArrowUp", LINES[2]], ["ArrowUp", LINES[1]], ["ArrowUp", LINES[0]]]
        : [["ArrowDown", LINES[1]], ["ArrowDown", LINES[2]], ["ArrowDown", LINES[0]], ["ArrowUp", LINES[2]], ["ArrowUp", LINES[1]], ["ArrowUp", LINES[0]]]) {
        await page.keyboard.press(key);
        s = await c.shows(`${key}: the highlight on ${want}`, (x) => x.on.join("|") === want);
        if (ph && s.lit.join("|") !== want) fail(`${name}: ${key}: the tinted rows are ${JSON.stringify(s.lit)}, not ${JSON.stringify(want)}`);
      }
      // a search lists what it finds, and an emptied one every prompt again
      await page.keyboard.type("GIT rev");
      await c.shows("a search", (x) => x.rows.join("|") === "git/review" && x.on.join("|") === (ph ? "" : "git/review")); // (a search takes the tint back: Enter takes the first hit)
      await page.keyboard.type("x");
      s = await c.shows("a search that finds nothing", (x) => x.rows.length === 0);
      const none = ph ? "No prompts match “GIT revx”" : "No matching prompts";
      if (s.says !== none) fail(`${name}: a search that finds nothing says ${JSON.stringify(s.says)}, not ${JSON.stringify(none)}`);
      await page.keyboard.press("Enter"); // (nothing is highlighted: nothing is inserted, and the popup stays)
      await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.press("Backspace");
      await c.shows("the search emptied", (x) => x.open === 1 && x.rows.join("|") === LINES.join("|") && x.on.join("|") === first);

      // Enter: the highlighted prompt's text where the cursor was, with its line breaks
      await page.keyboard.press("Enter");
      let text = "Hello" + COMMIT + " world";
      await c.holds("Enter in the middle of typed text", text);
      await c.caret("Enter in the middle of typed text", text, 5 + COMMIT.length);
      const shown = bare(await c.boxText());
      if (shown.split("\n").filter((l) => l).join("\n") !== text.split("\n").filter((l) => l).join("\n")) fail(`${name}: the box shows ${JSON.stringify(shown)}`);

      // in place of a selection, the prompt found by a search
      for (let i = 0; i < 6; i++) await page.keyboard.press("Shift+ArrowRight");
      await c.popup("with a selection");
      await page.keyboard.type("todo");
      await c.shows("a search for one prompt", (x) => x.rows.join("|") === "todo");
      await page.keyboard.press("Enter");
      text = "Hello" + COMMIT + TODO;
      await c.holds("Enter in place of a selection", text);
      await c.caret("Enter in place of a selection", text, text.length);

      // in an empty box, by a press on a prompt that is not the highlighted one
      await c.empty();
      await c.holds("the box emptied", "");
      await c.popup("in an empty box");
      await press(page, byTid(page, "insert-row").nth(1));
      await c.holds("a press in an empty box", REVIEW);
      await c.caret("a press in an empty box", REVIEW, REVIEW.length);

      // Esc: nothing is inserted, the cursor is where it was
      for (let i = 0; i < 7; i++) await page.keyboard.press("ArrowLeft");
      await c.popup("before Esc");
      await page.keyboard.type("commit");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Escape");
      await c.caret("Esc", REVIEW, REVIEW.length - 7);
      // and a selection is the selection it was; a press beside the popup closes it the same way
      for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowLeft");
      const was = (await c.read()).selected;
      await c.popup("with a selection, before Esc");
      await page.keyboard.press("Escape");
      s = await c.shows("Esc with a selection", (x) => x.open === 0 && x.focus === "box");
      if (s.selected !== was || was.length !== 4) fail(`${name}: after Esc ${JSON.stringify(s.selected)} is selected, not ${JSON.stringify(was)}`);
      await c.popup("before a press beside the popup");
      if (touch) await page.touchscreen.tap(8, 8); else await page.mouse.click(8, 8);
      s = await c.shows("a press beside the popup", (x) => x.open === 0 && x.focus === "box");
      if (s.selected !== was) fail(`${name}: after a press beside the popup ${JSON.stringify(s.selected)} is selected, not ${JSON.stringify(was)}`);
      await c.holds("after Esc and a press beside the popup", REVIEW);

      // the focus stays in the popup: picked in the sidebar, an item gives its composer the focus a moment later (focusComposer, 30 ms), and ⌘P pressed before that moment has
      // its popup open by then (the sidebar's row is in the page on the wide layouts; the phone's stack keeps it under the chat, where it is pressed all the same)
      {
        const picked = await page.evaluate(() => {
          const row = document.querySelector('[data-testid="side-row"][data-key="c_plain"]'), box = document.querySelector('[data-testid="composer-input"]'), mac = /Mac|iPhone|iPad/.test(navigator.platform);
          if (!row || !box) return false;
          row.click();
          box.dispatchEvent(new KeyboardEvent("keydown", { key: "p", code: "KeyP", metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true }));
          return true;
        });
        if (!picked) note(`${name}: the page has no row of the chat under the box here, so "⌘P right after the chat was picked" is not played`);
        else {
          await c.shows("⌘P right after the chat was picked", (x) => x.open === 1 && x.focus === "search");
          await page.evaluate(() => new Promise((ok) => setTimeout(ok, 300))); // (ten times the moment)
          s = await c.shows("a moment after the chat was picked", (x) => x.open === 1 && x.focus === "search");
          await page.keyboard.press("Escape");
          s = await c.shows("Esc after it", (x) => x.open === 0 && x.focus === "box");
          if (s.selected !== was) fail(`${name}: after ⌘P right after the chat was picked and Esc ${JSON.stringify(s.selected)} is selected, not ${JSON.stringify(was)}`);
          await c.holds("after ⌘P right after the chat was picked", REVIEW);
        }
      }

      // the toolbar's button opens it for the box, with the cursor where it is
      await page.keyboard.press("ArrowRight"); // (the cursor to the end of the selection)
      const way = await viaButton(c);
      await c.shows(way, (x) => x.open === 1 && x.focus === "search");
      for (let i = 0; i < (ph ? 3 : 2); i++) await page.keyboard.press("ArrowDown"); // (the sheet's first arrow tints the first row)
      await page.keyboard.press("Enter");
      text = REVIEW.slice(0, REVIEW.length - 7) + TODO + REVIEW.slice(-7);
      await c.holds(`${way}, the third prompt`, text);
      await c.caret(way, text, REVIEW.length - 7 + TODO.length);
      text = bare(await draftOf());

      // elsewhere ⌘P is the browser's, and opens nothing
      const left = async (where) => {
        await page.evaluate(() => window.__pressed());
        await page.keyboard.press(KEY);
        kept = await page.evaluate(() => window.__pressed());
        s = await c.read();
        if (kept.length !== 1 || kept[0] || s.open) fail(`${name}: ⌘P ${where} was taken from the browser (${JSON.stringify(kept)}) or opened the popup (${s.open})`);
      };
      await page.evaluate(() => document.activeElement?.blur());
      await left("with the focus nowhere");
      await press(page, byTid(page, "msg").first(), { position: { x: 5, y: 5 } });
      if ((await c.read()).focus === "box") fail(`${name}: a press on a message left the focus in the text box`);
      else await left("after a press on a message");
      await page.evaluate(() => { const i = document.createElement("input"); i.id = "other-field"; document.body.append(i); i.focus(); });
      await left("in another field");
      await page.evaluate(() => document.getElementById("other-field").remove());

      // the draft after a reload, and what is sent
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(tidSel("composer-input"), { timeout: 15000 });
      if (!await until(async () => bare(await c.boxText()) === text, 10000)) fail(`${name}: after a reload the box shows ${JSON.stringify(await c.boxText())}, not the draft ${JSON.stringify(text)}`);
      await c.empty();
      await page.keyboard.type("Before ");
      await page.evaluate(watchKeys);
      await c.popup("after a reload");
      await page.keyboard.press("Enter");
      text = "Before " + COMMIT;
      await c.holds("after a reload", text);
      await press(page, byTid(page, "send").first());
      const sent = () => mockEval("return items.c_plain.filter((x) => x.kind === 'user').at(-1)?.text ?? '';", url);
      let got;
      if (!await until(async () => (got = await sent()) === text, 10000)) fail(`${name}: what was sent is ${JSON.stringify(got)}, not ${JSON.stringify(text)}`);
      note(`${name}: ⌘P opens the popup and is never the browser's there, Enter and a press insert at the cursor, Esc leaves the box as it was, the draft and what is sent have the text`);
    } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    await c.p.ctx.close();
  }
  if (await library() !== start) fail("the library changed while only the insert popup was used");

  // ---- reference chips and mentions, in a chat beside a board (the canvas under the chat is the wide layouts')
  if (layout !== "desktop") note(`a chat beside a board is not played at the ${layout}: its shapes are selected by a click and ⌘A on the canvas, which a mouse does and a finger does not (composer.mjs playable), so no chip can be made for the box; the box's chips beside an insertion are L4-chips'`);
  else {
    const name = "a chat beside a board", c = await openBox(name, selOf("board-selected"), () => mockEval("return chats.c_A2_sketch.draft?.text ?? '';", url)), { page } = c;
    try {
      await editHere(page); // (a board opens as a reader's, in view mode: the button makes the window its writer, and only then can shapes be selected on the canvas)
      // (the shapes are selected by a click on the canvas and ⌘A: on a loaded machine the keys may come before the canvas has the focus, so it is tried again)
      for (let tries = 0; ; tries++) {
        await act(page, "select");
        const on = await page.waitForFunction(() => { const b = document.querySelector('[data-testid="ctx-act"][data-kind="selection"]'); return b && b.getAttribute("aria-disabled") !== "true" && !b.disabled; }, null, { timeout: 8000 }).then(() => true, () => false);
        if (on) break;
        if (tries >= 2) throw new Error("the shapes of the board are not selected after three tries");
      }
      await page.keyboard.press("ControlOrMeta+l");
      const chips = () => byTid(page, "composer-input").locator(tidSel("ref-chip"));
      if (!await until(() => chips().count().then((n) => n === 1), 10000)) fail(`${name}: ⌘L with shapes selected put ${await chips().count()} references into the message`);
      const tag = await chips().evaluate((e) => { e.__was = true; return e.dataset.ref; });
      await press(page, c.box);
      await page.keyboard.press("ControlOrMeta+ArrowDown"); await page.keyboard.press("End"); // (the end of the box, on a Mac and elsewhere)
      await page.keyboard.type("see ");
      let before = await mockEval("return chats.c_A2_sketch.draft?.text ?? '';", url);
      if (!await until(async () => (before = await mockEval("return chats.c_A2_sketch.draft?.text ?? '';", url)).includes("see"), 10000) || !before.includes(tag)) fail(`${name}: the draft with a reference holds ${JSON.stringify(before)}`);
      await c.popup("beside a reference");
      await page.keyboard.type("review");
      await page.keyboard.press("Enter");
      await c.holds("an insertion beside a reference", bare(before) + (before.endsWith(" ") ? "" : " ") + REVIEW);
      const chip = await page.evaluate(() => [...document.querySelectorAll('[data-testid="composer-input"] [data-testid="ref-chip"]')].map((e) => [e.__was === true, e.dataset.ref]));
      if (chip.length !== 1 || !chip[0][0] || chip[0][1] !== tag) fail(`${name}: after an insertion the box's references are ${JSON.stringify(chip)}, not the one element that was there`);
      // a mention typed after the insertion is completed from its list
      await page.keyboard.type(" @ar");
      if (!await until(() => byTid(page, "mention-item").count().then((n) => n > 0), 10000)) fail(`${name}: typing @ar after an insertion opened no list of boards`);
      else {
        await page.keyboard.press("Enter");
        let v;
        if (!await until(async () => /@arch $/.test((v = await mockEval("return chats.c_A2_sketch.draft?.text ?? '';", url))), 10000)) fail(`${name}: the mention picked after an insertion left the draft ${JSON.stringify(v)}`);
      }
      // one more insertion, after the mention; then the message is sent as it stands
      await c.popup("after a mention");
      await page.keyboard.type("todo");
      await page.keyboard.press("Enter");
      let text;
      if (!await until(async () => (text = await mockEval("return chats.c_A2_sketch.draft?.text ?? '';", url)).endsWith("@arch " + TODO), 10000)) fail(`${name}: an insertion after a mention left the draft ${JSON.stringify(text)}`);
      await press(page, byTid(page, "send").first());
      let m;
      if (!await until(async () => (m = await mockEval("return items.c_A2_sketch.filter((x) => x.kind === 'user').at(-1) ?? null;", url))?.text?.includes(REVIEW), 10000)) fail(`${name}: the message sent is ${JSON.stringify(m)}`);
      else if (m.text.trim() !== text.trim() || !m.text.includes(tag) || !m.text.includes("@arch")) fail(`${name}: the message sent is ${JSON.stringify(m)}, not the draft ${JSON.stringify(text)} with its reference`);
      note(`${name}: a reference chip stays the element it was and stays in the draft, a mention is completed after an insertion, and the message has them and the text`);
    } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    await c.p.ctx.close();
  }

  // ---- an empty library, the way to the library popup, and another server's prompts
  {
    await seed(url, "A2"); // (anew: the chats' drafts are as seeded)
    await servers([]);
    await setLocal({ groups: [{ id: "g_git", name: "git", parent: "" }], prompts: [] });
    const name = "the popup and the libraries", first = ph ? "" : LINES[0];
    // (the library popup is closed by Esc; the Library screen of the phone's stack by its back button, which leaves the box as it was; the popup's Esc gives it the focus itself)
    const leaveLibrary = async () => {
      if (!ph) { await page.keyboard.press("Escape"); await c.shows("the library popup closed", (x) => x.library === 0); return; }
      await back(page);
      await c.shows("the Library screen left", (x) => x.library === 0);
      // (the phone does not give a box the focus back when a screen is left: the keyboard would rise unasked. The box is as it was: its text is, and the focus given to it by the script finds the cursor where it was)
      await c.box.evaluate((e) => e.focus());
      await c.shows("the box given the focus", (x) => x.focus === "box");
    };
    const c = await openBox(name, selOf("plain-started"), () => mockEval("return chats.c_plain.draft?.text ?? '';", url)), { page } = c;
    try {
      await page.waitForTimeout(1000); // (a page closed a moment ago may still be writing its draft: it is over when what is typed now is not overwritten)
      await c.empty();
      await page.keyboard.type("Hello world");
      for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
      let s = await c.popup("with an empty library");
      if (s.says !== "The library has no prompts yet.Open the library" || s.buttons.join("|") !== (ph ? "Cancel|Library|Open the library" : "Open the library") || s.rows.length) fail(`${name}: with an empty library the popup says ${JSON.stringify(s.says)} and has ${JSON.stringify(s.buttons)}`);
      // its button opens the library popup; closed, the box has the focus and its cursor
      await press(page, byTid(page, "insert-open-library"));
      await c.shows("the empty popup's button", (x) => x.open === 0 && x.library === 1 && (ph || x.focus === "library"));
      await leaveLibrary();
      await c.caret("back from the library popup", "Hello world", 5);

      // a prompt made meanwhile is in the popup that is open, with no reload
      await c.popup("before the library gets a prompt");
      await setLocal(LIBRARY);
      await c.shows("a library that changed under the open popup", (x) => x.rows.join("|") === LINES.join("|") && x.on.join("|") === first);
      // another server joins the list: its prompts are under its name, after this computer's, and every path has its server's name
      await servers([STUDIO]);
      await mockEval(`setLibrary("s_studio", ${JSON.stringify(THEIRS)});`, url);
      const both = [...LINES.map((l) => "This computer/" + l), "Studio/team/standup"];
      await c.shows("a server that joined", (x) => x.rows.join("|") === both.join("|") && !x.off.length);
      // the server's name and a prompt's name find the prompt
      await page.keyboard.type("studio stand");
      await c.shows("a search for the server's name and a prompt's name", (x) => x.rows.join("|") === "Studio/team/standup");
      // the server drops: its prompt is still listed, marked, and can be inserted
      await mockEval(`setServerState("s_studio", "unreachable");`, url);
      s = await c.shows("a server that dropped", (x) => x.rows.join("|") === "Studio/team/standup" && x.off.join("|") === "Studio/team/standup");
      await page.keyboard.press("Enter");
      await c.holds("a prompt of a server that dropped, inserted", "Hello" + THEIRS.prompts[0].text + " world");
      // "Edit the library" is the popup's way to the library popup, and gives the box its cursor back too
      await c.popup("before Edit the library");
      await press(page, byTid(page, ph ? "insert-library" : "insert-edit-library"));
      await c.shows(ph ? "Library" : "Edit the library", (x) => x.open === 0 && x.library === 1);
      await leaveLibrary();
      await c.caret("back from Edit the library", "Hello" + THEIRS.prompts[0].text + " world", 5 + THEIRS.prompts[0].text.length);
      // removed from the server list, it takes its prompts with it
      await c.popup("before the server is removed");
      await servers([]);
      await mockEval(`setLibrary("s_studio", null);`, url);
      await c.shows("a server removed from the list", (x) => x.rows.join("|") === LINES.join("|"));
      await page.keyboard.press("Escape");
      note(`${name}: an empty library is said and leads to the library popup; a library that changes, a server that joins, drops and leaves show in the open popup`);
    } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    await c.p.ctx.close();
  }

  // ---- the toolbar's "more": the entry of a row that has the chip and no room for the button. The phone layout (a window under 700 px) has no such row: its toolbar is "+", the dictation and
  // Talk or Send, and the way into the popup is the "+" sheet, which the sections above played through viaButton; so this section is the wide layouts' alone.
  if (ph) note("a new chat's toolbar: the phone has no \"more\" chip, its way to the insert popup is the \"+\" sheet (played above)");
  else {
    const name = "a new chat's toolbar";
    let found = false;
    // (the row's widths are the machine's font's: the first window in which the row has the chip and no button is taken; the sidebar is beside the page from 700 px, so the
    // narrowest chat page of a wide layout is 700 - 264 px; a window under 700 px is the phone layout)
    for (let width = 700; width <= 900 && !found; width += 10) {
      const c = await openBox(`${name} in a window of ${width} px`, selOf("plain-new"), () => mockEval("return chats.c_A2_new.draft?.text ?? '';", url), { size: [width, 640], wait: tidSel("send") }), { page } = c;
      try {
        await page.evaluate(() => document.fonts.ready);
        await frame(page);
        if (await byTid(page, "more-chip").count() && !await byTid(page, "insert-btn").count()) {
          found = true;
          await press(page, c.box);
          await page.keyboard.type("Hello world");
          for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
          const title = await byTid(page, "more-chip").getAttribute("title");
          if (!/insert a prompt$/.test(title ?? "")) fail(`${name}: the "more" chip's title is ${JSON.stringify(title)}`);
          await press(page, byTid(page, "more-chip"));
          const entry = byTid(page, "more-insert");
          if (await entry.count() !== 1) fail(`${name}: the open "more" popup has ${await entry.count()} entries of the insert popup`);
          else {
            await press(page, entry);
            await c.shows("the entry of the \"more\" popup", (x) => x.open === 1 && x.focus === "search");
            if (await byTid(page, "more-pop").count()) fail(`${name}: the "more" popup stayed open under the insert popup`);
            await page.keyboard.press("Enter");
            await c.holds("the entry of the \"more\" popup", "Hello" + COMMIT + " world");
            // with the keyboard: the chip, Enter, the entry, Enter
            await byTid(page, "more-chip").focus();
            await page.keyboard.press("Enter");
            await entry.focus();
            await page.keyboard.press("Enter");
            await c.shows("the entry, by the keyboard", (x) => x.open === 1 && x.focus === "search");
            await page.keyboard.press("Escape");
            await c.shows("Esc after the entry", (x) => x.open === 0 && x.focus === "box");
            note(`${name} in a window of ${width} px: the row has the "more" chip and no room for the Insert button, and the chip's popup has the entry`);
          }
        }
      } catch (e) { fail(`${name} in a window of ${width} px: ${e.message.split("\n")[0]}`); }
      await c.p.ctx.close();
    }
    if (!found) fail(`${name}: no window of 700 to 900 px has a row with the "more" chip and without the Insert button`);
  }
}, { viewports, page: false });
