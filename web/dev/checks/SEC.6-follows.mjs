// Proves that a section follows its server (plans/remote-server-sections-goal.md, 3.3 "A change made anywhere shows
// without a reload", 3.5 "Deleted elsewhere"): what the owner of that server or another client of it makes, renames,
// moves, archives, unarchives and deletes (a chat, a board, a group) shows in the section as it happens, with
// no reload and no call of this page; a new group shows open; the groups keep that server's order; a chat's draft
// mark follows. What is deleted there leaves the section with no row left behind, greyed or not, also with "Show
// archived" on. A chat and a board that are open when they are deleted there stay on screen, and their view
// says that they are no longer on that server.
// The changes are made in the mock by `elsewhere` (dev/mock.mjs): that machine's own routes, called by nobody's
// page, whose events reach this page as that server's.
// Ports dev/checks/SEC.6-follows.mjs (S1) to the new build, at the three viewports (A-SB-13, A-SC-16, A-SC-17, A-ST-06's row half). Deviations:
// the old page marked nothing of a row "gone" by a class that the check could look for (`.gone`, `.side-row.grey`), and the app has no such
// mark: a row that is deleted there is not drawn, which `gone` below asserts for each name, with "Show archived" on; the view of the open board
// is read by the testID `board-off` (its `view` is "gone"), the bar of the open chat by `remote-bar` (its `kind`); on the phone the list is
// behind the chat, still drawn, so the rows are read where they are, and the local part's first chat is opened by the stack's path.
// Besides the old check (A-SB-13): the draft mark of a row is titled "Unsent message".
// The phone (package H1) has Home and group screens in the sidebar's place (plans/ux-improvements/h1-design.md §3): its half (`onPhone` below)
// reads each change where it is listed, Studio Mac's Home or the screen of the group it is in (a board's chats as the count of its row's
// line), with the same changes made elsewhere, the same "no call, no reload", and the open chat and board deleted there. The phone has no
// "Show archived": what is archived there leaves Home and is listed in Settings › Archived (`archived-screen`), and is gone from it again when
// unarchived or deleted. Home's rows have no
// draft mark (h1-design §3: icon, name, line, dot or count), so the draft part is the wide layouts'.
import { callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { byTid, openBoard, openChat, openFoot, press, showHome, showList } from "./sel.mjs";
import { archivedNames } from "./rows.mjs";
import { homeOf, rowNamed, section, sideSeen } from "./side.mjs";
import { WAIT, composerBlock, headSub, messages, says, sendIsOff, textOf, threadShown } from "./chat.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const J = JSON.stringify;
const STUDIO = "s_studio", LOOSE = "__ungrouped__";

await check("SEC.6 a section follows what is made, changed and deleted on its server from elsewhere", async ({ url, viewport, open, fail, note, layout }) => {
  await seed(url, "SEC");
  if (layout === "phone") return onPhone({ url, viewport, open, fail, note });
  const { page } = await open({ wait: '[data-testid="side-tree"]' });
  const calls = callsOf(page);
  const sec = section(page, STUDIO);
  const row = (name) => rowNamed(page, name, sec);
  const outline = async () => (await sideSeen(page, STUDIO)).outline;
  /** A call made on Studio Mac by somebody else; answers its body. */
  const far = async (method, path, body) => {
    const r = await mockEval(`return await elsewhere("${STUDIO}", ${J(method)}, ${J(path)}, ${body === undefined ? "undefined" : J(body)});`, url);
    if (r.status !== 200) fail(`the mock answered ${method} ${path} with ${r.status}: ${J(r.body)}`);
    return r.body;
  };
  let n = 0;
  /** After a change made elsewhere: the section has (or has not) each line, the first of them right under `under`. */
  const shows = async (name, { has = [], hasNot = [], under } = {}) => {
    n++;
    const ok = (o) => has.every((l) => o.includes(l)) && hasNot.every((l) => !o.includes(l)) && (!under || o[o.indexOf(under) + 1] === has[0]);
    if (!await until(async () => ok(await outline()), 10000)) fail(`${name}: the section does not show it: ${J(await outline())}`);
  };
  await byTid(sec, "side-row").first().waitFor({ state: "attached", timeout: 15000 });
  await page.evaluate(() => { window.__loaded = 1; });
  const writes0 = calls.filter((c) => c.method !== "GET").length;

  // ---- made elsewhere
  const chat = await far("POST", "/chats", { group: "g_old" });
  await shows("a chat made in a group", { has: ["  chat New chat"] });
  await far("PATCH", `/chats/${chat.id}`, { name: "Take 15" });
  await shows("that chat named", { has: ["  chat Take 15"], hasNot: ["  chat New chat"], under: "group Old takes" });
  await far("POST", "/boards", { group: "g_shop", name: "Shot list" });
  await shows("a board made in a group", { has: ["  board Shot list"] });
  const dailies = await far("POST", "/groups", { name: "Dailies" });
  await shows("a group made", { has: ["group Dailies"] });
  if ((await outline()).at(-1) !== "group Dailies") fail(`a group made elsewhere is not the last of the section, open: ${J(await outline())}`);
  await far("POST", "/groups", { name: "Monday", parent: dailies.id });
  await shows("a group made in a group", { has: ["  group Monday"], under: "group Dailies" });
  const onBoard = await far("POST", "/chats", { board: "b_arch" });
  await far("PATCH", `/chats/${onBoard.id}`, { name: "Cut scene nine" });
  await shows("a chat made on a board", { has: ["    chat Cut scene nine"] });

  // ---- renamed elsewhere
  await far("PATCH", "/chats/c_take", { name: "Take 14b" });
  await shows("a chat renamed", { has: ["  chat Take 14b"], hasNot: ["  chat Take 14"] });
  await far("POST", "/boards/b_arch/rename", { name: "Storyboard B" });
  await shows("a board renamed", { has: ["  board Storyboard B"], hasNot: ["  board Storyboard"] });
  await far("PATCH", "/groups/g_old", { name: "Older takes" });
  await shows("a group renamed", { has: ["group Older takes"], hasNot: ["group Old takes"] });

  // ---- moved elsewhere
  await far("PATCH", "/chats/c_take", { group: "g_shop" });
  await shows("a chat moved to another group", { has: ["  chat Take 14b"] });
  const groupOf = (name) => page.evaluate((name) => {
    const q = (e, id) => e.querySelector(`[data-testid="${id}"]`);
    const r = [...document.querySelectorAll('[data-testid="side-row"]')].find((x) => q(x, "side-name")?.textContent === name);
    return r?.closest('[data-testid="side-group"]') && q(r.closest('[data-testid="side-group"]'), "side-group-name")?.textContent;
  }, name);
  if (!await until(async () => await groupOf("Take 14b") === "Renders", 10000)) fail("the chat moved elsewhere is not in the group Renders");
  await far("PATCH", "/boards/b_arch", { group: LOOSE });
  await shows("a board moved out of its group", { has: ["board Storyboard B", "  chat Tighten act two"], hasNot: ["  board Storyboard B"] });
  await far("POST", "/groups/g_sub/move", { parent: "" });
  await shows("a group moved to the top level", { has: ["group Nightly", "  chat Last night's failures"], hasNot: ["  group Nightly"] });
  // that server's order of its groups is the section's
  const order = async () => (await outline()).filter((l) => l.startsWith("group "));
  const was = await order();
  await mockEval(`onServer("${STUDIO}", () => { groups.reverse(); send({ type: "groups", groups }); });`, url);
  if (!await until(async () => J(await order()) === J([...was].reverse()), 10000)) fail(`the groups turned round on Studio Mac, the section has ${J(await order())}, before ${J(was)}`);
  n++;

  // ---- a chat's draft mark follows
  await far("PUT", "/chats/c_night/draft", { text: "ask about the fan curve" });
  if (!await until(() => byTid(row("Last night's failures"), "draft-tag").count(), 10000)) fail("a draft saved elsewhere does not mark the chat's row");
  if (await byTid(row("Last night's failures"), "draft-tag").first().getAttribute("title") !== "Unsent message") fail(`the draft mark of a chat's row is titled "${await byTid(row("Last night's failures"), "draft-tag").first().getAttribute("title")}", not "Unsent message"`); // (A-SB-13)
  await far("PUT", "/chats/c_night/draft", { text: "" });
  if (!await until(async () => !await byTid(row("Last night's failures"), "draft-tag").count(), 10000)) fail("a draft removed elsewhere still marks the chat's row");
  n += 2;

  // ---- archived and unarchived elsewhere
  for (const [what, path, line, also] of [["a chat", "/chats/c_take", "  chat Take 14b"], ["a board", "/boards/b_arch", "board Storyboard B", "  chat Tighten act two"], ["a group", "/groups/g_old", "group Older takes", "  chat Take 15"]]) {
    await far("POST", `${path}/archive`);
    await shows(`${what} archived`, { hasNot: [line, ...(also ? [also] : [])] });
    await far("POST", `${path}/unarchive`);
    await shows(`${what} unarchived`, { has: [line, ...(also ? [also] : [])] });
  }

  // ---- deleted elsewhere: no row stays, greyed or not, also with "Show archived" on
  await showList(page);
  await press(page, byTid(page, "side-archived").first());
  const gone = async (name, names) => {
    n++;
    const left = () => page.evaluate(([id, names]) => {
      const s = [...document.querySelectorAll('[data-testid="side-section"]')].find((x) => x.dataset.server === id);
      return [...s.querySelectorAll('[data-testid="side-row"], [data-testid="side-group-head"]')]
        .filter((r) => names.includes(r.querySelector('[data-testid="side-name"], [data-testid="side-group-name"]')?.textContent ?? "")).map((r) => r.dataset.testid + " " + (r.dataset.key ?? r.dataset.group));
    }, [STUDIO, names]);
    if (!await until(async () => !(await left()).length, 10000)) fail(`${name}: a row stays in the section: ${J(await left())}`);
  };
  await far("DELETE", "/chats/c_take"); await gone("a chat deleted", ["Take 14b"]);
  await far("DELETE", "/boards/b_arch"); await gone("a board deleted, with its chats", ["Storyboard B", "Tighten act two", "Cut scene nine"]);
  await far("DELETE", "/groups/g_old?contents=delete"); await gone("a group deleted with what is in it", ["Older takes", "Take 15"]);
  await far("DELETE", `/groups/${dailies.id}?contents=keep`); await gone("a group deleted, its contents kept", ["Dailies"]);
  await shows("the kept group of the deleted one", { has: ["group Monday"], hasNot: ["  group Monday"] });
  await press(page, byTid(page, "side-archived").first());

  // ---- the page did all of that by following: no call that changes something, and no reload
  const own = calls.filter((c) => c.method !== "GET").slice(writes0);
  if (own.length) fail(`the page made calls of its own meanwhile: ${J(own.map((c) => `${c.method} ${c.path}`))}`);
  if (!await page.evaluate(() => window.__loaded === 1)) fail("the page was loaded anew");

  // ---- open, and deleted elsewhere: the view stays and says so
  await openChat(page, `${STUDIO}~c_plain`);
  await threadShown(page);
  await far("DELETE", "/chats/c_plain");
  const bar = byTid(page, "remote-bar");
  if (!await says(page, "remote-bar-text", "This chat is no longer on Studio Mac.")) fail(`${viewport}: the open chat deleted elsewhere does not say so: "${await textOf(page, "remote-bar-text")}"`);
  await gone("the open chat deleted elsewhere", ["Render queue is stuck"]);
  if (!(await messages(page)).some((m) => m.role === "user")) fail(`${viewport}: the open chat's thread went with the chat`);
  const send = byTid(page, "send");
  if (await send.count() && !(await send.first().isDisabled())) fail(`${viewport}: Send is on for a chat that is no longer on its server`);
  if (await bar.first().getAttribute("data-kind") !== "gone") fail(`${viewport}: the chat that is gone there says that its server is not connected`);

  await openBoard(page, `${STUDIO}~b_loose`);
  await byTid(page, "board-canvas", { state: "ready" }).first().waitFor({ state: "attached", timeout: 15000 });
  await far("DELETE", "/boards/b_loose");
  if (!await says(page, "board-off", "No longer on Studio Mac")) fail(`${viewport}: the open board deleted elsewhere does not say so: "${await textOf(page, "board-off")}"`);
  await gone("the open board deleted elsewhere", ["Floor plan", "Label the rooms"]);
  // left, it is gone for good: the local part's first chat is opened, and nothing of the board is on screen
  await showList(page);
  const first = await byTid(section(page, "local"), "side-row", { kind: "chat" }).first().getAttribute("data-key");
  await openChat(page, first);
  if (!await until(async () => (await page.evaluate(() => JSON.parse(localStorage.getItem("aiwb.sel") ?? "{}"))).board !== `${STUDIO}~b_loose` && !await byTid(page, "board-off").count(), 10000)) fail(`${viewport}: the view of the deleted board stays after another thing was opened`);

  note(`${n} changes made on Studio Mac from elsewhere, each shown without a reload and without a call of the page; nothing deleted left a row; an open chat and board said that they are no longer there`);
}, { viewports, page: false });

/** The phone's half: each change read on Studio Mac's Home or its group's screen (see the head of the file). */
async function onPhone({ url, viewport, open, fail, note }) {
  const { page } = await open({ wait: '[data-testid="home"]' });
  const calls = callsOf(page);
  const far = async (method, path, body) => {
    const r = await mockEval(`return await elsewhere("${STUDIO}", ${J(method)}, ${J(path)}, ${body === undefined ? "undefined" : J(body)});`, url);
    if (r.status !== 200) fail(`the mock answered ${method} ${path} with ${r.status}: ${J(r.body)}`);
    return r.body;
  };
  /** Studio Mac's Home (`group` null) or the screen of its top-level group `group` (its id there), on screen. */
  const at = async (group) => {
    await showHome(page, STUDIO);
    if (!group) return null;
    const key = `${STUDIO}~${group}`;
    await byTid(page, "home-row", { kind: "group", key }).first().waitFor({ state: "visible", timeout: 10000 });
    await press(page, byTid(page, "home-row", { kind: "group", key }).first());
    await byTid(page, "group-screen", { key }).last().waitFor({ state: "visible", timeout: 10000 });
    return key;
  };
  let n = 0;
  const shows = async (name, group, { has = [], hasNot = [], rows } = {}) => {
    n++;
    const key = await at(group);
    const ok = (s) => has.every((l) => s.outline.includes(l)) && hasNot.every((l) => !s.outline.includes(l)) && (!rows || rows(s.rows));
    if (!await until(async () => ok(await homeOf(page, key)), 10000)) fail(`${name}: ${group ?? "Studio Mac's Home"} does not show it: ${J((await homeOf(page, key)).outline)}`);
  };
  /** Settings › Archived, opened and read (the phone has no "Show archived": archived things are only listed there); `want` names that must / must not be listed. */
  const inArchived = async (name, { has = [], hasNot = [] }) => {
    n++;
    await showHome(page, STUDIO);
    await openFoot(page, "side-archived");
    const ok = async () => { const l = await archivedNames(page); return has.every((x) => l.includes(x)) && hasNot.every((x) => !l.includes(x)); };
    if (!await until(ok, 10000)) fail(`${name}: Settings › Archived lists ${J(await archivedNames(page))}, wanted ${J(has)} and not ${J(hasNot)}`);
  };
  const sub = (name) => (rows) => rows.find((r) => r.name === name)?.sub ?? "";
  await showHome(page, STUDIO);
  if (!await until(async () => (await homeOf(page)).rows.length, 15000)) fail("Studio Mac's Home has no row");
  await page.evaluate(() => { window.__loaded = 1; });
  const writes0 = calls.filter((c) => c.method !== "GET").length;

  // ---- made elsewhere
  const chat = await far("POST", "/chats", { group: "g_old" });
  await shows("a chat made in a group", "g_old", { has: ["chat New chat"] });
  await far("PATCH", `/chats/${chat.id}`, { name: "Take 15" });
  await shows("that chat named", "g_old", { has: ["chat Take 15"], hasNot: ["chat New chat"] });
  await far("POST", "/boards", { group: "g_shop", name: "Shot list" });
  await shows("a board made in a group", "g_shop", { has: ["board Shot list"] });
  const dailies = await far("POST", "/groups", { name: "Dailies" });
  await shows("a group made", null, { has: ["group Dailies"] });
  await far("POST", "/groups", { name: "Monday", parent: dailies.id });
  await shows("a group made in a group", dailies.id, { has: ["group Monday"] });
  const onBoard = await far("POST", "/chats", { board: "b_arch" });
  await far("PATCH", `/chats/${onBoard.id}`, { name: "Cut scene nine" });
  await shows("a chat made on a board", "g_shop", { rows: (r) => /2 chats/.test(sub("Storyboard")(r)) });

  // ---- renamed elsewhere
  await far("PATCH", "/chats/c_take", { name: "Take 14b" });
  await shows("a chat renamed", "g_old", { has: ["chat Take 14b"], hasNot: ["chat Take 14"] });
  await far("POST", "/boards/b_arch/rename", { name: "Storyboard B" });
  await shows("a board renamed", "g_shop", { has: ["board Storyboard B"], hasNot: ["board Storyboard"] });
  await far("PATCH", "/groups/g_old", { name: "Older takes" });
  await shows("a group renamed", null, { has: ["group Older takes"], hasNot: ["group Old takes"] });

  // ---- moved elsewhere
  await far("PATCH", "/chats/c_take", { group: "g_shop" });
  await shows("a chat moved to another group", "g_shop", { has: ["chat Take 14b"] });
  await shows("a chat moved out of its group", "g_old", { hasNot: ["chat Take 14b"] });
  await far("PATCH", "/boards/b_arch", { group: LOOSE });
  await shows("a board moved out of its group", null, { has: ["board Storyboard B"] });
  await far("POST", "/groups/g_sub/move", { parent: "" });
  await shows("a group moved to the top level", null, { has: ["group Nightly"] });
  // that server's order of its groups is Home's
  const order = async () => (await homeOf(page)).outline.filter((l) => l.startsWith("group "));
  await at(null);
  const was = await order();
  await mockEval(`onServer("${STUDIO}", () => { groups.reverse(); send({ type: "groups", groups }); });`, url);
  if (!await until(async () => J(await order()) === J([...was].reverse()), 10000)) fail(`the groups turned round on Studio Mac, Home has ${J(await order())}, before ${J(was)}`);
  n++;

  // ---- archived and unarchived elsewhere
  // (gone from Home, listed in Settings › Archived; back on Home, gone from Archived)
  for (const [what, path, group, line, name] of [["a chat", "/chats/c_take", "g_shop", "chat Take 14b", "Take 14b"], ["a board", "/boards/b_arch", null, "board Storyboard B", "Storyboard B"], ["a group", "/groups/g_old", null, "group Older takes", "Older takes"]]) {
    await far("POST", `${path}/archive`);
    await shows(`${what} archived`, group, { hasNot: [line] });
    await inArchived(`${what} archived`, { has: [name] });
    await far("POST", `${path}/unarchive`);
    await shows(`${what} unarchived`, group, { has: [line] });
    await inArchived(`${what} unarchived`, { hasNot: [name] });
  }

  // ---- deleted elsewhere: no row stays
  await far("DELETE", "/chats/c_take"); await shows("a chat deleted", "g_shop", { hasNot: ["chat Take 14b"] });
  await far("DELETE", "/boards/b_arch"); await shows("a board deleted", null, { hasNot: ["board Storyboard B"] });
  await far("DELETE", "/groups/g_old?contents=delete"); await shows("a group deleted with what is in it", null, { hasNot: ["group Older takes"] });
  await far("DELETE", `/groups/${dailies.id}?contents=keep`); await shows("a group deleted, its contents kept", null, { has: ["group Monday"], hasNot: ["group Dailies"] });

  await inArchived("everything deleted", { hasNot: ["Take 14b", "Storyboard B", "Older takes", "Take 15", "Dailies"] });

  // ---- the page did all of that by following: no call that changes something, and no reload
  const own = calls.filter((c) => c.method !== "GET").slice(writes0);
  if (own.length) fail(`the page made calls of its own meanwhile: ${J(own.map((c) => `${c.method} ${c.path}`))}`);
  if (!await page.evaluate(() => window.__loaded === 1)) fail("the page was loaded anew");

  // ---- open, and deleted elsewhere: the view stays and says so
  await openChat(page, `${STUDIO}~c_plain`);
  await threadShown(page);
  await far("DELETE", "/chats/c_plain");
  // (the phone has no top banner (T3, goal 3.1): a chat that is gone from a server that is connected is shown as it was, so its header gives the place line,
  // not "offline" (X2's headline `gone`), and the composer's block, V1's `composer-block` of kind "gone", takes the toolbar's place and says it. As SEC.7-drop and
  // AAC.2-localdown, the block's lines fail until V1 is merged; goal 4.10)
  if (!await until(async () => !!await composerBlock(page), 5000)) fail(`${viewport}: the open chat deleted elsewhere does not say so: the composer has no block (V1's, not merged yet)`);
  else {
    const blk = await composerBlock(page);
    if (blk.kind !== "gone" || blk.text !== "This chat is no longer on Studio Mac.") fail(`${viewport}: the open chat deleted elsewhere: the composer's block is ${J(blk)}, not the gone line "This chat is no longer on Studio Mac."`);
    if (blk.servers || await byTid(page, "block-servers").count()) fail(`${viewport}: the block of a chat that is no longer on its server offers "Servers"`);
  }
  if (await byTid(page, "remote-bar").count()) fail(`${viewport}: the phone draws a top banner (remote-bar) for a chat that is no longer on its server`);
  const place = await headSub(page);
  if (!place || place.includes("offline")) fail(`${viewport}: the header of a chat that is gone from a connected server says "${place}", not its place line`);
  if (!(await messages(page)).some((m) => m.role === "user")) fail(`${viewport}: the open chat's thread went with the chat`);
  if (!await sendIsOff(page)) fail(`${viewport}: Send is on for a chat that is no longer on its server`);
  await shows("the open chat deleted elsewhere", null, { hasNot: ["chat Render queue is stuck"] });

  await openBoard(page, `${STUDIO}~b_loose`);
  await byTid(page, "board-canvas", { state: "ready" }).first().waitFor({ state: "attached", timeout: 15000 });
  await far("DELETE", "/boards/b_loose");
  if (!await says(page, "board-off", "No longer on Studio Mac")) fail(`${viewport}: the open board deleted elsewhere does not say so: "${await textOf(page, "board-off")}"`);
  await shows("the open board deleted elsewhere", null, { hasNot: ["board Floor plan"] });
  // left, it is gone for good: a chat of this computer is opened, and nothing of the board is on screen
  await showHome(page, "local");
  await press(page, byTid(page, "home-row", { kind: "group", key: "g_shop" }).first());
  const first = await byTid(byTid(page, "group-screen", { key: "g_shop" }).last(), "home-row", { kind: "chat" }).first().getAttribute("data-key");
  await openChat(page, first);
  if (!await until(async () => (await page.evaluate(() => JSON.parse(localStorage.getItem("aiwb.sel") ?? "{}"))).board !== `${STUDIO}~b_loose` && !await byTid(page, "board-off").count(), 10000)) fail(`${viewport}: the view of the deleted board stays after another thing was opened`);

  note(`${n} changes made on Studio Mac from elsewhere, each shown on its Home or group screen without a reload and without a call of the page; an open chat and board said that they are no longer there`);
}
