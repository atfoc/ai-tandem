// L11 (new in the app, package S1): the parts of the sidebar that no browser check proved on the page (the `none` rows of A.2 and A.3 of
// plans/rn-rewrite/parity-inventory.md) and what the touch layouts changed. The unseeded mock's things of this computer, with a group "Lab"
// that holds a board "Plan" (marked new, one of its chats at work), a chat that is "legacy" (the old board connection), a chat with three
// branches, a group that is empty, and an archived board.
//   A-SB-12  a row's tooltip is "name — line" (a chat), its path (a board, a group); a section's head says "<name> — <state>"
//   A-SB-15  a legacy chat: greyed, a "Disabled" tag, its menu "Archive", "Delete", and a double press renames nothing
//   A-SB-16  a chat with branches shows their number, titled "3 branches"
//   A-SB-20  a board row: the caret closes and opens its chats (closed, their count); the "new" dot until the board is opened; an archived board's tag
//   A-SB-27  archiving a board whose chat is at work asks "An agent is working on this board. Stop it and archive?"; "Stop and archive" stops it, then archives
//   A-SB-29  a board's rename that its server refuses shows the server's sentence in a line under the row, and the name stays
//   A-SB-34  a change that is refused says its own title ("Couldn't archive the board") with the server's sentence
//   A-SB-35  the "+" and "…" of a row show under the pointer (a mouse), and are always drawn for a finger
//   A-SB-36  a menu is a popover (a sheet on the phone), headed for a "+", its Delete in the danger colour; Esc closes only it; a press outside does
//   A-SB-37  a collapsed group shows what it holds and a dot while one of its chats works; a double press renames it
//   (new)    a chat that waits for its background work has the muted dot (`crow-dot` of state "waiting") and the line "Waiting for background work"
//   A-SB-41  an empty group says "Empty — use + or drag chats here."
//   A-SB-06  the foot: Show archived, Servers, the prompt library, Settings (voice's), the theme picker, in that order; the Servers button's title
// The touch layouts run the same body: a double press is two taps, hover is not asked of a finger.
// The phone has no sidebar (package H1, plans/ux-improvements/h1-design.md §2–§8): its half reads the same things on Home and the group's screen
// (`phoneHalf` below): a row's words (A-SB-12: the row's accessible label "name, line"; the server's head: Home's sub-line), the chat that waits
// for its background work (its state word, no dot), a board's chats count (the sub-line "Whiteboard · 1 chat"), the archived board not listed
// (Home never lists archived things, §3; Settings › Archived lists it,
// under its group, and has no "Show archived" switch), a group's counts and an empty group (A-SB-41's "Nothing here yet"), "+ New" as H2's new sheet (A-SB-36: the Where card with the
// place, Chat, Whiteboard, Group; a press outside and Esc close it), a board opened tells its server it was seen, the foot behind the gear (Settings' rows, S1). Left to the wide layouts, which alone have
// the counterpart: tooltips (a finger has none), the Disabled tag and the row menus of a legacy chat, the branch badge, the "new" dot, the caret
// of a board's chats (Home lists no board's chats, §3), Show archived (the wide layouts' switch), the hover buttons and the row menus
// (rowactions.ts is H2's: swipe and long press give `{}` for now), the rename of a group and a board, the archive questions and their refusals
// (A-SB-27/29/34) and the collapse of a group (a group is a screen).
import { callMatcher, callsOf, check, colourOf, mockEval, until } from "../shot.mjs";
import { IDS, back, byTid, hover, openFoot, placed, press, showHome, showList, touchNow } from "./sel.mjs";
import { atRest, settingsText } from "./settings.mjs";
import { archivedSeen, newSheetSeen } from "./rows.mjs";
import { footOf, groupHead, homeOf, rowNamed, section, sideMenu, sideSeen } from "./side.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const J = JSON.stringify;
const SETUP = `
  groups.push({ id: "g_L", name: "Lab" }, { id: "g_E", name: "Empty one" });
  boards.b_L1 = { id: "b_L1", name: "Plan", group: "g_L", created: iso(T0 - 90 * MIN), new: true };
  boards.b_L2 = { id: "b_L2", name: "Idle board", group: "g_L", created: iso(T0 - 85 * MIN) };
  boards.b_LA = { id: "b_LA", name: "Shelved", group: "g_L", created: iso(T0 - 80 * MIN), archived: true };
  chats.c_L1 = chat("c_L1", { name: "Working chat", board: "b_L1", status: "tool", statusTool: "Bash" }); items.c_L1 = [];
  chats.c_L2 = chat("c_L2", { name: "Old style", group: "g_L", instructionsSent: true }); items.c_L2 = [];
  chats.c_L3 = chat("c_L3", { name: "Many branches", group: "g_L", branches: 3 }); items.c_L3 = [];
  resync();`;

