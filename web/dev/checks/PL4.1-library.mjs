// Proves the library popup in the app (plans/prompt-library.md, sections 4 and 7; section 10, lines 7 to 10, line 4,
// and lines 19, 22, 23 and 25 as far as the page goes). The insert popup is PL5.2's; the rules of a library are its
// server's (the mock answers with the server's sentences), and what two real servers do is the Go tests'.
//   The button is at the sidebar's foot between Servers and the theme picker, on their line. Enter on it opens the
//   popup with the focus in its search; Esc, a click beside it and Close close it, and the focus is on the button
//   again. Without another server the tree has no level of servers: groups before prompts, both by name. A group
//   closes and opens, by its twist and by the arrow keys, which also walk the rows from the search.
//   A search shows the flat list of what it finds, each with its path, in the order of the goal file's example;
//   emptied, the tree is back.
//   The editor has the chosen prompt's name and text, and says where the prompt is; it has no choice of a group. A
//   save the server refuses (a name of its group, in another case; a prompt deleted meanwhile) shows the server's
//   sentence and keeps what was typed. Leaving a prompt with unsaved changes asks first: Cancel keeps them, Discard
//   drops them; Esc asks too. The buttons under the tree make a new prompt in the chosen group and a new group beside
//   the chosen prompt, and the tree shows the new item's row where it goes; a prompt is moved by dragging it onto
//   another group. A name with "/" is said before the save. Deleting asks first, and a group's question says how
//   many prompts go with it. (The menu of a right click, the moves and their refusals are PL6.1's.)
//   A change made in a second window shows in the first with no reload: a new prompt in the tree, a new text in the
//   editor that has nothing unsaved; what is typed there stays, and the later save wins.
//   Another server joins the list while the popup is open: the tree has one entry per server, this computer first,
//   and a search for the server's name and a prompt's name finds the prompt. A prompt made at the top of that
//   server's entry is made there. When the server drops its prompts stay, it is marked "not connected", nothing of
//   it can be changed and nothing new goes there; back, it can be changed again. A call refused on the way to it
//   shows the reason and keeps what was typed. Removed from the list, it takes its entry and its prompts with it,
//   and the tree has no level of servers again.
// At the phone (ux-improvements S4) there is no popup: the library is the Library screen (`lib-screen`, pushed from Settings' Prompt library row, and from
// the sidebar foot's button where the phone still has it), a group is a pushed screen (`lib-group-screen`, its back naming the screen below), the editor is a
// P3 sheet (`prompt-editor`), the Group row opens the move picker (P2), a new or renamed group is a P3 (`group-form`), a delete is a P4 (`confirm-sheet`).
// `playPhone` below proves the same behaviours through those screens, with the phone's words (read from the screens, not from the popup's `seen()`):
//   the Library screen opens with its search; without another server no section titles; groups before prompts, both by name; a group opens (pushed, back
//   names the screen below) and back returns; a search is the flat list of hits with their paths in the example's order ("No prompts match" for none), emptied the
//   lists are back; a prompt's editor (a tap, or a tap on a hit) has its name and text and says where it is in its Group row; a save the server refuses (a name of
//   its group in another case; a prompt deleted meanwhile) is the server's sentence in `form-error` with what was typed kept; leaving with unsaved changes asks
//   (Keep editing keeps them, Discard changes drops them, a press on the dimmed page asks too); "+" > New prompt makes a prompt at the top level, a group's
//   "New prompt here" one in that group, a group's "New group here" a group in it, "+" > New group a group at the top, and the lists show them; a name with "/" is
//   said before the save; deleting asks first, and a group's question says "Delete group and N prompts"; a change made behind the page (the second window's
//   save reaches the page as the stream's library event, so the check changes the mock's library) shows with no reload: a new prompt in the list, a new text in an
//   editor with nothing unsaved; what is typed stays and the later save wins; another server joining gives one titled section per server (this computer first), a
//   search for the server's name and a prompt's name finds the prompt, a prompt made with the Group row set to that server's top level is made there; when the server
//   drops its prompts stay, its section has the one not-connected notice, its editor is read-only with Save, the Group row and Delete off, "New prompt here" waits and
//   nothing new can be put there; back, it can be changed again; a call refused on the way shows the reason with what was typed kept; removed from the list its section
//   and prompts are gone and no section is titled again.
//   Left out at the phone, having no counterpart: the sidebar foot's button between Servers and the picker, Enter on it, Esc, Close and a press beside the popup,
//   the focus going back to the button (a pushed screen has its back and a sheet its Cancel); the ⌘P-style keys, Tab and the tree's arrow keys; the tree's twists
//   (a group is a screen); the buttons under the tree and the chosen row (the editor is a sheet over the list); dragging (a move is the picker, swipe and long press,
//   PL6.1's, with UX.S4.1 and UX.S4.2); Revert (Cancel and the leave guard); a server's entry in the tree (a prompt goes to a server by the editor's Group row, a
//   picker's Top level of that server).
// Ports dev/checks/PL4.1-library.mjs (S11) to the new build, at the three viewports (C-PL-01, 03 to 11, 15 to 18, 23; the popup is a dialog at the desktop and the tablet, the screens above on the phone, with the
// same words where there are the same things). What changed: the selectors (testIDs, `library.mjs` reads the popup), the presses (a click with a mouse, a tap with a finger), the drag (a pointer gesture: the mouse
// drags at once, a finger is held first), the question that asks before a drop (`confirm-dialog`), and "a click beside the popup" is a press at the window's corner, on the dimmed page.
import { check, mockEval, seed, until } from "../shot.mjs";
import { byTid, pointerDragger, press, showList, tidSel } from "./sel.mjs";
import { seen } from "./library.mjs";
import { atRest } from "./settings.mjs";
import { barOf, openGroup, openLibrary, pressSheetRow, rowsOf, sectionsOf, sheetOf, texts, topScreen } from "./libphone.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const g = (id, name, parent = "") => ({ id, name, parent }), p = (id, name, parent, text) => ({ id, name, parent, text });
// The example of the goal file, section 6.
const EXAMPLE = { groups: [g("g_misc", "misc"), g("g_gc", "git commit"), g("g_git", "git")],
  prompts: [p("p_style", "git commit style", "g_misc", "Use the imperative."), p("p_review", "review", "g_git", "Review this change."), p("p_squash", "squash", "g_gc", "Squash them."), p("p_msg", "commit message", "g_git", "Write a commit message.")] };
const TREE = ["git", "  commit message", "  review", "git commit", "  squash", "misc", "  git commit style"];
const SEARCHES = [["git commit", ["git/commit message", "misc/git commit style", "git commit/squash"]], ["com mes", ["git/commit message"]], ["mes com", []],
  ["GIT", ["misc/git commit style", "git/commit message", "git/review", "git commit/squash"]]];
const STUDIO = { id: "s_studio", name: "Studio", address: "https://studio.example:4790", state: "connected", version: "dev" };
const THEIRS = { groups: [g("g_team", "team")], prompts: [p("p_stand", "standup", "g_team", "What did you do yesterday?")] };
const TOP = "At the top level";
const NONE = "Choose a prompt to edit it, or make a new one. Right-click in the list to make one there; drag a prompt or a group to move it.";

// ---- the phone's half: the same behaviours through the Library screen, a group's screen and the sheets
const PHONE_TOP = ["git", "git commit", "misc"];
const ARROW = " › ";
// a hit of the wide list ("git/commit message") as the phone says it: the path under the name ("git", "This computer › git"), "Top level" for none
const phoneHit = (line) => { const p = line.split("/"); return `${p.slice(0, -1).join(ARROW) || "Top level"}|${p[p.length - 1]}`; };

