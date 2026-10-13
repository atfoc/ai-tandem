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
import { act, check, measureComposer, mockEval, openPage, paneSize, seed, until } from "../shot.mjs";

const KEY = "ControlOrMeta+p";
const COMMIT = "Write a commit message.\n\n- a first line of 60 characters\n- then why", REVIEW = "Review this change.", TODO = "TODO: ";
const LIBRARY = { groups: [{ id: "g_git", name: "git", parent: "" }],
  prompts: [{ id: "p_todo", name: "todo", parent: "", text: TODO }, { id: "p_review", name: "review", parent: "g_git", text: REVIEW }, { id: "p_commit", name: "commit message", parent: "g_git", text: COMMIT }] };
const LINES = ["git/commit message", "git/review", "todo"]; // the order of the tree: a group before the prompts beside it, both by name
const STUDIO = { id: "s_studio", name: "Studio", address: "https://studio.example:4790", state: "connected", version: "dev" };
const THEIRS = { groups: [{ id: "g_team", name: "team", parent: "" }], prompts: [{ id: "p_stand", name: "standup", parent: "g_team", text: "What did you do yesterday?" }] };
const bare = (v) => v.replace(/\n+$/, ""); // (the break of an empty last line is the browser's)

/** In the page: notes every keydown before anything of the page gets it; prevented() answers which of the ⌘P presses
 *  since the last call were kept from the browser, read after the page has handled them. */
function watchKeys() {
  window.__keys = [];
  window.addEventListener("keydown", (e) => window.__keys.push(e), true);
  window.__pressed = () => window.__keys.splice(0).filter((e) => e.code === "KeyP").map((e) => e.defaultPrevented);
}
/** In the page: what the insert popup shows, and where the focus is. */
function seen() {
  const pop = document.querySelector(".ins-dialog"), at = document.activeElement;
  const line = (r) => (r.querySelector(".lib-path")?.textContent ?? "") + (r.querySelector(".lib-pname")?.textContent ?? "");
  return {
    open: document.querySelectorAll(".ins-dialog").length, rows: [...(pop?.querySelectorAll('[role="option"]') ?? [])].map(line),
    on: [...(pop?.querySelectorAll('[role="option"][aria-selected="true"]') ?? [])].map(line), off: [...(pop?.querySelectorAll('[role="option"]') ?? [])].filter((r) => r.querySelector(".lib-off")).map(line),
    fields: pop?.querySelectorAll("input, textarea, select, [contenteditable]").length ?? 0, buttons: [...(pop?.querySelectorAll("button") ?? [])].map((b) => b.textContent.trim()),
    says: pop?.querySelector(".ins-empty, .menu-empty")?.textContent ?? "",
    focus: !at || at === document.body ? "nothing" : at.matches(".ins-dialog input") ? "search" : at.matches(".composer-input") ? "box" : at.matches(".lib-dialog input") ? "library" : at.matches(".ins-dialog button") ? "button" : at.tagName.toLowerCase() + "." + at.className,
    selected: String(getSelection()), library: document.querySelectorAll(".lib-dialog").length,
  };
}

