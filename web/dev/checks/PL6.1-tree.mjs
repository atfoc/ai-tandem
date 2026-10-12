// Proves that where an item of the prompt library is, is set in the tree of the library popup and nowhere else. It
// goes on from PL4.1, which has the popup's search, its editor and its saves.
//   How the tree is set in: a prompt at the top is at the left edge, in the column of the twists of the groups there,
//   with no line beside it, also right after the rows of a group; what is in a group starts further right, beside a
//   line that runs down from that group's twist, one line for every group it is in. The rows touch, so the lines have
//   no gaps. A tree 16 groups deep is set in by less a level and its names keep their room.
//   The menu of a right click says where it was opened and makes a new prompt or group there: in the group that was
//   clicked, beside the prompt that was clicked, at the top level on the space under the rows. The place is lit while
//   the menu is open, and the new item has a row in the tree where it goes, with the name as it is typed; a closed
//   group opens for it. With unsaved changes it asks first. The menu opens at the row for the menu key too, its
//   entries are walked with the arrows, and Esc closes it alone, with the focus back on the row.
//   The buttons under the tree make the new item beside the one that is being made, in the chosen group, beside the
//   chosen prompt, and at the top level with nothing chosen. The editor has no choice of a group, for a prompt, a
//   group or a new one of either.
//   A drag moves a prompt or a group: the group it would land in is lit with what is in it (over a prompt: the group
//   that prompt is in), the top level is the space under the rows and a bar that stands in the place of the buttons
//   during the move, and the dragged row is dimmed. Nothing is lit, and a drop does nothing, where the item is
//   already, on a group's own rows and on the rows below it, and beside the tree. What the server refuses (a name
//   that is taken at the new place, groups too deep) is said under the tree in the server's sentence, and nothing has
//   moved. A drag that begins changes neither the height of the list nor where it is scrolled to, also under such a
//   sentence in a list scrolled to its end: a row that shifts under the pointer then would end the drag at once.
//   What is typed in the editor stays through a move, and is saved after it.
//   "Move…" of the menu does the same with the keys: the focused row is where the item would land, Enter lands it,
//   Tab reaches the bar of the top level, Esc ends the move and leaves the popup open; a click on a row lands it too.
//   With another server's library: nothing is lit on another server's rows, a server's entry is the top of its
//   library (the bar names it), and a new item made at the entry is that server's. While the server is away its rows
//   cannot be dragged and its menu makes nothing, and says why.
// The menu key itself is not pressed (a headless Chromium on macOS has none): the event a browser makes of it, a
// contextmenu with no pointer, is sent to the focused row.
import { check, mockEval, openPage, pointerDrag, seed, until } from "../shot.mjs";

const g = (id, name, parent = "") => ({ id, name, parent }), p = (id, name, parent, text = name + "!") => ({ id, name, parent, text });
const LIB = { groups: [g("g_git", "git"), g("g_hooks", "hooks", "g_git"), g("g_misc", "misc")],
  prompts: [p("p_msg", "commit message", "g_git"), p("p_review", "review", "g_git"), p("p_pre", "pre-commit", "g_hooks"), p("p_style", "git commit style", "g_misc"), p("p_scratch", "scratch", ""), p("p_todo", "todo", "")] };
const TREE = ["git", "  hooks", "    pre-commit", "  commit message", "  review", "misc", "  git commit style", "scratch", "todo"];
const STUDIO = { id: "s_studio", name: "Studio", address: "https://studio.example:4790", state: "connected", version: "dev" };
const THEIRS = { groups: [g("g_team", "team")], prompts: [p("p_stand", "standup", "g_team"), p("p_retro", "retro", "")] };
const DLG = ".lib-dialog", TOP = "At the top level", TO_TOP = "Move to the top level", ITEMS = ["New prompt", "New group"];

/** In the page: what the library popup shows. rows: the rows of the tree, each set in by its level; drawn: the same
 *  with the row of an item that is being made, marked "+"; lit: what is lit as a place (head: the rows framed,
 *  inside: the rows tinted, all: the whole list, top: the bar of the top level); moved: the rows dimmed as on their
 *  way; top: the bar; menu: the menu of a right click. */