async function playPhone({ url, open, fail, note }) {
  const { page } = await open();
  const lib = (server = "local") => mockEval(`return libraries[${JSON.stringify(server)}] ?? null;`, url);
  const servers = (list) => mockEval(`setServers(${JSON.stringify(list)});`, url);
  const setLib = (server, l) => mockEval(`setLibrary(${JSON.stringify(server)}, ${JSON.stringify(l)});`, url);
  await servers([]); // (the seed's servers leave the list: this computer's library is the only one until Studio joins)
  await setLib("local", EXAMPLE);

  // ---- what the screens show now
  /** The editor on top, or null. */
  const editorOf = () => page.evaluate(() => {
    const T = (id) => [...document.querySelectorAll(`[data-testid="${id}"]`)].pop();
    if (!T("prompt-editor")) return null;
    const txt = (id) => T(id)?.innerText.replace(/\s+/g, " ").trim() ?? "", off = (id) => T(id)?.getAttribute("aria-disabled") === "true", ro = (e) => !!e && (e.readOnly || e.disabled);
    return { title: txt("sheet-title"), name: T("editor-name")?.value ?? "", text: T("editor-text")?.value ?? "", group: txt("editor-group-row"), problem: txt("editor-problem"), err: txt("form-error"),
      notice: txt("editor-off-notice"), saveOff: off("sheet-right"), groupOff: off("editor-group-row"), deleteOff: T("editor-delete") ? off("editor-delete") : null, roName: ro(T("editor-name")), roText: ro(T("editor-text")) };
  });
  /** The group form on top, or null. */
  const formOf = () => page.evaluate(() => {
    const T = (id) => [...document.querySelectorAll(`[data-testid="${id}"]`)].pop();
    if (!T("group-form")) return null;
    const txt = (id) => T(id)?.innerText.replace(/\s+/g, " ").trim() ?? "";
    return { title: txt("sheet-title"), name: T("group-form-name")?.value ?? "", where: txt("group-form-where"), problem: txt("group-form-problem"), err: txt("form-error"), saveOff: T("sheet-right")?.getAttribute("aria-disabled") === "true" };
  });
  /** The question (P4) on top, or null. */
  const askOf = () => page.evaluate(() => {
    const T = (id) => [...document.querySelectorAll(`[data-testid="${id}"]`)].pop();
    if (!T("confirm-sheet")) return null;
    const txt = (id) => T(id)?.innerText.replace(/\s+/g, " ").trim() ?? "";
    return { title: txt("confirm-title"), body: txt("confirm-body"), go: txt("confirm-go"), alt: txt("confirm-alt"), cancel: txt("confirm-cancel") };
  });
  const read = async () => {
    const [top, bar, rows, secs, ed, form, ask, none, notices] = await Promise.all([topScreen(page), barOf(page), rowsOf(page), sectionsOf(page), editorOf(), formOf(), askOf(), texts(page, "lib-phone-none"), texts(page, "lib-off-notice")]);
    return { top: top.testId, back: bar.back, title: bar.title, rows, secs, ed, form, ask, none: none[0] ?? "", notices, names: rows.map((r) => r.name).join("|"), hits: rows.filter((r) => r.kind === "hit").map((r) => `${r.sub}|${r.name}`) };
  };
  /** Waits for the screens to show what `want` says; fails with what they show. */
  const shows = async (what, want) => {
    let s;
    if (!await until(async () => want((s = await read())), 10000)) fail(`${what}: the screens show ${JSON.stringify({ ...s, rows: s.rows.map((r) => `${r.kind} ${r.name}`) })}`);
    return s;
  };

  // ---- what is pressed
  const search = () => byTid(page, "lib-phone-search").last();
  const plus = async (action) => { await press(page, byTid(page, "lib-plus").last()); await byTid(page, "action-sheet").last().waitFor({ state: "visible", timeout: 10000 }); await atRest(page, "action-row"); await pressSheetRow(page, "action-sheet", action); };
  const row = (kind, id) => byTid(page, `lib-${kind}-row`, { id }).last();
  const field = (id) => byTid(page, id).last();
  const sheetBtn = (side) => byTid(page, `sheet-${side}`).last();
  const goBack = async () => { await press(page, byTid(page, "nav-back").last()); };
  /** The Library screen on top, whatever group screens are over it. */
  const home = async () => {
    for (let i = 0; i < 6 && (await topScreen(page)).testId !== "lib-screen"; i++) { await goBack(); await page.waitForTimeout(300); }
    await atRest(page, "lib-screen");
  };
  /** The editor, the group form and any question closed: Cancel, and Discard changes when it asks. */
  const closeSheets = async () => {
    for (let i = 0; i < 4; i++) {
      if (await byTid(page, "confirm-sheet").count()) { await press(page, byTid(page, "confirm-go").last()); await page.waitForTimeout(300); continue; }
      if (await byTid(page, "prompt-editor").count() || await byTid(page, "group-form").count()) { await press(page, sheetBtn("left")); await page.waitForTimeout(400); continue; }
      break;
    }
    if (!await until(async () => !(await byTid(page, "prompt-editor").count()) && !(await byTid(page, "group-form").count()) && !(await byTid(page, "confirm-sheet").count()), 10000)) fail(`a sheet is still open: ${JSON.stringify(await read())}`);
  };
  const reset = async (l = EXAMPLE) => { await closeSheets(); await setLib("local", l); await home(); await shows("the example again", (s) => s.top === "lib-screen" && s.names === PHONE_TOP.join("|")); };
  /** Presses a prompt's row on the screen on top and waits for its editor. */
  const edit = async (id, name) => { await press(page, row("prompt", id)); return shows(`the editor of "${name}"`, (s) => s.ed?.name === name); };
  const save = () => press(page, sheetBtn("right"));

  try {
    // ---- the Library screen: from the sidebar foot where the phone has its button, and from Settings
    const foot = byTid(page, "library-btn").first();
    if (await foot.isVisible().catch(() => false)) {
      await press(page, foot);
      let s = await shows("the sidebar foot's button", (x) => x.top === "lib-screen");
      if (s.title !== "Prompt library") fail(`the foot's button opens a screen titled ${JSON.stringify(s.title)}`);
      await showList(page);
    } else note("the phone's sidebar foot has no Library button: the Library screen is reached from Settings' Prompt library row only");
    await openLibrary(page);
    let s = await shows("the Library screen", (x) => x.top === "lib-screen" && x.names === PHONE_TOP.join("|"));
    if (s.title !== "Prompt library" || s.back !== "Settings") fail(`the Library screen's bar says back ${JSON.stringify(s.back)}, title ${JSON.stringify(s.title)}`);
    if (await byTid(page, "lib-phone-search").count() < 1 || (await search().getAttribute("placeholder")) !== "Search prompts") fail("the Library screen has no search");
    if (s.rows.some((r) => r.kind !== "group") || s.secs.length !== 1 || s.secs[0].title) fail(`one library: the sections are ${JSON.stringify(s.secs)} and the rows ${JSON.stringify(s.rows.map((r) => r.kind))}, not one section with no title of groups`);
    // groups before prompts, both by name
    await setLib("local", { ...EXAMPLE, prompts: [...EXAMPLE.prompts, p("p_zeta", "zeta", "", "Z."), p("p_alpha", "Alpha", "", "A.")] });
    s = await shows("groups before prompts", (x) => x.names === [...PHONE_TOP, "Alpha", "zeta"].join("|") && x.rows.map((r) => r.kind).join() === "group,group,group,prompt,prompt");
    await setLib("local", EXAMPLE);
    // a group opens (pushed), and back returns
    await openGroup(page, "g_git");
    s = await shows("the group git", (x) => x.top === "lib-group-screen" && x.title === "git" && x.names === "commit message|review" && x.rows.every((r) => r.kind === "prompt"));
    if (s.back !== "Prompt library") fail(`the group screen's back is ${JSON.stringify(s.back)}, not "Prompt library"`);
    await goBack();
    await shows("back from the group", (x) => x.top === "lib-screen" && x.title === "Prompt library" && x.names === PHONE_TOP.join("|"));
    note("the Library screen opens with its search and no section titles, groups before prompts; a group opens and back returns");

    // ---- the search: the flat list of hits, in the order of the goal file's example
    for (const [query, want] of SEARCHES) {
      await search().fill(query);
      s = await shows(`the search "${query}"`, (x) => x.rows.every((r) => r.kind === "hit") && x.hits.join("&") === want.map(phoneHit).join("&") && (want.length || x.none === `No prompts match “${query}”`));
      if (!want.length && s.rows.length) fail(`the search "${query}" finds ${JSON.stringify(s.hits)}`);
      if (s.secs.length) fail(`the search "${query}" shows the sections too: ${JSON.stringify(s.secs)}`);
    }
    await search().fill("squ");
    await shows("a search for squash", (x) => x.hits.join() === "git commit|squash");
    await press(page, row("hit", "p_squash"));
    s = await shows("a tap on a prompt found", (x) => x.ed?.name === "squash");
    if (s.ed.text !== "Squash them." || s.ed.group !== "Group git commit" || s.ed.title !== "Prompt" || !s.ed.saveOff) fail(`the editor of "squash" shows ${JSON.stringify(s.ed)}`);
    await closeSheets();
    await search().fill("");
    await shows("the search emptied", (x) => x.top === "lib-screen" && x.names === PHONE_TOP.join("|") && x.rows.every((r) => r.kind === "group"));
    note("the four searches of the example give its results in its order, with their paths; a tap on a hit opens the editor; emptied, the lists are back");

    // ---- the editor, and a save the server refuses: the reason, and what was typed
    await openGroup(page, "g_git");
    s = await edit("p_msg", "commit message");
    if (s.ed.text !== "Write a commit message." || s.ed.group !== "Group git" || s.ed.title !== "Prompt" || !s.ed.saveOff) fail(`the editor of "commit message" shows ${JSON.stringify(s.ed)}`);
    await field("editor-name").fill("REVIEW");
    await field("editor-text").fill("Typed text.\nA second line.");
    await save();
    s = await shows("a name of its group, in another case", (x) => !!x.ed?.err);
    if (s.ed.err !== 'There is already a prompt called "review" in the group "git".' || s.ed.name !== "REVIEW" || s.ed.text !== "Typed text.\nA second line.") fail(`a refused save left ${JSON.stringify(s.ed)}`);
    if ((await lib()).prompts.find((x) => x.id === "p_msg").name !== "commit message") fail("a refused save changed the prompt");
    // the same name in another group is taken, and the sheet closes
    await field("editor-name").fill("squash");
    await save();
    await shows("the same name in another group", (x) => !x.ed && x.names === "review|squash");
    let saved = (await lib()).prompts.find((x) => x.id === "p_msg");
    if (saved.name !== "squash" || saved.text !== "Typed text.\nA second line." || saved.parent !== "g_git") fail(`the saved prompt is ${JSON.stringify(saved)}`);
    // a prompt deleted meanwhile: what was typed stays, and the save says why it cannot be
    await edit("p_msg", "squash");
    await field("editor-text").fill("Typed over a prompt that is gone.");
    await mockEval(`libraries.local.prompts = libraries.local.prompts.filter((x) => x.id !== "p_msg"); sendLibrary("local");`, url);
    s = await shows("a prompt deleted under what was typed", (x) => x.names === "review" && x.ed?.text === "Typed over a prompt that is gone.");
    await save();
    s = await shows("the save of a prompt that is gone", (x) => !!x.ed?.err);
    if (s.ed.err !== "This prompt no longer exists." || s.ed.text !== "Typed over a prompt that is gone.") fail(`the save of a prompt that is gone left ${JSON.stringify(s.ed)}`);
    await closeSheets();
    await reset();
    note("a refused save shows the server's sentence and keeps the typed name and text, for a name that is taken and for a prompt deleted meanwhile");

    // ---- unsaved changes: leaving asks first
    await search().fill("review");
    await shows("a search for review", (x) => x.hits.join() === "git|review");
    await press(page, row("hit", "p_review"));
    await shows("the editor of review", (x) => x.ed?.name === "review");
    await field("editor-text").fill("Not saved yet.");
    await press(page, sheetBtn("left"));
    s = await shows("leaving a prompt with unsaved changes", (x) => !!x.ask);
    if (s.ask.title !== "Discard changes to “review”?" || s.ask.body !== "The changes to the prompt “review” are not saved. Discarding goes back to the saved text." || [s.ask.go, s.ask.alt, s.ask.cancel].join() !== "Discard changes,Save and close,Keep editing") fail(`the question is ${JSON.stringify(s.ask)}`);
    await press(page, byTid(page, "confirm-cancel").last());
    await shows("Keep editing", (x) => !x.ask && x.ed?.name === "review" && x.ed.text === "Not saved yet.");
    await page.touchscreen.tap(10, 6); // (a press on the dimmed page above the sheet)
    await shows("a press on the dimmed page", (x) => !!x.ask && x.ed?.text === "Not saved yet.");
    await press(page, byTid(page, "confirm-cancel").last());
    await shows("Keep editing, once more", (x) => !x.ask && x.ed?.text === "Not saved yet.");
    await press(page, sheetBtn("left"));
    await shows("leaving again", (x) => !!x.ask);
    await press(page, byTid(page, "confirm-go").last());
    await shows("Discard changes", (x) => !x.ask && !x.ed && x.top === "lib-screen");
    if ((await lib()).prompts.find((x) => x.id === "p_review").text !== "Review this change.") fail("what was discarded was saved");
    // (with nothing typed nothing is asked, and what was discarded is gone when the editor opens again)
    await press(page, row("hit", "p_review"));
    s = await shows("the prompt as it is saved", (x) => x.ed?.text === "Review this change.");
    await press(page, sheetBtn("left"));
    await shows("leaving a prompt with nothing typed", (x) => !x.ask && !x.ed);
    await search().fill("");
    note("leaving unsaved changes asks: Keep editing keeps them, Discard changes drops them, a press on the dimmed page asks too");

    // ---- new items, and the names the screens check themselves
    await reset();
    await plus("new-prompt");
    s = await shows("New prompt at the top", (x) => x.ed?.title === "New prompt");
    if (s.ed.group !== "Group Top level" || s.ed.name !== "" || s.ed.text !== "" || !s.ed.saveOff) fail(`a new prompt at the top starts as ${JSON.stringify(s.ed)}`);
    await field("editor-name").fill("a/b");
    s = await shows("a name with a slash", (x) => !!x.ed?.problem);
    if (s.ed.problem !== 'A name cannot contain "/".' || !s.ed.saveOff) fail(`a name with "/" leaves ${JSON.stringify(s.ed)}`);
    await field("editor-name").fill("todo-top");
    await field("editor-text").fill("TODO: ");
    await save();
    await shows("a new prompt saved at the top", (x) => !x.ed && x.names === [...PHONE_TOP, "todo-top"].join("|") && x.rows[3].kind === "prompt");
    let made = (await lib()).prompts.find((x) => x.name === "todo-top");
    if (!made || made.parent !== "" || made.text !== "TODO: ") fail(`the new prompt at the top is ${JSON.stringify(made)}`);
    // "New prompt here" of a group makes the prompt in that group
    await openGroup(page, "g_misc");
    await press(page, byTid(page, "lib-new-here").last());
    s = await shows("New prompt here", (x) => x.ed?.title === "New prompt");
    if (s.ed.group !== "Group misc" || s.ed.name !== "" || s.ed.text !== "" || !s.ed.saveOff) fail(`a new prompt in "misc" starts as ${JSON.stringify(s.ed)}`);
    await field("editor-name").fill("todo");
    await field("editor-text").fill("x");
    await save();
    await shows("a new prompt saved in the group", (x) => !x.ed && x.top === "lib-group-screen" && x.names === "git commit style|todo");
    made = (await lib()).prompts.find((x) => x.name === "todo");
    if (!made || made.parent !== "g_misc" || made.text !== "x") fail(`the new prompt in "misc" is ${JSON.stringify(made)}`);
    // "New group here" of a group makes a group in it, its name checked before the save
    await press(page, byTid(page, "lib-more").last());
    await byTid(page, "action-sheet").last().waitFor({ state: "visible", timeout: 10000 });
    await atRest(page, "action-row");
    await pressSheetRow(page, "action-sheet", "new-group");
    s = await shows("New group here", (x) => x.form?.title === "New group");
    if (s.form.where !== "In misc" || s.form.name !== "" || !s.form.saveOff) fail(`a new group in "misc" starts as ${JSON.stringify(s.form)}`);
    await field("group-form-name").fill("a/b");
    s = await shows("a group name with a slash", (x) => !!x.form?.problem);
    if (s.form.problem !== 'A name cannot contain "/".' || !s.form.saveOff) fail(`a group name with "/" leaves ${JSON.stringify(s.form)}`);
    await field("group-form-name").fill("inner");
    await save();
    s = await shows("a new group saved in the group", (x) => !x.form && x.names === "inner|git commit style|todo" && x.rows[0].kind === "group");
    const inner = (await lib()).groups.find((x) => x.name === "inner");
    if (!inner || inner.parent !== "g_misc") fail(`the new group is ${JSON.stringify(inner)}`);
    // (a nested group's back names the screen below)
    await openGroup(page, inner.id);
    s = await shows("the nested group", (x) => x.top === "lib-group-screen" && x.title === "inner");
    if (s.back !== "misc") fail(`the nested group's back is ${JSON.stringify(s.back)}, not "misc"`);
    await goBack();
    await shows("back to the group", (x) => x.title === "misc");
    await goBack();
    await shows("back to the Library screen", (x) => x.top === "lib-screen");
    // "+" > New group makes a group at the top, beside the others
    await plus("new-group");
    s = await shows("New group at the top", (x) => x.form?.title === "New group");
    if (s.form.where !== "In Top level") fail(`a new group at the top says ${JSON.stringify(s.form.where)}`);
    await field("group-form-name").fill("outer");
    await save();
    await shows("a new group saved at the top", (x) => !x.form && x.names === ["git", "git commit", "misc", "outer", "todo-top"].join("|"));
    const outer = (await lib()).groups.find((x) => x.name === "outer");
    if (!outer || outer.parent !== "") fail(`the new group at the top is ${JSON.stringify(outer)}`);
    note("new prompts and groups go where they are made (the top by \"+\", a group by its \"here\"), the lists show them, and a name with \"/\" is said before the save");

    // ---- deleting asks first; a group's question says how many prompts go with it
    await press(page, row("prompt", (await lib()).prompts.find((x) => x.name === "todo-top").id));
    await shows("the editor of todo-top", (x) => x.ed?.name === "todo-top");
    await press(page, byTid(page, "editor-delete").last());
    s = await shows("Delete prompt…", (x) => !!x.ask);
    if (s.ask.title !== "Delete “todo-top”?" || s.ask.body !== "“todo-top” is deleted from This computer's library." || s.ask.go !== "Delete prompt" || !s.ed) fail(`a prompt's question is ${JSON.stringify(s.ask)}`);
    await press(page, byTid(page, "confirm-cancel").last());
    await shows("Cancel on the question", (x) => !x.ask && !!x.ed);
    if (!(await lib()).prompts.some((x) => x.name === "todo-top")) fail("Cancel deleted the prompt");
    await press(page, byTid(page, "editor-delete").last());
    await shows("Delete prompt… again", (x) => !!x.ask);
    await press(page, byTid(page, "confirm-go").last());
    await shows("a prompt deleted", (x) => !x.ask && !x.ed && !x.names.includes("todo-top"));
    if ((await lib()).prompts.some((x) => x.name === "todo-top")) fail("the prompt was not deleted in the mock");
    await openGroup(page, "g_misc");
    await press(page, byTid(page, "lib-more").last());
    await byTid(page, "action-sheet").last().waitFor({ state: "visible", timeout: 10000 });
    await atRest(page, "action-row");
    await pressSheetRow(page, "action-sheet", "delete");
    s = await shows("Delete group…", (x) => !!x.ask);
    if (s.ask.title !== "Delete “misc”?" || s.ask.go !== "Delete group and 2 prompts" || s.ask.body !== "The group “misc” and everything in it are deleted from This computer's library.") fail(`a group's question is ${JSON.stringify(s.ask)}`);
    await press(page, byTid(page, "confirm-cancel").last());
    await shows("Cancel on the group's question", (x) => !x.ask && x.title === "misc");
    if (!(await lib()).groups.some((x) => x.name === "misc")) fail("Cancel deleted the group");
    await press(page, byTid(page, "lib-more").last());
    await byTid(page, "action-sheet").last().waitFor({ state: "visible", timeout: 10000 });
    await atRest(page, "action-row");
    await pressSheetRow(page, "action-sheet", "delete");
    await shows("Delete group… again", (x) => !!x.ask);
    await press(page, byTid(page, "confirm-go").last());
    await shows("a group deleted", (x) => !x.ask && x.top === "lib-screen" && x.names === ["git", "git commit", "outer"].join("|"));
    const left = await lib();
    if (left.groups.some((x) => ["misc", "inner"].includes(x.name)) || left.prompts.some((x) => ["todo", "git commit style"].includes(x.name))) fail(`after the group was deleted the library holds ${JSON.stringify(left)}`);
    note("deleting asks first; a prompt's question and a group's, which says how many prompts go with it, and both delete");

    // ---- a change made in a second window
    await reset();
    await mockEval(`libraries.local.prompts.push({ id: "p_w2", name: "from window two", parent: "", text: "Made elsewhere." }); sendLibrary("local");`, url);
    s = await shows("a prompt made in the second window", (x) => x.names === [...PHONE_TOP, "from window two"].join("|") && x.rows[3].kind === "prompt");
    await openGroup(page, "g_git");
    await edit("p_review", "review");
    // the chosen prompt's new text is in the editor that has nothing unsaved
    await mockEval(`const x = libraries.local.prompts.find((p) => p.id === "p_review"); x.name = "review twice"; x.text = "Changed in window two."; sendLibrary("local");`, url);
    s = await shows("the open prompt changed in the second window", (x) => x.ed?.text === "Changed in window two." && x.ed.name === "review twice" && x.ed.saveOff && x.names === "commit message|review twice");
    // what is typed here stays when the other window saves, and the later save wins
    await field("editor-text").fill("Typed in window one.");
    await mockEval(`libraries.local.prompts.find((p) => p.id === "p_review").text = "Saved first by window two."; sendLibrary("local");`, url);
    await page.waitForTimeout(800);
    s = await shows("the other window's save under what is typed", (x) => x.ed?.text === "Typed in window one." && !x.ask && !x.ed.err && !x.ed.saveOff);
    await save();
    if (!await until(async () => (await lib()).prompts.find((x) => x.id === "p_review").text === "Typed in window one.", 10000)) fail("the later save did not win");
    await shows("the later save done", (x) => !x.ed && x.names === "commit message|review twice");
    note("a prompt made and a prompt changed behind the page show with no reload; what is typed stays and the later of two saves wins");

    // ---- another server
    await reset();
    await servers([STUDIO]);
    await setLib("s_studio", THEIRS);
    s = await shows("a server that joined the list", (x) => x.secs.length === 2);
    if (s.secs.map((c) => c.title).join("|") !== "This computer|Studio" || s.secs[0].server !== "local" || s.secs[1].server !== "s_studio" || s.secs.map((c) => c.rows).join() !== "3,1" || s.notices.length) fail(`the sections are ${JSON.stringify(s.secs)}, notices ${JSON.stringify(s.notices)}`);
    await search().fill("studio stand");
    await shows("a search for the server's name and a prompt's name", (x) => x.hits.join() === "Studio › team|standup");
    await search().fill("git commit");
    await shows("the example's search with two libraries", (x) => x.hits.join("&") === SEARCHES[0][1].map((l) => phoneHit("This computer/" + l)).join("&"));
    await search().fill("");
    await shows("the search emptied", (x) => x.secs.length === 2);
    // a prompt made at the top of the server's library is that server's: the editor's Group row set to it
    await plus("new-prompt");
    s = await shows("New prompt with two servers", (x) => x.ed?.title === "New prompt");
    if (s.ed.group !== "Group This computer › Top level") fail(`a new prompt with two servers starts in ${JSON.stringify(s.ed.group)}`);
    await press(page, byTid(page, "editor-group-row").last());
    await atRest(page, "move-picker");
    await press(page, byTid(page, "move-picker").last().locator(tidSel("picker-row", { value: "s_studio|" })));
    s = await shows("Studio's top level picked", (x) => x.ed?.group === "Group Studio › Top level");
    await field("editor-name").fill("retro");
    await field("editor-text").fill("What went well?");
    await save();
    await shows("a prompt made on the other server", (x) => !x.ed && x.secs.map((c) => c.rows).join() === "3,2");
    const retro = (await lib("s_studio")).prompts.find((x) => x.name === "retro");
    if (!retro || retro.parent !== "" || retro.text !== "What went well?" || (await lib()).prompts.some((x) => x.name === "retro")) fail(`the prompt made at Studio's top is ${JSON.stringify(retro)} there`);
    await openGroup(page, "g_team");
    s = await shows("Studio's group", (x) => x.top === "lib-group-screen" && x.title === "team" && x.names === "standup");
    s = await edit("p_stand", "standup");
    if (s.ed.group !== "Group Studio › team") fail(`the editor says Studio's prompt is in ${JSON.stringify(s.ed.group)}`);

    // the server drops: its prompts stay; nothing of it can be changed, and nothing new goes there
    await field("editor-text").fill("Typed before the server dropped.");
    await mockEval(`setServerState("s_studio", "unreachable");`, url);
    s = await shows("a server that dropped", (x) => !!x.ed?.notice);
    if (!/^Studio is not connected/.test(s.ed.notice) || s.ed.text !== "Typed before the server dropped." || !s.ed.saveOff || !s.ed.groupOff || s.ed.deleteOff !== true || !s.ed.roName || !s.ed.roText) fail(`a prompt of a server that dropped shows ${JSON.stringify(s.ed)}`);
    if (s.notices.length !== 1) fail(`with the server dropped its screen has ${s.notices.length} notices, not one`);
    await closeSheets();
    s = await shows("the editor closed", (x) => !x.ed && x.names === "standup");
    const nh = await page.evaluate(() => { const e = [...document.querySelectorAll('[data-testid="lib-new-here"]')].pop(); return { off: e?.getAttribute("aria-disabled"), text: e?.textContent }; });
    if (nh.off !== "true" || !nh.text.includes("Studio is not connected")) fail(`with the server dropped "New prompt here" is ${JSON.stringify(nh)}`);
    await home();
    s = await shows("the server's section", (x) => x.secs.some((c) => c.notice.length));
    const away = s.secs.find((c) => c.server === "s_studio"), here = s.secs.find((c) => c.server === "local");
    if (away.notice.length !== 1 || !away.notice[0].startsWith("Studio is not connected") || here.notice.length || away.rows !== 2 || here.rows !== 3) fail(`with the server dropped the sections are ${JSON.stringify(s.secs)}`);
    await search().fill("stand");
    await shows("its prompt in a search", (x) => x.hits.join() === "Studio › team|standup");
    await search().fill("");
    await plus("new-prompt");
    s = await shows("New prompt with the server dropped", (x) => x.ed?.title === "New prompt");
    if (s.ed.group !== "Group This computer › Top level") fail(`with the server dropped a new prompt goes to ${JSON.stringify(s.ed.group)}`);
    await press(page, byTid(page, "editor-group-row").last());
    await atRest(page, "move-picker");
    const offered = await page.evaluate(() => [...document.querySelectorAll('[data-testid="move-picker"]')].pop().querySelectorAll('[data-testid="picker-row"]').length && [...[...document.querySelectorAll('[data-testid="move-picker"]')].pop().querySelectorAll('[data-testid="picker-row"]')].filter((r) => r.dataset.value.startsWith("s_studio|")).map((r) => [r.getAttribute("aria-disabled"), r.innerText.replace(/\s+/g, " ").trim()]));
    if (!offered.length || offered.some(([off, text]) => off !== "true" || !text.includes("Studio is not connected"))) fail(`with the server dropped its places in the picker are ${JSON.stringify(offered)}`);
    await page.keyboard.press("Escape");
    await until(async () => (await byTid(page, "move-picker").count()) === 0, 10000);
    await closeSheets();
    // back, it can be changed again
    await mockEval(`setServerState("s_studio", "connected");`, url);
    await shows("the server back", (x) => !x.secs.some((c) => c.notice.length) && x.notices.length === 0);
    await openGroup(page, "g_team");
    s = await edit("p_stand", "standup");
    if (s.ed.notice || s.ed.roText || s.ed.text !== "What did you do yesterday?") fail(`the server back, its prompt shows ${JSON.stringify(s.ed)}`);
    await field("editor-text").fill("What will you do today?");
    await save();
    if (!await until(async () => (await lib("s_studio")).prompts.find((x) => x.id === "p_stand").text === "What will you do today?", 10000)) fail("the save on the server that is back did not reach its library");
    await shows("the save on the server that is back", (x) => !x.ed);
    // a call refused on the way to the server: the reason, and what was typed
    await mockEval(`flags.library = { refuse: { status: 503, code: "server_unreachable", error: "Studio is not connected: its prompts cannot be changed until it is back." } };`, url);
    await edit("p_stand", "standup");
    await field("editor-text").fill("Typed while the way was cut.");
    await save();
    s = await shows("a call refused on the way", (x) => !!x.ed?.err);
    if (s.ed.err !== "Studio is not connected: its prompts cannot be changed until it is back." || s.ed.text !== "Typed while the way was cut.") fail(`a call refused on the way left ${JSON.stringify(s.ed)}`);
    await mockEval("delete flags.library;", url);
    await closeSheets();
    // removed from the list, it takes its section and its prompts with it
    await servers([]);
    await setLib("s_studio", null);
    s = await shows("a server removed from the list", (x) => x.top === "lib-screen" && x.names === PHONE_TOP.join("|") && x.secs.length === 1 && !x.secs[0].title);
    await search().fill("stand");
    await shows("a search for its prompt", (x) => x.rows.length === 0 && x.none === "No prompts match “stand”");
    note("another server's library is a titled section and found by its name, is changed from here, stays and is unchangeable while the server is away, and goes with the server");
  } catch (e) { fail(e.message.split("\n")[0]); }
}

