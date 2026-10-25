// UX.S4.1-library (package S4 chunk 1, ux-improvements goal 3.8.6; mockups 06a, 06b-c, 06b-d): the phone's Library screen and a group's screen,
// their P1 sheets, the swipe and the delete question. The editor, the move picker and the group form are other chunks' (UX.S4.2): here a press
// that opens one is read from the store of the sheets, `window.__aiwbLibrary.sheets()` (the uicheck build's seam), not from the screen.
// On the phone, in the light theme, then the sizes and the shots again in the dark (`aiwb.theme`):
//   the bar       back "Settings" (reached from Settings' Prompt library row), title "Prompt library", a "+" at least 44 pt, no Close
//   "+"           a P1 sheet "New in Prompt library" naming where new items go; New prompt and New group open the editor and the group form
//                 (the stores of the sheets) at the top of the first connected library
//   the search    44 pt high, 17 px; hits are one flat list, each with its path ("Top level" at the top), a tap opens the editor; "No prompts
//                 match “…”" when nothing is found; emptied, the sections are back
//   the sections  none titled with one library; with a second server two, titled with the servers' names; hits then name the server
//   the rows      groups 60 pt: a folder tile, the name at 17 px, the count of what it holds directly, a chevron; prompts: the first line of the
//                 text ("No text" for none); a tap on a group pushes its screen (back "Prompt library"; a nested group's back names the parent)
//   a group       the caps header with the count, "New prompt here" 48 pt, the foot "In git, on …"; the bar's "⋯" sheet: head (name, "Group in
//                 git · 2 prompts"), the rows in order with Delete last after a separator, and no Cancel; each row opens its sheet (the stores);
//                 Delete asks "Delete group and 2 prompts", and confirming deletes it in the mock and takes the screen off the stack
//                 A rename (the "⋯" sheet's Rename group, the form's Save) shows in the bar at once: the nested group's own title, and the
//                 back's name of the group below (R1; the title follows the store, c66cad3)
//   swipe         a left swipe on a prompt and on a group gives Move (grey) and Delete (red), at least 44 pt high; Move opens the move picker's
//                 store; Delete asks (P4) and deletes; a long press opens the row's P1 (the prompt's, the group's)
//   offline       a server that is not connected: one notice in its section, the rows open, the swipe gives no actions, the P1's change rows are
//                 aria-disabled with "<server> is not connected", "New prompt here" waits, "+" offers the connected library only
//   the footer    "Each server keeps its own prompts…", and no "⌘P" or "right-click" anywhere on these screens; no text under 13 px, no target
//                 under 44 pt
// The tablet and the desktop keep the dialog: the sidebar foot's Library button opens `library-dialog`, and a push of `library` by the seam draws
// no library screen. OUT=/tmp/x (default web/out/s4-shots) keeps screenshots of the Library, a group, its "⋯" sheet, an open swipe, two servers and
// the offline library, in the light and the dark themes, at the phone.
import fs from "node:fs";
import { check, mockEval, until } from "../shot.mjs";
import { byTid, layoutNow, press, touchDrag } from "./sel.mjs";
import { atRest, themeNow } from "./settings.mjs";
import { LIB_EXAMPLE, barOf, holdOpen, openGroup, openLibrary, pressSheetRow, rowsOf, sectionsOf, seedLibrary, sheetOf, smalls, texts, topScreen } from "./libphone.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const WAIT = 15000;
const J = JSON.stringify;
const OUT = process.env.OUT ?? new URL("../../out/s4-shots/", import.meta.url).pathname;
const BUILD = { id: "s_build", name: "Build Box", address: "https://build.example:4790", state: "connected", version: "dev" };
const BUILD_LIB = { groups: [{ id: "g_deploy", name: "deploy", parent: "" }], prompts: [{ id: "p_check", name: "Deploy checklist", parent: "g_deploy", text: "List what to check before a deploy." }] };
const FOOT = "Each server keeps its own prompts. Insert one in a chat with the prompt button of the message box.";

