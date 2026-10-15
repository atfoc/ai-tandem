// Proves how things of a section are changed (plans/remote-server-sections-goal.md, 3.5): a rename, an archive, an
// unarchive and a delete of a chat, a board and a group of a section go to that server (the call's server is the
// entry id, and its path has that server's own ids), and the question before a delete names the server; a row and a
// group are moved between the groups of their own section by a drag; a drag from one section into another, from a
// section into the local part and from the local part into a section lights nothing and makes no call, for a row and
// for a group; and a board's "Move to…" lists the groups of its own section and nothing else.
// The seed's board and group with the ids of local things (b_arch, g_shop) are the ones changed:
// the local things with those ids stay as they are.
// Ports dev/checks/SEC.5-change.mjs (S1) to the new build, at the three viewports (A-SB-14, A-SB-18, A-SB-19, A-SB-25, A-SB-26, A-SB-28, A-SB-30,
// A-SB-39, A-SB-40, A-DD-05, A-DL-01, A-DL-03). The drags (the ones across servers that light nothing and make no call, and the ones inside a
// section that are asked of that server) are the drag's (S2), with the drag of the viewport (a mouse presses and moves, a finger is held
// first); the section is where the drags leave it in the old check (the chat "Take 14" is ungrouped by then).
// Besides the old check (A-DD-12, whose proof was the old page's Sidebar test): a section group's rename and move are shown before the answer, a refused one is
// put back with the sentence of the refusal, and one refused after that server told its groups leaves its word (the calls are held and refused with page.route).
import { callMatcher, callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { byTid, press, showList } from "./sel.mjs";
import { dragReader } from "./drag.mjs";
import { groupHead, rowNamed, section, sideMenu, sideSeen } from "./side.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const J = JSON.stringify;
const STUDIO = "s_studio";

await check("SEC.5 changes in a section go to its server; nothing is dropped across servers", async ({ url, open, fail, note }) => {
  await seed(url, "SEC");
  // another section with a group, a second local group, and the long local group closed: the targets of the drops
  await mockEval(`onServer("s_empty", () => { groups.push({ id: "g_theirs", name: "Their group" }); chats.c_theirs = chat("c_theirs", { name: "Their chat", group: "g_theirs" }); items.c_theirs = []; });
    groups.find((g) => g.id === "g_shop").collapsed = true; groups.push({ id: "g_second", name: "Second local" }); chats.c_second = chat("c_second", { name: "Local chat", group: "g_second" }); items.c_second = [];
    chats.c_loose = chat("c_loose", { name: "Loose chat", group: UNGROUPED }); items.c_loose = [];`, url);
  const { page } = await open({ wait: '[data-testid="side-tree"]' });
  const calls = callsOf(page);
  const writes = () => calls.filter((c) => c.method !== "GET");
  const sec = section(page, STUDIO);
  const row = (name) => rowNamed(page, name, sec);
  const gHead = (name) => groupHead(page, name, sec);
  const outline = async () => (await sideSeen(page, STUDIO)).outline;
  const has = async (name, line, want = true) => { if (!await until(async () => (await outline()).includes(line) === want, 10000)) fail(`${name}: the section ${want ? "has no" : "still has the"} row "${line}": ${J(await outline())}`); };
  const there = (code) => mockEval(`return onServer("${STUDIO}", () => { ${code} });`, url);
  /** One change: what is done, and the one call it must make (method, path, and the body's fields named). */
  let made = 0, crossed = 0;
  const change = async (name, act, method, path, body = {}) => {
    const n = writes().length;
    await act();
    if (!await until(() => writes().length > n && writes().slice(n).every((c) => c.status !== undefined), 10000)) return fail(`${name}: no call was made`);
    const got = writes().slice(n);
    if (got.length !== 1 || got[0].server !== STUDIO || got[0].method !== method || got[0].path !== path) return fail(`${name}: the calls were ${J(got.map((c) => `${c.server} ${c.method} ${c.path}`))}, not ${STUDIO} ${method} ${path}`);
    for (const [k, v] of Object.entries(body)) if (J(got[0].body?.[k]) !== J(v)) fail(`${name}: the body has ${k} ${J(got[0].body?.[k])}, not ${J(v)}: ${J(got[0].body)}`);
    if (got[0].body && typeof got[0].body === "object" && ("collapsed" in got[0].body || "server" in got[0].body)) fail(`${name}: the body carries ${J(got[0].body)}`);
    if (got[0].status !== 200) fail(`${name}: answered ${got[0].status}`);
    made++;
  };
  const rename = (root, to) => async () => { await sideMenu(page, root, "More", "Rename"); const box = byTid(sec, "name-input"); await box.fill(to); await box.press("Enter"); };
  const pick = (root, ...items) => () => sideMenu(page, root, "More", ...items);
  /** A delete: the menu's item, the question (which must name the server), and the button that answers it. */
  const del = (root, button = "Delete") => async () => {
    await sideMenu(page, root, "More", "Delete");
    const dialog = byTid(page, "confirm-dialog");
    await dialog.waitFor({ timeout: 10000 });
    if (!(await dialog.textContent()).includes("Studio Mac")) fail(`the question before a delete in the section does not name the server: "${await dialog.textContent()}"`);
    await press(page, dialog.getByText(button, { exact: true }).first());
  };
  await byTid(sec, "side-row").first().waitFor({ state: "attached", timeout: 15000 });
  await showList(page);
  const local0 = await mockEval("return JSON.stringify([groups, Object.values(boards), Object.values(chats).map((c) => [c.id, c.name, c.group, c.archived])]);", url);

  const d = await dragReader(page);
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
  crossed = 15;

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
  await within("a chat into another group of its section", () => d.row("Take 14"), () => d.head("Renders", 0.3, 0.8), "group(Renders).drop [VISIBLE]", "PATCH", `/api/chats/c_take`, { group: "g_shop" }, async () => await d.groupOf("Take 14") === "Renders");
  await within("a chat out of its group, to the section's ungrouped rows", () => d.row("Take 14"), () => d.row("Scratch"), "loose.drop [VISIBLE]", "PATCH", `/api/chats/c_take`, { group: "__ungrouped__" }, async () => await d.groupOf("Take 14") === "");
  await within("a board into another group of its section", () => d.row("Storyboard"), () => d.head("Old takes", 0.3, 0.8), "group(Old takes).drop [VISIBLE]", "PATCH", `/api/boards/b_arch`, { group: "g_old" }, async () => await d.groupOf("Storyboard") === "Old takes");
  await within("a group into another group of its section", () => d.head("Old takes"), () => d.head("Renders", 0.3, 0.8), "group(Renders).drop [VISIBLE]", "POST", `/api/groups/g_old/move`, { parent: "g_shop" }, async () => await d.parentOf("Old takes") === "Renders");
  await within("a group back to the top level of its section", () => d.head("Old takes"), () => d.row("Scratch"), "loose.drop [VISIBLE]", "POST", `/api/groups/g_old/move`, { parent: "" }, async () => await d.parentOf("Old takes") === "");
  if (J(await there("return [chats.c_take.group, boards.b_arch.group, groups.find((g) => g.id === 'g_old').parent ?? ''];")) !== J(["__ungrouped__", "g_old", ""])) fail(`Studio Mac does not have the moves: ${J(await there("return [chats.c_take.group, boards.b_arch.group, groups.find((g) => g.id === 'g_old').parent ?? ''];"))}`);

  // ---- a board's "Move to…": the groups of its own section, and nothing else
  const targets = async (root) => {
    await sideMenu(page, root, "More", "Move to…");
    const labels = (await byTid(page, "menu").last().locator('[data-testid="menu-item"]').allTextContents()).map((t) => t.trim());
    await page.keyboard.press("Escape");
    if (!await until(async () => !await byTid(page, "menu").count(), 3000)) await press(page, byTid(page, "overlay-backdrop").last()); // (a menu that Esc does not close is closed by a press elsewhere)
    return labels;
  };
  const offered = await targets(row("Floor plan"));
  if (J(offered) !== J(["Renders", "Renders / Nightly", "Old takes"])) fail(`"Move to…" of a board of the section offers ${J(offered)}, not that section's groups`);
  await change("a board moved by its menu", pick(row("Floor plan"), "Move to…", "Old takes"), "PATCH", `/api/boards/b_loose`, { group: "g_old" });
  await has("a board moved by its menu", "  board Floor plan");
  const offeredNow = await targets(row("Floor plan"));
  if (J(offeredNow) !== J(["Ungrouped", "Renders", "Renders / Nightly"])) fail(`"Move to…" of a board in a group of the section offers ${J(offeredNow)}`);
  // (a local board has no "Move to…": its menu is the one it had)
  const localBoard = rowNamed(page, "arch", section(page, "local"));
  await sideMenu(page, localBoard, "More").catch(() => {});
  const localMenu = (await byTid(page, "menu").last().locator('[data-testid="menu-item"]').allTextContents()).map((t) => t.trim());
  await page.keyboard.press("Escape"); if (!await until(async () => !await byTid(page, "menu").count(), 3000)) await press(page, byTid(page, "overlay-backdrop").last());
  if (localMenu.some((t) => /Studio Mac|Renders|Old takes|Their group/.test(t)) || !localMenu.includes("Reveal in Finder")) fail(`the menu of a local board is ${J(localMenu)}`);

  // ---- rename, archive, unarchive, delete: a chat, a board, a group
  await press(page, byTid(page, "side-archived").first()); // (Show archived: an archived row stays, with its menu)
  await change("a chat renamed", rename(row("Take 14"), "Take 15"), "PATCH", `/api/chats/c_take`, { name: "Take 15" });
  await has("a chat renamed", `chat Take 15`);
  await change("a chat archived", pick(row("Take 15"), "Archive"), "POST", `/api/chats/c_take/archive`);
  await has("a chat archived", `chat Take 15 [archived]`);
  await change("a chat unarchived", pick(row("Take 15"), "Unarchive"), "POST", `/api/chats/c_take/unarchive`);
  await has("a chat unarchived", `chat Take 15`);
  await change("a chat deleted", del(row("Take 15")), "DELETE", `/api/chats/c_take`);
  await has("a chat deleted", `chat Take 15`, false);

  await change("a board renamed", rename(row("Storyboard"), "Storyboard v2"), "POST", `/api/boards/b_arch/rename`, { name: "Storyboard v2" });
  await has("a board renamed", "  board Storyboard v2");
  await change("a board archived", pick(row("Storyboard v2"), "Archive"), "POST", `/api/boards/b_arch/archive`);
  await has("a board archived", "  board Storyboard v2 [archived]");
  await change("a board unarchived", pick(row("Storyboard v2"), "Unarchive"), "POST", `/api/boards/b_arch/unarchive`);
  await has("a board unarchived", "  board Storyboard v2");
  await change("a board deleted", del(row("Storyboard v2")), "DELETE", `/api/boards/b_arch`);
  await has("a board deleted", "  board Storyboard v2", false);
  await has("a board deleted, its chat", "    chat Tighten act two", false);

  await change("a group renamed", rename(gHead("Renders"), "Renders 2"), "PATCH", `/api/groups/g_shop`, { name: "Renders 2" });
  await has("a group renamed", "group Renders 2");
  await change("a group archived", pick(gHead("Old takes"), "Archive"), "POST", `/api/groups/g_old/archive`);
  await has("a group archived", "group Old takes [archived]");
  await change("a group unarchived", pick(gHead("Old takes"), "Unarchive"), "POST", `/api/groups/g_old/unarchive`);
  await has("a group unarchived", "group Old takes");
  await change("a group deleted, its contents kept", del(gHead("Nightly"), "Move contents to Renders 2"), "DELETE", `/api/groups/g_sub?contents=keep`);
  await has("a group deleted, its contents kept", "  group Nightly", false);
  await has("a group deleted, its contents kept: its chat", "  chat Last night's failures");
  await change("a group deleted with everything in it", del(gHead("Old takes"), "Delete everything in it"), "DELETE", `/api/groups/g_old?contents=delete`);
  await has("a group deleted with everything in it", "group Old takes", false);
  await has("a group deleted with everything in it: its board", "  board Floor plan", false);
  if (J(await there("return [Object.keys(chats).sort(), Object.keys(boards), groups.map((g) => [g.id, g.name])];")) !== J([["c_arch", "c_night", "c_note", "c_plain", "c_queue"], [], [["g_shop", "Renders 2"]]])) fail(`Studio Mac is left with ${J(await there("return [Object.keys(chats).sort(), Object.keys(boards), groups.map((g) => [g.id, g.name])];"))}`);


  // ---- A-DD-12: a rename or a move of a section's group shows at once, and is put back when that server refuses it (the old page's
  // Sidebar tests of it went with the page); unless that server told its groups meanwhile: then its word stands
  {
    const refusal = J({ error: "That name is taken here." });
    /** Holds the calls that `re` matches on Studio Mac until `release()`, and then refuses them. */
    const holding = (re) => {
      let release; const gate = new Promise((ok) => { release = ok; });
      const match = callMatcher(re, STUDIO), h = { held: 0, release: () => release(), off: () => page.unroute(match) };
      return page.route(match, async (route) => { h.held++; await gate; await route.fulfill({ status: 409, contentType: "application/json", body: refusal }); }).then(() => h);
    };
    const groupLines = async () => (await outline()).filter((l) => /^ *group /.test(l));
    const dismiss = async (name, title) => {
      const dialog = byTid(page, "confirm-dialog");
      if (!await until(() => dialog.count(), 10000)) return fail(`${name}: the refusal is not told (no "${title}")`);
      const said = await dialog.textContent();
      if (!said.includes(title) || !said.includes("That name is taken here.")) fail(`${name}: the refusal says "${said}", not "${title}" and the server's sentence`);
      await page.keyboard.press("Escape");
      if (!await until(async () => !await byTid(page, "confirm-dialog").count(), 5000)) await press(page, byTid(page, "overlay-backdrop").last());
    };
    const far = async (method, path, body) => {
      const r = await mockEval(`return await elsewhere("${STUDIO}", ${J(method)}, ${J(path)}, ${J(body)});`, url);
      if (r.status !== 200) fail(`the mock answered ${method} ${path} with ${r.status}: ${J(r.body)}`);
      return r.body;
    };
    const other = await far("POST", "/groups", { name: "Elsewhere" });
    await has("a group made elsewhere", "group Elsewhere");

    // a rename: shown before the answer, put back by the refusal
    let h = await holding(/^PATCH \/api\/groups\/g_shop$/);
    await rename(gHead("Renders 2"), "Refused name")();
    await has("a group renamed, the answer not here yet", "group Refused name");
    if (!await until(() => h.held === 1, 10000)) fail("the rename of the group made no call");
    h.release();
    await has("a group renamed and refused, put back", "group Renders 2");
    if ((await groupLines()).some((l) => l.includes("Refused name"))) fail(`the refused name stays: ${J(await groupLines())}`);
    await dismiss("a group renamed and refused", "Couldn't rename the group");
    await h.off();

    // a move: the group is nested at once, and out again by the refusal
    h = await holding(new RegExp(`^POST \\/api\\/groups\\/${other.id}\\/move$`));
    const d = await dragReader(page);
    if (!await d.start(await d.head("Elsewhere"))) fail("a group of the section did not start a drag");
    await d.over(await d.head("Renders 2", 0.3, 0.8));
    await d.drop();
    await has("a group moved, the answer not here yet", "  group Elsewhere");
    if (!await until(() => h.held === 1, 10000)) fail("the move of the group made no call");
    h.release();
    await has("a group moved and refused, put back", "group Elsewhere");
    if ((await groupLines()).some((l) => l === "  group Elsewhere")) fail(`the refused move stays: ${J(await groupLines())}`);
    await dismiss("a group moved and refused", "Couldn't move the group");
    await h.off();

    // refused after the server told its groups: its word stands (here a rename made elsewhere), not the list before the page's change
    h = await holding(/^PATCH \/api\/groups\/g_shop$/);
    await rename(gHead("Renders 2"), "Refused again")();
    await has("a group renamed, the answer not here yet (again)", "group Refused again");
    if (!await until(() => h.held === 1, 10000)) fail("the second rename of the group made no call");
    await far("PATCH", `/groups/${other.id}`, { name: "Elsewhere 2" });
    await has("a rename made elsewhere while one waits", "group Elsewhere 2");
    h.release();
    await dismiss("a group renamed and refused after the server told its groups", "Couldn't rename the group");
    await has("a refused rename after the server told its groups: the server's word", "group Elsewhere 2");
    await has("a refused rename after the server told its groups: the group is as the server has it", "group Renders 2");
    await h.off();
    await far("DELETE", `/groups/${other.id}?contents=keep`);
    await has("the group made elsewhere, deleted", "group Elsewhere 2", false);
  }

  // ---- nothing of all this reached this computer's own things, and no call was a local one
  const local1 = await mockEval("return JSON.stringify([groups.map((g) => ({ ...g, collapsed: g.id === 'g_shop' ? true : g.collapsed })), Object.values(boards), Object.values(chats).map((c) => [c.id, c.name, c.group, c.archived])]);", url);
  if (local1 !== local0) fail("this computer's own groups, boards or chats changed");
  const local = writes().filter((c) => c.server !== STUDIO);
  if (local.length) fail(`calls went elsewhere than /api/: ${J(local.map((c) => `${c.method} ${c.path}`))}`);

  note(`${made} changes of a chat, a board and a group, each one call under /api/; ${crossed} drags across servers lit nothing and made no call; "Move to…" offers the section's own groups`);
}, { viewports, page: false });