await check("PL5.2 the insert popup: ⌘P in a composer, the list, an insertion, Esc, the draft and what is sent", async ({ url, browser, fail, note }) => {
  const seeded = await seed(url, "A2");
  const selOf = (id) => seeded.find((s) => s.id === id)?.sel ?? fail(`the seed has no state ${id}`);
  const library = () => mockEval("return JSON.stringify(libraries);", url);
  const setLocal = (lib) => mockEval(`setLibrary("local", ${JSON.stringify(lib)});`, url);
  const servers = (list) => mockEval(`extra.servers = ${JSON.stringify([{ id: "local", local: true, name: "This computer", state: "connected" }, ...list])}; send({ type: "servers", servers: extra.servers, notice: "" });`, url);
  // (the seed's servers leave the list: this computer's library is the only one until Studio joins)
  await servers([]);
  await setLocal(LIBRARY);
  const start = await library();

  /** A page with one composer. saved(): the box's text as the server holds it in the draft. */
  const open = async (name, sel, saved, size = {}) => {
    const errors = [];
    const p = await openPage({ url, browser, sel, errors, wait: ".composer .composer-input", ...size });
    const { page } = p;
    await page.evaluate(watchKeys);
    const read = () => page.evaluate(seen);
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
    const empty = async () => { await page.locator(".composer .composer-input").first().click(); await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.press("Backspace"); };
    const close = async () => { for (const e of errors) fail(`${name}: page error: ${e}`); await p.ctx.close(); };
    return { page, read, shows, holds, popup, caret, empty, close };
  };

  // ---- a chat's composer
  const draftOf = () => mockEval("return chats.c_plain.draft?.text ?? '';", url);
  for (const [name, sel, elsewhere] of [["a chat's composer", selOf("plain-started"), ".thread .msg"]]) {
    const c = await open(name, sel, draftOf), { page } = c;
    try {
      // (the box is emptied by hand, as a user would)
      await c.empty();
      await page.keyboard.type("Hello world");
      for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
      await c.holds("typed", "Hello world");

      // the popup: the search has the focus, every prompt is listed in the order of the tree, the first is highlighted
      let s = await c.popup("in the middle of typed text");
      if (s.rows.join("|") !== LINES.join("|") || s.on.join("|") !== LINES[0]) fail(`${name}: the popup lists ${JSON.stringify(s.rows)} with ${JSON.stringify(s.on)} highlighted, not ${JSON.stringify(LINES)} with the first`);
      if (s.fields !== 1 || s.buttons.join("|") !== "Edit the library") fail(`${name}: the popup has ${s.fields} fields and the buttons ${JSON.stringify(s.buttons)}: something in it could change the library`);
      // held, the key is the popup's: no press of it reaches the browser, and there is one popup
      await page.keyboard.down("ControlOrMeta");
      for (let i = 0; i < 4; i++) await page.keyboard.down("p");
      await page.keyboard.up("p"); await page.keyboard.up("ControlOrMeta");
      let kept = await page.evaluate(() => window.__pressed());
      if (kept.length !== 4 || kept.some((k) => !k)) fail(`${name}: ⌘P held with the focus in the popup's search was left to the browser: ${JSON.stringify(kept)}`);
      // Tab stays in the popup: from the search to its button and back; the key is the popup's from the button too
      await page.keyboard.press("Tab");
      s = await c.shows("Tab from the search", (x) => x.focus === "button");
      await page.keyboard.press(KEY);
      kept = await page.evaluate(() => window.__pressed());
      if (kept.length !== 1 || !kept[0]) fail(`${name}: ⌘P with the focus on the popup's button was left to the browser: ${JSON.stringify(kept)}`);
      await page.keyboard.press("Tab");
      s = await c.shows("Tab from the popup's last control", (x) => x.focus === "search" && x.open === 1);
      // the arrow keys move the highlight, around the ends
      for (const [key, want] of [["ArrowDown", LINES[1]], ["ArrowDown", LINES[2]], ["ArrowDown", LINES[0]], ["ArrowUp", LINES[2]], ["ArrowUp", LINES[1]], ["ArrowUp", LINES[0]]]) {
        await page.keyboard.press(key);
        await c.shows(`${key}: the highlight on ${want}`, (x) => x.on.join("|") === want);
      }
      // a search lists what it finds, and an emptied one every prompt again
      await page.keyboard.type("GIT rev");
      await c.shows("a search", (x) => x.rows.join("|") === "git/review" && x.on.join("|") === "git/review");
      await page.keyboard.type("x");
      s = await c.shows("a search that finds nothing", (x) => x.rows.length === 0);
      if (s.says !== "No matching prompts") fail(`${name}: a search that finds nothing says ${JSON.stringify(s.says)}`);
      await page.keyboard.press("Enter"); // (nothing is highlighted: nothing is inserted, and the popup stays)
      await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.press("Backspace");
      await c.shows("the search emptied", (x) => x.open === 1 && x.rows.join("|") === LINES.join("|") && x.on.join("|") === LINES[0]);

      // Enter: the highlighted prompt's text where the cursor was, with its line breaks
      await page.keyboard.press("Enter");
      let text = "Hello" + COMMIT + " world";
      await c.holds("Enter in the middle of typed text", text);
      await c.caret("Enter in the middle of typed text", text, 5 + COMMIT.length);
      const shown = bare(await page.locator(".composer .composer-input").first().evaluate((e) => e.innerText));
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

      // in an empty box, by a click on a prompt that is not the highlighted one
      await c.empty();
      await c.holds("the box emptied", "");
      await c.popup("in an empty box");
      await page.locator('.ins-dialog [role="option"]').nth(1).click();
      await c.holds("a click in an empty box", REVIEW);
      await c.caret("a click in an empty box", REVIEW, REVIEW.length);

      // Esc: nothing is inserted, the cursor is where it was
      for (let i = 0; i < 7; i++) await page.keyboard.press("ArrowLeft");
      await c.popup("before Esc");
      await page.keyboard.type("commit");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Escape");
      await c.caret("Esc", REVIEW, REVIEW.length - 7);
      // and a selection is the selection it was; a click beside the popup closes it the same way
      for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowLeft");
      const was = (await c.read()).selected;
      await c.popup("with a selection, before Esc");
      await page.keyboard.press("Escape");
      s = await c.shows("Esc with a selection", (x) => x.open === 0 && x.focus === "box");
      if (s.selected !== was || was.length !== 4) fail(`${name}: after Esc ${JSON.stringify(s.selected)} is selected, not ${JSON.stringify(was)}`);
      await c.popup("before a click beside the popup");
      await page.mouse.click(8, 8);
      s = await c.shows("a click beside the popup", (x) => x.open === 0 && x.focus === "box");
      if (s.selected !== was) fail(`${name}: after a click beside the popup ${JSON.stringify(s.selected)} is selected, not ${JSON.stringify(was)}`);
      await c.holds("after Esc and a click beside the popup", REVIEW);

      // the focus stays in the popup: picked in the sidebar, an item gives its composer the focus a moment later
      // (focusComposer, 30 ms), and ⌘P pressed before that moment has its popup open by then
      { // (the chat's row, picked again)
        const picked = await page.evaluate(() => {
          const row = document.querySelector(".side-row.is-chat.on"), box = document.querySelector(".composer .composer-input"), mac = /Mac|iPhone|iPad/.test(navigator.platform);
          if (!row || !box) return false;
          row.click();
          box.dispatchEvent(new KeyboardEvent("keydown", { key: "p", code: "KeyP", metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true }));
          return true;
        });
        if (!picked) fail(`${name}: the sidebar has no row of the chat, or the page no composer`);
        await c.shows("⌘P right after the chat was picked", (x) => x.open === 1 && x.focus === "search");
        await page.evaluate(() => new Promise((ok) => setTimeout(ok, 300))); // (ten times the moment)
        s = await c.shows("a moment after the chat was picked", (x) => x.open === 1 && x.focus === "search");
        await page.keyboard.press("Escape");
        s = await c.shows("Esc after it", (x) => x.open === 0 && x.focus === "box");
        if (s.selected !== was) fail(`${name}: after ⌘P right after the chat was picked and Esc ${JSON.stringify(s.selected)} is selected, not ${JSON.stringify(was)}`);
        await c.holds("after ⌘P right after the chat was picked", REVIEW);
      }

      // the toolbar's button opens it for the box, with the cursor where it is
      await page.keyboard.press("ArrowRight"); // (the cursor to the end of the selection)
      const button = page.locator(".composer .composer-tools .insert-btn");
      if (await button.count() !== 1) fail(`${name}: the toolbar has ${await button.count()} Insert buttons`);
      else {
        await button.click();
        await c.shows("the Insert button", (x) => x.open === 1 && x.focus === "search");
        await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
        text = REVIEW.slice(0, REVIEW.length - 7) + TODO + REVIEW.slice(-7);
        await c.holds("the Insert button, the third prompt", text);
        await c.caret("the Insert button", text, REVIEW.length - 7 + TODO.length);
      }
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
      await page.locator(elsewhere).first().click({ position: { x: 5, y: 5 } });
      if ((await c.read()).focus === "box") fail(`${name}: a click on ${elsewhere} left the focus in the text box`);
      else await left(`after a click on ${elsewhere}`);
      await page.evaluate(() => { const i = document.createElement("input"); i.id = "other-field"; document.body.append(i); i.focus(); });
      await left("in another field");
      await page.evaluate(() => document.getElementById("other-field").remove());

      // the draft after a reload, and what is sent
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(".composer .composer-input", { timeout: 15000 });
      if (!await until(async () => bare(await page.locator(".composer .composer-input").first().evaluate((e) => e.innerText)) === text, 10000)) fail(`${name}: after a reload the box shows ${JSON.stringify(await page.locator(".composer .composer-input").first().evaluate((e) => e.innerText))}, not the draft ${JSON.stringify(text)}`);
      await c.empty();
      await page.keyboard.type("Before ");
      await page.evaluate(watchKeys);
      await c.popup("after a reload");
      await page.keyboard.press("Enter");
      text = "Before " + COMMIT;
      await c.holds("after a reload", text);
      await page.locator(".composer .send:not(.stop)").first().click();
      const sent = () => mockEval("return items.c_plain.filter((x) => x.kind === 'user').at(-1)?.text ?? '';", url);
      let got;
      if (!await until(async () => (got = await sent()) === text, 10000)) fail(`${name}: what was sent is ${JSON.stringify(got)}, not ${JSON.stringify(text)}`);
      note(`${name}: ⌘P opens the popup and is never the browser's there, Enter and a click insert at the cursor, Esc leaves the box as it was, the draft and what is sent have the text`);
    } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    await c.close();
  }
  if (await library() !== start) fail("the library changed while only the insert popup was used");

  // ---- reference chips and mentions, in a chat beside a board
  {
    const name = "a chat beside a board", c = await open(name, selOf("board-selected"), () => mockEval("return chats.c_A2_sketch.draft?.text ?? '';", url), paneSize("panel", 420)), { page } = c;
    try {
      await page.waitForSelector(".excalidraw:not(.excalidraw--view-mode) canvas.interactive", { timeout: 15000 });
      await act(page, "select");
      await page.waitForSelector(".composer .ctx-act:not([disabled])", { timeout: 10000 });
      await page.keyboard.press("ControlOrMeta+l");
      if (!await until(() => page.locator(".composer-input .ref-chip").count().then((n) => n === 1), 10000)) fail(`${name}: ⌘L with shapes selected put ${await page.locator(".composer-input .ref-chip").count()} references into the message`);
      const tag = await page.locator(".composer-input .ref-chip").evaluate((e) => { e.__was = true; return e.dataset.ref; });
      await page.locator(".composer .composer-input").click();
      await page.keyboard.press("ControlOrMeta+ArrowDown"); await page.keyboard.press("End"); // (the end of the box, on a Mac and elsewhere)
      await page.keyboard.type("see ");
      let before = await mockEval("return chats.c_A2_sketch.draft?.text ?? '';", url);
      if (!await until(async () => (before = await mockEval("return chats.c_A2_sketch.draft?.text ?? '';", url)).includes("see"), 10000) || !before.includes(tag)) fail(`${name}: the draft with a reference holds ${JSON.stringify(before)}`);
      await c.popup("beside a reference");
      await page.keyboard.type("review");
      await page.keyboard.press("Enter");
      await c.holds("an insertion beside a reference", bare(before) + (before.endsWith(" ") ? "" : " ") + REVIEW);
      const chip = await page.evaluate(() => [...document.querySelectorAll(".composer-input .ref-chip")].map((e) => [e.__was === true, e.dataset.ref]));
      if (chip.length !== 1 || !chip[0][0] || chip[0][1] !== tag) fail(`${name}: after an insertion the box's references are ${JSON.stringify(chip)}, not the one element that was there`);
      // a mention typed after the insertion is completed from its list
      await page.keyboard.type(" @ar");
      if (!await until(() => page.locator(".mention-pop .menu-item").count().then((n) => n > 0), 10000)) fail(`${name}: typing @ar after an insertion opened no list of boards`);
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
      await page.locator(".composer .send:not(.stop)").first().click();
      let m;
      if (!await until(async () => (m = await mockEval("return items.c_A2_sketch.filter((x) => x.kind === 'user').at(-1) ?? null;", url))?.text?.includes(REVIEW), 10000)) fail(`${name}: the message sent is ${JSON.stringify(m)}`);
      else if (m.text.trim() !== text.trim() || !m.text.includes(tag) || !m.text.includes("@arch")) fail(`${name}: the message sent is ${JSON.stringify(m)}, not the draft ${JSON.stringify(text)} with its reference`);
      note(`${name}: a reference chip stays the element it was and stays in the draft, a mention is completed after an insertion, and the message has them and the text`);
    } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    await c.close();
  }

  // ---- an empty library, the way to the library popup, and another server's prompts
  {
    await seed(url, "A2"); // (anew: the chats' drafts are as seeded)
    await servers([]);
    await setLocal({ groups: [{ id: "g_git", name: "git", parent: "" }], prompts: [] });
    const name = "the popup and the libraries", c = await open(name, selOf("plain-started"), () => mockEval("return chats.c_plain.draft?.text ?? '';", url)), { page } = c;
    try {
      await c.empty();
      await page.keyboard.type("Hello world");
      for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
      let s = await c.popup("with an empty library");
      if (s.says !== "The library has no prompts yet.Open the library" || s.buttons.join("|") !== "Open the library" || s.rows.length) fail(`${name}: with an empty library the popup says ${JSON.stringify(s.says)} and has ${JSON.stringify(s.buttons)}`);
      // its button opens the library popup; closed, the box has the focus and its cursor
      await page.locator(".ins-dialog button").click();
      await c.shows("the empty popup's button", (x) => x.open === 0 && x.library === 1 && x.focus === "library");
      await page.keyboard.press("Escape");
      await c.shows("the library popup closed", (x) => x.library === 0);
      await c.caret("back from the library popup", "Hello world", 5);

      // a prompt made meanwhile is in the popup that is open, with no reload
      await c.popup("before the library gets a prompt");
      await setLocal(LIBRARY);
      await c.shows("a library that changed under the open popup", (x) => x.rows.join("|") === LINES.join("|") && x.on.join("|") === LINES[0]);
      // another server joins the list: its prompts are under its name, after this computer's, and every path has its server's name
      await servers([STUDIO]);
      await mockEval(`setLibrary("s_studio", ${JSON.stringify(THEIRS)});`, url);
      const both = [...LINES.map((l) => "This computer/" + l), "Studio/team/standup"];
      await c.shows("a server that joined", (x) => x.rows.join("|") === both.join("|") && !x.off.length);
      // the server's name and a prompt's name find the prompt
      await page.keyboard.type("studio stand");
      await c.shows("a search for the server's name and a prompt's name", (x) => x.rows.join("|") === "Studio/team/standup");
      // the server drops: its prompt is still listed, marked, and can be inserted
      await mockEval(`libraries.s_studio.connected = false; sendLibrary("s_studio"); extra.servers[1].state = "unreachable"; send({ type: "server_state", server: extra.servers[1] });`, url);
      s = await c.shows("a server that dropped", (x) => x.rows.join("|") === "Studio/team/standup" && x.off.join("|") === "Studio/team/standup");
      await page.keyboard.press("Enter");
      await c.holds("a prompt of a server that dropped, inserted", "Hello" + THEIRS.prompts[0].text + " world");
      // "Edit the library" is the popup's way to the library popup, and gives the box its cursor back too
      await c.popup("before Edit the library");
      await page.locator(".ins-dialog .ins-foot button").click();
      await c.shows("Edit the library", (x) => x.open === 0 && x.library === 1);
      await page.keyboard.press("Escape");
      await c.caret("back from Edit the library", "Hello" + THEIRS.prompts[0].text + " world", 5 + THEIRS.prompts[0].text.length);
      // removed from the server list, it takes its prompts with it
      await c.popup("before the server is removed");
      await servers([]);
      await mockEval(`setLibrary("s_studio", null);`, url);
      await c.shows("a server removed from the list", (x) => x.rows.join("|") === LINES.join("|"));
      await page.keyboard.press("Escape");
      note(`${name}: an empty library is said and leads to the library popup; a library that changes, a server that joins, drops and leaves show in the open popup`);
    } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); }
    await c.close();
  }

  // ---- the toolbar's "more": the entry of a row that has the chip and no room for the button
  {
    const name = "a new chat's toolbar";
    let found = false;
    // (the row's widths are the machine's font's: the first pane in which the row has the chip and no button is taken)
    for (let width = 320; width <= 520 && !found; width += 10) {
      const c = await open(`${name} in a page of ${width} px`, selOf("plain-new"), () => mockEval("return chats.c_A2_new.draft?.text ?? '';", url), paneSize("page", width)), { page } = c;
      try {
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok()))));
        if (await page.locator(".composer .more-chip").count() && !await page.locator(".composer .composer-tools .insert-btn").count()) {
          found = true;
          await page.locator(".composer .composer-input").click();
          await page.keyboard.type("Hello world");
          for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
          const title = await page.locator(".composer .more-chip").getAttribute("title");
          if (!/insert a prompt$/.test(title ?? "")) fail(`${name}: the "more" chip's title is ${JSON.stringify(title)}`);
          await page.locator(".composer .more-chip").click();
          const entry = page.locator(".composer .more-pop .more-insert");
          if (await entry.count() !== 1) fail(`${name}: the open "more" popup has ${await entry.count()} entries of the insert popup`);
          else {
            const m = (await measureComposer(page)).find((x) => !x.none);
            if (!m || m.past || m.send !== "ok" || m.docScroll > 0) fail(`${name}: the composer does not fit with the popup open: ${JSON.stringify(m && { past: m.past, over: m.over, send: m.send })}`);
            await entry.click();
            await c.shows("the entry of the \"more\" popup", (x) => x.open === 1 && x.focus === "search");
            if (await page.locator(".composer .more-pop").count()) fail(`${name}: the "more" popup stayed open under the insert popup`);
            await page.keyboard.press("Enter");
            await c.holds("the entry of the \"more\" popup", "Hello" + COMMIT + " world");
            // with the keyboard: the chip, Tab to the entry, Enter
            await page.locator(".composer .more-chip").focus();
            await page.keyboard.press("Enter");
            await entry.focus();
            await page.keyboard.press("Enter");
            await c.shows("the entry, by the keyboard", (x) => x.open === 1 && x.focus === "search");
            await page.keyboard.press("Escape");
            await c.shows("Esc after the entry", (x) => x.open === 0 && x.focus === "box");
            note(`${name} in a page of ${width} px: the row has the "more" chip and no room for the Insert button, and the chip's popup has the entry`);
          }
        }
      } catch (e) { fail(`${name} in a page of ${width} px: ${e.message.split("\n")[0]}`); }
      await c.close();
    }
    if (!found) fail(`${name}: no page of 320 to 520 px has a row with the "more" chip and without the Insert button`);
  }
});