function seen() {
  const dlg = document.querySelector(".lib-dialog"), at = document.activeElement, text = (e) => e?.textContent ?? "";
  const all = [...(dlg?.querySelectorAll(".lib-list .lib-row") ?? [])], rows = all.filter((r) => !r.matches(".new"));
  const name = (r) => text(r.querySelector(".lib-name")), line = (r) => "  ".repeat(Number(r.getAttribute("aria-level")) - 1) + name(r);
  const form = dlg?.querySelector(".lib-form"), menu = dlg?.querySelector(".lib-ctx .menu"), top = dlg?.querySelector(".lib-top"), ask = document.querySelector(".dialog-backdrop .dialog");
  return {
    open: document.querySelectorAll(".lib-dialog").length, rows: rows.map(line), drawn: all.map((r) => (r.matches(".new") ? "+" : "") + line(r)), on: rows.filter((r) => r.getAttribute("aria-selected") === "true").map(name),
    closed: rows.filter((r) => r.getAttribute("aria-expanded") === "false").map(name), fixed: rows.filter((r) => r.getAttribute("draggable") !== "true").map(name),
    lit: { head: all.filter((r) => r.matches(".drop")).map(name), inside: all.filter((r) => r.matches(".drop-in")).map(name), all: !!dlg?.querySelector(".lib-list.drop"), top: !!top?.matches(".drop") },
    moved: rows.filter((r) => r.matches(".moved")).map(name), top: top ? { text: text(top), off: top.getAttribute("aria-disabled") === "true" } : null,
    hint: text(dlg?.querySelector(".lib-side > .lib-hint")), buttons: [...(dlg?.querySelectorAll(".lib-new button") ?? [])].map(text), treeErr: [...(dlg?.querySelectorAll('.lib-side > .dialog-err[role="alert"]') ?? [])].map(text).join("|"),
    menu: menu ? { note: text(menu.querySelector(".menu-note")), items: [...menu.querySelectorAll(".menu-item")].map((b) => b.textContent + (b.disabled ? " (off)" : "")), role: menu.getAttribute("role") } : null,
    form: form ? { head: text(form.querySelector(".lib-form-head > span")), where: text(form.querySelector(".lib-where")), name: form.querySelector("input").value, text: form.querySelector("textarea")?.value ?? null,
      selects: form.querySelectorAll("select").length, err: text(form.querySelector(".dialog-err")) } : null,
    ask: ask ? text(ask.querySelector(".dialog-title")) : "",
    focus: !at || at === document.body ? "nothing" : at.matches(".lib-search input") ? "search" : at.matches(".lib-row") ? "row " + name(at) : at.matches(".lib-form input") ? "name" : at.matches(".lib-ctx .menu-item") ? "menu " + at.textContent
      : at.matches(".lib-top") ? "top" : at.matches(".lib-dialog *") ? "popup " + at.tagName.toLowerCase() : at.tagName.toLowerCase() + "." + at.className,
  };
}

/** In the page: how the rows of the tree are set in, in pixels from the left edge of the list's own space. start:
 *  where the first thing of the row is (its twist, or a prompt's icon); twist: the column of its twist; guides: the
 *  lines beside it; over, under: how far a line ends from the row's upper and lower edge; gap: the space between the
 *  row and the one above; room: the width its name has. */
function shape() {
  const list = document.querySelector(".lib-dialog .lib-list"), box = list.getBoundingClientRect(), edge = box.left + list.clientLeft + parseFloat(getComputedStyle(list).paddingLeft);
  const x = (v) => Math.round((v - edge) * 10) / 10, rows = [...list.querySelectorAll(".lib-row")];
  return rows.map((r, i) => {
    const b = r.getBoundingClientRect(), first = [...r.children].find((c) => !c.matches(".lib-guide")).getBoundingClientRect(), twist = r.querySelector(".lib-twist")?.getBoundingClientRect(), lines = [...r.querySelectorAll(".lib-guide")].map((l) => l.getBoundingClientRect());
    return { name: r.querySelector(".lib-name").textContent, level: Number(r.getAttribute("aria-level")), kind: ["server", "group", "prompt"].find((k) => r.matches("." + k)), start: x(first.left), twist: twist ? [x(twist.left), x(twist.right)] : null,
      guides: lines.map((l) => x(l.left)), over: Math.max(0, ...lines.map((l) => Math.abs(l.top - b.top))), under: Math.max(0, ...lines.map((l) => Math.abs(l.bottom - b.bottom))),
      gap: i ? Math.round((b.top - rows[i - 1].getBoundingClientRect().bottom) * 10) / 10 : 0, room: Math.round(r.querySelector(".lib-name").getBoundingClientRect().width) };
  });
}

/** What is wrong with how a tree is set in: nothing, for one that reads as it is built. step: how far a level is set
 *  in at least; a tree that is not deep also has every row of a group right of that group's twist. */
function misshapen(rows, { step, deep = false }) {
  const bad = [], up = []; // up[level - 1]: the row of that level the current row is under
  for (const r of rows) {
    up.length = r.level - 1;
    const parent = up[r.level - 2];
    if (r.guides.length !== r.level - 1) bad.push(`"${r.name}" (level ${r.level}) has ${r.guides.length} lines beside it`);
    r.guides.forEach((at, i) => { const t = up[i]?.twist; if (!t || at < t[0] || at > t[1]) bad.push(`line ${i + 1} beside "${r.name}" is at ${at}, not in the twist's column of "${up[i]?.name}" (${JSON.stringify(t)})`); });
    if (r.over > 0.5 || r.under > 0.5 || r.gap !== 0) bad.push(`the lines beside "${r.name}" have a gap: ${JSON.stringify({ over: r.over, under: r.under, gap: r.gap })}`);
    if (!parent && (r.start !== rows[0].start || r.start > 8)) bad.push(`"${r.name}" is at the top and starts at ${r.start}, the first row at ${rows[0].start}`);
    if (parent && r.start - parent.start < step) bad.push(`"${r.name}" starts ${r.start - parent.start} px right of "${parent.name}", which it is in`);
    if (parent && !deep && r.start < parent.twist[1]) bad.push(`"${r.name}" starts at ${r.start}, under the twist of "${parent.name}" (${JSON.stringify(parent.twist)})`);
    if ((r.kind === "prompt") !== !r.twist) bad.push(`"${r.name}" is a ${r.kind} and has ${r.twist ? "a" : "no"} twist`);
    if (r.room < 60) bad.push(`the name of "${r.name}" has ${r.room} px`);
    up[r.level - 1] = r;
  }
  return bad;
}

