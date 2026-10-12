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
import { check, mockEval, openPage, pointerDrag, seed, until } from "../shot.mjs";

const g = (id, name, parent = "") => ({ id, name, parent }), p = (id, name, parent, text) => ({ id, name, parent, text });
// The example of the goal file, section 6.
const EXAMPLE = { groups: [g("g_misc", "misc"), g("g_gc", "git commit"), g("g_git", "git")],
  prompts: [p("p_style", "git commit style", "g_misc", "Use the imperative."), p("p_review", "review", "g_git", "Review this change."), p("p_squash", "squash", "g_gc", "Squash them."), p("p_msg", "commit message", "g_git", "Write a commit message.")] };
const TREE = ["git", "  commit message", "  review", "git commit", "  squash", "misc", "  git commit style"];
const SEARCHES = [["git commit", ["git/commit message", "misc/git commit style", "git commit/squash"]], ["com mes", ["git/commit message"]], ["mes com", []],
  ["GIT", ["misc/git commit style", "git/commit message", "git/review", "git commit/squash"]]];
const STUDIO = { id: "s_studio", name: "Studio", address: "https://studio.example:4790", state: "connected", version: "dev" };
const THEIRS = { groups: [g("g_team", "team")], prompts: [p("p_stand", "standup", "g_team", "What did you do yesterday?")] };
const TOP = "At the top level", DLG = ".lib-dialog";
const NONE = "Choose a prompt to edit it, or make a new one. Right-click in the list to make one there; drag a prompt or a group to move it.";

/** In the page: what the library popup shows, the question above it, and where the focus is. rows: the rows of the
 *  list, each set in by its level; fresh: the row of an item that is being made, "" with none; form.where: where the
 *  editor says its item is; form.fields: the editor's controls that take a value. */
function seen() {
  const dlg = document.querySelector(".lib-dialog"), at = document.activeElement, text = (e) => e?.textContent ?? "";
  const rows = [...(dlg?.querySelectorAll(".lib-list .lib-row:not(.new)") ?? [])], fresh = dlg?.querySelector(".lib-list .lib-row.new");
  const line = (r) => (r.matches(".hit") ? text(r.querySelector(".lib-path")) + text(r.querySelector(".lib-pname")) : "  ".repeat(Number(r.getAttribute("aria-level")) - 1) + text(r.querySelector(".lib-name")));
  const form = dlg?.querySelector(".lib-form"), ask = document.querySelector(".dialog-backdrop .dialog");
  return {
    open: document.querySelectorAll(".lib-dialog").length, list: dlg?.querySelector(".lib-list")?.getAttribute("role") ?? "", rows: rows.map(line), fresh: fresh ? line(fresh) : "",
    on: rows.filter((r) => r.getAttribute("aria-selected") === "true").map(line), off: rows.filter((r) => r.querySelector(".lib-off")).map(line), closed: rows.filter((r) => r.getAttribute("aria-expanded") === "false").map(line),
    says: text(dlg?.querySelector(".lib-list .menu-empty")), none: text(dlg?.querySelector(".lib-none")), about: text(dlg?.querySelector(".lib-about")),
    form: form ? { head: text(form.querySelector(".lib-form-head > span")), name: form.querySelector("input").value, text: form.querySelector("textarea")?.value ?? null, fixed: form.querySelector("input").readOnly,
      where: text(form.querySelector(".lib-where")), fields: [...form.querySelectorAll("input, textarea, select")].map((e) => e.tagName.toLowerCase()).join(),
      err: text(form.querySelector(".dialog-err")), notice: text(form.querySelector(".lib-notice")), problem: text(form.querySelector(".lib-problem")),
      off: [...form.querySelectorAll("button")].filter((b) => b.disabled).map((b) => b.textContent), buttons: [...form.querySelectorAll("button")].map((b) => b.textContent) } : null,
    ask: ask ? { title: text(ask.querySelector(".dialog-title")), body: text(ask.querySelector(".dialog-body")), err: text(ask.querySelector(".dialog-err")), buttons: [...ask.querySelectorAll("button")].map((b) => b.textContent) } : null,
    focus: !at || at === document.body ? "nothing" : at.matches(".library-btn") ? "button" : at.matches(".lib-search input") ? "search" : at.matches(".lib-row") ? "row " + line(at).trim() : at.matches(".lib-form input") ? "name"
      : at.matches(".lib-dialog *") ? "popup " + at.tagName.toLowerCase() : at.matches(".dialog *") ? "question" : at.tagName.toLowerCase() + "." + at.className,
  };
}

