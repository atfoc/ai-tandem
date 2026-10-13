// Proves how things of a section are changed (plans/remote-server-sections-goal.md, 3.5): a rename, an archive, an
// unarchive and a delete of a chat, a board and a group of a section go to that server (the call is under
// /api/on/<entry id>/ with that server's own ids), and the question before a delete names the server; a row and a
// group are moved between the groups of their own section by a drag; a drag from one section into another, from a
// section into the local part and from the local part into a section lights nothing and makes no call, for a row and
// for a group; and a board's "Move to…" lists the groups of its own section and nothing else.
// The seed's board and group with the ids of local things (b_arch, g_shop) are the ones changed:
// the local things with those ids stay as they are.
import { callsOf, check, dragger, mockEval, openPage, seed, sideMenu, sideSeen, until } from "../shot.mjs";

const J = JSON.stringify;
const STUDIO = "s_studio", ON = `/api/on/${STUDIO}`;

await check("SEC.5 changes in a section go to its server; nothing is dropped across servers", async ({ url, browser, fail, note }) => {
  await seed(url, "SEC");
  // another section with a group, a second local group, and the long local group closed: the targets of the drops
  await mockEval(`onServer("s_empty", () => { groups.push({ id: "g_theirs", name: "Their group" }); chats.c_theirs = chat("c_theirs", { name: "Their chat", group: "g_theirs" }); items.c_theirs = []; });
    groups.find((g) => g.id === "g_shop").collapsed = true; groups.push({ id: "g_second", name: "Second local" }); chats.c_second = chat("c_second", { name: "Local chat", group: "g_second" }); items.c_second = [];
    chats.c_loose = chat("c_loose", { name: "Loose chat", group: UNGROUPED }); items.c_loose = [];`, url);
  const { ctx, page, errors } = await openPage({ url, browser, size: [1280, 1500] });
  const calls = callsOf(page), d = await dragger(page);
  const writes = () => calls.filter((c) => c.method !== "GET");
  const sec = `.side-section[data-server="${STUDIO}"]`;
  const row = (name) => page.locator(`${sec} .side-row:has(.side-name:text-is("${name}"))`);
  const groupHead = (name) => page.locator(`${sec} .side-group-head:has(.side-group-name:text-is("${name}"))`);
  const outline = async () => (await sideSeen(page, STUDIO)).outline;
  const has = async (name, line, want = true) => { if (!await until(async () => (await outline()).includes(line) === want, 10000)) fail(`${name}: the section ${want ? "has no" : "still has the"} row "${line}": ${J(await outline())}`); };
  const there = (code) => mockEval(`return onServer("${STUDIO}", () => { ${code} });`, url);
  /** One change: what is done, and the one call it must make (method, path, and the body's fields named). */
  let made = 0;
  const change = async (name, act, method, path, body = {}) => {
    const n = writes().length;
    await act();
    if (!await until(() => writes().length > n && writes().slice(n).every((c) => c.status !== undefined), 10000)) return fail(`${name}: no call was made`);
    const got = writes().slice(n);
    if (got.length !== 1 || got[0].method !== method || got[0].path !== path) return fail(`${name}: the calls were ${J(got.map((c) => `${c.method} ${c.path}`))}, not ${method} ${path}`);
    for (const [k, v] of Object.entries(body)) if (J(got[0].body?.[k]) !== J(v)) fail(`${name}: the body has ${k} ${J(got[0].body?.[k])}, not ${J(v)}: ${J(got[0].body)}`);
    if (got[0].body && typeof got[0].body === "object" && ("collapsed" in got[0].body || "server" in got[0].body)) fail(`${name}: the body carries ${J(got[0].body)}`);
    if (got[0].status !== 200) fail(`${name}: answered ${got[0].status}`);
    made++;
  };
  const rename = (root, to) => async () => { await sideMenu(page, root, "More", "Rename"); const box = page.locator(`${sec} input.name-input`); await box.fill(to); await box.press("Enter"); };
  const pick = (root, ...items) => () => sideMenu(page, root, "More", ...items);
  /** A delete: the menu's item, the question (which must name the server), and the button that answers it. */
  const del = (root, button = "Delete") => async () => {
    await sideMenu(page, root, "More", "Delete");
    const dialog = page.locator(".dialog[role=dialog]");
    await dialog.waitFor({ timeout: 10000 });
    if (!(await dialog.textContent()).includes("Studio Mac")) fail(`the question before a delete in the section does not name the server: "${await dialog.textContent()}"`);
    await dialog.locator("button", { hasText: button }).click();
  };
  await page.waitForSelector(`${sec} .side-row`);
  const local0 = await mockEval("return JSON.stringify([groups, Object.values(boards), Object.values(chats).map((c) => [c.id, c.name, c.group, c.archived])]);", url);

  // ---- drags across servers: nothing lit, no call, nothing moved
  const places = async () => J([await d.groupOf("Take 14"), await d.groupOf("Loose chat"), await d.groupOf("Their chat"), await d.parentOf("Old takes"), await d.parentOf("Second local"), await d.parentOf("Their group")]);
  const places0 = await places();
  const across = async (name, from, to) => {
    const n = writes().length;
    if (!await d.start(await from())) return fail(`${name}: the drag did not start`);
    await d.over(await to());
    const lit = await d.lit();
    if (lit.length) fail(`${name}: lights ${J(lit)}`);
    await d.drop();
    if (writes().length !== n) fail(`${name}: made the calls ${J(writes().slice(n).map((c) => `${c.method} ${c.path} ${J(c.body)}`))}`);
    if (await places() !== places0) fail(`${name}: something moved: ${await places()}, before ${places0}`);
    if ((await d.lit()).length) fail(`${name}: something stays lit after the drop: ${J(await d.lit())}`);
  };
  await across("a chat of the section onto a local group", () => d.row("Take 14"), () => d.head("Second local", 0.3, 0.8));
  await across("a chat of the section onto the local part's ungrouped rows", () => d.row("Take 14"), () => d.row("Loose chat"));
  await across("a chat of the section onto a row of a local group", () => d.row("Take 14"), () => d.row("Local chat"));
  await across("a chat of the section onto a group of another section", () => d.row("Take 14"), () => d.head("Their group", 0.3, 0.8));
  await across("a chat of the section onto a row of another section", () => d.row("Take 14"), () => d.row("Their chat"));
  await across("a board of the section onto a local group", () => d.row("Storyboard"), () => d.head("Second local", 0.3, 0.8));
  await across("a local chat onto the section's ungrouped rows", () => d.row("Local chat"), () => d.row("Scratch"));
  await across("a local chat onto a group of the section", () => d.row("Local chat"), () => d.head("Old takes", 0.3, 0.8));
  await across("a group of the section into a local group", () => d.head("Old takes"), () => d.head("Second local", 0.3, 0.8));
  await across("a group of the section before a local group", () => d.head("Old takes"), () => d.head("Second local", 0.3, 0.2));
  await across("a group of the section into a group of another section", () => d.head("Old takes"), () => d.head("Their group", 0.3, 0.8));
  await across("a group of the section onto the local part's ungrouped rows", () => d.head("Old takes"), () => d.row("Loose chat"));
  await across("a local group into a group of the section", () => d.head("Second local"), () => d.head("Renders", 0.3, 0.8));
  await across("a local group before a group of the section", () => d.head("Second local"), () => d.head("Renders", 0.3, 0.2));
  await across("a local group onto the section's ungrouped rows", () => d.head("Second local"), () => d.row("Scratch"));
  const crossed = 15;

  // ---- drags inside the section: taken, lit, and asked of that server
  const within = async (name, from, to, lights, method, path, body, after) => {
    await change(name, async () => {
      if (!await d.start(await from())) return fail(`${name}: the drag did not start`);
      await d.over(await to());
      const lit = (await d.lit()).filter((x) => x.endsWith("[VISIBLE]"));
      if (J(lit) !== J([lights])) fail(`${name}: lights ${J(lit)}, not ${J([lights])}`);
      await d.drop();
    }, method, path, body);
    if (!await until(after, 10000)) fail(`${name}: the row is not where it was dropped: ${J(await outline())}`);
  };
  await within("a chat into another group of its section", () => d.row("Take 14"), () => d.head("Renders", 0.3, 0.8), "group(Renders).drop [VISIBLE]", "PATCH", `${ON}/chats/c_take`, { group: "g_shop" }, async () => await d.groupOf("Take 14") === "Renders");
  await within("a chat out of its group, to the section's ungrouped rows", () => d.row("Take 14"), () => d.row("Scratch"), "loose.drop [VISIBLE]", "PATCH", `${ON}/chats/c_take`, { group: "__ungrouped__" }, async () => await d.groupOf("Take 14") === "");
  await within("a board into another group of its section", () => d.row("Storyboard"), () => d.head("Old takes", 0.3, 0.8), "group(Old takes).drop [VISIBLE]", "PATCH", `${ON}/boards/b_arch`, { group: "g_old" }, async () => await d.groupOf("Storyboard") === "Old takes");
  await within("a group into another group of its section", () => d.head("Old takes"), () => d.head("Renders", 0.3, 0.8), "group(Renders).drop [VISIBLE]", "POST", `${ON}/groups/g_old/move`, { parent: "g_shop" }, async () => await d.parentOf("Old takes") === "Renders");
  await within("a group back to the top level of its section", () => d.head("Old takes"), () => d.row("Scratch"), "loose.drop [VISIBLE]", "POST", `${ON}/groups/g_old/move`, { parent: "" }, async () => await d.parentOf("Old takes") === "");
  if (J(await there("return [chats.c_take.group, boards.b_arch.group, groups.find((g) => g.id === 'g_old').parent ?? ''];")) !== J(["__ungrouped__", "g_old", ""])) fail(`Studio Mac does not have the moves: ${J(await there("return [chats.c_take.group, boards.b_arch.group, groups.find((g) => g.id === 'g_old').parent ?? ''];"))}`);

  // ---- a board's "Move to…": the groups of its own section, and nothing else
  const targets = async (root) => {
    await sideMenu(page, root, "More", "Move to…");
    const labels = await page.locator(".menu .menu-item .menu-label").allTextContents();
    await page.keyboard.press("Escape");
    if (await page.locator(".menu").count()) await page.mouse.click(900, 700); // (a menu that Esc does not close is closed by a press elsewhere)
    return labels;
  };
  const offered = await targets(row("Floor plan"));
  if (J(offered) !== J(["Renders", "Renders / Nightly", "Old takes"])) fail(`"Move to…" of a board of the section offers ${J(offered)}, not that section's groups`);
  await change("a board moved by its menu", pick(row("Floor plan"), "Move to…", "Old takes"), "PATCH", `${ON}/boards/b_loose`, { group: "g_old" });
  await has("a board moved by its menu", "  board Floor plan");
  const offeredNow = await targets(row("Floor plan"));
  if (J(offeredNow) !== J(["Ungrouped", "Renders", "Renders / Nightly"])) fail(`"Move to…" of a board in a group of the section offers ${J(offeredNow)}`);
  // (a local board has no "Move to…": its menu is the one it had)
  await page.locator(".side-tree > .side-group > .side-group-head:has(.side-group-name:text-is('Shop'))").click();
  const localBoard = page.locator('.side-tree > .side-group .side-row.is-board:has(.side-name:text-is("arch"))');
  await localBoard.hover(); await localBoard.locator('button[title="More"]').click();
  const localMenu = await page.locator(".menu .menu-item").allTextContents();
  await page.keyboard.press("Escape"); if (await page.locator(".menu").count()) await page.mouse.click(900, 700);
  if (localMenu.some((t) => /Studio Mac|Renders|Old takes|Their group/.test(t)) || !localMenu.includes("Reveal in Finder")) fail(`the menu of a local board is ${J(localMenu)}`);

  // ---- rename, archive, unarchive, delete: a chat, a board, a group
  await page.locator(".side input.switch").click(); // (Show archived: an archived row stays, with its menu)
  await change("a chat renamed", rename(row("Take 14"), "Take 15"), "PATCH", `${ON}/chats/c_take`, { name: "Take 15" });
  await has("a chat renamed", "chat Take 15");
  await change("a chat archived", pick(row("Take 15"), "Archive"), "POST", `${ON}/chats/c_take/archive`);
  await has("a chat archived", "chat Take 15 [archived]");
  await change("a chat unarchived", pick(row("Take 15"), "Unarchive"), "POST", `${ON}/chats/c_take/unarchive`);
  await has("a chat unarchived", "chat Take 15");
  await change("a chat deleted", del(row("Take 15")), "DELETE", `${ON}/chats/c_take`);
  await has("a chat deleted", "chat Take 15", false);

  await change("a board renamed", rename(row("Storyboard"), "Storyboard v2"), "POST", `${ON}/boards/b_arch/rename`, { name: "Storyboard v2" });
  await has("a board renamed", "  board Storyboard v2");
  await change("a board archived", pick(row("Storyboard v2"), "Archive"), "POST", `${ON}/boards/b_arch/archive`);
  await has("a board archived", "  board Storyboard v2 [archived]");
  await change("a board unarchived", pick(row("Storyboard v2"), "Unarchive"), "POST", `${ON}/boards/b_arch/unarchive`);
  await has("a board unarchived", "  board Storyboard v2");
  await change("a board deleted", del(row("Storyboard v2")), "DELETE", `${ON}/boards/b_arch`);
  await has("a board deleted", "  board Storyboard v2", false);
  await has("a board deleted, its chat", "    chat Tighten act two", false);

  await change("a group renamed", rename(groupHead("Renders"), "Renders 2"), "PATCH", `${ON}/groups/g_shop`, { name: "Renders 2" });
  await has("a group renamed", "group Renders 2");
  await change("a group archived", pick(groupHead("Old takes"), "Archive"), "POST", `${ON}/groups/g_old/archive`);
  await has("a group archived", "group Old takes [archived]");
  await change("a group unarchived", pick(groupHead("Old takes"), "Unarchive"), "POST", `${ON}/groups/g_old/unarchive`);
  await has("a group unarchived", "group Old takes");
  await change("a group deleted, its contents kept", del(groupHead("Nightly"), "Move contents to Renders 2"), "DELETE", `${ON}/groups/g_sub?contents=keep`);
  await has("a group deleted, its contents kept", "  group Nightly", false);
  await has("a group deleted, its contents kept: its chat", "  chat Last night's failures");
  await change("a group deleted with everything in it", del(groupHead("Old takes"), "Delete everything in it"), "DELETE", `${ON}/groups/g_old?contents=delete`);
  await has("a group deleted with everything in it", "group Old takes", false);
  await has("a group deleted with everything in it: its board", "  board Floor plan", false);
  if (J(await there("return [Object.keys(chats).sort(), Object.keys(boards), groups.map((g) => [g.id, g.name])];")) !== J([["c_arch", "c_night", "c_note", "c_plain", "c_queue"], [], [["g_shop", "Renders 2"]]])) fail(`Studio Mac is left with ${J(await there("return [Object.keys(chats).sort(), Object.keys(boards), groups.map((g) => [g.id, g.name])];"))}`);

  // ---- nothing of all this reached this computer's own things, and no call was a local one
  const local1 = await mockEval("return JSON.stringify([groups.map((g) => ({ ...g, collapsed: g.id === 'g_shop' ? true : g.collapsed })), Object.values(boards), Object.values(chats).map((c) => [c.id, c.name, c.group, c.archived])]);", url);
  if (local1 !== local0) fail("this computer's own groups, boards or chats changed");
  const local = writes().filter((c) => !c.path.startsWith(ON + "/") && !(c.method === "PATCH" && c.path === "/api/groups/g_shop")); // (the one local call: the local group Shop, opened for its board's menu)
  if (local.length) fail(`calls went elsewhere than ${ON}/: ${J(local.map((c) => `${c.method} ${c.path}`))}`);

  for (const e of errors) fail(`page error: ${e}`);
  await ctx.close();
  note(`${made} changes of a chat, a board and a group, each one call under ${ON}/; ${crossed} drags across servers lit nothing and made no call; "Move to…" offers the section's own groups`);
});