await check("PL6.1 the library's tree: how it is set in, the menu of a right click, the buttons, and moves by a drag and by the keys", async ({ url, browser, fail, note }) => {
  const seeded = await seed(url, "A2");
  const sel = seeded.find((s) => s.id === "plain-started")?.sel ?? fail("the seed has no state plain-started");
  const lib = (server = "local") => mockEval(`return libraries[${JSON.stringify(server)}] ?? null;`, url);
  const item = async (name, server = "local") => { const l = await lib(server); return [...l.prompts, ...l.groups].find((x) => x.name === name); };
  const servers = (list) => mockEval(`extra.servers = ${JSON.stringify([{ id: "local", local: true, name: "This computer", state: "connected" }, ...list])}; send({ type: "servers", servers: extra.servers, notice: "" });`, url);
  await servers([]);
  await mockEval(`setLibrary("local", ${JSON.stringify(LIB)});`, url);
  const errors = [], w = await openPage({ url, browser, sel, errors, wait: ".side-foot .library-btn" }), { page } = w;
  const calls = []; // the calls that change a library
  page.on("request", (r) => { if (r.method() !== "GET" && r.url().includes("/api/library/")) calls.push(r.method()); });
  const read = () => page.evaluate(seen);
  /** Waits for the page to show what `want` says; fails with what it shows. */
  const shows = async (what, want) => {
    let s;
    if (!await until(async () => want((s = await read())), 10000)) fail(`${what}: the page shows ${JSON.stringify(s)}`);
    return s;
  };
  const row = (label) => page.locator(`${DLG} .lib-row:not(.new):has(.lib-name:text-is("${label}"))`);
  const button = (label) => page.locator(`${DLG} button:text-is("${label}")`), entry = (label) => page.locator(`${DLG} .lib-ctx .menu-item:text-is("${label}")`);
  const name = page.locator(`${DLG} .lib-form input`), words = page.locator(`${DLG} .lib-form textarea`), bar = page.locator(`${DLG} .lib-top`);
  const answer = (label) => page.locator(`.dialog-backdrop .dialog button:text-is("${label}")`).click();
  const same = (a, b) => a.join("|") === b.join("|"), unlit = (x) => !x.lit.head.length && !x.lit.inside.length && !x.lit.all && !x.lit.top;
  /** A point of the space under the rows of the list. */
  const under = async () => { const b = await page.locator(`${DLG} .lib-list`).boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height - 10 }; };
  /** Opens the menu as a right click does, on a row or on the space under the rows, and waits for it. */
  const menuOn = async (label, want) => {
    if (label) await row(label).click({ button: "right" }); else { const at = await under(); await page.mouse.click(at.x, at.y, { button: "right" }); }
    return shows(`the menu on ${label ? `"${label}"` : "the space under the rows"}`, (x) => x.menu?.note === want && x.focus === "menu New prompt");
  };
  const drag = pointerDrag(page);
  /** The list's own height and where it is scrolled to, and where a row is in the window. */
  const held = (label) => page.evaluate((label) => { const l = document.querySelector(".lib-dialog .lib-list"), r = [...l.querySelectorAll(".lib-row")].find((x) => x.querySelector(".lib-name").textContent === label);
    return [l.clientHeight, l.scrollTop, Math.round(r.getBoundingClientRect().top)].join(); }, label);
  const pick = async (label) => drag.start(await drag.at(row(label)));
  const over = async (label) => drag.over(await drag.at(row(label)));
  try {
    await page.locator(".side-foot .library-btn").click();
    let s = await shows("the tree", (x) => same(x.rows, TREE));

    // ---- how the tree is set in
    let form = await page.evaluate(shape), bad = misshapen(form, { step: 16 });
    const at = (rows, label) => rows.find((r) => r.name === label);
    // (the complaint: a prompt at the top that follows a group's rows must not read as one of them)
    if (at(form, "scratch").start !== at(form, "misc").start || at(form, "scratch").guides.length) bad.push(`"scratch", at the top, starts at ${at(form, "scratch").start} with ${at(form, "scratch").guides.length} lines; the group "misc" above it starts at ${at(form, "misc").start}`);
    if (at(form, "git commit style").start - at(form, "scratch").start < 16) bad.push(`"git commit style", in "misc", starts ${at(form, "git commit style").start - at(form, "scratch").start} px right of "scratch", at the top`);
    for (const b of bad) fail(`the tree: ${b}`);
    note(`a prompt at the top starts at ${at(form, "scratch").start} px with no line; one in a group ${at(form, "git commit style").start - at(form, "scratch").start} px further right, beside its group's line`);

    // ---- the menu of a right click: a new item where it was opened
    s = await menuOn("hooks", "In git/hooks");
    if (!same(s.menu.items, [...ITEMS, "Move…"]) || s.menu.role !== "menu" || !same(s.lit.head, ["hooks"]) || !same(s.lit.inside, ["pre-commit"]) || s.lit.all || s.on.length || s.form) fail(`the menu on the group "hooks" shows ${JSON.stringify(s)}`);
    await entry("New prompt").click();
    s = await shows("New prompt of the menu on a group", (x) => x.form?.head === "New prompt" && x.focus === "name" && !x.menu);
    if (s.form.where !== "In git/hooks" || s.form.selects || !same(s.drawn, [...TREE.slice(0, 2), "+    New prompt", ...TREE.slice(2)]) || !unlit(s)) fail(`a new prompt begun in "hooks" shows ${JSON.stringify(s)}`);
    await page.keyboard.type("lint");
    await shows("the new prompt's row as its name is typed", (x) => x.drawn[2] === "+    lint");
    await page.keyboard.press("Enter");
    let tree = [...TREE.slice(0, 2), "    lint", ...TREE.slice(2)];
    await shows("the new prompt saved", (x) => same(x.drawn, tree) && same(x.on, ["lint"]) && x.form?.where === "In git/hooks");
    if ((await item("lint"))?.parent !== "g_hooks") fail(`the prompt made by the menu on "hooks" is ${JSON.stringify(await item("lint"))}`);
    // on a prompt: beside it
    s = await menuOn("review", "In git");
    if (!same(s.menu.items, [...ITEMS, "Move…"]) || !same(s.lit.head, ["git"]) || !same(s.lit.inside, tree.slice(1, 6).map((l) => l.trim()))) fail(`the menu on the prompt "review" shows ${JSON.stringify(s)}`);
    await entry("New group").click();
    s = await shows("New group of the menu on a prompt", (x) => x.form?.head === "New group" && x.focus === "name");
    if (s.form.where !== "In git" || s.form.selects || s.form.text !== null || !same(s.drawn, [tree[0], "+  New group", ...tree.slice(1)])) fail(`a new group begun beside "review" shows ${JSON.stringify(s)}`);
    await page.keyboard.type("ci");
    await page.keyboard.press("Enter");
    tree = [tree[0], "  ci", ...tree.slice(1)];
    await shows("the new group saved", (x) => same(x.drawn, tree) && same(x.on, ["ci"]));
    if ((await item("ci"))?.parent !== "g_git") fail(`the group made by the menu on "review" is ${JSON.stringify(await item("ci"))}`);
    // on the space under the rows: at the top level. Esc closes the menu alone
    s = await menuOn("", TOP);
    if (!same(s.menu.items, ITEMS) || !s.lit.all || s.lit.head.length) fail(`the menu on the space under the rows shows ${JSON.stringify(s)}`);
    await page.keyboard.press("Escape");
    await shows("Esc on the menu", (x) => !x.menu && x.open === 1 && unlit(x) && x.focus.startsWith("row "));
    await menuOn("", TOP);
    await entry("New prompt").click();
    s = await shows("New prompt of the menu on the space under the rows", (x) => x.form?.head === "New prompt" && x.form.where === TOP);
    if (!same(s.drawn, [...tree.slice(0, 9), "+New prompt", ...tree.slice(9)])) fail(`a new prompt begun at the top has its row at ${JSON.stringify(s.drawn)}`);
    await page.keyboard.type("zeta");
    await page.keyboard.press("Enter");
    tree = [...tree, "zeta"];
    await shows("the new prompt at the top saved", (x) => same(x.drawn, tree) && same(x.on, ["zeta"]) && x.form?.where === TOP);
    if ((await item("zeta"))?.parent !== "") fail(`the prompt made on the space under the rows is ${JSON.stringify(await item("zeta"))}`);
    // on a prompt at the top: the top level
    await menuOn("scratch", TOP);
    await page.keyboard.press("Escape");
    // with unsaved changes it asks first
    await words.fill("Typed and not saved.");
    await menuOn("misc", "In misc");
    await entry("New prompt").click();
    await shows("New prompt of the menu with unsaved changes", (x) => x.ask === "Discard changes?");
    await answer("Cancel");
    s = await shows("Cancel on its question", (x) => !x.ask && x.form?.name === "zeta" && x.form.text === "Typed and not saved." && !x.drawn.some((l) => l.startsWith("+")));
    await button("Revert").click();
    // a closed group opens for the item made in it
    await row("git").locator(".lib-twist").click();
    await shows("the group closed", (x) => same(x.closed, ["git"]) && same(x.rows, ["git", ...tree.slice(7)]));
    await menuOn("git", "In git");
    await entry("New prompt").click();
    s = await shows("New prompt of the menu on a closed group", (x) => x.form?.where === "In git" && !x.closed.length);
    if (!same(s.drawn, [...tree.slice(0, 5), "+  New prompt", ...tree.slice(5)])) fail(`a new prompt begun in a closed group has its row at ${JSON.stringify(s.drawn)}`);
    await button("Cancel").click();
    await shows("Cancel on a new prompt", (x) => same(x.drawn, tree) && same(x.on, ["zeta"]));
    // the menu key: the menu is at its row, its entries are walked with the arrows, and Esc gives the row the focus back
    await row("misc").focus();
    await row("misc").dispatchEvent("contextmenu", { bubbles: true, cancelable: true, button: 0, clientX: 0, clientY: 0 });
    s = await shows("the menu key on a row", (x) => x.menu?.note === "In misc" && x.focus === "menu New prompt");
    const near = await page.evaluate(() => { const m = document.querySelector(".lib-ctx .menu").getBoundingClientRect(), r = document.activeElement.closest(".lib-dialog").querySelector('.lib-row[tabindex="0"]').getBoundingClientRect(); return { dx: Math.round(m.left - r.left), dy: Math.round(m.top - r.top) }; });
    if (near.dx < 0 || near.dx > 80 || near.dy < 0 || near.dy > 40) fail(`opened by the menu key, the menu is ${JSON.stringify(near)} px from its row`);
    for (const [key, want] of [["ArrowDown", "New group"], ["ArrowDown", "Move…"], ["ArrowDown", "New prompt"], ["ArrowUp", "Move…"], ["Home", "New prompt"], ["End", "Move…"]]) {
      await page.keyboard.press(key);
      await shows(`${key} in the menu`, (x) => x.focus === "menu " + want);
    }
    await page.keyboard.press("Escape");
    await shows("Esc on the menu of the menu key", (x) => !x.menu && x.open === 1 && x.focus === "row misc");
    note("the menu of a right click makes a prompt in the clicked group, a group beside the clicked prompt and a prompt at the top level on the space under the rows; the place is lit and the new row is where it goes");

    // ---- the buttons under the tree
    await button("New group").click(); // ("zeta", a prompt at the top, is chosen)
    await shows("New group beside a chosen prompt at the top", (x) => x.form?.head === "New group" && x.form.where === TOP && x.drawn[0] === "+New group" && !x.form.selects);
    await button("New prompt").click();
    await shows("New prompt beside the group that is being made", (x) => x.form?.head === "New prompt" && x.form.where === TOP && x.drawn[9] === "+New prompt");
    await button("Cancel").click();
    await row("hooks").click();
    s = await shows("a group chosen", (x) => x.form?.head === "Group" && x.form.name === "hooks" && x.form.where === "In git");
    if (s.form.selects) fail("the editor of a group has a choice of a group");
    await button("New prompt").click();
    await shows("New prompt in the chosen group", (x) => x.form?.where === "In git/hooks" && x.drawn[3] === "+    New prompt");
    await button("New group").click();
    await shows("New group beside the prompt that is being made", (x) => x.form?.head === "New group" && x.form.where === "In git/hooks" && x.drawn[3] === "+    New group");
    await button("Cancel").click();
    await row("review").click();
    s = await shows("a prompt chosen", (x) => x.form?.name === "review" && x.form.where === "In git");
    if (s.form.selects) fail("the editor of a prompt has a choice of a group");
    await button("New group").click();
    await shows("New group beside the chosen prompt", (x) => x.form?.where === "In git" && x.drawn[1] === "+  New group");
    await button("Cancel").click();
    await button("Close").click();
    await page.locator(".side-foot .library-btn").click();
    await shows("the popup opened again", (x) => x.open === 1 && !x.on.length && !x.form);
    await button("New prompt").click();
    await shows("New prompt with nothing chosen", (x) => x.form?.where === TOP && x.drawn[9] === "+New prompt");
    await button("Cancel").click();
    note("the buttons make the new item in the chosen group, beside the chosen prompt, beside the one that is being made, and at the top level with nothing chosen; the editor has no choice of a group");

    // ---- a drag moves a prompt
    s = await read();
    if (s.fixed.length) fail(`rows that cannot be dragged: ${JSON.stringify(s.fixed)}`);
    if (!same(s.buttons, ITEMS)) fail(`under the tree are the buttons ${JSON.stringify(s.buttons)}`);
    calls.length = 0;
    let before = await held("scratch");
    await pick("scratch");
    s = await shows("a drag begun", (x) => same(x.moved, ["scratch"]) && !!x.top);
    if (s.top.text !== TO_TOP || !s.top.off || !unlit(s) || !same(s.buttons, [TO_TOP])) fail(`with "scratch" picked up the page shows ${JSON.stringify(s)}`);
    if (await held("scratch") !== before) fail(`a drag that began changed the list or moved its row: [height, scrolled, row's top] was ${before}, is ${await held("scratch")}`);
    await over("misc");
    await shows("the drag over a group", (x) => same(x.lit.head, ["misc"]) && same(x.lit.inside, ["git commit style"]) && !x.lit.all && !x.lit.top);
    await over("git commit style"); // (over a prompt: the group it is in)
    await shows("the drag over a prompt of that group", (x) => same(x.lit.head, ["misc"]) && same(x.lit.inside, ["git commit style"]));
    await over("todo"); // (beside it already: nothing)
    await shows("the drag over a prompt beside the dragged one", unlit);
    await drag.over(await under());
    await shows("the drag of a prompt at the top over the space under the rows", unlit);
    await drag.over(await drag.at(bar));
    await shows("the drag of a prompt at the top over the bar of the top level", unlit);
    await over("pre-commit");
    await shows("the drag over a prompt two groups deep", (x) => same(x.lit.head, ["hooks"]) && same(x.lit.inside, ["lint", "pre-commit"]));
    await drag.drop();
    tree = ["git", "  ci", "  hooks", "    lint", "    pre-commit", "    scratch", "  commit message", "  review", "misc", "  git commit style", "todo", "zeta"];
    s = await shows("the drop on a prompt two groups deep", (x) => same(x.rows, tree) && !x.top && unlit(x) && !x.moved.length && same(x.buttons, ITEMS));
    if ((await item("scratch")).parent !== "g_hooks" || s.treeErr || !same(calls, ["PATCH"])) fail(`after the drop "scratch" is ${JSON.stringify(await item("scratch"))}, the calls were ${JSON.stringify(calls)}, and the page says ${JSON.stringify(s.treeErr)}`);
    // back to the top level: the space under the rows, and the bar
    await pick("scratch");
    await drag.over(await under());
    s = await shows("the drag of a prompt in a group over the space under the rows", (x) => x.lit.all && !x.lit.head.length && x.top?.off === false);
    await drag.over(await drag.at(bar));
    await shows("the drag over the bar of the top level", (x) => x.lit.top && x.lit.all);
    await drag.drop();
    tree = ["git", "  ci", "  hooks", "    lint", "    pre-commit", "  commit message", "  review", "misc", "  git commit style", "scratch", "todo", "zeta"];
    await shows("the drop on the bar of the top level", (x) => same(x.rows, tree) && !x.top && unlit(x));
    if ((await item("scratch")).parent !== "") fail(`after the drop on the bar "scratch" is ${JSON.stringify(await item("scratch"))}`);

    // ---- a group: never into itself or below itself; and a release beside the tree
    calls.length = 0;
    await pick("git");
    await shows("a group picked up", (x) => same(x.moved, ["git"]) && x.top?.off === true);
    for (const label of ["hooks", "pre-commit", "ci", "review", "git"]) {
      await over(label);
      await shows(`the drag of "git" over its own "${label}"`, unlit);
    }
    await drag.drop();
    await shows("the drop of a group on a row of its own", (x) => same(x.rows, tree) && !x.top && !x.moved.length && !x.treeErr);
    await pick("todo");
    await over("misc");
    await shows("the drag over a group, before it leaves the tree", (x) => same(x.lit.head, ["misc"]));
    await drag.over(await drag.at(page.locator(`${DLG} .lib-edit`)));
    await shows("the drag beside the tree", unlit);
    await drag.drop();
    await shows("the release beside the tree", (x) => same(x.rows, tree) && !x.top && !x.moved.length);
    if (calls.length) fail(`drops that land nowhere made the calls ${JSON.stringify(calls)}`);
    await pick("git");
    await over("git commit style");
    await shows("the drag of a group over a prompt of another group", (x) => same(x.lit.head, ["misc"]));
    await drag.drop();
    tree = ["misc", "  git", "    ci", "    hooks", "      lint", "      pre-commit", "    commit message", "    review", "  git commit style", "scratch", "todo", "zeta"];
    await shows("a group dropped into another", (x) => same(x.rows, tree) && !x.top);
    if ((await item("git")).parent !== "g_misc") fail(`after the drop the group "git" is ${JSON.stringify(await item("git"))}`);
    for (const b of misshapen(await page.evaluate(shape), { step: 16 })) fail(`the tree after the moves: ${b}`);
    note("a drag lights the group it would land in, over a prompt the group that prompt is in, and the top level under the rows and on its bar; nothing is lit where the item is, on a group's own rows, and beside the tree");

    // ---- what the server refuses is said under the tree, and nothing has moved
    await mockEval(`libraries.local.prompts.push(${JSON.stringify(p("p_todo2", "TODO", "g_misc"))}); sendLibrary("local");`, url);
    tree = [...tree.slice(0, 9), "  TODO", ...tree.slice(9)];
    await shows("a prompt of a taken name in a group", (x) => same(x.rows, tree));
    await pick("TODO");
    await drag.over(await drag.at(bar));
    await shows("its drag over the bar", (x) => x.lit.top);
    await drag.drop();
    s = await shows("a move the server refuses for the name", (x) => !!x.treeErr);
    if (s.treeErr !== 'There is already a prompt called "todo" at the top of the library.' || !same(s.rows, tree) || (await item("TODO")).parent !== "g_misc" || s.top) fail(`a refused move left ${JSON.stringify(s)}`);
    await row("zeta").click();
    await shows("the refusal after the next click", (x) => !x.treeErr && x.form?.name === "zeta");
    // too deep: a tree 16 groups deep takes a prompt and no group
    const chain = Array.from({ length: 16 }, (_, i) => g(`g_d${i + 1}`, `d${i + 1}`, i ? `g_d${i}` : ""));
    await mockEval(`libraries.local.groups.push(...${JSON.stringify(chain)}); sendLibrary("local");`, url);
    await shows("a tree 16 groups deep", (x) => x.rows.length === tree.length + 16 && x.rows[15] === "  ".repeat(15) + "d16");
    form = await page.evaluate(shape);
    for (const b of misshapen(form, { step: 8, deep: true })) fail(`the deep tree: ${b}`);
    await pick("ci");
    await over("d16");
    await shows("the drag of a group over the 16th group", (x) => same(x.lit.head, ["d16"]));
    await drag.drop();
    s = await shows("a move the server refuses for the depth", (x) => !!x.treeErr);
    if (s.treeErr !== "Groups can be at most 16 deep." || (await item("ci")).parent !== "g_git") fail(`a move too deep left ${JSON.stringify({ err: s.treeErr, ci: await item("ci") })}`);
    // the refusal is still said, and the list is scrolled to its end: the last row can be dragged, and nothing shifts
    await page.evaluate(() => { const l = document.querySelector(".lib-dialog .lib-list"); l.scrollTop = l.scrollHeight; });
    before = await held("zeta");
    await pick("zeta");
    s = await shows("the drag of the last row of a list scrolled to its end, under a refusal", (x) => same(x.moved, ["zeta"]) && !!x.top);
    if (await held("zeta") !== before || !s.treeErr) fail(`that drag changed the list or moved its row: [height, scrolled, row's top] was ${before}, is ${await held("zeta")}; the refusal reads ${JSON.stringify(s.treeErr)}`);
    await over("d16");
    await drag.drop();
    await shows("a prompt dropped into the 16th group", (x) => !x.treeErr && x.rows[16] === "  ".repeat(16) + "zeta");
    if ((await item("zeta")).parent !== "g_d16") fail(`the prompt dropped into the 16th group is ${JSON.stringify(await item("zeta"))}`);
    note(`a move the server refuses says its sentence under the tree and moves nothing; 16 groups deep a level is set in by ${form[1].start - form[0].start} px and the narrowest name has ${Math.min(...form.map((r) => r.room))} px`);

    // ---- what is typed in the editor stays through a move, and is saved after it
    await mockEval(`setLibrary("local", ${JSON.stringify(LIB)});`, url);
    await shows("the first library again", (x) => same(x.rows, TREE));
    await row("review").click();
    await shows("a prompt chosen before its move", (x) => x.form?.name === "review");
    await words.fill("Typed, then moved.");
    await pick("review");
    await over("misc");
    await drag.drop();
    s = await shows("a prompt moved under what was typed", (x) => x.form?.where === "In misc" && x.rows.includes("  review") && x.rows.indexOf("  review") > x.rows.indexOf("misc"));
    if (s.form.text !== "Typed, then moved." || s.ask || s.form.name !== "review" || !same(s.on, ["review"])) fail(`after the move the editor shows ${JSON.stringify(s.form)}`);
    if ((await item("review")).text !== "review!") fail("the move saved what was typed");
    await button("Save").click();
    if (!await until(async () => { const r = await item("review"); return r.text === "Typed, then moved." && r.parent === "g_misc"; }, 10000)) fail(`after the save the moved prompt is ${JSON.stringify(await item("review"))}`);

    // ---- "Move…" of the menu: the same with the keys
    await mockEval(`setLibrary("local", ${JSON.stringify(LIB)});`, url);
    await shows("the first library once more", (x) => same(x.rows, TREE) && x.form?.where === "In git");
    await menuOn("scratch", TOP);
    await entry("Move…").click();
    s = await shows("Move… of the menu", (x) => !x.menu && !!x.hint && x.focus === "row scratch");
    if (s.hint !== "Moving “scratch”: choose a group, or the top. Enter moves it there, Esc cancels." || !same(s.moved, ["scratch"]) || !s.top?.off || !unlit(s)) fail(`a move by the keys begins with ${JSON.stringify(s)}`);
    await page.keyboard.press("ArrowUp");
    await shows("ArrowUp in a move", (x) => x.focus === "row git commit style" && same(x.lit.head, ["misc"]) && same(x.lit.inside, ["git commit style"]));
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await shows("the focus on a prompt of another group", (x) => x.focus === "row review" && same(x.lit.head, ["git"]));
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    s = await shows("Enter in a move", (x) => same(x.rows, [...TREE.slice(0, 7), "  scratch", "todo"]) && !x.hint && !x.top && unlit(x));
    if ((await item("scratch")).parent !== "g_misc" || s.focus !== "row scratch" || s.form?.name !== "review") fail(`after Enter in a move the page shows ${JSON.stringify(s)}`);
    // Esc ends the move, and the popup stays
    await row("scratch").focus();
    await row("scratch").dispatchEvent("contextmenu", { bubbles: true, cancelable: true, button: 0, clientX: 0, clientY: 0 });
    await shows("the menu key on the moved prompt", (x) => x.menu?.note === "In misc");
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await shows("Move… by the keys", (x) => !!x.hint && x.focus === "row scratch" && x.top?.off === false);
    await page.keyboard.press("Escape");
    s = await shows("Esc in a move", (x) => !x.hint && !x.top && x.open === 1 && !x.moved.length);
    if (s.focus !== "row scratch" || (await item("scratch")).parent !== "g_misc") fail(`after Esc in a move the page shows ${JSON.stringify(s)}`);
    // Tab reaches the bar of the top level
    await row("scratch").click({ button: "right" });
    await entry("Move…").click();
    await shows("Move… again", (x) => !!x.hint && x.focus === "row scratch");
    await page.keyboard.press("Tab");
    await shows("Tab in a move", (x) => x.focus === "top" && x.lit.top && x.lit.all);
    await page.keyboard.press("Enter");
    s = await shows("Enter on the bar of the top level", (x) => same(x.rows, TREE) && !x.hint && !x.top);
    if ((await item("scratch")).parent !== "" || s.focus !== "row scratch") fail(`after Enter on the bar the page shows ${JSON.stringify(s)}`);
    // a group's own rows take nothing, and a click on another group's row lands it
    calls.length = 0;
    await row("git").click({ button: "right" });
    await entry("Move…").click();
    await shows("Move… on a group", (x) => !!x.hint && x.focus === "row git" && x.top?.off === true);
    await page.keyboard.press("ArrowDown");
    await shows("the focus on a group below the moved one", (x) => x.focus === "row hooks" && unlit(x));
    await page.keyboard.press("Enter");
    await shows("Enter on a group below the moved one", (x) => !!x.hint && same(x.rows, TREE));
    if (calls.length) fail(`Enter on a row that takes nothing made the calls ${JSON.stringify(calls)}`);
    await row("git commit style").click();
    s = await shows("a click on a row in a move", (x) => same(x.rows, ["misc", "  git", "    hooks", "      pre-commit", "    commit message", "    review", "  git commit style", "scratch", "todo"]) && !x.hint);
    if ((await item("git")).parent !== "g_misc" || s.form?.name !== "review") fail(`after a click in a move the page shows ${JSON.stringify(s)}`);
    note("Move… of the menu moves with the keys: the focused row is lit as the place, Enter and a click land the item, Tab reaches the top level's bar, Esc ends the move alone");

    // ---- another server's library
    await mockEval(`setLibrary("local", ${JSON.stringify(LIB)});`, url);
    await servers([STUDIO]);
    await mockEval(`setLibrary("s_studio", ${JSON.stringify(THEIRS)});`, url);
    const BOTH = ["This computer", ...TREE.map((r) => "  " + r), "Studio", "  team", "    standup", "  retro"];
    s = await shows("a server that joined the list", (x) => same(x.rows, BOTH));
    if (!same(s.fixed, ["This computer", "Studio"])) fail(`with two libraries the rows that cannot be dragged are ${JSON.stringify(s.fixed)}`);
    form = await page.evaluate(shape);
    for (const b of misshapen(form, { step: 16 })) fail(`the tree of two libraries: ${b}`);
    if (at(form, "retro").guides.length !== 1 || at(form, "standup").guides.length !== 2) fail(`under a server's entry "retro" has ${at(form, "retro").guides.length} lines and "standup" ${at(form, "standup").guides.length}`);
    calls.length = 0;
    await pick("todo");
    for (const label of ["team", "standup", "Studio", "This computer"]) {
      await over(label);
      await shows(`the drag of this computer's prompt at the top over "${label}"`, unlit);
    }
    await drag.drop();
    await shows("its drop on a server's entry", (x) => same(x.rows, BOTH) && !x.top);
    if (calls.length) fail(`a drop on another server's rows made the calls ${JSON.stringify(calls)}`);
    await pick("standup");
    s = await shows("a prompt of the other server picked up", (x) => x.top?.text === "Move to the top of Studio" && x.top.off === false);
    await over("git");
    await shows("its drag over a group of this computer", unlit);
    await over("Studio");
    await shows("its drag over its server's entry", (x) => same(x.lit.head, ["Studio"]) && same(x.lit.inside, ["team", "standup", "retro"]) && !x.lit.all);
    await drag.drop();
    await shows("its drop on its server's entry", (x) => same(x.rows, [...BOTH.slice(0, -2), "  retro", "  standup"]));
    if ((await item("standup", "s_studio")).parent !== "" || (await lib()).prompts.some((x) => x.name === "standup")) fail(`after the drop on Studio's entry "standup" is ${JSON.stringify(await item("standup", "s_studio"))} there`);
    s = await menuOn("Studio", "In Studio");
    if (!same(s.menu.items, ITEMS) || !same(s.lit.head, ["Studio"])) fail(`the menu on a server's entry shows ${JSON.stringify(s)}`);
    await entry("New group").click();
    await shows("New group of the menu on a server's entry", (x) => x.form?.head === "New group" && x.form.where === "In Studio" && x.drawn[11] === "+  New group");
    await page.keyboard.type("plans");
    await page.keyboard.press("Enter");
    await shows("the new group on the other server", (x) => x.rows.includes("  plans") && x.form?.head === "Group");
    if ((await item("plans", "s_studio"))?.parent !== "" || (await lib()).groups.some((x) => x.name === "plans")) fail(`the group made at Studio's entry is ${JSON.stringify(await item("plans", "s_studio"))} there`);
    await menuOn("", "In This computer");
    await page.keyboard.press("Escape");
    // the server drops: its rows cannot be dragged, and its menu makes nothing and says why
    await mockEval(`libraries.s_studio.connected = false; sendLibrary("s_studio"); extra.servers[1].state = "unreachable"; send({ type: "server_state", server: extra.servers[1] });`, url);
    s = await shows("a server that dropped", (x) => same(x.fixed, ["This computer", "Studio", "plans", "team", "retro", "standup"]));
    await row("team").click({ button: "right" });
    s = await shows("the menu on a row of a server that dropped", (x) => !!x.menu);
    if (s.menu.note !== "Studio is not connected: nothing can be changed there until it is back." || !same(s.menu.items, [...ITEMS, "Move…"].map((l) => l + " (off)")) || !unlit(s)) fail(`the menu on a row of a server that dropped shows ${JSON.stringify(s.menu)}`);
    await page.keyboard.press("Escape");
    await shows("Esc on that menu", (x) => !x.menu && x.open === 1);
    note("nothing is lit on another server's rows; a server's entry is the top of its library; while the server is away its rows cannot be dragged and its menu makes nothing");
  } catch (e) { fail(e.message.split("\n")[0]); }
  for (const e of errors) fail(`page error: ${e}`);
  await w.ctx.close();
});
