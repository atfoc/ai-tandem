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
// At the phone (ux-improvements S4) the popup is gone: the Library screen and the group screens are pushed screens, and the rule above is proved through them (`phoneHalf`).
//   A new item is made where the screen says: "+" on the Library screen at the top level; "New prompt here" / "New group here" of a group's "⋯" sheet and its "+ New prompt here" row in that group;
//   a nested group is one more push and its "here" is the nested group; the editor's and the group form's Group row says that place before the save; with unsaved changes in an open editor a press on the
//   page behind only asks (a sheet at a time). A move is the Move picker (from a swipe's Move, a row's long-press sheet, a group's "Move group…" and the editor's Group row): "Top level" first, then the
//   groups depth-first, each in by more than its parent (the icons' offsets are measured, also 16 deep), the current place tinted and checked with "Now here", a group's own subtree not offered; a pick moves
//   the prompt or group (the mock's parent, and the lists: it leaves this screen and is on the target's), the current place does nothing, the editor's Group row changes the place only on Save (Discard leaves it).
//   What the server refuses (a name taken at the new place, groups too deep) is said in the server's sentence, in the toast of a move and in the form's error of a save, nothing has moved and what was typed stays.
//   With another server's library: its places are dimmed with "A prompt stays in its own server's library" and cannot be picked, a new item made in its section or at its top is that server's, and while it is
//   away its rows have no swipe actions, its sheets' change rows wait with the reason and the picker's rows say "<name> is not connected".
//   No phone counterpart: the indent lines, the menu key, the drag with its lit places and bar, Tab and the arrows of "Move…" (a finger has no hover, no key and no drag over rows; the picker is the one way to move).
// Ports dev/checks/PL6.1-tree.mjs (S11) to the new build, at the three viewports (C-PL-10, 12 to 15, 17). What changed: the selectors (testIDs; `library.mjs` reads the popup and how the tree is set in),
// the presses, the right click (a long press with a finger: the row's menu), the drag (a pointer gesture: a mouse drags at once, a finger is held first, then moves; the pointer's route is `pointerDragger`),
// and the list's height and scroll, which are the scroll view's.

import fs from "node:fs";
import { callOfRequest, check, mockEval, seed, until } from "../shot.mjs";
import { byTid, longPress, pointerDragger, press, showList, tidSel, touchDrag } from "./sel.mjs";
import { misshapen, seen, shape } from "./library.mjs";
import { barOf, holdOpen, openGroup, openLibrary, pressSheetRow, rowsOf, sectionsOf, sheetOf, topScreen } from "./libphone.mjs";
import { atRest } from "./settings.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const g = (id, name, parent = "") => ({ id, name, parent }), p = (id, name, parent, text = name + "!") => ({ id, name, parent, text });
const LIB = { groups: [g("g_git", "git"), g("g_hooks", "hooks", "g_git"), g("g_misc", "misc")],
  prompts: [p("p_msg", "commit message", "g_git"), p("p_review", "review", "g_git"), p("p_pre", "pre-commit", "g_hooks"), p("p_style", "git commit style", "g_misc"), p("p_scratch", "scratch", ""), p("p_todo", "todo", "")] };
const TREE = ["git", "  hooks", "    pre-commit", "  commit message", "  review", "misc", "  git commit style", "scratch", "todo"];
const STUDIO = { id: "s_studio", name: "Studio", address: "https://studio.example:4790", state: "connected", version: "dev" };
const THEIRS = { groups: [g("g_team", "team")], prompts: [p("p_stand", "standup", "g_team"), p("p_retro", "retro", "")] };
const mkG = g, mkP = p;
const TOP = "At the top level", TO_TOP = "Move to the top level", ITEMS = ["New prompt", "New group"];

// ---- the phone's half (ux-improvements S4): the Library screen and the group screens, the editor, the group form and the Move picker
const WAIT = 15000, J = JSON.stringify;
const SENTENCE_TAKEN = 'There is already a prompt called "todo" at the top of the library.';