await check("PL4.1 the library popup: the tree, the search, the editor, a second window and another server", async ({ url, browser, fail, note }) => {
  const seeded = await seed(url, "A2");
  const sel = seeded.find((s) => s.id === "plain-started")?.sel ?? fail("the seed has no state plain-started");
  const lib = (server = "local") => mockEval(`return libraries[${JSON.stringify(server)}] ?? null;`, url);
  const servers = (list) => mockEval(`extra.servers = ${JSON.stringify([{ id: "local", local: true, name: "This computer", state: "connected" }, ...list])}; send({ type: "servers", servers: extra.servers, notice: "" });`, url);
  // (the seed's servers leave the list: this computer's library is the only one until Studio joins)
  await servers([]);
  await mockEval(`setLibrary("local", ${JSON.stringify(EXAMPLE)});`, url);

  /** A window of the app with what the check does in its library popup. */
  const windowOf = async (name) => {
    const errors = [];
    const w = await openPage({ url, browser, sel, errors, wait: ".side-foot .library-btn" });
    const { page } = w;
    const read = () => page.evaluate(seen);
    /** Waits for the page to show what `want` says; fails with what it shows. */
    const shows = async (what, want) => {
      let s;
      if (!await until(async () => want((s = await read())), 10000)) fail(`${name}, ${what}: the page shows ${JSON.stringify(s)}`);
      return s;
    };
    const row = (label) => page.locator(`${DLG} .lib-row:not(.new):has(.lib-name:text-is("${label}"))`);
    const hit = (label) => page.locator(`${DLG} .lib-row.hit:has(.lib-pname:text-is("${label}"))`);
    const button = (label) => page.locator(`${DLG} button:text-is("${label}")`);
    const field = { name: page.locator(`${DLG} .lib-form input`), text: page.locator(`${DLG} .lib-form textarea`), search: page.locator(`${DLG} .lib-search input`) };
    /** Chooses a row of the tree and waits for the editor to be on it. */
    const choose = async (label) => { await row(label).click(); return shows(`"${label}" chosen`, (s) => s.form?.name === label && s.on.join().trim() === label); };
    const save = () => button("Save").click();
    const answer = (label) => page.locator(`.dialog-backdrop .dialog button:text-is("${label}")`).click();
    const close = async () => { for (const e of errors) fail(`${name}: page error: ${e}`); await w.ctx.close(); };
    return { page, read, shows, row, hit, button, field, choose, save, answer, close };
  };
  const a = await windowOf("the first window"), { page } = a;
  try {
    // ---- the button, and the ways the popup opens and closes
    const foot = await page.evaluate(() => [".servers-btn", ".library-btn", ".theme-btn"].map((s) => { const r = document.querySelector(".side-foot " + s)?.getBoundingClientRect(); return r ? [Math.round(r.left), Math.round(r.right), Math.round(r.top + r.height / 2)] : null; }));
    if (foot.some((r) => !r)) fail(`the sidebar's foot has not all of Servers, the library's button and the theme picker: ${JSON.stringify(foot)}`);
    else if (!(foot[0][1] <= foot[1][0] && foot[1][1] <= foot[2][0]) || Math.abs(foot[0][2] - foot[1][2]) > 1 || Math.abs(foot[1][2] - foot[2][2]) > 1) fail(`the library's button is not between Servers and the theme picker on their line: ${JSON.stringify(foot)}`);
    const title = await page.locator(".side-foot .library-btn").getAttribute("title");
    if (title !== "Prompt library") fail(`the button's title is ${JSON.stringify(title)}`);
    await page.locator(".side-foot .library-btn").focus();
    await page.keyboard.press("Enter");
    let s = await a.shows("Enter on the button", (x) => x.open === 1 && x.focus === "search");
    if (await page.locator(`${DLG}[role="dialog"][aria-modal="true"][aria-label="Prompt library"]`).count() !== 1) fail("the popup is no dialog named Prompt library");
    await page.keyboard.press("Escape");
    await a.shows("Esc", (x) => x.open === 0 && x.focus === "button");
    await page.locator(".side-foot .library-btn").click();
    await a.shows("a click on the button", (x) => x.open === 1 && x.focus === "search");
    await page.mouse.click(6, 6);
    await a.shows("a click beside the popup", (x) => x.open === 0 && x.focus === "button");
    await page.keyboard.press("Enter");
    await a.shows("Enter on the button again", (x) => x.open === 1);
    await a.button("Close").click();
    await a.shows("Close", (x) => x.open === 0 && x.focus === "button");
    await page.keyboard.press("Enter");

    // ---- the tree, with no level of servers
    s = await a.shows("the tree", (x) => x.open === 1 && x.rows.join("|") === TREE.join("|"));
    if (s.list !== "tree" || s.none !== NONE || s.form) fail(`the popup opens with ${JSON.stringify({ list: s.list, none: s.none, form: s.form })}`);
    // a group closes and opens by its twist
    await a.row("git").locator(".lib-twist").click();
    await a.shows("the twist of an open group", (x) => x.rows.join("|") === TREE.filter((r) => r !== "  commit message" && r !== "  review").join("|") && x.closed.join() === "git");
    await a.row("git").locator(".lib-twist").click();
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
    note("the button opens the popup, Esc, Close and a click beside it close it with the focus back; the tree has no level of servers and is walked with the keys");

    // ---- the search: the flat list, in the order of the goal file's example
    for (const [query, want] of SEARCHES) {
      await a.field.search.fill(query);
      s = await a.shows(`the search "${query}"`, (x) => x.list === "listbox" && x.rows.join("|") === want.join("|"));
      if (!want.length && s.says !== "No matching prompts") fail(`the search "${query}" says ${JSON.stringify(s.says)}`);
    }
    await a.field.search.fill("com mes");
    await a.shows("a search whose one prompt is the chosen one", (x) => x.rows.join("|") === "git/commit message" && x.on.join("|") === "git/commit message");
    await a.field.search.fill("squ");
    await a.hit("squash").click();
    await a.shows("a click on a prompt found", (x) => x.form?.name === "squash" && x.form.where === "In git commit");
    await a.field.search.fill("");
    await a.shows("the search emptied", (x) => x.list === "tree" && x.rows.join("|") === TREE.join("|") && x.on.join("|") === "  squash");
    // (Enter in the search chooses the first prompt found; the clearing button empties it)
    await a.field.search.fill("review");
    await page.keyboard.press("Enter");
    await a.shows("Enter in the search", (x) => x.form?.name === "review");
    await page.locator(`${DLG} .menu-search-clear`).click();
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
    await a.button("Revert").click();
    await a.shows("Revert on a prompt that is gone", (x) => !x.form && !!x.none);
    await mockEval(`libraries.local.prompts.push(${JSON.stringify(EXAMPLE.prompts[3])}); sendLibrary("local");`, url); // (as the example again)
    await a.shows("the example again", (x) => x.rows.join("|") === TREE.join("|"));
    note("a refused save shows the server's sentence and keeps the typed name and text, for a name that is taken and for a prompt deleted meanwhile");

    // ---- unsaved changes: leaving asks first
    await a.choose("review");
    await a.field.text.fill("Not saved yet.");
    await a.row("squash").click();
    s = await a.shows("leaving a prompt with unsaved changes", (x) => !!x.ask);
    if (s.ask.title !== "Discard changes?" || s.ask.body !== "The changes to the prompt “review” are not saved." || s.ask.buttons.join() !== "Cancel,Discard") fail(`the question is ${JSON.stringify(s.ask)}`);
    await a.answer("Cancel");
    s = await a.shows("Cancel", (x) => !x.ask && x.form?.name === "review" && x.form.text === "Not saved yet." && x.open === 1);
    await page.keyboard.press("Escape");
    await a.shows("Esc with unsaved changes", (x) => !!x.ask && x.open === 1);
    await page.keyboard.press("Escape"); // (the question's own Esc: it goes, the popup stays)
    await a.shows("Esc on the question", (x) => !x.ask && x.open === 1 && x.form?.text === "Not saved yet.");
    await a.button("Close").click();
    await a.shows("Close with unsaved changes", (x) => !!x.ask);
    await a.answer("Cancel");
    await a.button("New prompt").click();
    await a.shows("New prompt with unsaved changes", (x) => !!x.ask);
    await a.answer("Cancel");
    await a.row("squash").click();
    await a.shows("leaving again", (x) => !!x.ask);
    await a.answer("Discard");
    await a.shows("Discard", (x) => !x.ask && x.form?.name === "squash" && x.form.text === "Squash them.");
    if ((await lib()).prompts.find((x) => x.id === "p_review").text !== "Review this change.") fail("what was discarded was saved");
    // (with nothing typed nothing is asked)
    await a.row("review").click();
    await a.shows("leaving a prompt with nothing typed", (x) => !x.ask && x.form?.name === "review" && x.form.text === "Review this change.");
    // closed through the question, the popup gives the focus back too, and what was typed is gone when it opens again
    await a.field.text.fill("Dropped with the popup.");
    await page.keyboard.press("Escape");
    await a.shows("Esc with unsaved changes, once more", (x) => !!x.ask);
    await a.answer("Discard");
    await a.shows("Discard on the question of a closing popup", (x) => !x.ask && x.open === 0 && x.focus === "button");
    await page.keyboard.press("Enter");
    await a.shows("the popup opened again", (x) => x.open === 1 && !x.form && x.rows.join("|") === TREE.join("|"));
    await a.row("review").click();
    await a.shows("the prompt as it is saved", (x) => x.form?.text === "Review this change.");

    // ---- new items, a move, and the names the popup checks itself
    await a.row("misc").click();
    s = await a.shows("a group chosen", (x) => x.form?.head === "Group" && x.form.name === "misc");
    if (s.form.text !== null || s.form.where !== TOP || s.form.fields !== "input") fail(`the editor of the group "misc" shows ${JSON.stringify(s.form)}`);
    await a.button("New prompt").click();
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
    await a.button("New group").click();
    s = await a.shows("New group beside the chosen prompt", (x) => x.form?.head === "New group" && x.form.where === "In misc" && x.form.text === null && x.fresh === "  New group");
    await page.keyboard.type("inner");
    await page.keyboard.press("Enter"); // (Enter in the name saves)
    s = await a.shows("a new group saved", (x) => x.form?.head === "Group" && x.rows.join("|") === [...TREE.slice(0, 6), "  inner", "  git commit style", "  todo"].join("|"));
    const inner = (await lib()).groups.find((x) => x.name === "inner");
    if (!inner || inner.parent !== "g_misc") fail(`the new group is ${JSON.stringify(inner)}`);
    // a prompt is moved by dragging it onto another group, and the editor that is on it says where it is now
    await a.choose("todo");
    const drag = pointerDrag(page);
    await drag.start(await drag.at(a.row("todo")));
    await drag.over(await drag.at(a.row("inner")));
    await drag.drop();
    await a.shows("a prompt moved", (x) => x.rows.join("|") === [...TREE.slice(0, 6), "  inner", "    todo", "  git commit style"].join("|") && x.form?.where === "In misc/inner" && x.form.off.includes("Save"));
    if ((await lib()).prompts.find((x) => x.name === "todo").parent !== inner?.id) fail("the moved prompt is not in its new group");
    await a.row("misc").click();
    await a.shows("the group above", (x) => x.form?.head === "Group" && x.form.name === "misc" && x.form.where === TOP);

    // ---- deleting asks first; a group's question says how many prompts go with it
    await a.button("Delete").click();
    s = await a.shows("Delete on a group", (x) => !!x.ask);
    if (s.ask.title !== "Delete group" || s.ask.body !== "“misc” is deleted with everything in it: 2 prompts and 1 group." || s.ask.buttons.join() !== "Cancel,Delete") fail(`a group's question is ${JSON.stringify(s.ask)}`);
    await a.answer("Cancel");
    await a.shows("Cancel on the question", (x) => !x.ask && x.rows.includes("misc"));
    await a.button("Delete").click();
    await a.shows("Delete on a group again", (x) => !!x.ask);
    await a.answer("Delete");
    s = await a.shows("a group deleted", (x) => !x.ask && x.rows.join("|") === TREE.slice(0, 5).join("|") && !x.form);
    if (s.focus === "nothing") fail("after a delete the focus is nowhere");
    const left = await lib();
    if (left.groups.some((x) => ["misc", "inner"].includes(x.name)) || left.prompts.some((x) => ["todo", "git commit style"].includes(x.name))) fail(`after the group was deleted the library holds ${JSON.stringify(left)}`);
    await a.choose("squash");
    await a.button("Delete").click();
    s = await a.shows("Delete on a prompt", (x) => !!x.ask);
    if (s.ask.title !== "Delete prompt" || s.ask.body !== "“squash” is deleted from the library.") fail(`a prompt's question is ${JSON.stringify(s.ask)}`);
    await a.answer("Delete");
    await a.shows("a prompt deleted", (x) => !x.ask && x.rows.join("|") === TREE.slice(0, 4).join("|") && !x.form);
    note("leaving unsaved changes asks; new prompts and groups go where the tree is chosen; a move, the checks of a name, and both deletes with their questions");

    // ---- a second window
    const b = await windowOf("the second window");
    try {
      await a.choose("review");
      await b.page.locator(".side-foot .library-btn").click();
      await b.shows("its tree", (x) => x.rows.join("|") === TREE.slice(0, 4).join("|"));
      await b.button("New prompt").click();
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
    await b.close();
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
    await a.row("Studio").click();
    s = await a.shows("a server's entry chosen", (x) => /^Studio1 prompt in 1 group\.$/.test(x.about) && !x.form);
    await a.button("New prompt").click();
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
    await mockEval(`libraries.s_studio.connected = false; sendLibrary("s_studio"); extra.servers[1].state = "unreachable"; send({ type: "server_state", server: extra.servers[1] });`, url);
    s = await a.shows("a server that dropped", (x) => x.off.join("|") === "Studio" && x.form?.fixed === true);
    if (s.rows.join("|") !== [...BOTH, "  retro"].join("|")) fail(`with the server dropped the tree is ${JSON.stringify(s.rows)}`);
    if (!["Save", "Delete"].every((l) => s.form.off.includes(l)) || !/^Studio is not connected/.test(s.form.notice) || s.form.text !== "Typed before the server dropped.") fail(`a prompt of a server that dropped shows ${JSON.stringify(s.form)}`);
    if (await a.row("standup").getAttribute("draggable") !== "false" || !await a.field.text.evaluate((e) => e.readOnly)) fail("a prompt of a server that dropped can be dragged or its text typed over");
    await a.button("Revert").click();
    await a.field.search.fill("stand");
    await a.shows("its prompt in a search", (x) => x.rows.join("|") === "Studio/team/standup" && x.off.join("|") === "Studio/team/standup");
    await a.field.search.fill("");
    await a.button("New prompt").click();
    s = await a.shows("New prompt beside a prompt of a server that dropped", (x) => x.form?.head === "New prompt");
    if (s.form.where !== "In This computer") fail(`with the server dropped a new prompt goes to ${JSON.stringify(s.form.where)}`);
    await a.button("Cancel").click();
    // back, it can be changed again
    await mockEval(`libraries.s_studio.connected = true; sendLibrary("s_studio"); extra.servers[1].state = "connected"; send({ type: "server_state", server: extra.servers[1] });`, url);
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
    await a.button("Revert").click();
    // removed from the list, it takes its entry and its prompts with it
    await a.shows("before the server is removed", (x) => x.form?.name === "standup" && !x.form.err);
    await servers([]);
    await mockEval(`setLibrary("s_studio", null);`, url);
    s = await a.shows("a server removed from the list", (x) => x.rows.join("|") === TREE.join("|") && !x.form);
    await a.field.search.fill("stand");
    await a.shows("a search for its prompt", (x) => x.rows.length === 0 && x.says === "No matching prompts");
    note("another server's library is under its name and found by it, is changed from here, stays marked and unchangeable while the server is away, and goes with the server");
  } catch (e) { fail(e.message.split("\n")[0]); }
  await a.close();
});
