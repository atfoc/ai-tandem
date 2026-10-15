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
import { callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { byTid, openBoard, openChat, press, showList } from "./sel.mjs";
import { rowNamed, section, sideSeen } from "./side.mjs";
import { messages, says, textOf, threadShown } from "./chat.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const J = JSON.stringify;
const STUDIO = "s_studio", LOOSE = "__ungrouped__";

await check("SEC.6 a section follows what is made, changed and deleted on its server from elsewhere", async ({ url, viewport, open, fail, note }) => {
  await seed(url, "SEC");
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