/** The phone's half: Home and the screen of the group "Lab" (and of the empty one) say what the sidebar's rows say on the wide layouts. */
async function phoneHalf({ page, url, fail, note }) {
  const calls = callsOf(page);
  const label = (kind, key) => byTid(page, IDS.homeRow, { kind, key }).last().getAttribute("aria-label");
  const rowOf = async (group, kind, key) => (await homeOf(page, group)).rows?.find((r) => r.kind === kind && r.key === key);
  const sheetGone = (timeout = 3000) => until(async () => !(await byTid(page, "home-new-sheet").count()), timeout);
  const home = await byTid(page, IDS.home).first();
  await home.waitFor({ state: "visible", timeout: 15000 });
  const row = (kind, key) => byTid(page, IDS.homeRow, { kind, key }).last();
  await row("group", "g_L").waitFor({ state: "attached", timeout: 15000 });

  // ---- A-SB-12: the server's head and a row's words (the phone has no tooltips: the row's accessible label is "name, line")
  const h = await homeOf(page);
  if (h.state !== "list" || h.name !== "This computer" || h.word !== "connected") fail(`Home says ${JSON.stringify([h.state, h.name, h.word])}, not the list of "This computer" connected`);
  if (await label("group", "g_L") !== "Lab, 2 boards · 2 chats") fail(`a group's label is "${await label("group", "g_L")}", not "Lab, 2 boards · 2 chats" (an archived board is not counted)`);
  if (await label("group", "g_E") !== "Empty one, Empty") fail(`an empty group's label is "${await label("group", "g_E")}", not "Empty one, Empty"`);

  // ---- the group's screen: its boards and chats, the archived board not listed, a board's chats counted in its line
  await press(page, row("group", "g_L"));
  await byTid(page, IDS.groupScreen, { key: "g_L" }).last().waitFor({ state: "visible", timeout: 15000 });
  const lab = await homeOf(page, "g_L");
  if (JSON.stringify([...lab.outline].sort()) !== JSON.stringify(["board Idle board", "board Plan", "chat Many branches", "chat Old style"])) fail(`the group Lab's screen lists ${JSON.stringify(lab.outline)}, not its two boards and two chats (the archived board "Shelved" and the board's chat are not rows)`);
  if (lab.outline.some((x) => /Shelved/.test(x))) fail("an archived board is listed on the group's screen"); // (A-SB-20: it shows only with Show archived on the wide layouts; Home never lists archived things)
  if (lab.place !== "This computer · 2 boards · 2 chats") fail(`the group Lab's place line is "${lab.place}", not "This computer · 2 boards · 2 chats"`);
  const plan = await rowOf("g_L", "board", "b_L1");
  if (plan?.sub !== "Whiteboard · 1 chat") fail(`the board Plan says "${plan?.sub}", not "Whiteboard · 1 chat"`); // (A-SB-20's count of its chats)
  const legacy = await rowOf("g_L", "chat", "c_L2");
  if (!legacy) fail("the legacy chat has no row on the group's screen");

  // ---- a chat that waits: its state word in the row (the chat is put back at the end of this part). Home names a waiting chat by `chatWord`
  // (h1-design.md §3), which knows the subagents it waits on ("Waiting on 2 subagents"), and says "Waiting for background work" for a chat that
  // waits with no subagent running, as the chat's header does (h2-design.md H2-5).
  {
    const setWaiting = (st, subs) => mockEval(`chats.c_L3.status = ${JSON.stringify(st)}; chats.c_L3.subsRunning = ${subs}; send({ type: "chat", chat: chats.c_L3 });`, url);
    const subOf = async () => (await rowOf("g_L", "chat", "c_L3"))?.sub;
    await setWaiting("waiting", 2);
    if (!await until(async () => (await subOf()) === "Waiting on 2 subagents", 10000)) fail(`the row of a chat that waits for 2 subagents says "${await subOf()}", not "Waiting on 2 subagents"`);
    else if (await label("chat", "c_L3") !== "Many branches, Waiting on 2 subagents") fail(`that row's label is "${await label("chat", "c_L3")}"`);
    await setWaiting("waiting", 0);
    if (!await until(async () => (await subOf()) === "Waiting for background work", 10000)) fail(`the row of a chat that waits for background work says "${await subOf()}", not "Waiting for background work"`);
    await setWaiting("ready", 0);
    if (!await until(async () => !/^Waiting/.test((await subOf()) ?? ""), 10000)) fail("the row keeps saying the chat waits when it is ready again");
  }

  // ---- "+ New" on the group's screen: the new sheet (H2): the Where card with the place, the Chat and Whiteboard tiles and the Group row; Esc closes it, a press outside does
  await press(page, byTid(page, "group-new").last());
  const sheet = byTid(page, "home-new-sheet").last();
  await sheet.waitFor({ state: "visible", timeout: 10000 });
  if (await byTid(page, "popover").count()) fail("the menu of + New is a popover on the phone"); // (a sheet: its own testID stands in for "sheet")
  const text = ((await sheet.textContent()) ?? "").replace(/\s+/g, " ");
  for (const want of ["New", "Where", "Change", "Chat", "Whiteboard", "Group"]) if (!text.includes(want)) fail(`the sheet of + New does not say "${want}": "${text}"`);
  for (const old of ["New chat", "New whiteboard", "New group"]) if (text.includes(old)) fail(`the sheet of + New still has H1's stop-gap row "${old}": "${text}"`);
  const made = await newSheetSeen(page);
  if (made?.page !== "what" || made.group !== "g_L" || !made.where?.includes("Lab") || J(made.tiles) !== J(["new-chat", "new-board", "new-group"])) fail(`the new sheet on the group Lab's screen is ${J(made)}, not the first page for g_L with the Where card naming Lab and Chat, Whiteboard, Group`);
  await page.keyboard.press("Escape");
  if (!await sheetGone()) fail("Esc did not close the sheet of + New");
  await press(page, byTid(page, "group-new").last());
  await sheet.waitFor({ state: "visible", timeout: 10000 });
  const backdrop = byTid(page, IDS.backdrop).last();
  const bb = await backdrop.boundingBox();
  await page.touchscreen.tap(bb.x + 5, bb.y + 5);
  if (!await sheetGone()) fail("a press outside did not close the sheet of + New");

  // ---- opening a board that is new tells its server that it was seen
  await press(page, row("board", "b_L1"));
  await byTid(page, IDS.boardBar).first().waitFor({ state: "visible", timeout: 15000 });
  if (!await until(() => calls.some((c) => c.method === "POST" && c.path === "/api/boards/b_L1/seen"), 10000)) fail("opening a board that is new did not tell its server that it was seen");
  await back(page);
  await byTid(page, IDS.groupScreen, { key: "g_L" }).last().waitFor({ state: "visible", timeout: 15000 });
  await back(page);

  // ---- an empty group says so (A-SB-41)
  await press(page, row("group", "g_E"));
  const empty = byTid(page, IDS.groupScreen, { key: "g_E" }).last();
  await empty.waitFor({ state: "visible", timeout: 15000 });
  if (!await byTid(empty, "group-empty").count() || !((await empty.textContent()) ?? "").includes("Nothing here yet")) fail('an empty group\'s screen does not say "Nothing here yet"');
  if (!await byTid(empty, "home-empty-new").count()) fail("an empty group's screen has no + New");
  if ((await homeOf(page, "g_E")).rows.length) fail("an empty group's screen lists rows");
  await back(page);

  // ---- the foot: behind Home's gear, in Settings (S1): a row for each control of the sidebar's foot (A-SB-06), Archived's own screen, the servers' state
  await press(page, byTid(page, IDS.gear).first());
  await atRest(page, "settings-screen");
  if (await byTid(page, "home-settings-stopgap").count()) fail("the gear still opens the stop-gap sheet");
  const rows = await page.evaluate(() => [...[...document.querySelectorAll('[data-testid="settings-screen"]')].pop().querySelectorAll('[data-testid="settings-row"]')].map((e) => e.dataset.row));
  const want = ["servers", "library", "archived", "voice", "appearance"];
  if (JSON.stringify(rows.filter((r) => want.includes(r))) !== JSON.stringify(want)) fail(`Settings holds the rows ${JSON.stringify(rows)}, not the foot's ${JSON.stringify(want)} in that order`);
  const said = await settingsText(page);
  if (!said.servers?.label || !said.library?.label) fail(`Settings' Servers and Library rows say ${JSON.stringify([said.servers, said.library])}`);
  for (const id of ["side-archived", "servers-btn", "library-btn", "settings-btn", "theme-btn"]) {
    await openFoot(page, id);
    if (id === "side-archived") { // (H2's screen: no switch on the phone; the archived board "Shelved" is listed there, under its group, and not on Home)
      const seen = await until(async () => (await archivedSeen(page)).rows.some((r) => r.name === "Shelved") || null, 10000);
      const a = await archivedSeen(page);
      if (!seen) fail(`Settings › Archived does not list the archived board: ${J(a.rows)}`);
      else if (a.rows.find((r) => r.name === "Shelved")?.kind !== "board" || !a.sections.some((x) => x.heading === "LAB")) fail(`Archived lists the board Shelved as ${J(a.rows)} under ${J(a.sections)}, not a board under LAB`);
      if (await byTid(page, "archived-screen").last().locator('[role="switch"]').count()) fail("Archived's screen has a switch: the phone has no Show archived");
      if (!a.foot) fail("Archived's screen has no foot line");
    }
    if (id === "servers-btn" || id === "library-btn" || id === "settings-btn") await page.keyboard.press("Escape");
    await showHome(page);
  }
  note("Home and the group's screen: the rows' labels and counts, the archived board not listed, the waiting chat's word, + New as a sheet (Esc, a press outside), a board seen, the empty group, the foot behind the gear");
}