async function phoneHalf({ url, open, fail, note }) {
  const { page } = await open();
  const OUT = process.env.OUT; // (set: the picker, the editor and the refusal are shot, light and dark)
  const shoot = async (name) => { if (!OUT) return; fs.mkdirSync(OUT, { recursive: true }); await page.waitForTimeout(450); await page.screenshot({ path: `${OUT}/pl61-${name}.png` }); };
  await byTid(page, "home").first().waitFor({ state: "visible", timeout: WAIT });
  const calls = []; // the calls that change a library
  page.on("request", (r) => { const c = callOfRequest(r); if (c && c.method !== "GET" && c.path.includes("/api/library/")) calls.push(c.method); });
  const lib = (server = "local") => mockEval(`return libraries[${J(server)}] ?? null;`, url);
  const item = async (name, server = "local") => { const l = await lib(server); return [...l.prompts, ...l.groups].find((x) => x.name === name) ?? null; };
  const reset = async ({ studio = false } = {}) => {
    await page.evaluate(() => window.__aiwbLibrary.closeAllSheets());
    await mockEval(`setServers(${studio ? J([STUDIO]) : "[]"}); setLibrary("local", ${J(LIB)});${studio ? ` setLibrary(${J(STUDIO.id)}, ${J(THEIRS)}); setServerState(${J(STUDIO.id)}, "connected", { version: "dev" });` : ""}`, url);
  };
  const shows = async (what, want) => { if (!await until(async () => Boolean(await want()), WAIT)) fail(`${what}: not so after ${WAIT} ms`); };
  const sheets = () => page.evaluate(() => window.__aiwbLibrary.sheets());
  const names = async () => (await rowsOf(page)).map((r) => r.name);
  const tx = async (id) => ((await byTid(page, id).last().innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
  const gone = (id) => until(async () => (await byTid(page, id).count()) === 0, WAIT);
  const field = (id) => byTid(page, id).last();
  const barIs = async (back, title, what) => { const b = await barOf(page); if (b.back !== back || b.title !== title) fail(`${what}: the bar says back ${J(b.back)}, title ${J(b.title)}; wanted ${J(back)}, ${J(title)}`); };

  /** The Library screen on top: the group screens above it are popped by their back. */
  const toLibrary = async () => {
    await page.evaluate(() => window.__aiwbLibrary.closeAllSheets());
    for (let i = 0; i < 20; i++) {
      const top = (await topScreen(page)).testId;
      if (top === "lib-screen") break;
      if (top === null) { await openLibrary(page); break; }
      await press(page, byTid(page, "nav-back").last());
      await page.waitForTimeout(250);
    }
    await atRest(page, "lib-screen");
  };
  const groupIn = async (ids) => { for (const id of ids) await openGroup(page, id); };

  // ---- sheets: the action sheet (P1), the swipe, the Move picker
  const sheetOpen = async (id = "action-sheet") => {
    await byTid(page, id).last().waitFor({ state: "visible", timeout: WAIT });
    await atRest(page, id === "action-sheet" ? "action-row" : "confirm-go");
    await page.waitForFunction((id) => { const s = [...document.querySelectorAll(`[data-testid="${id}"]`)].pop(), last = [...s.querySelectorAll('[data-testid="action-row"], [data-testid="confirm-go"]')].pop(); return !!last && last.getBoundingClientRect().bottom <= innerHeight; }, id, { timeout: WAIT });
    return sheetOf(page, id);
  };
  const sheetGone = () => until(async () => (await byTid(page, "action-sheet").count()) === 0 || !(await byTid(page, "action-sheet").last().isVisible().catch(() => false)), WAIT);
  const closeP1 = async () => { await page.keyboard.press("Escape"); await sheetGone(); };
  const swipeRow = (id) => `[data-testid="swipe-row"][data-id=${J(id)}]`;
  const actionsOf = (id) => page.evaluate((sel) => [...document.querySelectorAll(`${sel} [data-testid="swipe-action"]`)].map((e) => ({ action: e.dataset.action, label: e.textContent.trim() })), swipeRow(id));
  const swipe = async (id) => {
    await until(async () => (await actionsOf(id)).length === 0, WAIT);
    const l = page.locator(swipeRow(id)).first();
    await l.scrollIntoViewIfNeeded();
    const b = await l.boundingBox();
    await touchDrag(page, { x: b.x + b.width * 0.7, y: b.y + b.height / 2 }, { x: b.x + b.width * 0.3, y: b.y + b.height / 2 }, { hold: 0 });
  };
  /** The picker opened by the row's swipe (Move). */
  const moveBySwipe = async (id) => {
    await swipe(id);
    if (!await until(async () => (await actionsOf(id)).length === 2, WAIT)) fail(`a swipe on ${id} did not open its actions`);
    await press(page, page.locator(`${swipeRow(id)} [data-testid="swipe-action"][data-action="move"]`).first());
    await atRest(page, "move-picker");
  };
  /** The picker opened by a row's long-press sheet. */
  const moveByRow = async (kind, id) => {
    await holdOpen(page, byTid(page, kind === "group" ? "lib-group-row" : "lib-prompt-row", { id }).last());
    await sheetOpen();
    await pressSheetRow(page, "action-sheet", "move");
    await atRest(page, "move-picker");
  };
  /** The picker opened by "Move group…" of the "⋯" sheet of the group screen on top. */
  const moveByMore = async () => {
    await press(page, byTid(page, "lib-more").last());
    await sheetOpen();
    await pressSheetRow(page, "action-sheet", "move");
    await atRest(page, "move-picker");
  };
  const pickerRows = () => page.evaluate(() => {
    const root = [...document.querySelectorAll('[data-testid="move-picker"]')].pop();
    const rows = [...root.querySelectorAll('[data-testid="picker-row"]')];
    const heads = [...root.querySelectorAll('[data-testid="menu-head"]')].map((e) => e.textContent.trim().toLowerCase());
    const sectionOf = (row) => { let s = ""; for (const h of root.querySelectorAll('[data-testid="menu-head"]')) if (h.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING) s = h.textContent.trim().toLowerCase(); return s; };
    return { title: root.querySelector('[data-testid="sheet-title"]')?.innerText.trim(), sub: root.querySelector('[data-testid="sheet-sub"]')?.innerText.trim(), heads, rows: rows.map((r) => {
      const lines = r.innerText.split("\n").map((s) => s.trim()).filter(Boolean), svg = r.querySelector("svg")?.getBoundingClientRect();
      return { value: r.dataset.value, label: lines[0], note: lines.find((l, i) => i && l !== "✓") ?? "", checked: r.getAttribute("aria-checked") === "true", off: r.getAttribute("aria-disabled") === "true", tick: lines.includes("✓"), glyph: svg ? Math.round(svg.left) : null, section: sectionOf(r) };
    }) };
  });
  const pickerRow = (value) => byTid(page, "move-picker").last().locator(tidSel("picker-row", { value }));
  const closePicker = async () => { await page.keyboard.press("Escape"); await gone("move-picker"); };
  const labels = (p, section) => p.rows.filter((r) => section === undefined || r.section === section).map((r) => r.label).join("|");
  /** The indents of the rows given (by label): the left of each row's icon. */
  const glyphs = (p, wanted) => wanted.map((l) => p.rows.find((r) => r.label === l)?.glyph);

  // ---- the editor and the group form
  const rowText = (id) => tx(id);
  const saveIt = async (id) => { await press(page, byTid(page, "sheet-right").last()); if (!await gone(id)) fail(`${id} stays after Save`); };
  const discard = async (id) => { await press(page, byTid(page, "sheet-left").last()); await atRest(page, "confirm-sheet"); await press(page, byTid(page, "confirm-go").last()); if (!await gone(id)) fail(`${id} stays after Discard`); };
  const tapOn = async (id, data) => { await press(page, byTid(page, id, data).last()); };
  const toastIs = async (what, sentence) => {
    if (!await until(async () => (await byTid(page, "toast").count()) > 0 && (await tx("toast")).includes(sentence), WAIT)) fail(`${what}: the toast says ${J(await tx("toast"))}, not ${J(sentence)}`);
    else if ((await byTid(page, "toast").last().getAttribute("data-kind")) !== "error") fail(`${what}: the toast is not an error`);
  };

  try {
    // ================================================================ a new item is made where the screen says
    await reset();
    await openLibrary(page);
    await toLibrary();
    // "+" on the Library screen: the top level
    await press(page, byTid(page, "lib-plus").last());
    let sh = await sheetOpen();
    if (sh.sub !== "At the top level") fail(`the "+" sheet says ${J(sh.sub)}, not "At the top level"`);
    await pressSheetRow(page, "action-sheet", "new-prompt");
    await atRest(page, "prompt-editor");
    if (await rowText("editor-group-row") !== "Group Top level") fail(`"+" › New prompt: the Group row says ${J(await rowText("editor-group-row"))} before the save, not "Group Top level"`);
    await field("editor-name").fill("zeta");
    await saveIt("prompt-editor");
    await shows("the prompt made by \"+\" at the top", async () => (await item("zeta"))?.parent === "");
    await shows("its row on the Library screen", async () => (await names()).includes("zeta"));
    await press(page, byTid(page, "lib-plus").last());
    await sheetOpen();
    await pressSheetRow(page, "action-sheet", "new-group");
    await atRest(page, "group-form");
    if (await tx("group-form-where") !== "In Top level") fail(`"+" › New group: the In row says ${J(await tx("group-form-where"))} before the save`);
    await field("group-form-name").fill("ci");
    await saveIt("group-form");
    await shows("the group made by \"+\" at the top", async () => (await item("ci"))?.parent === "");
    await shows("its row on the Library screen", async () => (await rowsOf(page)).some((r) => r.kind === "group" && r.name === "ci"));

    // a group's screen: its "⋯" sheet and its "+ New prompt here" row make the item in that group
    await groupIn(["g_git", "g_hooks"]);
    await barIs("git", "hooks", "the nested group screen");
    await press(page, byTid(page, "lib-more").last());
    sh = await sheetOpen();
    if (sh.title !== "hooks" || sh.sub !== "Group in git · 1 prompt") fail(`hooks' sheet head is ${J([sh.title, sh.sub])}`);
    await pressSheetRow(page, "action-sheet", "new-prompt");
    await atRest(page, "prompt-editor");
    if (await rowText("editor-group-row") !== "Group git › hooks") fail(`"New prompt here" of hooks' sheet: the Group row says ${J(await rowText("editor-group-row"))} before the save`);
    await field("editor-name").fill("lint");
    await saveIt("prompt-editor");
    await shows("the prompt made by hooks' sheet", async () => (await item("lint"))?.parent === "g_hooks");
    await shows("its row on hooks' screen", async () => (await rowsOf(page)).some((r) => r.kind === "prompt" && r.name === "lint"));
    await tapOn("lib-new-here");
    await atRest(page, "prompt-editor");
    if (await rowText("editor-group-row") !== "Group git › hooks") fail(`"+ New prompt here" of hooks: the Group row says ${J(await rowText("editor-group-row"))}`);
    await field("editor-name").fill("fmt");
    await saveIt("prompt-editor");
    await shows("the prompt made by hooks' New prompt here row", async () => (await item("fmt"))?.parent === "g_hooks");
    await press(page, byTid(page, "lib-more").last());
    await sheetOpen();
    await pressSheetRow(page, "action-sheet", "new-group");
    await atRest(page, "group-form");
    if (await tx("group-form-where") !== "In git › hooks") fail(`hooks' "New group here": the In row says ${J(await tx("group-form-where"))}`);
    await field("group-form-name").fill("deep");
    await saveIt("group-form");
    await shows("the group made by hooks' sheet", async () => (await item("deep"))?.parent === "g_hooks");
    // a nested group is one more push, and its "here" is the nested group
    const deep = await item("deep");
    await shows("the nested group's row", async () => (await rowsOf(page)).some((r) => r.id === deep.id));
    await openGroup(page, deep.id);
    await barIs("hooks", "deep", "the nested group's screen");
    await tapOn("lib-new-here");
    await atRest(page, "prompt-editor");
    if (await rowText("editor-group-row") !== "Group git › hooks › deep") fail(`the nested group's "New prompt here": the Group row says ${J(await rowText("editor-group-row"))}`);
    // with unsaved changes nothing else opens over the editor: a press on the page behind asks first (a sheet at a time)
    await field("editor-name").fill("half");
    await shoot("editor-new-light");
    await page.mouse.click(10, 6);
    await atRest(page, "confirm-sheet");
    if (await tx("confirm-title") !== "Discard the new prompt?") fail(`a press behind an unsaved editor asks ${J(await tx("confirm-title"))}`);
    if ((await byTid(page, "action-sheet").count()) || (await byTid(page, "move-picker").count()) || (await byTid(page, "group-form").count())) fail("a sheet opened over the unsaved editor");
    await press(page, byTid(page, "confirm-cancel").last());
    await gone("confirm-sheet");
    const s = await sheets();
    if (s.editor?.mode !== "new" || s.move || s.groupForm || (await field("editor-name").inputValue()) !== "half") fail(`after Keep editing the sheets are ${J(s)} and the name ${J(await field("editor-name").inputValue())}`);
    await discard("prompt-editor");
    if (await item("half")) fail("Discard saved the new prompt");
    await press(page, byTid(page, "lib-more").last());
    await sheetOpen();
    await pressSheetRow(page, "action-sheet", "new-group");
    await atRest(page, "group-form");
    if (await tx("group-form-where") !== "In git › hooks › deep") fail(`the nested group's "New group here": the In row says ${J(await tx("group-form-where"))}`);
    await press(page, byTid(page, "sheet-left").last());
    if (!await gone("group-form")) fail("an unchanged group form stays after Cancel");
    note("a new item is made where the screen says: \"+\" at the top, a group's \"⋯\" sheet and its New prompt here row in that group, a nested group is one more push; the Group row says the place before the save; an unsaved editor asks before anything else");

    // ================================================================ the Move picker
    await reset();
    await toLibrary();
    calls.length = 0;
    // from a swipe: "Top level" first, then the groups depth-first, each in by more than its parent; the current place tinted and checked
    await moveBySwipe("p_scratch");
    let p = await pickerRows();
    if (p.title !== "Move “scratch” to…" || p.sub !== "Choose its new group") fail(`the picker says ${J([p.title, p.sub])}`);
    if (labels(p) !== "Top level|git|hooks|misc") fail(`the picker lists ${labels(p)}, not Top level|git|hooks|misc`);
    let [gTop, gGit, gHooks, gMisc] = glyphs(p, ["Top level", "git", "hooks", "misc"]);
    if (!(gHooks > gGit) || gMisc !== gGit || gGit < gTop) fail(`the icons of Top level, git, hooks, misc are at ${gTop}, ${gGit}, ${gHooks}, ${gMisc}: hooks must be in by more than git`);
    await shoot("picker-light");
    await page.emulateMedia({ colorScheme: "dark" });
    await shoot("picker-dark");
    await page.emulateMedia({ colorScheme: "light" });
    const here = p.rows.filter((r) => r.checked);
    if (here.length !== 1 || here[0].label !== "Top level" || !here[0].tick || here[0].note !== "Now here") fail(`the current place is ${J(here)}, not Top level ✓ Now here`);
    await pickerRow("local|g_hooks").evaluate((e) => e.scrollIntoView({ block: "center" }));
    await press(page, pickerRow("local|g_hooks"));
    if (!await gone("move-picker")) fail("the picker stays after a pick");
    await shows("the prompt moved by the swipe's Move", async () => (await item("scratch"))?.parent === "g_hooks");
    await shows("it left the Library screen", async () => !(await names()).includes("scratch"));
    if (calls.join() !== "PATCH") fail(`a move made the calls ${J(calls)}`);
    await groupIn(["g_git", "g_hooks"]);
    await shows("it is on hooks' screen", async () => (await rowsOf(page)).some((r) => r.kind === "prompt" && r.name === "scratch"));
    // from the row's long-press sheet: picking the current place does nothing
    calls.length = 0;
    await moveByRow("prompt", "p_scratch");
    p = await pickerRows();
    const cur = p.rows.filter((r) => r.checked);
    if (cur.length !== 1 || cur[0].label !== "hooks" || cur[0].note !== "Now here") fail(`the current place of "scratch" is ${J(cur)}, not hooks ✓ Now here`);
    await press(page, pickerRow("local|g_hooks"));
    await gone("move-picker");
    await page.waitForTimeout(500);
    if (calls.length || (await item("scratch")).parent !== "g_hooks") fail(`a pick of the current place made the calls ${J(calls)} or moved the prompt`);
    // a group: not into itself or below itself (from its row's sheet), a pick moves it (from the "⋯" sheet)
    await toLibrary();
    await moveByRow("group", "g_git");
    p = await pickerRows();
    if (p.title !== "Move “git” to…" || labels(p) !== "Top level|misc") fail(`git's picker lists ${J(labels(p))} under ${J(p.title)}: its own subtree must not be offered`);
    if (p.rows.find((r) => r.checked)?.label !== "Top level") fail("git's current place is not Top level");
    await closePicker();
    await sheetGone();
    await groupIn(["g_misc"]);
    await moveByMore();
    p = await pickerRows();
    if (p.title !== "Move “misc” to…" || labels(p) !== "Top level|git|hooks") fail(`misc's picker lists ${J(labels(p))} under ${J(p.title)}`);
    calls.length = 0;
    await press(page, pickerRow("local|g_hooks"));
    if (!await gone("move-picker")) fail("the group picker stays after a pick");
    await shows("the group moved by its \"⋯\" sheet", async () => (await item("misc"))?.parent === "g_hooks");
    await press(page, byTid(page, "nav-back").last());
    await atRest(page, "lib-screen");
    await shows("the group left the Library screen", async () => !(await names()).includes("misc"));
    await groupIn(["g_git", "g_hooks"]);
    await shows("the group is on hooks' screen", async () => (await rowsOf(page)).some((r) => r.kind === "group" && r.name === "misc"));
    if (calls.join() !== "PATCH") fail(`the group's move made the calls ${J(calls)}`);
    // the editor's Group row changes the place only on Save
    await reset();
    await toLibrary();
    await groupIn(["g_git"]);
    await tapOn("lib-prompt-row", { id: "p_review" });
    await atRest(page, "prompt-editor");
    if (await rowText("editor-group-row") !== "Group git") fail(`the Group row of "review" says ${J(await rowText("editor-group-row"))}`);
    await tapOn("editor-group-row");
    await atRest(page, "move-picker");
    p = await pickerRows();
    if (p.rows.find((r) => r.checked)?.label !== "git" || p.rows.find((r) => r.checked)?.note !== "Now here") fail(`the editor's picker has the current place ${J(p.rows.find((r) => r.checked))}`);
    await press(page, pickerRow("local|g_misc"));
    await gone("move-picker");
    if (await rowText("editor-group-row") !== "Group misc") fail(`after a pick the Group row says ${J(await rowText("editor-group-row"))}`);
    if ((await item("review")).parent !== "g_git") fail("a pick in the editor moved the prompt before Save");
    await discard("prompt-editor");
    if ((await item("review")).parent !== "g_git") fail("Discard moved the prompt");
    await tapOn("lib-prompt-row", { id: "p_review" });
    await atRest(page, "prompt-editor");
    if (await rowText("editor-group-row") !== "Group git") fail(`reopened, the Group row says ${J(await rowText("editor-group-row"))}, not "Group git"`);
    await tapOn("editor-group-row");
    await atRest(page, "move-picker");
    await press(page, pickerRow("local|g_misc"));
    await gone("move-picker");
    await saveIt("prompt-editor");
    await shows("the prompt moved by the editor's Save", async () => (await item("review"))?.parent === "g_misc");
    await shows("it left git's screen", async () => !(await names()).includes("review"));
    note("the Move picker (swipe, row sheet, \"Move group…\", the editor's Group row): Top level first, then the groups depth-first, each in by more than its parent, the current place ✓ Now here; a group is not offered its own subtree; a pick moves, the current place does nothing; the editor moves only on Save");

    // ================================================================ what the server refuses
    await reset();
    await mockEval(`libraries.local.prompts.push(${J(mkP("p_todo2", "TODO", "g_misc"))}); sendLibrary("local");`, url);
    await toLibrary();
    await groupIn(["g_misc"]);
    await shows("the prompt of a taken name in misc", async () => (await names()).includes("TODO"));
    await moveBySwipe("p_todo2");
    await press(page, pickerRow("local|"));
    await gone("move-picker");
    await toastIs("a move to a taken name", SENTENCE_TAKEN);
    await shoot("refused-toast-light");
    await page.waitForTimeout(400);
    if ((await item("TODO")).parent !== "g_misc") fail("a refused move moved the prompt");
    // the editor: the refusal is the form's error, what was typed stays
    await tapOn("lib-prompt-row", { id: "p_todo2" });
    await atRest(page, "prompt-editor");
    await field("editor-text").fill("Typed text that must stay.");
    await tapOn("editor-group-row");
    await atRest(page, "move-picker");
    await press(page, pickerRow("local|"));
    await gone("move-picker");
    await press(page, byTid(page, "sheet-right").last());
    if (!await until(async () => (await byTid(page, "form-error").count()) === 1, WAIT)) fail("a refused save shows no error in the form");
    else if (await tx("form-error") !== SENTENCE_TAKEN) fail(`the refusal in the form reads ${J(await tx("form-error"))}`);
    if ((await field("editor-text").inputValue()) !== "Typed text that must stay." || (await field("editor-name").inputValue()) !== "TODO" || await rowText("editor-group-row") !== "Group Top level") fail("a refused save lost what was typed");
    if (!(await byTid(page, "prompt-editor").count())) fail("a refused save closed the editor");
    if ((await item("TODO")).parent !== "g_misc") fail("a refused save moved the prompt");
    await discard("prompt-editor");
    // too deep: a chain of 16 groups takes a prompt and no group
    await toLibrary();
    const chain = Array.from({ length: 16 }, (_, i) => mkG(`g_d${i + 1}`, `d${i + 1}`, i ? `g_d${i}` : ""));
    await mockEval(`libraries.local.groups.push(${J(mkG("g_ci", "ci", ""))}, ...${J(chain)}); sendLibrary("local");`, url);
    await shows("the chain and ci on the Library screen", async () => (await names()).includes("ci"));
    await moveBySwipe("g_ci");
    p = await pickerRows();
    const ds = glyphs(p, chain.map((x) => x.name));
    if (ds.some((x, i) => x == null || (i && x <= ds[i - 1]))) fail(`the 16 nested places are not each in by more than the one above: ${J(ds)}`);
    await press(page, pickerRow("local|g_d16"));
    await gone("move-picker");
    await toastIs("a move too deep", "Groups can be at most 16 deep.");
    await page.waitForTimeout(400);
    if ((await item("ci")).parent !== "") fail("a refused move too deep moved the group");
    note("what the server refuses is said in its sentence (the toast of a move, the form's error of a save) and nothing has moved; what was typed stays; 16 nested places are each in by more than the one above");

    // ================================================================ another server's library
    await reset({ studio: true });
    await toLibrary();
    await shows("two sections", async () => (await sectionsOf(page)).length === 2);
    calls.length = 0;
    await moveBySwipe("p_scratch");
    p = await pickerRows();
    if (p.heads.join("|") !== "this computer|studio") fail(`the picker's sections are ${J(p.heads)}`);
    const theirs = p.rows.filter((r) => r.section === "studio");
    if (!theirs.length || theirs.some((r) => !r.off || r.note !== "A prompt stays in its own server's library")) fail(`Studio's places are ${J(theirs)}, not dimmed with the reason`);
    if (p.rows.filter((r) => r.section === "this computer").some((r) => r.off)) fail("this computer's places are dimmed for its own prompt");
    await shoot("picker-two-servers-light");
    await page.emulateMedia({ colorScheme: "dark" });
    await shoot("picker-two-servers-dark");
    await page.emulateMedia({ colorScheme: "light" });
    await pickerRow("s_studio|g_team").evaluate((e) => e.scrollIntoView({ block: "center" }));
    await page.touchscreen.tap(...(await (async () => { const b = await pickerRow("s_studio|g_team").boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; })()));
    await page.waitForTimeout(500);
    if (calls.length || (await item("scratch")).parent !== "") fail(`a dimmed place of another server could be picked: calls ${J(calls)}`);
    await closePicker();
    // a prompt of the other server: its own places are open, this computer's are dimmed
    await moveBySwipe("p_retro");
    p = await pickerRows();
    if (p.rows.filter((r) => r.section === "studio").some((r) => r.off) || p.rows.filter((r) => r.section === "this computer").some((r) => !r.off)) fail(`the picker for Studio's prompt is ${J(p.rows.map((r) => [r.section, r.label, r.off]))}`);
    await press(page, pickerRow("s_studio|g_team"));
    await gone("move-picker");
    await shows("Studio's prompt moved in its own library", async () => (await item("retro", "s_studio"))?.parent === "g_team");
    // a new item made in the server's section is that server's
    await openGroup(page, "g_team");
    await tapOn("lib-new-here");
    await atRest(page, "prompt-editor");
    if (await rowText("editor-group-row") !== "Group Studio › team") fail(`in Studio's group the Group row says ${J(await rowText("editor-group-row"))}`);
    await field("editor-name").fill("newbie");
    await saveIt("prompt-editor");
    await shows("the new prompt is Studio's", async () => (await item("newbie", "s_studio"))?.parent === "g_team" && !(await item("newbie")));
    // at the top of the server's library, chosen with the Group row
    await toLibrary();
    await press(page, byTid(page, "lib-plus").last());
    await sheetOpen();
    await pressSheetRow(page, "action-sheet", "new-prompt");
    await atRest(page, "prompt-editor");
    await tapOn("editor-group-row");
    await atRest(page, "move-picker");
    p = await pickerRows();
    if (p.rows.some((r) => r.off)) fail(`a new prompt cannot be put in every connected library: ${J(p.rows.filter((r) => r.off))}`);
    await pickerRow("s_studio|").evaluate((e) => e.scrollIntoView({ block: "center" }));
    await press(page, pickerRow("s_studio|"));
    await gone("move-picker");
    if (await rowText("editor-group-row") !== "Group Studio › Top level") fail(`after the pick the Group row says ${J(await rowText("editor-group-row"))}`);
    await field("editor-name").fill("toplevel");
    await saveIt("prompt-editor");
    await shows("the prompt at Studio's top is Studio's", async () => (await item("toplevel", "s_studio"))?.parent === "" && !(await item("toplevel")));
    // the server is away
    await mockEval(`setServerState(${J(STUDIO.id)}, "unreachable", { detail: "connection refused" });`, url);
    await shows("a notice for Studio", async () => (await sectionsOf(page)).some((x) => x.notice.length));
    await swipe("g_team");
    await page.waitForTimeout(500);
    if ((await actionsOf("g_team")).length) fail("a swipe on a row of the server that is away shows actions");
    await holdOpen(page, byTid(page, "lib-group-row", { id: "g_team" }).last());
    sh = await sheetOpen();
    if (sh.rows.some((r) => !r.disabled || r.note !== "Studio is not connected")) fail(`the sheet of a row of the server that is away has the rows ${J(sh.rows)}`);
    await closeP1();
    await moveBySwipe("p_scratch");
    p = await pickerRows();
    const away = p.rows.filter((r) => r.section === "studio");
    if (!away.length || away.some((r) => !r.off || r.note !== "Studio is not connected")) fail(`Studio's places while it is away are ${J(away)}, not "Studio is not connected"`);
    await closePicker();
    note("another server's places are dimmed with the reason and cannot be picked; a new item made in its section or at its top is that server's; while it is away its rows have no swipe actions, its sheets wait and its places say it is not connected");
  } catch (e) { fail(`${String(e.message ?? e).split("\n")[0]} (${(String(e.stack).match(/PL6\.1-tree\.mjs:\d+/g) ?? ["?"]).join(" < ")})`); }
}

await check("PL6.1 the library's tree: how it is set in, the menu of a right click, the buttons, and moves by a drag and by the keys", async ({ url, open, fail, note, touch, layout }) => {
  if (layout === "phone") return phoneHalf({ url, open, fail, note });
  const seeded = await seed(url, "A2");
  const sel = seeded.find((s) => s.id === "plain-started")?.sel ?? fail("the seed has no state plain-started");
  const lib = (server = "local") => mockEval(`return libraries[${JSON.stringify(server)}] ?? null;`, url);
  const item = async (name, server = "local") => { const l = await lib(server); return [...l.prompts, ...l.groups].find((x) => x.name === name); };
  const servers = (list) => mockEval(`setServers(${JSON.stringify(list)});`, url);
  await servers([]);
  await mockEval(`setLibrary("local", ${JSON.stringify(LIB)});`, url);
  const w = await open({ sel }), { page } = w;
  await showList(page);
  const calls = []; // the calls that change a library
  page.on("request", (r) => { const c = callOfRequest(r); if (c && c.method !== "GET" && c.path.includes("/api/library/")) calls.push(c.method); });
  const read = () => page.evaluate(seen);
  /** Waits for the page to show what `want` says; fails with what it shows. */
  const shows = async (what, want) => {
    let s;
    if (!await until(async () => want((s = await read())), 10000)) fail(`${what}: the page shows ${JSON.stringify(s)}`);
    return s;
  };
  const esc = (l) => new RegExp(`^${l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  const D = byTid(page, "library-dialog"), libBtn = byTid(page, "library-btn");
  const row = (label) => D.locator(`${tidSel("lib-row")}:not([data-new="true"])`).filter({ has: page.locator(tidSel("lib-name"), { hasText: esc(label) }) });
  const button = (label) => D.locator('[role="button"]').filter({ hasText: esc(label) }), entry = (label) => byTid(page, "lib-menu").locator(tidSel("lib-menu-item")).filter({ hasText: esc(label) });
  const name = byTid(D, "lib-name-input"), words = byTid(D, "lib-text-input"), bar = byTid(D, "lib-top");
  const answer = (label) => press(page, byTid(page, "confirm-dialog").locator('[role="button"]').filter({ hasText: esc(label) }));
  const same = (a, b) => a.join("|") === b.join("|"), unlit = (x) => !x.lit.head.length && !x.lit.inside.length && !x.lit.all && !x.lit.top;
  /** A point of the space under the rows of the list (the list scrolled to its end). */
  const under = async () => {
    await page.evaluate(() => { const l = document.querySelector('[data-testid="lib-scroll"]'); l.scrollTop = l.scrollHeight; }); // (a list taller than its box shows the space after its last row at its end)
    const b = await byTid(D, "lib-list-frame").boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height - 10 }; };
  /** A right click with a mouse, a long press with a finger. */
  const rightClick = (target) => (touch ? longPress(page, target) : "x" in target ? page.mouse.click(target.x, target.y, { button: "right" }) : target.click({ button: "right" }));
  /** Opens the menu as a right click does, on a row or on the space under the rows, and waits for it. */
  const menuOn = async (label, want) => {
    await rightClick(label ? row(label) : await under());
    return shows(`the menu on ${label ? `"${label}"` : "the space under the rows"}`, (x) => x.menu?.note === want && x.focus === "menu New prompt");
  };
  const d = await pointerDragger(page, { steps: 6 });
  /** A point of an element's box (scrolled to first), or the point given. */
  const centre = async (t) => { if ("x" in t) return t; await t.scrollIntoViewIfNeeded(); const b = await t.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
  const drag = { at: centre, async start(p) { await d.start(p); await d.move({ x: p.x + 9, y: p.y + 5 }); }, over: (p) => d.move(p), drop: () => d.end() };
  /** The list's own height and where it is scrolled to, and where a row is in the window. */
  const held = async (label) => { await row(label).scrollIntoViewIfNeeded(); return page.evaluate((label) => {
    const l = document.querySelector('[data-testid="lib-list"]'), r = [...l.querySelectorAll('[data-testid="lib-row"]')].find((x) => x.querySelector('[data-testid="lib-name"]').textContent === label);
    const s = document.querySelector('[data-testid="lib-scroll"]');
    return [s.clientHeight, s.scrollTop, Math.round(r.getBoundingClientRect().top)].join();
  }, label); };
  const pick = async (label) => drag.start(await drag.at(row(label)));
  const over = async (label) => drag.over(await drag.at(row(label)));
  try {
    await press(page, libBtn);
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
    if (!same(s.menu.items, [...ITEMS, "Move…"]) || s.menu.role !== "menu" || !same(s.lit.head, ["hooks"]) || !same(s.lit.inside, ["pre-commit"]) || s.lit.all || s.onName.length || s.form) fail(`the menu on the group "hooks" shows ${JSON.stringify(s)}`);
    await press(page, entry("New prompt"));
    s = await shows("New prompt of the menu on a group", (x) => x.form?.head === "New prompt" && x.focus === "name" && !x.menu);
    if (s.form.where !== "In git/hooks" || /select/.test(s.form.fields) || !same(s.drawn, [...TREE.slice(0, 2), "+    New prompt", ...TREE.slice(2)]) || !unlit(s)) fail(`a new prompt begun in "hooks" shows ${JSON.stringify(s)}`);
    await page.keyboard.type("lint");
    await shows("the new prompt's row as its name is typed", (x) => x.drawn[2] === "+    lint");
    await page.keyboard.press("Enter");
    let tree = [...TREE.slice(0, 2), "    lint", ...TREE.slice(2)];
    await shows("the new prompt saved", (x) => same(x.drawn, tree) && same(x.onName, ["lint"]) && x.form?.where === "In git/hooks");
    if ((await item("lint"))?.parent !== "g_hooks") fail(`the prompt made by the menu on "hooks" is ${JSON.stringify(await item("lint"))}`);
    // on a prompt: beside it
    s = await menuOn("review", "In git");
    if (!same(s.menu.items, [...ITEMS, "Move…"]) || !same(s.lit.head, ["git"]) || !same(s.lit.inside, tree.slice(1, 6).map((l) => l.trim()))) fail(`the menu on the prompt "review" shows ${JSON.stringify(s)}`);
    await press(page, entry("New group"));
    s = await shows("New group of the menu on a prompt", (x) => x.form?.head === "New group" && x.focus === "name");
    if (s.form.where !== "In git" || /select/.test(s.form.fields) || s.form.text !== null || !same(s.drawn, [tree[0], "+  New group", ...tree.slice(1)])) fail(`a new group begun beside "review" shows ${JSON.stringify(s)}`);
    await page.keyboard.type("ci");
    await page.keyboard.press("Enter");
    tree = [tree[0], "  ci", ...tree.slice(1)];
    await shows("the new group saved", (x) => same(x.drawn, tree) && same(x.onName, ["ci"]));
    if ((await item("ci"))?.parent !== "g_git") fail(`the group made by the menu on "review" is ${JSON.stringify(await item("ci"))}`);
    // on the space under the rows: at the top level. Esc closes the menu alone
    s = await menuOn("", TOP);
    if (!same(s.menu.items, ITEMS) || !s.lit.all || s.lit.head.length) fail(`the menu on the space under the rows shows ${JSON.stringify(s)}`);
    await page.keyboard.press("Escape");
    await shows("Esc on the menu", (x) => !x.menu && x.open === 1 && unlit(x) && x.focus.startsWith("row "));
    await menuOn("", TOP);
    await press(page, entry("New prompt"));
    s = await shows("New prompt of the menu on the space under the rows", (x) => x.form?.head === "New prompt" && x.form.where === TOP);
    if (!same(s.drawn, [...tree.slice(0, 9), "+New prompt", ...tree.slice(9)])) fail(`a new prompt begun at the top has its row at ${JSON.stringify(s.drawn)}`);
    await page.keyboard.type("zeta");
    await page.keyboard.press("Enter");
    tree = [...tree, "zeta"];
    await shows("the new prompt at the top saved", (x) => same(x.drawn, tree) && same(x.onName, ["zeta"]) && x.form?.where === TOP);
    if ((await item("zeta"))?.parent !== "") fail(`the prompt made on the space under the rows is ${JSON.stringify(await item("zeta"))}`);
    // on a prompt at the top: the top level
    await menuOn("scratch", TOP);
    await page.keyboard.press("Escape");
    // with unsaved changes it asks first
    await words.fill("Typed and not saved.");
    await menuOn("misc", "In misc");
    await press(page, entry("New prompt"));
    await shows("New prompt of the menu with unsaved changes", (x) => x.ask?.title === "Discard changes?");
    await answer("Cancel");
    s = await shows("Cancel on its question", (x) => !x.ask && x.form?.name === "zeta" && x.form.text === "Typed and not saved." && !x.drawn.some((l) => l.startsWith("+")));
    await press(page, button("Revert"));
    // a closed group opens for the item made in it
    await press(page, byTid(row("git"), "lib-twist"));
    await shows("the group closed", (x) => same(x.closed, ["git"]) && same(x.rows, ["git", ...tree.slice(7)]));
    await menuOn("git", "In git");
    await press(page, entry("New prompt"));
    s = await shows("New prompt of the menu on a closed group", (x) => x.form?.where === "In git" && !x.closed.length);
    if (!same(s.drawn, [...tree.slice(0, 5), "+  New prompt", ...tree.slice(5)])) fail(`a new prompt begun in a closed group has its row at ${JSON.stringify(s.drawn)}`);
    await press(page, button("Cancel"));
    await shows("Cancel on a new prompt", (x) => same(x.drawn, tree) && same(x.onName, ["zeta"]));
    // the menu key: the menu is at its row, its entries are walked with the arrows, and Esc gives the row the focus back
    await row("misc").focus();
    await row("misc").dispatchEvent("contextmenu", { bubbles: true, cancelable: true, button: 0, clientX: 0, clientY: 0 });
    s = await shows("the menu key on a row", (x) => x.menu?.note === "In misc" && x.focus === "menu New prompt");
    const near = await page.evaluate(() => { const m = document.querySelector('[data-testid="lib-menu"]').getBoundingClientRect(), r = document.querySelector('[data-testid="library-dialog"] [data-testid="lib-row"][tabindex="0"]').getBoundingClientRect(); return { dx: Math.round(m.left - r.left), dy: Math.round(m.top - r.top) }; });
    if (layout !== "phone" && (near.dx < 0 || near.dx > 80 || near.dy < 0 || near.dy > 40)) fail(`opened by the menu key, the menu is ${JSON.stringify(near)} px from its row`);
    for (const [key, want] of [["ArrowDown", "New group"], ["ArrowDown", "Move…"], ["ArrowDown", "New prompt"], ["ArrowUp", "Move…"], ["Home", "New prompt"], ["End", "Move…"]]) {
      await page.keyboard.press(key);
      await shows(`${key} in the menu`, (x) => x.focus === "menu " + want);
    }
    await page.keyboard.press("Escape");
    await shows("Esc on the menu of the menu key", (x) => !x.menu && x.open === 1 && x.focus === "row misc");
    note("the menu of a right click makes a prompt in the clicked group, a group beside the clicked prompt and a prompt at the top level on the space under the rows; the place is lit and the new row is where it goes");

    // ---- the buttons under the tree
    await press(page, button("New group")); // ("zeta", a prompt at the top, is chosen)
    await shows("New group beside a chosen prompt at the top", (x) => x.form?.head === "New group" && x.form.where === TOP && x.drawn[0] === "+New group" && !x.form.fields.includes("select"));
    await press(page, button("New prompt"));
    await shows("New prompt beside the group that is being made", (x) => x.form?.head === "New prompt" && x.form.where === TOP && x.drawn[9] === "+New prompt");
    await press(page, button("Cancel"));
    await press(page, row("hooks"));
    s = await shows("a group chosen", (x) => x.form?.head === "Group" && x.form.name === "hooks" && x.form.where === "In git");
    if (/select/.test(s.form.fields)) fail("the editor of a group has a choice of a group");
    await press(page, button("New prompt"));
    await shows("New prompt in the chosen group", (x) => x.form?.where === "In git/hooks" && x.drawn[3] === "+    New prompt");
    await press(page, button("New group"));
    await shows("New group beside the prompt that is being made", (x) => x.form?.head === "New group" && x.form.where === "In git/hooks" && x.drawn[3] === "+    New group");
    await press(page, button("Cancel"));
    await press(page, row("review"));
    s = await shows("a prompt chosen", (x) => x.form?.name === "review" && x.form.where === "In git");
    if (/select/.test(s.form.fields)) fail("the editor of a prompt has a choice of a group");
    await press(page, button("New group"));
    await shows("New group beside the chosen prompt", (x) => x.form?.where === "In git" && x.drawn[1] === "+  New group");
    await press(page, button("Cancel"));
    await press(page, button("Close"));
    await press(page, libBtn);
    await shows("the popup opened again", (x) => x.open === 1 && !x.onName.length && !x.form);
    await press(page, button("New prompt"));
    await shows("New prompt with nothing chosen", (x) => x.form?.where === TOP && x.drawn[9] === "+New prompt");
    await press(page, button("Cancel"));
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
    await drag.over(await drag.at(byTid(D, "lib-edit")));
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
    await press(page, row("zeta"));
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
    await page.evaluate(() => { const s = document.querySelector('[data-testid="lib-scroll"]'); s.scrollTop = s.scrollHeight; });
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
    await press(page, row("review"));
    await shows("a prompt chosen before its move", (x) => x.form?.name === "review");
    await words.fill("Typed, then moved.");
    await pick("review");
    await over("misc");
    await drag.drop();
    s = await shows("a prompt moved under what was typed", (x) => x.form?.where === "In misc" && x.rows.includes("  review") && x.rows.indexOf("  review") > x.rows.indexOf("misc"));
    if (s.form.text !== "Typed, then moved." || s.ask || s.form.name !== "review" || !same(s.onName, ["review"])) fail(`after the move the editor shows ${JSON.stringify(s.form)}`);
    if ((await item("review")).text !== "review!") fail("the move saved what was typed");
    await press(page, button("Save"));
    if (!await until(async () => { const r = await item("review"); return r.text === "Typed, then moved." && r.parent === "g_misc"; }, 10000)) fail(`after the save the moved prompt is ${JSON.stringify(await item("review"))}`);

    // ---- "Move…" of the menu: the same with the keys
    await mockEval(`setLibrary("local", ${JSON.stringify(LIB)});`, url);
    await shows("the first library once more", (x) => same(x.rows, TREE) && x.form?.where === "In git");
    await menuOn("scratch", TOP);
    await press(page, entry("Move…"));
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
    await rightClick(row("scratch"));
    await press(page, entry("Move…"));
    await shows("Move… again", (x) => !!x.hint && x.focus === "row scratch");
    await page.keyboard.press("Tab");
    await shows("Tab in a move", (x) => x.focus === "top" && x.lit.top && x.lit.all);
    await page.keyboard.press("Enter");
    s = await shows("Enter on the bar of the top level", (x) => same(x.rows, TREE) && !x.hint && !x.top);
    if ((await item("scratch")).parent !== "" || s.focus !== "row scratch") fail(`after Enter on the bar the page shows ${JSON.stringify(s)}`);
    // a group's own rows take nothing, and a click on another group's row lands it
    calls.length = 0;
    await rightClick(row("git"));
    await press(page, entry("Move…"));
    await shows("Move… on a group", (x) => !!x.hint && x.focus === "row git" && x.top?.off === true);
    await page.keyboard.press("ArrowDown");
    await shows("the focus on a group below the moved one", (x) => x.focus === "row hooks" && unlit(x));
    await page.keyboard.press("Enter");
    await shows("Enter on a group below the moved one", (x) => !!x.hint && same(x.rows, TREE));
    if (calls.length) fail(`Enter on a row that takes nothing made the calls ${JSON.stringify(calls)}`);
    await press(page, row("git commit style"));
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
    await press(page, entry("New group"));
    await shows("New group of the menu on a server's entry", (x) => x.form?.head === "New group" && x.form.where === "In Studio" && x.drawn[11] === "+  New group");
    await page.keyboard.type("plans");
    await page.keyboard.press("Enter");
    await shows("the new group on the other server", (x) => x.rows.includes("  plans") && x.form?.head === "Group");
    if ((await item("plans", "s_studio"))?.parent !== "" || (await lib()).groups.some((x) => x.name === "plans")) fail(`the group made at Studio's entry is ${JSON.stringify(await item("plans", "s_studio"))} there`);
    await menuOn("", "In This computer");
    await page.keyboard.press("Escape");
    // the server drops: its rows cannot be dragged, and its menu makes nothing and says why
    await mockEval(`setServerState("s_studio", "unreachable");`, url);
    s = await shows("a server that dropped", (x) => same(x.fixed, ["This computer", "Studio", "plans", "team", "retro", "standup"]));
    await rightClick(row("team"));
    s = await shows("the menu on a row of a server that dropped", (x) => !!x.menu);
    if (s.menu.note !== "Studio is not connected: nothing can be changed there until it is back." || !same(s.menu.items, [...ITEMS, "Move…"].map((l) => l + " (off)")) || !unlit(s)) fail(`the menu on a row of a server that dropped shows ${JSON.stringify(s.menu)}`);
    await page.keyboard.press("Escape");
    await shows("Esc on that menu", (x) => !x.menu && x.open === 1);
    note("nothing is lit on another server's rows; a server's entry is the top of its library; while the server is away its rows cannot be dragged and its menu makes nothing");
  } catch (e) { fail(e.message.split("\n")[0]); }
}, { viewports, page: false });