await check("UX.S4.1 the phone's Library and group screens, their sheets, swipe and delete; the wide layouts unchanged", async ({ url, layout, page, fail, note }) => {
  const sheets = () => page.evaluate(() => window.__aiwbLibrary.sheets());
  const closeSheets = () => page.evaluate(() => window.__aiwbLibrary.closeAllSheets());
  const lib = () => mockEval(`return libraries.local;`, url);

  if (layout !== "phone") {
    // ---- the wide layouts: the foot's button opens the dialog, and the push of the screen draws nothing
    if (layoutNow(page) === "phone") return fail("a wide viewport is the phone layout");
    await byTid(page, "side-pane").first().waitFor({ state: "visible", timeout: WAIT });
    await press(page, byTid(page, "library-btn").first());
    await byTid(page, "library-dialog").first().waitFor({ state: "visible", timeout: WAIT });
    await page.keyboard.press("Escape");
    if (!(await until(async () => (await byTid(page, "library-dialog").count()) === 0, WAIT))) fail("Esc did not close the library dialog");
    await page.evaluate(() => window.__aiwbStack.push("library", {}));
    await page.waitForTimeout(500);
    if (await byTid(page, "lib-screen").count() || await byTid(page, "pushed-screen").count()) fail("a wide layout draws the phone's Library screen");
    if (!(await byTid(page, "library-btn").first().isVisible().catch(() => false))) fail("after the push, the sidebar foot's Library button is gone");
    note("the wide layout keeps the library dialog; the seam's push of `library` draws no screen");
    return;
  }

  fs.mkdirSync(OUT, { recursive: true });
  const shoot = (theme, name) => page.screenshot({ path: `${OUT}/${theme}-${name}.png` });
  await byTid(page, "home").first().waitFor({ state: "visible", timeout: WAIT });
  const barIs = async (want, what) => { const b = await barOf(page); if (b.back !== want.back || b.title !== want.title) fail(`${what}: the bar says back ${J(b.back)}, title ${J(b.title)}; wanted ${J(want.back)}, ${J(want.title)}`); return b; };
  const sheetOpen = async (id = "action-sheet") => { await byTid(page, id).last().waitFor({ state: "visible", timeout: WAIT }); await atRest(page, id === "action-sheet" ? "action-row" : "confirm-go");
    // (the sheet rises: its last row is inside the window once it is up)
    await page.waitForFunction((id) => { const s = [...document.querySelectorAll(`[data-testid="${id}"]`)].pop(), last = [...s.querySelectorAll('[data-testid="action-row"], [data-testid="confirm-go"]')].pop(); return !!last && last.getBoundingClientRect().bottom <= innerHeight; }, id, { timeout: WAIT });
    return sheetOf(page, id); };
  const sheetGone = (id = "action-sheet") => until(async () => (await byTid(page, id).count()) === 0 || !(await byTid(page, id).last().isVisible().catch(() => false)), WAIT);
  const tail = (a) => a[a.length - 1];
  const rowBox = async (sel) => { await page.locator(sel).first().scrollIntoViewIfNeeded(); return page.locator(sel).first().boundingBox(); };
  const swipeRow = (id) => `[data-testid="swipe-row"][data-id=${J(id)}]`;
  const swipe = async (id) => {
    await until(async () => (await actionsOf(id)).length === 0, WAIT); // (a row that was just used is closed by then)
    const b = await rowBox(swipeRow(id));
    await touchDrag(page, { x: b.x + b.width * 0.7, y: b.y + b.height / 2 }, { x: b.x + b.width * 0.3, y: b.y + b.height / 2 }, { hold: 0 });
  };
  const actionsOf = (id) => page.evaluate((sel) => [...document.querySelectorAll(`${sel} [data-testid="swipe-action"]`)].map((e) => ({ action: e.dataset.action, label: e.textContent.trim(), h: e.getBoundingClientRect().height, bg: getComputedStyle(e).backgroundColor })), swipeRow(id));
  const closeP1 = async () => { await page.keyboard.press("Escape"); await sheetGone(); };
  const reset = async (second) => {
    await mockEval(`setServers(${second ? J([BUILD]) : "[]"}); setLibrary("local", ${J(LIB_EXAMPLE)});${second ? ` setLibrary(${J(BUILD.id)}, ${J(BUILD_LIB)}); setServerState(${J(BUILD.id)}, "connected", { version: "dev" });` : ""}`, url);
  };

  /** The sizes of the screen on top: no text under 13 px, no target under 44, the rows' type and heights. */
  const sizes = async (tag) => {
    const s = await smalls(page);
    if (s.fonts.length) fail(`${tag}: texts under 13 px: ${J(s.fonts)}`);
    if (s.targets.length) fail(`${tag}: targets under 44 pt: ${J(s.targets)}`);
    for (const r of await rowsOf(page)) {
      if (r.h < 60) fail(`${tag}: the ${r.kind} row ${J(r.name)} is ${r.h} px high, under 60`);
      if (r.fonts[0] < 17) fail(`${tag}: the name of ${J(r.name)} is ${r.fonts[0]} px, under 17`);
      if (r.fonts[1] < 13) fail(`${tag}: the line of ${J(r.name)} is ${r.fonts[1]} px, under 13`);
      if (!r.tile) fail(`${tag}: the row ${J(r.name)} has no tile`);
      if (!r.chevron) fail(`${tag}: the row ${J(r.name)} has no chevron`);
    }
  };

  /** The shots of the screens in the theme now: the library with one server, a group, its sheet, a swipe, two servers, one away. */
  const shots = async (theme) => {
    await reset(false);
    await openLibrary(page);
    await until(async () => (await rowsOf(page)).length === 4, WAIT);
    await sizes(`${theme} library`);
    await shoot(theme, "1-library");
    await openGroup(page, "g_git");
    await sizes(`${theme} group`);
    await shoot(theme, "2-group");
    await press(page, byTid(page, "lib-more").last());
    await sheetOpen();
    await shoot(theme, "3-group-sheet");
    await closeP1();
    await press(page, byTid(page, "nav-back").last());
    await atRest(page, "lib-screen");
    await swipe("p_sum");
    await until(async () => (await actionsOf("p_sum")).length === 2, WAIT);
    await page.waitForTimeout(400);
    await shoot(theme, "4-swipe");
    const gb = await byTid(page, "lib-group-row", { id: "g_git" }).last().boundingBox();
    await page.touchscreen.tap(gb.x + gb.width / 2, gb.y + gb.height / 2); // (the first tap on a row while another is open only closes it)
    await until(async () => (await actionsOf("p_sum")).length === 0, WAIT);
    await reset(true);
    await until(async () => (await sectionsOf(page)).length === 2, WAIT);
    await shoot(theme, "5-two-servers");
    await mockEval(`setServerState(${J(BUILD.id)}, "unreachable", { detail: "connection refused" });`, url);
    await until(async () => (await sectionsOf(page)).some((s) => s.notice.length), WAIT);
    await shoot(theme, "6-offline");
    await mockEval(`setServerState(${J(BUILD.id)}, "connected", { version: "dev" });`, url);
  };

  // ======== light
  await reset(false);
  await openLibrary(page);

  // ---- the bar and the "+"
  await barIs({ back: "Settings", title: "Prompt library" }, "the Library screen");
  const bar = await barOf(page);
  if (bar.backName !== "Back to Settings") fail(`the back is labelled ${J(bar.backName)}, not "Back to Settings"`);
  if (/Close/.test(bar.text ?? "")) fail(`the bar has a Close: ${J(bar.text)}`);
  const plus = await byTid(page, "lib-plus").last().boundingBox();
  if (!plus || plus.width < 43.5 || plus.height < 43.5) fail(`the "+" is ${plus?.width} × ${plus?.height}, under 44`);
  if ((await byTid(page, "lib-plus").last().getAttribute("aria-label")) !== "New in Prompt library") fail("the \"+\" has no label \"New in Prompt library\"");

  // ---- the rows: one library, no title
  await until(async () => (await rowsOf(page)).length === 4, WAIT);
  let rows = await rowsOf(page), secs = await sectionsOf(page);
  if (secs.length !== 1 || secs[0].title) fail(`one library: the sections are ${J(secs)}, not one with no title`);
  const want = [["group", "git", "1 group · 2 prompts"], ["group", "review", "2 prompts"], ["group", "writing", "1 prompt"], ["prompt", "Summarise this chat", "Summarise what was decided in this chat."]];
  if (rows.map((r) => [r.kind, r.name, r.sub].join("|")).join("\n") !== want.map((w) => w.join("|")).join("\n")) fail(`the rows are\n${rows.map((r) => [r.kind, r.name, r.sub].join("|")).join("\n")}\nwanted\n${want.map((w) => w.join("|")).join("\n")}`);
  await sizes("light library");
  if (rows.some((r, i) => i && r.top <= rows[i - 1].top)) fail("the rows are not drawn top to bottom in order");
  const foot = (await texts(page, "lib-foot"))[0];
  if (foot !== FOOT) fail(`the foot says ${J(foot)}`);
  const bodyText = await page.evaluate(() => [...document.querySelectorAll('[data-testid="pushed-screen"]')].pop().innerText);
  if (/⌘|right-click|Right-click/.test(bodyText)) fail(`the screen mentions a shortcut or a right-click: ${J(bodyText)}`);

  // ---- "+": the sheet and what its rows open
  await press(page, byTid(page, "lib-plus").last());
  let sh = await sheetOpen();
  if (sh.title !== "New in Prompt library" || sh.sub !== "At the top level") fail(`the "+" sheet's head is ${J([sh.title, sh.sub])}`);
  if (sh.rows.map((r) => r.label).join() !== "New prompt,New group" || sh.rows.some((r) => r.disabled)) fail(`the "+" sheet's rows are ${J(sh.rows)}`);
  await pressSheetRow(page, "action-sheet", "new-prompt");
  if (!(await until(async () => (await sheets()).editor?.mode === "new", WAIT))) fail(`New prompt did not open the editor: ${J(await sheets())}`);
  const ed = (await sheets()).editor;
  if (ed.at.server !== "local" || ed.at.group !== "") fail(`New prompt's place is ${J(ed.at)}, not the top of "local"`);
  await closeSheets();
  await press(page, byTid(page, "lib-plus").last());
  await sheetOpen();
  await pressSheetRow(page, "action-sheet", "new-group");
  if (!(await until(async () => (await sheets()).groupForm?.mode === "new", WAIT))) fail(`New group did not open the group form: ${J(await sheets())}`);
  await closeSheets();
  await sheetGone();

  // ---- the search
  const search = byTid(page, "lib-phone-search").last();
  const sb = await search.boundingBox(), fs17 = await search.evaluate((e) => getComputedStyle(e).fontSize);
  if (!sb || sb.height < 43.5) fail(`the search is ${sb?.height} high, under 44`);
  if (fs17 !== "17px") fail(`the search's text is ${fs17}, not 17px`);
  await search.fill("pull");
  await until(async () => (await rowsOf(page)).every((r) => r.kind === "hit") && (await rowsOf(page)).length === 2, WAIT);
  rows = await rowsOf(page);
  if (rows.length !== 2 || rows.some((r) => r.kind !== "hit" || r.sub !== "git › pull requests")) fail(`the hits of "pull" are ${J(rows.map((r) => [r.name, r.sub]))}`);
  if (rows.map((r) => r.name).sort().join() !== "PR title,Pull request description") fail(`the hits of "pull" are ${J(rows.map((r) => r.name))}`);
  if ((await texts(page, "lib-section")).length) fail("the search shows the sections too");
  await search.fill("Summarise");
  await until(async () => (await rowsOf(page)).length === 1, WAIT);
  rows = await rowsOf(page);
  if (rows[0]?.sub !== "Top level") fail(`a prompt at the top says ${J(rows[0]?.sub)}, not "Top level"`);
  await press(page, byTid(page, "lib-hit-row").last());
  if (!(await until(async () => (await sheets()).editor?.mode === "edit" && (await sheets()).editor.id === "p_sum", WAIT))) fail(`a tap on a hit did not open the editor: ${J(await sheets())}`);
  await closeSheets();
  await search.fill("zzzz");
  if (!(await until(async () => (await texts(page, "lib-phone-none"))[0] === "No prompts match “zzzz”", WAIT))) fail(`nothing found says ${J(await texts(page, "lib-phone-none"))}`);
  await search.fill("");
  if (!(await until(async () => (await rowsOf(page)).length === 4 && (await rowsOf(page))[0].kind === "group", WAIT))) fail("emptied, the sections are not back");

  // ---- the second server: two titled sections; hits name the server
  await reset(true);
  if (!(await until(async () => (await sectionsOf(page)).length === 2, WAIT))) fail(`a second server: the sections are ${J(await sectionsOf(page))}`);
  secs = await sectionsOf(page);
  if (secs.some((s) => !s.title) || secs[1].title !== BUILD.name || secs[1].server !== BUILD.id) fail(`the sections are titled ${J(secs.map((s) => [s.server, s.title]))}`);
  const localName = secs[0].title;
  await search.fill("checklist");
  await until(async () => (await rowsOf(page)).length === 1 && (await rowsOf(page))[0].kind === "hit", WAIT);
  if ((await rowsOf(page))[0].sub !== "Build Box › deploy") fail(`a hit on the second server says ${J((await rowsOf(page))[0].sub)}`);
  await search.fill("Summarise");
  await until(async () => (await rowsOf(page)).length === 1 && (await rowsOf(page))[0].kind === "hit", WAIT);
  if ((await rowsOf(page))[0].sub !== localName) fail(`a hit at the top of the first server says ${J((await rowsOf(page))[0].sub)}, not ${J(localName)}`);
  await search.fill("");
  await press(page, byTid(page, "lib-plus").last());
  sh = await sheetOpen();
  if (sh.sub !== `At the top level of ${localName}`) fail(`with two servers the "+" sheet says ${J(sh.sub)}`);
  await closeP1();
  await shoot("light", "0-two-servers");
  await reset(false);
  await until(async () => (await sectionsOf(page)).length === 1, WAIT);

  // ---- a group's screen, and a nested one
  await openGroup(page, "g_git");
  await barIs({ back: "Prompt library", title: "git" }, "the group screen");
  rows = await rowsOf(page);
  if (rows.map((r) => [r.kind, r.name, r.sub].join("|")).join("\n") !== ["group|pull requests|2 prompts", "prompt|Commit message|Write a commit message for the staged changes.", "prompt|Squash commits|Squash these commits into one."].join("\n")) fail(`git's rows are ${J(rows.map((r) => [r.kind, r.name, r.sub]))}`);
  secs = await sectionsOf(page);
  if (secs[0]?.title !== "1 group · 2 prompts") fail(`git's header says ${J(secs[0]?.title)}`);
  if ((await texts(page, "lib-foot"))[0] !== `At the top level, on ${localName}.`) fail(`git's foot says ${J(await texts(page, "lib-foot"))}`);
  await openGroup(page, "g_pr");
  await barIs({ back: "git", title: "pull requests" }, "the nested group screen");
  secs = await sectionsOf(page);
  if (secs[0]?.title !== "2 prompts") fail(`pull requests' header says ${J(secs[0]?.title)}`);
  if ((await texts(page, "lib-foot"))[0] !== `In git, on ${localName}.`) fail(`pull requests' foot says ${J(await texts(page, "lib-foot"))}`);
  const nh = await byTid(page, "lib-new-here").last().boundingBox();
  if (!nh || nh.height < 43.5 || nh.height > 52) fail(`"New prompt here" is ${nh?.height} high, not 48`);
  if (!(await texts(page, "lib-new-here"))[0].includes("New prompt here")) fail(`the new row says ${J(await texts(page, "lib-new-here"))}`);
  await sizes("light nested group");
  await press(page, byTid(page, "lib-new-here").last());
  if (!(await until(async () => (await sheets()).editor?.mode === "new" && (await sheets()).editor.at.group === "g_pr", WAIT))) fail(`"New prompt here" opened ${J(await sheets())}`);
  await closeSheets();

  // ---- the "⋯" sheet
  const more = byTid(page, "lib-more").last();
  if ((await more.getAttribute("aria-label")) !== "More for “pull requests”") fail(`the "⋯" is labelled ${J(await more.getAttribute("aria-label"))}`);
  const mb = await more.boundingBox();
  if (!mb || mb.width < 43.5 || mb.height < 43.5) fail(`the "⋯" is ${mb?.width} × ${mb?.height}, under 44`);
  await press(page, more);
  sh = await sheetOpen();
  if (sh.title !== "pull requests" || sh.sub !== "Group in git · 2 prompts") fail(`the group sheet's head is ${J([sh.title, sh.sub])}`);
  if (sh.rows.map((r) => r.action).join() !== "new-prompt,new-group,rename,move,delete") fail(`the group sheet's rows are ${J(sh.rows.map((r) => r.action))}`);
  if (sh.rows.map((r) => r.label).join("|") !== "New prompt here|New group here|Rename group…|Move group…|Delete group…") fail(`the group sheet's labels are ${J(sh.rows.map((r) => r.label))}`);
  if (sh.rows.some((r) => r.disabled)) fail("a row of the group sheet waits while the library is connected");
  if (sh.sepTop == null || !(sh.sepTop > sh.rows[3].top && sh.sepTop < sh.rows[4].top)) fail(`Delete is not last after a separator: ${J({ sep: sh.sepTop, rows: sh.rows.map((r) => r.top) })}`);
  if (/Cancel/.test(await byTid(page, "action-sheet").last().innerText())) fail("the group sheet has a Cancel row");
  for (const [action, ok] of [
    ["new-prompt", (s) => s.editor?.mode === "new" && s.editor.at.group === "g_pr"],
    ["new-group", (s) => s.groupForm?.mode === "new" && s.groupForm.at.group === "g_pr"],
    ["rename", (s) => s.groupForm?.mode === "rename" && s.groupForm.id === "g_pr"],
    ["move", (s) => s.move?.kind === "group" && s.move.id === "g_pr"],
  ]) {
    await pressSheetRow(page, "action-sheet", action);
    if (!(await until(async () => ok(await sheets()), WAIT))) fail(`${action} opened ${J(await sheets())}`);
    await closeSheets();
    await sheetGone();
    await press(page, more);
    await sheetOpen();
  }
  await pressSheetRow(page, "action-sheet", "delete");
  await sheetOpen("confirm-sheet");
  const ask = await page.evaluate(() => ({ title: document.querySelector('[data-testid="confirm-title"]')?.textContent, body: document.querySelector('[data-testid="confirm-body"]')?.textContent, go: document.querySelector('[data-testid="confirm-go"]')?.textContent }));
  if (ask.title !== "Delete “pull requests”?" || ask.go !== "Delete group and 2 prompts" || ask.body !== `The group “pull requests” and everything in it are deleted from ${localName}'s library.`) fail(`the delete question is ${J(ask)}`);
  await press(page, byTid(page, "confirm-go").last());
  if (!(await until(async () => !(await lib()).groups.some((g) => g.id === "g_pr") && !(await lib()).prompts.some((p) => p.id === "p_prt"), WAIT))) fail("confirming did not delete the group and its prompts in the mock");
  if (!(await until(async () => (await barOf(page)).title === "git", WAIT))) fail(`after the delete the bar says ${J(await barOf(page))}, the group's screen is still there`);
  if ((await topScreen(page)).testId !== "lib-group-screen") fail(`after the delete the top screen is ${J(await topScreen(page))}`);
  await reset(false);

  // ---- a rename shows in the bar at once (R1: a pushed group screen's title follows the store, not the push): the nested group's own title and the back's name of the group below it
  await openGroup(page, "g_pr");
  const renameFrom = async (what, name) => {
    await press(page, byTid(page, "lib-more").last());
    await sheetOpen();
    await pressSheetRow(page, "action-sheet", "rename");
    const field = page.locator('[data-testid="group-form-name"]').last();
    await field.waitFor({ state: "visible", timeout: WAIT });
    await field.fill(name);
    await press(page, byTid(page, "sheet-right").last());
    if (!(await until(async () => (await byTid(page, "group-form").count()) === 0, WAIT))) fail(`${what}: the rename's form stays after Save`);
  };
  await renameFrom("the nested group", "PRs");
  if (!(await until(async () => (await barOf(page)).title === "PRs", 3000))) fail(`after renaming the nested group the bar says ${J((await barOf(page)).title)}, not "PRs" (the title was read once, at the push)`);
  await barIs({ back: "git", title: "PRs" }, "the renamed nested group");
  await press(page, byTid(page, "nav-back").last());
  await atRest(page, "lib-group-screen");
  await renameFrom("the group below", "version control");
  if (!(await until(async () => (await barOf(page)).title === "version control", 3000))) fail(`after renaming a group on top of the Library the bar says ${J((await barOf(page)).title)}, not "version control"`);
  await openGroup(page, "g_pr");
  await barIs({ back: "version control", title: "PRs" }, "the nested group under a renamed group");
  await press(page, byTid(page, "nav-back").last());
  await atRest(page, "lib-group-screen");
  await reset(false);
  if (!(await until(async () => (await barOf(page)).title === "git", WAIT))) fail(`after the library is restored the bar says ${J((await barOf(page)).title)}, not "git"`);

  // ---- swipe, on a prompt and on a group; long press
  await press(page, byTid(page, "nav-back").last());
  await atRest(page, "lib-screen");
  await until(async () => (await rowsOf(page)).length === 4, WAIT);
  await swipe("p_sum");
  if (!(await until(async () => (await actionsOf("p_sum")).length === 2, WAIT))) fail("a left swipe on a prompt did not show two actions");
  let acts = await actionsOf("p_sum");
  if (acts.map((a) => a.label).join() !== "Move,Delete" || acts.some((a) => a.h < 43.5)) fail(`the swipe's actions are ${J(acts)}`);
  if (acts[0].bg === acts[1].bg) fail(`Move and Delete have the same colour: ${acts[0].bg}`);
  await press(page, page.locator(`${swipeRow("p_sum")} [data-testid="swipe-action"][data-action="move"]`).first());
  if (!(await until(async () => { const m = (await sheets()).move; return m?.kind === "prompt" && m.id === "p_sum" && m.server === "local"; }, WAIT))) fail(`Move opened ${J(await sheets())}`);
  await closeSheets();
  await swipe("g_writing");
  await until(async () => (await actionsOf("g_writing")).length === 2, WAIT);
  await press(page, page.locator(`${swipeRow("g_writing")} [data-testid="swipe-action"][data-action="move"]`).first());
  if (!(await until(async () => { const m = (await sheets()).move; return m?.kind === "group" && m.id === "g_writing"; }, WAIT))) fail(`a group's Move opened ${J(await sheets())}`);
  await closeSheets();
  await swipe("g_writing");
  await until(async () => (await actionsOf("g_writing")).length === 2, WAIT);
  await press(page, page.locator(`${swipeRow("g_writing")} [data-testid="swipe-action"][data-action="delete"]`).first());
  await sheetOpen("confirm-sheet");
  const gask = await page.evaluate(() => [document.querySelector('[data-testid="confirm-title"]')?.textContent, document.querySelector('[data-testid="confirm-go"]')?.textContent]);
  if (gask[0] !== "Delete “writing”?" || gask[1] !== "Delete group and 1 prompt") fail(`the swipe's group delete asks ${J(gask)}`);
  await press(page, byTid(page, "confirm-cancel").last());
  await sheetGone("confirm-sheet");
  if (!(await lib()).groups.some((g) => g.id === "g_writing")) fail("Cancel deleted the group");
  await swipe("p_sum");
  await until(async () => (await actionsOf("p_sum")).length === 2, WAIT);
  await press(page, page.locator(`${swipeRow("p_sum")} [data-testid="swipe-action"][data-action="delete"]`).first());
  await sheetOpen("confirm-sheet");
  const pask = await page.evaluate(() => [document.querySelector('[data-testid="confirm-title"]')?.textContent, document.querySelector('[data-testid="confirm-body"]')?.textContent, document.querySelector('[data-testid="confirm-go"]')?.textContent]);
  if (pask[0] !== "Delete “Summarise this chat”?" || pask[1] !== `“Summarise this chat” is deleted from ${localName}'s library.` || pask[2] !== "Delete prompt") fail(`the prompt's delete asks ${J(pask)}`);
  await press(page, byTid(page, "confirm-go").last());
  if (!(await until(async () => !(await lib()).prompts.some((p) => p.id === "p_sum"), WAIT))) fail("confirming did not delete the prompt in the mock");
  if (!(await until(async () => (await rowsOf(page)).every((r) => r.id !== "p_sum"), WAIT))) fail("the deleted prompt's row is still drawn");
  await reset(false);
  await until(async () => (await rowsOf(page)).length === 4, WAIT);

  // long press: a prompt's sheet and a group's
  await holdOpen(page, byTid(page, "lib-prompt-row", { id: "p_sum" }).last());
  sh = await sheetOpen();
  if (sh.title !== "Summarise this chat" || sh.sub !== "Prompt at the top level") fail(`the prompt's sheet head is ${J([sh.title, sh.sub])}`);
  if (sh.rows.map((r) => r.label).join("|") !== "Edit prompt|Move prompt…|Delete prompt…") fail(`the prompt's sheet rows are ${J(sh.rows.map((r) => r.label))}`);
  await pressSheetRow(page, "action-sheet", "edit");
  if (!(await until(async () => (await sheets()).editor?.mode === "edit" && (await sheets()).editor.id === "p_sum", WAIT))) fail(`Edit prompt opened ${J(await sheets())}`);
  await closeSheets();
  await sheetGone();
  await holdOpen(page, byTid(page, "lib-group-row", { id: "g_git" }).last());
  sh = await sheetOpen();
  if (sh.title !== "git" || sh.sub !== "Group at the top level · 1 group · 2 prompts") fail(`the group's long-press sheet head is ${J([sh.title, sh.sub])}`);
  if (sh.rows.length !== 5) fail(`the group's long-press sheet has ${sh.rows.length} rows, not 5`);
  await closeP1();

  // ---- offline: one notice, rows open, no swipe, P1 waits
  await reset(true);
  await until(async () => (await sectionsOf(page)).length === 2, WAIT);
  await mockEval(`setServerState(${J(BUILD.id)}, "unreachable", { detail: "connection refused" });`, url);
  if (!(await until(async () => (await sectionsOf(page)).some((s) => s.notice.length), WAIT))) fail("a server that is not connected has no notice");
  secs = await sectionsOf(page);
  const off = secs.find((s) => s.server === BUILD.id), on = secs.find((s) => s.server !== BUILD.id);
  if (off.notice.length !== 1 || !off.notice[0].startsWith("Build Box is not connected")) fail(`the offline section's notices are ${J(off.notice)}`);
  if (on.notice.length) fail(`the connected section has a notice: ${J(on.notice)}`);
  if (off.rows !== 1) fail(`the offline section has ${off.rows} rows, not its one group`);
  await swipe("g_deploy");
  await page.waitForTimeout(500);
  if ((await actionsOf("g_deploy")).length) fail("a swipe on an offline row shows actions");
  await holdOpen(page, byTid(page, "lib-group-row", { id: "g_deploy" }).last());
  sh = await sheetOpen();
  if (sh.rows.some((r) => !r.disabled || r.note !== "Build Box is not connected")) fail(`the offline group sheet's rows are ${J(sh.rows)}`);
  await closeP1();
  await press(page, byTid(page, "lib-plus").last());
  sh = await sheetOpen();
  if (sh.sub !== `At the top level of ${localName}` || sh.rows.some((r) => r.disabled)) fail(`"+" with one server away is ${J(sh)}`);
  await closeP1();
  await press(page, byTid(page, "lib-group-row", { id: "g_deploy" }).last());
  await atRest(page, "lib-group-screen");
  await barIs({ back: "Prompt library", title: "deploy" }, "the offline group screen");
  if ((await texts(page, "lib-off-notice")).length !== 1) fail(`the offline group screen has ${(await texts(page, "lib-off-notice")).length} notices`);
  const nhOff = await page.evaluate(() => { const e = [...document.querySelectorAll('[data-testid="lib-new-here"]')].pop(); return { disabled: e.getAttribute("aria-disabled"), text: e.textContent }; });
  if (nhOff.disabled !== "true" || !nhOff.text.includes("Build Box is not connected")) fail(`offline, "New prompt here" is ${J(nhOff)}`);
  await press(page, byTid(page, "lib-more").last());
  sh = await sheetOpen();
  if (sh.rows.some((r) => !r.disabled)) fail(`the offline group's "⋯" rows are ${J(sh.rows)}`);
  await closeP1();
  await press(page, byTid(page, "nav-back").last());
  await atRest(page, "lib-screen");
  await mockEval(`setServerState(${J(BUILD.id)}, "connected", { version: "dev" });`, url);

  // ---- the empty library, and none
  await reset(false);
  await mockEval(`setLibrary("local", { groups: [], prompts: [] });`, url);
  if (!(await until(async () => (await texts(page, "lib-phone-empty")).length === 1, WAIT))) fail("an empty library has no empty card");
  if (!(await texts(page, "lib-phone-empty"))[0].includes("No prompts yet")) fail(`the empty card says ${J(await texts(page, "lib-phone-empty"))}`);
  const eb = await byTid(page, "lib-empty-new").last().boundingBox();
  if (!eb || eb.height < 43.5) fail(`the empty card's button is ${eb?.height} high`);
  await press(page, byTid(page, "lib-empty-new").last());
  if (!(await until(async () => (await sheets()).editor?.mode === "new" && (await sheets()).editor.at.group === "", WAIT))) fail(`the empty card's New prompt opened ${J(await sheets())}`);
  await closeSheets();
  await shoot("light", "7-empty");

  // ---- the dark theme: the sizes and the shots again
  await page.evaluate(() => localStorage.setItem("aiwb.theme", "dark"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await byTid(page, "home").first().waitFor({ state: "visible", timeout: WAIT });
  if (!(await until(async () => (await themeNow(page)).theme === "dark", WAIT))) fail(`the dark theme did not apply: ${J(await themeNow(page))}`);
  await shots("dark");
  await reset(false);
  await mockEval(`setLibrary("local", { groups: [], prompts: [] });`, url);
  await shoot("dark", "7-empty");
  // (the light shots are taken last, with the light theme back, so both sets show the same states)
  await page.evaluate(() => localStorage.setItem("aiwb.theme", "light"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await byTid(page, "home").first().waitFor({ state: "visible", timeout: WAIT });
  await until(async () => (await themeNow(page)).theme === "light", WAIT);
  await shots("light");
  note(`screenshots in ${OUT}`);
}, { viewports });