await check("L11 the sidebar's rows, heads and menus: the parts nothing proved on the page, and the touch layouts", async ({ url, viewport, layout, open, fail, note }) => {
  await mockEval(SETUP, url);
  if (layout === "phone") {
    const { page } = await open({ wait: '[data-testid="home"]' });
    return phoneHalf({ page, url, fail, note });
  }
  const { page } = await open({ wait: '[data-testid="side-tree"]' });
  const calls = callsOf(page);
  const touch = await touchNow(page);
  const loc = section(page, "local");
  await rowNamed(page, "Working chat", loc).waitFor({ state: "attached", timeout: 15000 });
  const lab = groupHead(page, "Lab", loc), plan = rowNamed(page, "Plan", loc), legacy = rowNamed(page, "Old style", loc), branched = rowNamed(page, "Many branches", loc);
  const title = (l) => l.getAttribute("title");
  const doublePress = async (l) => { if (touch) { await l.tap(); await l.tap(); } else await l.dblclick(); };
  const menuItems = async () => (await byTid(page, "menu").last().locator('[data-testid="menu-item"]').allTextContents()).map((t) => t.trim());
  const menuGone = (timeout = 3000) => until(async () => !await byTid(page, "menu").count(), timeout);
  await showList(page);

  // ---- tooltips
  if (await title(plan) !== "Lab / Plan") fail(`a board's tooltip is "${await title(plan)}", not its path "Lab / Plan"`);
  if (await title(lab) !== "Lab") fail(`a group's tooltip is "${await title(lab)}"`);
  const t3 = await title(branched);
  if (!/^Many branches — /.test(t3 ?? "")) fail(`a chat's tooltip is "${t3}", not "name — line"`);
  if (await title(byTid(loc, "side-section-head").first()) !== "This computer — Connected") fail(`a section's head says "${await title(byTid(loc, "side-section-head").first())}", not "This computer — Connected"`);

  // ---- a legacy chat
  const l = await sideSeen(page, "local");
  if (!l.outline.includes("  chat Old style [archived]")) fail(`a legacy chat is not greyed: ${J(l.outline.filter((x) => /Old style/.test(x)))}`);
  if (await legacy.locator('[data-testid="archived-tag"]').first().textContent() !== "Disabled") fail(`a legacy chat's tag is "${await legacy.locator('[data-testid="archived-tag"]').first().textContent()}", not "Disabled"`);
  await sideMenu(page, legacy, "More").catch(() => {});
  await byTid(page, "menu").last().waitFor({ timeout: 10000 }); await placed(byTid(page, "menu").last());
  if (J(await menuItems()) !== J(["Archive", "Delete"])) fail(`a legacy chat's menu is ${J(await menuItems())}, not Archive, Delete`);
  await page.keyboard.press("Escape");
  if (!await menuGone()) fail("Esc did not close the legacy chat's menu");
  if (layout !== "phone") { // (on the phone the first press opens the chat, which is a screen over the list)
    await doublePress(legacy.locator('[data-testid="side-name"]'));
    if (await byTid(loc, "name-input").count()) fail("a double press on a legacy chat opened a rename box");
  }

  // ---- branches
  const badge = byTid(branched, "branch-badge");
  if (await badge.count() !== 1 || (await badge.textContent()).trim() !== "3" || await badge.getAttribute("title") !== "3 branches") fail(`the branch badge: ${await badge.count()} of them, saying "${await badge.first().textContent().catch(() => "")}", titled "${await badge.first().getAttribute("title").catch(() => "")}"`);
  if (await byTid(rowNamed(page, "Working chat", loc), "branch-badge").count()) fail("a chat with one branch shows a branch badge");

  // ---- a chat that waits for its background work: the muted dot and its words (the chat is put back at the end of this part)
  {
    const setWaiting = (st) => mockEval(`chats.c_L3.status = ${J(st)}; send({ type: "chat", chat: chats.c_L3 });`, url);
    const dotOf = () => byTid(branched, "crow-dot").first().getAttribute("data-state").catch(() => null);
    const lineOf = async () => ((await byTid(branched, "side-sub").first().textContent().catch(() => "")) ?? "").trim();
    await setWaiting("waiting");
    if (!await until(async () => (await dotOf()) === "waiting", 10000)) fail(`${viewport}: the dot of a chat that waits for background work is "${await dotOf()}", not "waiting"`);
    else {
      if (await lineOf() !== "Waiting for background work") fail(`${viewport}: the row of a chat that waits for background work says "${await lineOf()}", not "Waiting for background work"`);
      if (!/ — Waiting for background work$/.test(await title(branched) ?? "")) fail(`${viewport}: the tooltip of that row is "${await title(branched)}"`);
    }
    await setWaiting("ready");
    if (!await until(async () => (await dotOf()) !== "waiting", 10000)) fail(`${viewport}: the dot stays "waiting" when the chat is ready again`);
  }

  // ---- the board row: new dot, caret and count, archived tag
  const dot = byTid(plan, "new-dot");
  if (await dot.count() !== 1 || await dot.getAttribute("title") !== "New — made by an agent") fail(`the new board has ${await dot.count()} "new" dots, titled "${await dot.first().getAttribute("title").catch(() => "")}"`);
  const caret = plan.locator('[aria-expanded]').first();
  if (await caret.getAttribute("aria-expanded") !== "true" || !await rowNamed(page, "Working chat", loc).count()) fail("a board's chats are not shown under it");
  await press(page, caret);
  if (!await until(async () => !await rowNamed(page, "Working chat", loc).count(), 5000)) fail("the caret did not close the board's chats");
  if ((await plan.locator('[data-testid="side-count"]').first().textContent().catch(() => "")).trim() !== "1") fail(`a board whose chats are closed shows "${await plan.locator('[data-testid="side-count"]').first().textContent().catch(() => "")}", not their count`);
  await press(page, caret);
  if (!await until(async () => await rowNamed(page, "Working chat", loc).count() === 1, 5000)) fail("the caret did not open the board's chats again");
  if (!(await sideSeen(page, "local")).outline.every((x) => !/Shelved/.test(x))) fail("an archived board shows with Show archived off");
  await press(page, byTid(page, "side-archived").first());
  if (!await until(async () => (await sideSeen(page, "local")).outline.includes("  board Shelved [archived]"), 5000)) fail("an archived board does not show with Show archived on");
  if (!await byTid(rowNamed(page, "Shelved", loc), "archived-tag").count()) fail("an archived board has no Archived tag");
  await press(page, byTid(page, "side-archived").first());
  await press(page, plan.locator('[data-testid="side-name"]'));   // opens the board: the app tells its server that the board has been seen
  if (!await until(() => calls.some((c) => c.method === "POST" && c.path === "/api/boards/b_L1/seen"), 10000)) fail("opening a board that is new did not tell its server that it was seen");
  await showList(page);

  // ---- a group: its words, its count and its dot while collapsed, a double press renames it, an empty one says so
  const empty = byTid(loc, "side-group-head", { group: "g_E" }).first(); // (by its key: the name is a box while it is renamed)
  if ((await byTid(section(page, "local"), "side-group", { group: "g_E" }).textContent()).indexOf("Empty — use + or drag chats here.") < 0) fail('an empty group does not say "Empty — use + or drag chats here."');
  await press(page, lab);
  if (!await until(async () => (await sideSeen(page, "local")).outline.includes("group Lab [collapsed]"), 5000)) fail("a press on the group did not collapse it");
  const count = (await lab.locator('[data-testid="side-count"]').first().textContent().catch(() => "")).trim();
  if (count !== "4") fail(`a collapsed group shows "${count}", not what it holds (two boards and two chats: 4; a board's chats are the board's)`);
  if (await lab.locator('[data-testid="crow-dot"]').count() !== 1) fail("a collapsed group with a chat at work shows no working dot");
  await press(page, lab);
  await doublePress(empty.locator('[data-testid="side-group-name"]'));
  if (!await until(() => byTid(empty, "name-input").count(), 5000)) fail("a double press on a group did not open its rename box");
  await page.keyboard.press("Escape");
  if (!await until(async () => !await byTid(loc, "name-input").count(), 5000)) fail("Esc did not drop the rename box");

  // ---- the hover buttons: under the pointer for a mouse, always for a finger
  const more = empty.locator('[data-testid="side-more"]').first();
  if (!touch) {
    await page.mouse.move(640, 400);
    if (await more.isVisible()) fail('a group\'s "…" shows with no pointer over it');
    await hover(page, empty);
    if (!await until(() => more.isVisible(), 5000)) fail('a group\'s "…" does not show under the pointer');
    await press(page, more);
    await byTid(page, "menu").last().waitFor({ timeout: 10000 }); await placed(byTid(page, "menu").last());
    await page.mouse.move(640, 400);
    if (!await more.isVisible()) fail('a group\'s "…" goes while its menu is open');
    await page.keyboard.press("Escape");
    if (!await menuGone()) fail("Esc did not close the group's menu");
  } else if (!await more.isVisible()) fail('a finger sees no "…" on a group: it is not drawn');

  // ---- menus: the form, the head of a "+", the danger colour, Esc and a press outside
  const kind = layout === "phone" ? "sheet" : "popover";
  await sideMenu(page, empty, "New in Empty one").catch(() => {});
  await byTid(page, "menu").last().waitFor({ timeout: 10000 }); await placed(byTid(page, "menu").last());
  if (!await byTid(page, kind).count()) fail(`a menu is not a ${kind} on the ${layout} layout`);
  if (layout === "phone" ? await byTid(page, "popover").count() : await byTid(page, "sheet").count()) fail(`a menu is a ${layout === "phone" ? "popover" : "sheet"} on the ${layout} layout`);
  const head = await byTid(page, "menu-head").last().textContent();
  if (head.trim() !== "New in Empty one") fail(`a "+" menu is headed "${head}"`);
  if (J(await menuItems()) !== J(["Chat", "Whiteboard", "Group"])) fail(`a group's "+" offers ${J(await menuItems())}`);
  await page.keyboard.press("Escape");
  if (!await menuGone()) fail("Esc did not close the menu");
  if (await byTid(loc, "name-input").count()) fail("Esc that closed a menu also acted on what is under it");
  await sideMenu(page, empty, "More").catch(() => {});
  await byTid(page, "menu").last().waitFor({ timeout: 10000 }); await placed(byTid(page, "menu").last());
  const del = byTid(page, "menu").last().locator('[data-testid="menu-item"]', { hasText: "Delete" }).first();
  const red = await del.locator('[dir="auto"]').first().evaluate((e) => getComputedStyle(e).color);
  if (red !== "rgb(224, 49, 49)") fail(`the Delete item is drawn in ${red}, not in the danger colour`);
  const backdrop = byTid(page, "overlay-backdrop").last();
  const bb = await backdrop.boundingBox();
  if (touch) await page.touchscreen.tap(bb.x + 5, bb.y + 5); else await page.mouse.click(bb.x + 5, bb.y + 5);
  if (!await menuGone()) fail("a press outside did not close the menu");

  // ---- archiving a board whose chat is at work asks first; a refusal is said in the question, a refusal of a plain archive in a dialog of its own title
  const writes = () => calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`);
  await sideMenu(page, plan, "More", "Archive");
  const dialog = byTid(page, "confirm-dialog");
  await dialog.waitFor({ timeout: 10000 });
  if (!(await dialog.textContent()).includes("An agent is working on this board. Stop it and archive?")) fail(`the question before archiving a board at work is "${await dialog.textContent()}"`);
  await press(page, dialog.getByText("Cancel", { exact: true }).first());
  if (writes().some((w) => /archive|interrupt/.test(w))) fail(`Cancel still made the calls ${J(writes())}`);
  await page.route(callMatcher(/^POST \/api\/boards\/b_L1\/archive$/), (route) => route.fulfill({ status: 409, contentType: "application/json", body: J({ error: "The server cannot archive it now.", code: "busy" }) }));
  await sideMenu(page, plan, "More", "Archive");
  await dialog.waitFor({ timeout: 10000 });
  await press(page, dialog.getByText("Stop and archive", { exact: true }).first());
  if (!await until(async () => (await byTid(page, "confirm-dialog").textContent().catch(() => "")).includes("The server cannot archive it now."), 10000)) fail(`a refused "Stop and archive" says "${await byTid(page, "confirm-dialog").textContent().catch(() => "")}" in its question, not the server's sentence`);
  if (!writes().some((w) => /POST \/api\/chats\/c_L1\/interrupt/.test(w))) fail(`"Stop and archive" did not stop the chat first: ${J(writes())}`);
  await press(page, byTid(page, "confirm-dialog").getByText("Cancel", { exact: true }).first());
  await page.unroute(callMatcher(/^POST \/api\/boards\/b_L1\/archive$/));
  // a board with no chat at work: archived by a call, whose refusal is a dialog of its own, titled for the change (A-SB-34)
  await page.route(callMatcher(/^POST \/api\/boards\/b_L2\/archive$/), (route) => route.fulfill({ status: 409, contentType: "application/json", body: J({ error: "The server cannot archive it now.", code: "busy" }) }));
  await sideMenu(page, rowNamed(page, "Idle board", loc), "More", "Archive");
  if (!await until(async () => /Couldn't archive the board/.test(await byTid(page, "confirm-dialog").textContent().catch(() => "")), 10000)) fail(`a refused archive says "${await byTid(page, "confirm-dialog").textContent().catch(() => "")}", not "Couldn't archive the board"`);
  if (!(await byTid(page, "confirm-dialog").textContent()).includes("The server cannot archive it now.")) fail("a refused archive does not say the server's sentence");
  await press(page, byTid(page, "confirm-dialog").getByText("Close", { exact: true }).first());
  await page.unroute(callMatcher(/^POST \/api\/boards\/b_L2\/archive$/));

  // ---- a rename that is refused: the sentence under the row, the name stays
  await page.route(callMatcher(/^POST \/api\/boards\/b_L1\/rename$/), (route) => route.fulfill({ status: 409, contentType: "application/json", body: J({ error: "That name is taken.", code: "name_taken" }) }));
  const planRow = byTid(loc, "side-row", { kind: "board", key: "b_L1" }).first(); // (by its key: the name is a box while it is renamed)
  await sideMenu(page, planRow, "More", "Rename");
  const box = byTid(planRow, "name-input");
  await box.waitFor({ timeout: 10000 });
  await box.fill("Elsewhere"); await box.press("Enter");
  const err = byTid(byTid(loc, "side-board", { board: "b_L1" }), "side-err");
  if (!await until(async () => (await err.textContent().catch(() => "")).includes("That name is taken."), 10000)) fail(`a refused rename shows "${await err.textContent().catch(() => "")}" under the row, not the server's sentence`);
  if (!await rowNamed(page, "Plan", loc).count()) fail("a board whose rename was refused is not named what its server has");
  await page.unroute(callMatcher(/^POST \/api\/boards\/b_L1\/rename$/));

  // ---- the foot
  const foot = await page.evaluate(() => [...document.querySelectorAll('[data-testid="side-foot"] [data-testid="side-archived"], [data-testid="side-foot"] [data-testid="servers-btn"], [data-testid="side-foot"] [data-testid="library-btn"], [data-testid="side-foot"] [data-testid="settings-btn"], [data-testid="side-foot"] [data-testid="theme-btn"]')].map((e) => [e.dataset.testid, Math.round(e.getBoundingClientRect().left), e.getAttribute("title") ?? "", Math.round((e.getBoundingClientRect().top + e.getBoundingClientRect().height / 2) / 30)]));
  const order = foot.map((f) => f[0]);
  if (J(order) !== J(["side-archived", "servers-btn", "library-btn", "settings-btn", "theme-btn"])) fail(`the foot's controls are ${J(order)}`);
  // (in a narrow sidebar the library's button and the picker wrap to a line of their own, at the right: they are still read after the others)
  const seen = [...foot].sort((a, b) => a[3] - b[3] || a[1] - b[1]).map((f) => f[0]);
  if (J(seen) !== J(order)) fail(`the foot's controls are not in that order, top to bottom and left to right: ${J(seen)}`);
  if (foot[1][2] !== "Servers" && !/^Servers: one is not connected/.test(foot[1][2])) fail(`the Servers button is titled "${foot[1][2]}"`);
  if (foot[2][2] !== "Prompt library") fail(`the library's button is titled "${foot[2][2]}"`);
  if (foot[3][2] !== "Settings") fail(`the Settings button is titled "${foot[3][2]}"`);
  void viewport; void colourOf; void showList;
  note(`the rows' words, the tags, the caret and count, the new dot, the hover buttons (${touch ? "drawn for a finger" : "under the pointer"}), ${kind}s, Delete in the danger colour, the question before an archive at work, a refusal and its title, a refused rename's line, the foot's order`);
}, { viewports, page: false });
