// Proves where a new thing is made (plans/remote-server-sections-goal.md, 3.1 "The + of the sidebar's head", 3.4):
// a chat, a whiteboard and a group from the "+" of a section's head are made on that server, outside any group,
// and from the "+" of a group inside the section in that group: the call goes to /api/on/<entry id>/… with the group's
// own id there, nothing asks where the thing should live, and the thing shows in the section and not in the local
// part. A chat on a board of a section is made on that server. The "+" of the sidebar's head makes things of this
// computer, also with servers in the list, and asks nothing. A make that server refuses shows the server's sentence
// and makes nothing, here or there.
// A group of the section has the id of a local group (g_shop): what is made in each stays in its own.
import { callsOf, check, mockEval, openPage, seed, sideMenu, sideSeen, until } from "../shot.mjs";

const J = JSON.stringify;
const STUDIO = "s_studio", ON = `/api/on/${STUDIO}`, LOOSE = "__ungrouped__";

await check("SEC.4 what is made in a section is made on that server; the sidebar's own + makes local things", async ({ url, browser, fail, note }) => {
  await seed(url, "SEC");
  const { ctx, page, errors } = await openPage({ url, browser, size: [1280, 1500] });
  const calls = callsOf(page);
  const sec = `.side-section[data-server="${STUDIO}"]`, head = page.locator(`${sec} > .side-section-head`);
  const groupHead = (name) => page.locator(`${sec} .side-group-head`, { has: page.locator(".side-group-name", { hasText: name }) });
  const posts = () => calls.filter((c) => c.method === "POST" && /\/(chats|boards|groups)$/.test(c.path));
  /** What the mock holds on a machine: the ids of its chats, boards and groups. */
  const held = (id) => mockEval(`return onServer(${J(id)}, () => ({ chats: Object.keys(chats), boards: Object.keys(boards), groups: groups.map((g) => g.id) }));`, url);
  const asked = async () => !!await page.locator("main.board-choice, .board-choice-box, .dialog[role=dialog]").count();
  await page.waitForSelector(`${sec} .side-row`);
  const local0 = await held("local"), localRows = (await sideSeen(page)).outline;

  /** One make from a "+": the menu's item, the call it must make, and where the new thing must be. kind: "chats" |
   *  "boards" | "groups"; want: the call's body, in part. Answers the id the server gave the thing. */
  const make = async (name, root, button, item, kind, want) => {
    const n = posts().length, before = await held(STUDIO);
    await sideMenu(page, root, button, item);
    if (!await until(() => posts().length === n + 1 && posts()[n].status !== undefined, 10000)) { fail(`${name}: ${posts().length - n} calls made a thing, not one: ${J(posts().slice(n).map((c) => `${c.method} ${c.path}`))}`); return ""; }
    const c = posts()[n];
    if (c.path !== `${ON}/${kind}`) fail(`${name}: the call went to ${c.path}, not ${ON}/${kind}`);
    for (const [k, v] of Object.entries(want)) if (J(c.body?.[k]) !== J(v)) fail(`${name}: the call's body has ${k} ${J(c.body?.[k])}, not ${J(v)}: ${J(c.body)}`);
    if (c.body && "server" in c.body) fail(`${name}: the call's body names a server: ${J(c.body)}`);
    if (c.status !== 200) fail(`${name}: the call was answered ${c.status}`);
    if (await asked()) fail(`${name}: the page asks something before or after the make`);
    const after = await held(STUDIO), made = after[kind].filter((x) => !before[kind].includes(x));
    if (made.length !== 1) fail(`${name}: Studio Mac has ${made.length} new ${kind} after it`);
    if (J(await held("local")) !== J(local0)) fail(`${name}: something was made on this computer`);
    // (a new board or group has its row in rename mode: Esc ends it, and the row says the name the server gave)
    if (kind !== "chats") { await page.locator(`${sec} input.name-input`).waitFor({ timeout: 10000 }).catch(() => fail(`${name}: the new row is not in rename mode in the section`)); await page.keyboard.press("Escape"); }
    return made[0] ?? "";
  };
  const placed = async (name, line) => { if (!await until(async () => (await sideSeen(page, STUDIO)).outline.includes(line), 10000)) fail(`${name}: the section has no row "${line}": ${J((await sideSeen(page, STUDIO)).outline)}`); };

  // ---- from the section's head: on that server, outside any group
  const NEW_HEAD = "New on Studio Mac";
  const chat = await make("a chat from the section's head", head, NEW_HEAD, "Chat", "chats", { group: LOOSE });
  await placed("a chat from the section's head", "chat New chat");
  if (!await until(async () => (await page.locator(".chat-head .chat-head-server").textContent().catch(() => "")) === "Studio Mac", 10000)) fail("the chat made from the section's head is not open as a chat of Studio Mac");
  if (await mockEval(`return onServer("${STUDIO}", () => chats[${J(chat)}]?.cwd);`, url) !== "/Users/studio/work") fail("the chat made on Studio Mac does not start in that server's default folder");
  await make("a whiteboard from the section's head", head, NEW_HEAD, "Whiteboard", "boards", { group: LOOSE });
  await placed("a whiteboard from the section's head", "board untitled");
  await make("a group from the section's head", head, NEW_HEAD, "Group", "groups", {});
  await placed("a group from the section's head", "group New group");
  if (calls.filter((c) => c.method === "POST" && c.path.endsWith("/groups")).at(-1)?.body?.parent) fail("a group made from the section's head names a parent");

  // ---- from a group of the section: in that group, by its own id there
  const OLD = "New in Old takes";
  await make("a chat from a group", groupHead("Old takes"), OLD, "Chat", "chats", { group: "g_old" });
  await placed("a chat from a group", "  chat New chat");
  await make("a whiteboard from a group", groupHead("Old takes"), OLD, "Whiteboard", "boards", { group: "g_old" });
  await placed("a whiteboard from a group", "  board untitled");
  await make("a group from a group", groupHead("Old takes"), OLD, "Group", "groups", { parent: "g_old" });
  await placed("a group from a group", "  group New group");
  // the section's group with the id of a local group: made there, and the local group has nothing new
  await make("a chat from the group that has a local group's id", groupHead("Renders"), "New in Renders", "Chat", "chats", { group: "g_shop" });
  if (J((await sideSeen(page)).outline) !== J(localRows)) fail(`a make in Studio Mac's group g_shop changed the local part: ${J((await sideSeen(page)).outline.filter((x) => !localRows.includes(x)))}`);
  // a chat on a board of the section
  await make("a chat on a board of the section", page.locator(`${sec} .side-row.is-board`, { has: page.locator(".side-name", { hasText: "Storyboard" }) }), "New chat on this board", undefined, "chats", { board: "b_arch" });

  // ---- a make that server refuses: its sentence, and nothing made
  const SAID = "Studio Mac has no agent this chat could use.";
  await mockEval(`flags.make = { server: "${STUDIO}", refuse: { status: 409, code: "no_agent", error: ${J(SAID)} } };`, url);
  for (const [item, kind] of [["Chat", "chats"], ["Whiteboard", "boards"], ["Group", "groups"]]) {
    const name = `a refused ${item.toLowerCase()}`, n = posts().length, before = await held(STUDIO), rows = (await sideSeen(page, STUDIO)).outline;
    await sideMenu(page, head, NEW_HEAD, item);
    const dialog = page.locator(".dialog[role=dialog]");
    if (!await until(async () => (await dialog.textContent().catch(() => "")).includes(SAID), 10000)) fail(`${name}: the page does not show the server's sentence: "${await dialog.textContent().catch(() => "")}"`);
    await until(() => posts()[n]?.status !== undefined, 5000); // (a call is heard of a moment after it was made)
    if (posts()[n]?.path !== `${ON}/${kind}` || posts()[n]?.status !== 409) fail(`${name}: the call was ${J(posts()[n])}`);
    await dialog.locator("button", { hasText: "Close" }).click();
    if (J(await held(STUDIO)) !== J(before) || J(await held("local")) !== J(local0)) fail(`${name}: something was made all the same`);
    if (J((await sideSeen(page, STUDIO)).outline) !== J(rows)) fail(`${name}: the section changed: ${J((await sideSeen(page, STUDIO)).outline.filter((x) => !rows.includes(x)))}`);
    if (await page.locator(`${sec} input.name-input`).count()) fail(`${name}: a row is in rename mode`);
  }
  await mockEval("delete flags.make;", url);

  // ---- the "+" of the sidebar's head: things of this computer, with servers in the list, and no question
  const studio0 = await held(STUDIO);
  for (const [item, kind, want] of [["New chat", "chats", { group: LOOSE }], ["New whiteboard", "boards", { group: LOOSE }], ["New group", "groups", {}]]) {
    const name = `the sidebar's + → ${item}`, n = posts().length, before = await held("local");
    await page.locator(".side-head button.new").click();
    await page.locator(".side-head .menu .menu-item", { hasText: item }).click();
    if (!await until(() => posts().length === n + 1 && posts()[n].status !== undefined, 10000)) { fail(`${name}: ${posts().length - n} calls made a thing`); continue; }
    const c = posts()[n];
    if (c.path !== `/api/${kind}` || c.status !== 200) fail(`${name}: the call was ${c.method} ${c.path}, answered ${c.status}`);
    for (const [k, v] of Object.entries(want)) if (J(c.body?.[k]) !== J(v)) fail(`${name}: the call's body has ${k} ${J(c.body?.[k])}, not ${J(v)}`);
    if (c.body && "server" in c.body) fail(`${name}: the call's body names a server: ${J(c.body)}`);
    if (await asked()) fail(`${name}: the page asks where the thing should live`);
    const after = await held("local");
    if (after[kind].length !== before[kind].length + 1) fail(`${name}: this computer has ${after[kind].length - before[kind].length} new ${kind}`);
    if (kind !== "chats") { await page.locator(".side-tree input.name-input").waitFor({ timeout: 10000 }).catch(() => fail(`${name}: the new row is not in rename mode`)); if (await page.locator(".side-section input.name-input").count()) fail(`${name}: the new row is in a section`); await page.keyboard.press("Escape"); }
  }
  if (J(await held(STUDIO)) !== J(studio0)) fail("the sidebar's own + made something on Studio Mac");

  for (const e of errors) fail(`page error: ${e}`);
  await ctx.close();
  note(`${posts().filter((c) => c.path.startsWith(ON) && c.status === 200).length} things made on Studio Mac by calls under ${ON}/, 3 refused with the server's sentence and nothing made, 3 made on this computer by the sidebar's own +; no question, no server in a body`);
});
