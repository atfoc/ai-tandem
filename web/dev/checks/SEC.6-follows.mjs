// Proves that a section follows its server (plans/remote-server-sections-goal.md, 3.3 "A change made anywhere shows
// without a reload", 3.5 "Deleted elsewhere"): what the owner of that server or another client of it makes, renames,
// moves, archives, unarchives and deletes (a chat, a board, a run, a group) shows in the section as it happens, with
// no reload and no call of this page; a new group shows open; the groups keep that server's order; a chat's draft
// mark follows. What is deleted there leaves the section with no row left behind, greyed or not, also with "Show
// archived" on. A chat, a run and a board that are open when they are deleted there stay on screen, and their view
// says that they are no longer on that server.
// The changes are made in the mock by `elsewhere` (dev/runmock.mjs): that machine's own routes, called by nobody's
// page, whose events reach this page as that server's.
import { callsOf, check, mockEval, openPage, seed, sideSeen, until } from "../shot.mjs";

const J = JSON.stringify;
const STUDIO = "s_studio", LOOSE = "__ungrouped__";

await check("SEC.6 a section follows what is made, changed and deleted on its server from elsewhere", async ({ url, browser, fail, note }) => {
  await seed(url, "SEC");
  const { ctx, page, errors } = await openPage({ url, browser, size: [1280, 1500] });
  const calls = callsOf(page);
  const sec = `.side-section[data-server="${STUDIO}"]`;
  const row = (name) => page.locator(`${sec} .side-row:has(.side-name:text-is("${name}"))`);
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
  await page.waitForSelector(`${sec} .side-row`);
  await page.evaluate(() => { window.__loaded = 1; });
  const writes0 = calls.filter((c) => c.method !== "GET").length;

  // ---- made elsewhere
  const chat = await far("POST", "/chats", { group: "g_old" });
  await shows("a chat made in a group", { has: ["  chat New chat"] });
  await far("PATCH", `/chats/${chat.id}`, { name: "Take 15" });
  await shows("that chat named", { has: ["  chat Take 15"], hasNot: ["  chat New chat"], under: "group Old takes" });
  await far("POST", "/boards", { group: "g_shop", name: "Shot list" });
  await shows("a board made in a group", { has: ["  board Shot list"] });
  await far("POST", "/runs", { group: LOOSE, name: "Weekly review" });
  await shows("a run made outside any group", { has: ["run Weekly review"] });
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
  await far("PATCH", "/runs/r_draft", { name: "Nightly B" });
  await shows("a run renamed", { has: ["run Nightly B"], hasNot: ["run Nightly render"] });
  await far("PATCH", "/groups/g_old", { name: "Older takes" });
  await shows("a group renamed", { has: ["group Older takes"], hasNot: ["group Old takes"] });

  // ---- moved elsewhere
  await far("PATCH", "/chats/c_take", { group: "g_shop" });
  await shows("a chat moved to another group", { has: ["  chat Take 14b"] });
  if (!await until(async () => await page.evaluate(() => [...document.querySelectorAll(".side-row")].find((r) => r.querySelector(".side-name")?.textContent === "Take 14b")?.parentElement.closest(".side-group")?.querySelector(".side-group-name")?.textContent) === "Renders", 10000)) fail("the chat moved elsewhere is not in the group Renders");
  await far("PATCH", "/boards/b_arch", { group: LOOSE });
  await shows("a board moved out of its group", { has: ["board Storyboard B", "  chat Tighten act two"], hasNot: ["  board Storyboard B"] });
  await far("PATCH", "/runs/r_draft", { group: "g_old" });
  await shows("a run moved into a group", { has: ["  run Nightly B"], hasNot: ["run Nightly B"] });
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
  if (!await until(() => row("Last night's failures").locator(".draft-tag").count(), 10000)) fail("a draft saved elsewhere does not mark the chat's row");
  await far("PUT", "/chats/c_night/draft", { text: "" });
  if (!await until(async () => !await row("Last night's failures").locator(".draft-tag").count(), 10000)) fail("a draft removed elsewhere still marks the chat's row");
  n += 2;

  // ---- archived and unarchived elsewhere
  for (const [what, path, line, also] of [["a chat", "/chats/c_take", "  chat Take 14b"], ["a board", "/boards/b_arch", "board Storyboard B", "  chat Tighten act two"], ["a run", "/runs/r_draft", "  run Nightly B"], ["a group", "/groups/g_old", "group Older takes", "  chat Take 15"]]) {
    await far("POST", `${path}/archive`);
    await shows(`${what} archived`, { hasNot: [line, ...(also ? [also] : [])] });
    await far("POST", `${path}/unarchive`);
    await shows(`${what} unarchived`, { has: [line, ...(also ? [also] : [])] });
  }

  // ---- deleted elsewhere: no row stays, greyed or not, also with "Show archived" on
  await page.locator(".side input.switch").click();
  const gone = async (name, names) => {
    n++;
    const left = () => page.evaluate(([sel, names]) => [...document.querySelectorAll(`${sel} .side-row, ${sel} .side-group-head`)].filter((r) => names.includes((r.querySelector(".side-name, .side-group-name")?.textContent ?? ""))).map((r) => r.className), [sec, names]);
    if (!await until(async () => !(await left()).length, 10000)) fail(`${name}: a row stays in the section: ${J(await left())}`);
  };
  await far("DELETE", "/chats/c_take"); await gone("a chat deleted", ["Take 14b"]);
  await far("DELETE", "/boards/b_arch"); await gone("a board deleted, with its chats", ["Storyboard B", "Tighten act two", "Cut scene nine"]);
  await far("DELETE", "/runs/r_draft"); await gone("a run deleted", ["Nightly B"]);
  await far("DELETE", "/groups/g_old?contents=delete"); await gone("a group deleted with what is in it", ["Older takes", "Take 15"]);
  await far("DELETE", `/groups/${dailies.id}?contents=keep`); await gone("a group deleted, its contents kept", ["Dailies"]);
  await shows("the kept group of the deleted one", { has: ["group Monday"], hasNot: ["  group Monday"] });
  if (await page.locator(`${sec} .gone, ${sec} .side-row.grey, ${sec} [class*="gone"]`).count()) fail("the section has a row marked gone");
  await page.locator(".side input.switch").click();

  // ---- the page did all of that by following: no call that changes something, and no reload
  const own = calls.filter((c) => c.method !== "GET").slice(writes0);
  if (own.length) fail(`the page made calls of its own meanwhile: ${J(own.map((c) => `${c.method} ${c.path}`))}`);
  if (!await page.evaluate(() => window.__loaded === 1)) fail("the page was loaded anew");

  // ---- open, and deleted elsewhere: the view stays and says so
  await row("Render queue is stuck").click();
  await page.waitForSelector(".thread .msg.user", { timeout: 10000 });
  await far("DELETE", "/chats/c_plain");
  const bar = page.locator(".remote-bar.gone");
  if (!await until(async () => (await bar.textContent().catch(() => "")).includes("This chat is no longer on Studio Mac."), 10000)) fail(`the open chat deleted elsewhere does not say so: "${await bar.textContent().catch(() => "")}"`);
  await gone("the open chat deleted elsewhere", ["Render queue is stuck"]);
  if (!await page.locator(".thread .msg.user").count()) fail("the open chat's thread went with the chat");
  const send = page.locator(".composer .send:not(.stop)");
  if (await send.count() && !(await send.isDisabled())) fail("Send is on for a chat that is no longer on its server");
  if (await page.locator(".remote-bar.off").count()) fail("the chat that is gone there says that its server is not connected");

  await row("Trailer cut").click();
  await page.waitForSelector(".run-stage", { timeout: 10000 });
  // (the run's detail is on screen first: a run that goes before its detail was read has no view to keep, and says the same in the view's place)
  if (!await until(() => page.evaluate(() => /\d+\/\d+ turns/.test(document.querySelector(".run-stage")?.innerText ?? "")), 15000)) fail("the run view shows nothing of the run");
  await far("DELETE", "/runs/r_film");
  const runBar = page.locator(".remote-bar.run-remote-bar.gone");
  if (!await until(async () => (await runBar.textContent().catch(() => "")).includes("This run is no longer on Studio Mac."), 10000)) fail(`the open run deleted elsewhere does not say so: "${await runBar.textContent().catch(() => "")}"`);
  await gone("the open run deleted elsewhere", ["Trailer cut", "Which shots made it"]);

  await row("Floor plan").click();
  await page.waitForSelector(".excalidraw", { timeout: 15000 });
  await far("DELETE", "/boards/b_loose");
  const off = page.locator(".board-off");
  if (!await until(async () => (await off.textContent().catch(() => "")).includes("No longer on Studio Mac"), 10000)) fail(`the open board deleted elsewhere does not say so: "${await off.textContent().catch(() => "")}"`);
  await gone("the open board deleted elsewhere", ["Floor plan", "Label the rooms"]);
  // left, it is gone for good: the local part's first row is opened, and nothing of the board is on screen
  await page.locator(".side-tree > .side-loose .side-row").first().click();
  if (!await until(async () => !await off.count(), 10000)) fail("the view of the deleted board stays after another thing was opened");

  for (const e of errors) fail(`page error: ${e}`);
  await ctx.close();
  note(`${n} changes made on Studio Mac from elsewhere, each shown without a reload and without a call of the page; nothing deleted left a row; an open chat, run and board said that they are no longer there`);
});