await check("PL4.1 the library popup: the tree, the search, the editor, a second window and another server", async ({ url, open, fail, note, touch, layout }) => {
  if (layout === "phone") return playPhone({ url, open, fail, note });
  // the buttons of a question, in the order they are drawn: the dialog's Cancel then the action, the phone's confirm sheet's action then Cancel
  const askButtons = (action) => (layout === "phone" ? `${action},Cancel` : `Cancel,${action}`);
  const seeded = await seed(url, "A2");
  const sel = seeded.find((s) => s.id === "plain-started")?.sel ?? fail("the seed has no state plain-started");
  const lib = (server = "local") => mockEval(`return libraries[${JSON.stringify(server)}] ?? null;`, url);
  const servers = (list) => mockEval(`setServers(${JSON.stringify(list)});`, url);
  // (the seed's servers leave the list: this computer's library is the only one until Studio joins)
  await servers([]);
  await mockEval(`setLibrary("local", ${JSON.stringify(EXAMPLE)});`, url);

  /** A window of the app with what the check does in its library popup. */
  const windowOf = async (name, first) => {
    const w = first ?? await open({ sel, beside: true }); // (the first window stays: open() of shot.mjs says how the two share the mock's stream)
    const { page } = w;
    await showList(page);
    const read = () => page.evaluate(seen);
    /** Waits for the page to show what `want` says; fails with what it shows. */
    const shows = async (what, want) => {
      let s;
      if (!await until(async () => want((s = await read())), 10000)) fail(`${name}, ${what}: the page shows ${JSON.stringify(s)}`);
      return s;
    };
    const D = byTid(page, "library-dialog");
    const row = (label) => D.locator(`${tidSel("lib-row")}:not([data-new="true"])`).filter({ has: page.locator(`${tidSel("lib-name")}`, { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) });
    const hit = (label) => D.locator(tidSel("lib-row", { hit: true })).filter({ has: page.locator(tidSel("lib-pname"), { hasText: new RegExp(`^${label}$`) }) });
    const button = (label) => D.locator('[role="button"]').filter({ hasText: new RegExp(`^${label}$`) });
    const field = { name: byTid(D, "lib-name-input"), text: byTid(D, "lib-text-input"), search: byTid(D, "lib-search") };
    /** Chooses a row of the tree and waits for the editor to be on it. */
    const choose = async (label) => { await press(page, row(label)); return shows(`"${label}" chosen`, (s) => s.form?.name === label && s.on.join().trim() === label); };
    const save = () => press(page, button("Save"));
    const answer = (label) => press(page, byTid(page, "confirm-dialog").locator('[role="button"]').filter({ hasText: new RegExp(`^${label}$`) }));
    const libBtn = byTid(page, "library-btn");
    return { page, read, shows, row, hit, button, field, choose, save, answer, libBtn, w };
  };
  const a = await windowOf("the first window"), { page } = a;
  try {
    // ---- the button, and the ways the popup opens and closes
    const foot = await page.evaluate(() => ["servers-btn", "library-btn", "theme-btn"].map((s) => { const r = document.querySelector(`[data-testid="side-foot"] [data-testid="${s}"]`)?.getBoundingClientRect(); return r ? [Math.round(r.left), Math.round(r.right), Math.round(r.top + r.height / 2)] : null; }));
    if (foot.some((r) => !r)) fail(`the sidebar's foot has not all of Servers, the library's button and the theme picker: ${JSON.stringify(foot)}`);
    // (with Settings' gear between the library's button and the picker the foot's right group no longer fits the line of Servers at the default width: it wraps to a line of its own, so
    // "between" is the reading order, top to bottom and left to right, and the library's button and the picker are on one line)
    else if (!(foot[0][2] < foot[1][2] - 1 || (Math.abs(foot[0][2] - foot[1][2]) <= 1 && foot[0][1] <= foot[1][0])) || Math.abs(foot[1][2] - foot[2][2]) > 1 || foot[1][1] > foot[2][0]) fail(`the library's button is not between Servers and the theme picker in the foot's reading order: ${JSON.stringify(foot)}`);
    const title = await a.libBtn.getAttribute("title");
    if (title !== "Prompt library") fail(`the button's title is ${JSON.stringify(title)}`);
    await a.libBtn.focus();
    await page.keyboard.press("Enter");
    let s = await a.shows("Enter on the button", (x) => x.open === 1 && x.focus === "search");
    if (await page.locator(`[role="dialog"][aria-modal="true"][aria-label="Prompt library"]`).count() < 1) fail("the popup is no dialog named Prompt library");
    await page.keyboard.press("Escape");
    await a.shows("Esc", (x) => x.open === 0 && x.focus === "button");
    await press(page, a.libBtn);
    await a.shows("a press on the button", (x) => x.open === 1 && x.focus === "search");
    if (touch) await page.touchscreen.tap(6, 6); else await page.mouse.click(6, 6);
    await a.shows("a press beside the popup", (x) => x.open === 0 && x.focus === "button");
    await page.keyboard.press("Enter");
    await a.shows("Enter on the button again", (x) => x.open === 1);
    await press(page, a.button("Close"));
    await a.shows("Close", (x) => x.open === 0 && x.focus === "button");
    await page.keyboard.press("Enter");

    // ---- the tree, with no level of servers
    s = await a.shows("the tree", (x) => x.open === 1 && x.rows.join("|") === TREE.join("|"));
    if (s.list !== "tree" || s.none !== NONE || s.form) fail(`the popup opens with ${JSON.stringify({ list: s.list, none: s.none, form: s.form })}`);
    // a group closes and opens by its twist
    await press(page, byTid(a.row("git"), "lib-twist"));
    await a.shows("the twist of an open group", (x) => x.rows.join("|") === TREE.filter((r) => r !== "  commit message" && r !== "  review").join("|") && x.closed.join() === "git");
    await press(page, byTid(a.row("git"), "lib-twist"));
    await a.shows("the twist of a closed group", (x) => x.rows.join("|") === TREE.join("|") && !x.closed.length);
    // and by the keys: from the search down into the rows, left closes, right opens and goes in, Enter chooses
    await a.field.search.focus();
    await page.keyboard.press("ArrowDown");
    await a.shows("ArrowDown in the search", (x) => x.focus === "row git");
    await page.keyboard.press("ArrowLeft");
    await a.shows("ArrowLeft on an open group", (x) => x.closed.join() === "git" && x.focus === "row git");
    await page.keyboard.press("ArrowDown");
    await a.shows("ArrowDown past a closed group", (x) => x.focus === "row git commit");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowRight");
    await a.shows("ArrowRight on a closed group", (x) => !x.closed.length && x.focus === "row git");
    await page.keyboard.press("ArrowRight");
    await a.shows("ArrowRight on an open group", (x) => x.focus === "row commit message");
    await page.keyboard.press("Enter");
    s = await a.shows("Enter on a prompt's row", (x) => x.form?.name === "commit message");
    if (s.form.head !== "Prompt" || s.form.where !== "In git" || s.form.text !== "Write a commit message." || s.form.fields !== "input,textarea") fail(`the editor of "commit message" shows ${JSON.stringify(s.form)}`);
    if (s.form.off.join() !== "Save" || s.form.buttons.join() !== "Delete,Save") fail(`with nothing typed the editor's buttons are ${JSON.stringify(s.form.buttons)}, disabled ${JSON.stringify(s.form.off)}`);
    await page.keyboard.press("ArrowUp"); await page.keyboard.press("ArrowUp");
    await a.shows("ArrowUp on the first row", (x) => x.focus === "search");
    note("the button opens the popup, Esc, Close and a press beside it close it with the focus back; the tree has no level of servers and is walked with the keys");

    // ---- the search: the flat list, in the order of the goal file's example
    for (const [query, want] of SEARCHES) {
      await a.field.search.fill(query);
      s = await a.shows(`the search "${query}"`, (x) => x.list === "listbox" && x.rows.join("|") === want.join("|"));
      if (!want.length && s.says !== "No matching prompts") fail(`the search "${query}" says ${JSON.stringify(s.says)}`);
    }
    await a.field.search.fill("com mes");
    await a.shows("a search whose one prompt is the chosen one", (x) => x.rows.join("|") === "git/commit message" && x.on.join("|") === "git/commit message");
    await a.field.search.fill("squ");
    await press(page, a.hit("squash"));
    await a.shows("a press on a prompt found", (x) => x.form?.name === "squash" && x.form.where === "In git commit");
    await a.field.search.fill("");
    await a.shows("the search emptied", (x) => x.list === "tree" && x.rows.join("|") === TREE.join("|") && x.on.join("|") === "  squash");
    // (Enter in the search chooses the first prompt found; the clearing button empties it)
    await a.field.search.fill("review");
    await page.keyboard.press("Enter");
    await a.shows("Enter in the search", (x) => x.form?.name === "review");
    await press(page, byTid(page, "lib-search-clear"));
    await a.shows("the search's clearing button", (x) => x.list === "tree" && x.focus === "search");
    note("the four searches of the example give its results in its order, and an emptied search shows the tree");

    // ---- a save the server refuses: the reason, and what was typed
    await a.choose("commit message");
    await a.field.name.fill("REVIEW");
    await a.field.text.fill("Typed text.\nA second line.");
    await a.save();
    s = await a.shows("a name of its group, in another case", (x) => !!x.form?.err);
    if (s.form.err !== 'There is already a prompt called "review" in the group "git".' || s.form.name !== "REVIEW" || s.form.text !== "Typed text.\nA second line.") fail(`a refused save left ${JSON.stringify(s.form)}`);
    if ((await lib()).prompts.find((x) => x.id === "p_msg").name !== "commit message") fail("a refused save changed the prompt");
    // the same name in another group is taken, and the error goes
    await a.field.name.fill("squash");
    await a.save();
    s = await a.shows("the same name in another group", (x) => x.form?.name === "squash" && !x.form.err && x.form.off.includes("Save") && x.rows.includes("  squash") && !x.rows.includes("  commit message"));
    let saved = (await lib()).prompts.find((x) => x.id === "p_msg");
    if (saved.name !== "squash" || saved.text !== "Typed text.\nA second line." || saved.parent !== "g_git") fail(`the saved prompt is ${JSON.stringify(saved)}`);
    // a prompt deleted meanwhile: what was typed stays, and the save says why it cannot be
    await a.field.text.fill("Typed over a prompt that is gone.");
    await mockEval(`libraries.local.prompts = libraries.local.prompts.filter((x) => x.id !== "p_msg"); sendLibrary("local");`, url);
    s = await a.shows("a prompt deleted under what was typed", (x) => x.rows.join("|") === TREE.filter((r) => r !== "  commit message").join("|") && !!x.form?.notice);
    if (s.form.text !== "Typed over a prompt that is gone." || !/no longer in the library/.test(s.form.notice)) fail(`a prompt deleted under what was typed left ${JSON.stringify(s.form)}`);
    await a.save();
    s = await a.shows("the save of a prompt that is gone", (x) => !!x.form?.err);
    if (s.form.err !== "This prompt no longer exists." || s.form.text !== "Typed over a prompt that is gone.") fail(`the save of a prompt that is gone left ${JSON.stringify(s.form)}`);
    await press(page, a.button("Revert"));
    await a.shows("Revert on a prompt that is gone", (x) => !x.form && !!x.none);
    await mockEval(`libraries.local.prompts.push(${JSON.stringify(EXAMPLE.prompts[3])}); sendLibrary("local");`, url); // (as the example again)
    await a.shows("the example again", (x) => x.rows.join("|") === TREE.join("|"));
    note("a refused save shows the server's sentence and keeps the typed name and text, for a name that is taken and for a prompt deleted meanwhile");

    // ---- unsaved changes: leaving asks first
    await a.choose("review");
    await a.field.text.fill("Not saved yet.");
    await press(page, a.row("squash"));
    s = await a.shows("leaving a prompt with unsaved changes", (x) => !!x.ask);
    if (s.ask.title !== "Discard changes?" || s.ask.body !== "The changes to the prompt “review” are not saved." || s.ask.buttons.join() !== askButtons("Discard")) fail(`the question is ${JSON.stringify(s.ask)}`);
    await a.answer("Cancel");
    s = await a.shows("Cancel", (x) => !x.ask && x.form?.name === "review" && x.form.text === "Not saved yet." && x.open === 1);
    await page.keyboard.press("Escape");
    await a.shows("Esc with unsaved changes", (x) => !!x.ask && x.open === 1);
    await page.keyboard.press("Escape"); // (the question's own Esc: it goes, the popup stays)
    await a.shows("Esc on the question", (x) => !x.ask && x.open === 1 && x.form?.text === "Not saved yet.");
    await press(page, a.button("Close"));
    await a.shows("Close with unsaved changes", (x) => !!x.ask);
    await a.answer("Cancel");
    await press(page, a.button("New prompt"));
    await a.shows("New prompt with unsaved changes", (x) => !!x.ask);
    await a.answer("Cancel");
    await press(page, a.row("squash"));
    await a.shows("leaving again", (x) => !!x.ask);
    await a.answer("Discard");
    await a.shows("Discard", (x) => !x.ask && x.form?.name === "squash" && x.form.text === "Squash them.");
    if ((await lib()).prompts.find((x) => x.id === "p_review").text !== "Review this change.") fail("what was discarded was saved");
    // (with nothing typed nothing is asked)
    await press(page, a.row("review"));
    await a.shows("leaving a prompt with nothing typed", (x) => !x.ask && x.form?.name === "review" && x.form.text === "Review this change.");
    // closed through the question, the popup gives the focus back too, and what was typed is gone when it opens again
    await a.field.text.fill("Dropped with the popup.");
    await page.keyboard.press("Escape");
    await a.shows("Esc with unsaved changes, once more", (x) => !!x.ask);
    await a.answer("Discard");
    await a.shows("Discard on the question of a closing popup", (x) => !x.ask && x.open === 0 && x.focus === "button");
    await page.keyboard.press("Enter");
    await a.shows("the popup opened again", (x) => x.open === 1 && !x.form && x.rows.join("|") === TREE.join("|"));
    await press(page, a.row("review"));
    await a.shows("the prompt as it is saved", (x) => x.form?.text === "Review this change.");

    // ---- new items, a move, and the names the popup checks itself
    await press(page, a.row("misc"));
    s = await a.shows("a group chosen", (x) => x.form?.head === "Group" && x.form.name === "misc");
    if (s.form.text !== null || s.form.where !== TOP || s.form.fields !== "input") fail(`the editor of the group "misc" shows ${JSON.stringify(s.form)}`);
    await press(page, a.button("New prompt"));
    s = await a.shows("New prompt in the chosen group", (x) => x.form?.head === "New prompt" && x.focus === "name");
    if (s.form.where !== "In misc" || s.form.name !== "" || s.form.text !== "" || !s.form.off.includes("Save") || s.form.fields !== "input,textarea") fail(`a new prompt starts as ${JSON.stringify(s.form)}`);
    // (the tree shows its row where it goes, before the prompt of that group, and no other row is the chosen one)
    if (s.fresh !== "  New prompt" || s.on.length || s.rows.join("|") !== TREE.join("|")) fail(`with a new prompt begun in "misc" the tree shows ${JSON.stringify({ fresh: s.fresh, on: s.on, rows: s.rows })}`);
    await page.keyboard.type("a/b");
    s = await a.shows("a name with a slash", (x) => !!x.form?.problem && x.fresh === "  a/b");
    if (s.form.problem !== 'A name cannot contain "/".' || !s.form.off.includes("Save")) fail(`a name with "/" leaves ${JSON.stringify(s.form)}`);
    await a.field.name.fill("todo");
    await a.field.text.fill("TODO: ");
    await page.keyboard.press("ControlOrMeta+Enter"); // (the save's key, from the text)
    s = await a.shows("a new prompt saved", (x) => x.form?.head === "Prompt" && x.form.name === "todo" && x.rows.join("|") === [...TREE, "  todo"].join("|") && x.on.join("|") === "  todo" && !x.fresh);
    const todo = (await lib()).prompts.find((x) => x.name === "todo");
    if (!todo || todo.parent !== "g_misc" || todo.text !== "TODO: ") fail(`the new prompt is ${JSON.stringify(todo)}`);
    await press(page, a.button("New group"));
    s = await a.shows("New group beside the chosen prompt", (x) => x.form?.head === "New group" && x.form.where === "In misc" && x.form.text === null && x.fresh === "  New group");
    await page.keyboard.type("inner");
    await page.keyboard.press("Enter"); // (Enter in the name saves)
    s = await a.shows("a new group saved", (x) => x.form?.head === "Group" && x.rows.join("|") === [...TREE.slice(0, 6), "  inner", "  git commit style", "  todo"].join("|"));
    const inner = (await lib()).groups.find((x) => x.name === "inner");
    if (!inner || inner.parent !== "g_misc") fail(`the new group is ${JSON.stringify(inner)}`);
    // a prompt is moved by dragging it onto another group, and the editor that is on it says where it is now
    await a.choose("todo");
    const drag = await pointerDragger(page);
    await drag.start(a.row("todo"));
    await drag.move(a.row("inner"));
    await drag.end();
    await a.shows("a prompt moved", (x) => x.rows.join("|") === [...TREE.slice(0, 6), "  inner", "    todo", "  git commit style"].join("|") && x.form?.where === "In misc/inner" && x.form.off.includes("Save"));
    if ((await lib()).prompts.find((x) => x.name === "todo").parent !== inner?.id) fail("the moved prompt is not in its new group");
    await press(page, a.row("misc"));
    await a.shows("the group above", (x) => x.form?.head === "Group" && x.form.name === "misc" && x.form.where === TOP);

    // ---- deleting asks first; a group's question says how many prompts go with it
    await press(page, a.button("Delete"));
    s = await a.shows("Delete on a group", (x) => !!x.ask);
    if (s.ask.title !== "Delete group" || s.ask.body !== "“misc” is deleted with everything in it: 2 prompts and 1 group." || s.ask.buttons.join() !== askButtons("Delete")) fail(`a group's question is ${JSON.stringify(s.ask)}`);
    await a.answer("Cancel");
    await a.shows("Cancel on the question", (x) => !x.ask && x.rows.includes("misc"));
    await press(page, a.button("Delete"));
    await a.shows("Delete on a group again", (x) => !!x.ask);
    await a.answer("Delete");
    s = await a.shows("a group deleted", (x) => !x.ask && x.rows.join("|") === TREE.slice(0, 5).join("|") && !x.form);
    if (s.focus === "nothing") fail("after a delete the focus is nowhere");
    const left = await lib();
    if (left.groups.some((x) => ["misc", "inner"].includes(x.name)) || left.prompts.some((x) => ["todo", "git commit style"].includes(x.name))) fail(`after the group was deleted the library holds ${JSON.stringify(left)}`);
    await a.choose("squash");
    await press(page, a.button("Delete"));
    s = await a.shows("Delete on a prompt", (x) => !!x.ask);
    if (s.ask.title !== "Delete prompt" || s.ask.body !== "“squash” is deleted from the library.") fail(`a prompt's question is ${JSON.stringify(s.ask)}`);
    await a.answer("Delete");
    await a.shows("a prompt deleted", (x) => !x.ask && x.rows.join("|") === TREE.slice(0, 4).join("|") && !x.form);
    note("leaving unsaved changes asks; new prompts and groups go where the tree is chosen; a move, the checks of a name, and both deletes with their questions");

    // ---- a second window
    const b = await windowOf("the second window");
    try {
      await a.choose("review");
      await press(b.page, b.libBtn);
      await b.shows("its tree", (x) => x.rows.join("|") === TREE.slice(0, 4).join("|"));
      await press(b.page, b.button("New prompt"));
      await b.shows("its new prompt", (x) => x.form?.head === "New prompt" && x.form.where === TOP);
      await b.field.name.fill("from window two");
      await b.save();
      await b.shows("its new prompt saved", (x) => x.rows.includes("from window two"));
      await a.shows("a prompt made in the second window", (x) => x.rows.join("|") === [...TREE.slice(0, 4), "from window two"].join("|") && x.form?.name === "review");
      // the chosen prompt's new text is in the editor that has nothing unsaved
      await b.choose("review");
      await b.field.text.fill("Changed in window two.");
      await b.field.name.fill("review twice");
      await b.save();
      await a.shows("the chosen prompt changed in the second window", (x) => x.form?.text === "Changed in window two." && x.form.name === "review twice" && x.rows.includes("  review twice") && x.form.off.includes("Save"));
      // what is typed here stays when the other window saves, and the later save wins
      await a.field.text.fill("Typed in window one.");
      await b.shows("its save done", (x) => x.form?.off.includes("Save"));
      await b.field.text.fill("Saved first by window two.");
      await b.save();
      if (!await until(async () => (await lib()).prompts.find((x) => x.id === "p_review").text === "Saved first by window two.", 10000)) fail("the second window's save did not reach the library");
      s = await a.shows("the other window's save under what is typed", (x) => x.form?.text === "Typed in window one." && !x.ask && !x.form.err);
      await a.save();
      if (!await until(async () => (await lib()).prompts.find((x) => x.id === "p_review").text === "Typed in window one.", 10000)) fail("the later save did not win");
      await b.shows("the first window's save in the second", (x) => x.form?.text === "Typed in window one.");
      await a.shows("the first window's save done", (x) => x.form?.text === "Typed in window one." && x.form.off.includes("Save"));
      note("a prompt made and a prompt changed in a second window show in the first with no reload; the later of two saves wins");
    } catch (e) { fail(`the second window: ${e.message.split("\n")[0]}`); }
    await b.w.ctx.close();
    await mockEval(`setLibrary("local", ${JSON.stringify(EXAMPLE)});`, url);
    await a.shows("the example again", (x) => x.rows.join("|") === TREE.join("|"));

    // ---- another server
    await servers([STUDIO]);
    await mockEval(`setLibrary("s_studio", ${JSON.stringify(THEIRS)});`, url);
    const BOTH = ["This computer", ...TREE.map((r) => "  " + r), "Studio", "  team", "    standup"];
    s = await a.shows("a server that joined the list", (x) => x.rows.join("|") === BOTH.join("|"));
    if (s.off.length) fail(`a connected server is marked: ${JSON.stringify(s.off)}`);
    await a.field.search.fill("studio stand");
    await a.shows("a search for the server's name and a prompt's name", (x) => x.rows.join("|") === "Studio/team/standup");
    await a.field.search.fill("git commit");
    await a.shows("the example's search with two libraries", (x) => x.rows.join("|") === SEARCHES[0][1].map((l) => "This computer/" + l).join("|"));
    await a.field.search.fill("");
    // a prompt made at the top of the server's entry is that server's
    await press(page, a.row("Studio"));
    s = await a.shows("a server's entry chosen", (x) => /^Studio1 prompt in 1 group\.$/.test(x.about) && !x.form);
    await press(page, a.button("New prompt"));
    s = await a.shows("New prompt at a server's entry", (x) => x.form?.head === "New prompt");
    if (s.form.where !== "In Studio" || s.fresh !== "  New prompt" || s.form.fields !== "input,textarea") fail(`a new prompt at Studio's entry goes to ${JSON.stringify(s.form.where)}, and its row is ${JSON.stringify(s.fresh)}`);
    await a.field.name.fill("retro");
    await a.field.text.fill("What went well?");
    await a.save();
    await a.shows("a prompt made on the other server", (x) => x.rows.join("|") === [...BOTH, "  retro"].join("|") && x.form?.head === "Prompt" && x.form.name === "retro");
    const retro = (await lib("s_studio")).prompts.find((x) => x.name === "retro");
    if (!retro || retro.parent !== "" || retro.text !== "What went well?" || (await lib()).prompts.some((x) => x.name === "retro")) fail(`the prompt made at Studio's entry is ${JSON.stringify(retro)} there`);
    s = await a.choose("standup");
    if (s.form.where !== "In Studio/team") fail(`the editor says Studio's prompt is ${JSON.stringify(s.form.where)}`);

    // the server drops: its prompts stay, marked; nothing of it can be changed, and nothing new goes there
    await a.field.text.fill("Typed before the server dropped.");
    await mockEval(`setServerState("s_studio", "unreachable");`, url);
    s = await a.shows("a server that dropped", (x) => x.off.join("|") === "Studio" && x.form?.fixed === true);
    if (s.rows.join("|") !== [...BOTH, "  retro"].join("|")) fail(`with the server dropped the tree is ${JSON.stringify(s.rows)}`);
    if (!["Save", "Delete"].every((l) => s.form.off.includes(l)) || !/^Studio is not connected/.test(s.form.notice) || s.form.text !== "Typed before the server dropped.") fail(`a prompt of a server that dropped shows ${JSON.stringify(s.form)}`);
    if (await a.row("standup").getAttribute("data-fixed") !== "true" || !await a.field.text.evaluate((e) => e.readOnly)) fail("a prompt of a server that dropped can be dragged or its text typed over");
    await press(page, a.button("Revert"));
    await a.field.search.fill("stand");
    await a.shows("its prompt in a search", (x) => x.rows.join("|") === "Studio/team/standup" && x.off.join("|") === "Studio/team/standup");
    await a.field.search.fill("");
    await press(page, a.button("New prompt"));
    s = await a.shows("New prompt beside a prompt of a server that dropped", (x) => x.form?.head === "New prompt");
    if (s.form.where !== "In This computer") fail(`with the server dropped a new prompt goes to ${JSON.stringify(s.form.where)}`);
    await press(page, a.button("Cancel"));
    // back, it can be changed again
    await mockEval(`setServerState("s_studio", "connected");`, url);
    s = await a.shows("the server back", (x) => !x.off.length && x.form?.name === "standup" && x.form.fixed === false && !x.form.notice);
    await a.field.text.fill("What will you do today?");
    await a.save();
    if (!await until(async () => (await lib("s_studio")).prompts.find((x) => x.id === "p_stand").text === "What will you do today?", 10000)) fail("the save on the server that is back did not reach its library");
    await a.shows("the save on the server that is back", (x) => x.form?.off.includes("Save") && !x.form.err);
    // a call refused on the way to the server: the reason, and what was typed
    await mockEval(`flags.library = { refuse: { status: 503, code: "server_unreachable", error: "Studio is not connected: its prompts cannot be changed until it is back." } };`, url);
    await a.field.text.fill("Typed while the way was cut.");
    await a.save();
    s = await a.shows("a call refused on the way", (x) => !!x.form?.err);
    if (s.form.err !== "Studio is not connected: its prompts cannot be changed until it is back." || s.form.text !== "Typed while the way was cut.") fail(`a call refused on the way left ${JSON.stringify(s.form)}`);
    await mockEval("delete flags.library;", url);
    await press(page, a.button("Revert"));
    // removed from the list, it takes its entry and its prompts with it
    await a.shows("before the server is removed", (x) => x.form?.name === "standup" && !x.form.err);
    await servers([]);
    await mockEval(`setLibrary("s_studio", null);`, url);
    s = await a.shows("a server removed from the list", (x) => x.rows.join("|") === TREE.join("|") && !x.form);
    await a.field.search.fill("stand");
    await a.shows("a search for its prompt", (x) => x.rows.length === 0 && x.says === "No matching prompts");
    note("another server's library is under its name and found by it, is changed from here, stays marked and unchangeable while the server is away, and goes with the server");
  } catch (e) { fail(e.message.split("\n")[0]); }
}, { viewports, page: false });
