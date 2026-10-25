// Proves where a new thing is made (plans/remote-server-sections-goal.md, 3.1 "The + of the sidebar's head", 3.4):
// a chat, a whiteboard and a group from the "+" of a section's head are made on that server, outside any group,
// and from the "+" of a group inside the section in that group: the call goes to that server (the call's `server` is the entry id) with the group's
// own id there, nothing asks where the thing should live, and the thing shows in the section and not in the local
// part. A chat on a board of a section is made on that server. The "+" of the sidebar's head makes things of this
// computer, also with servers in the list, and asks nothing. A make that server refuses shows the server's sentence
// and makes nothing, here or there.
// A group of the section has the id of a local group (g_shop): what is made in each stays in its own.
// Ports dev/checks/SEC.4-make.mjs (S1) to the new build, at the three viewports (A-SB-03, A-SB-31 to A-SB-34, A-SB-38, A-SC-13, A-SC-14, A-DL-01's
// make half). Deviations: the chat made is open "as a chat of Studio Mac" by the saved selection (its key names the entry), the header's own
// server name being S4's; on the phone a board made opens its screen over the list, so its row is in rename mode only where the list stays (a
// group's is, on every layout); the list is shown again before each make (`showList`).
// The phone (packages H1 and H2) makes things with "+ New" of Home and of a group's screen and the new sheet `home-new-sheet` (the Where card, the
// Chat and Whiteboard tiles, the Group row; plans/ux-improvements/h2-design.md §4). Its half (`onPhone` below): "+ New" on a server's Home makes on that server outside
// any group, on a group's screen in that group by its own id there (the section's group with a local group's id included), on this
// computer's Home things of this computer; nothing asks where; a refused make shows the server's sentence and makes nothing. A new group opens
// the Rename sheet (`rename-sheet`) at once: a name typed and saved there is the group's name on its server and the group is listed with it (the wide
// layouts' rename mode of the new row, `name-input`, is theirs). Change → the Where page: into a child level, Done (the choice as it was), "Put it in",
// and the chat made lands in the chosen group. Left to package B1: a chat made from a board's row (Home's rows have no "+"; the board's own Chats is B1's).
import { callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { newSheetSeen } from "./rows.mjs";
import { byTid, layoutNow, press, showHome, showList } from "./sel.mjs";
import { groupHead, homeOf, rowNamed, section, sectionHead, sideMenu, sideSeen } from "./side.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const J = JSON.stringify;
const STUDIO = "s_studio", LOOSE = "__ungrouped__";

await check("SEC.4 what is made in a section is made on that server; the sidebar's own + makes local things", async ({ url, open, fail, note, layout }) => {
  if (layout === "phone") return onPhone({ url, open, fail, note });
  await seed(url, "SEC");
  const { page } = await open({ wait: '[data-testid="side-tree"]' });
  const calls = callsOf(page);
  const sec = section(page, STUDIO), head = sectionHead(page, STUDIO);
  const gHead = (name) => groupHead(page, name, sec);
  const posts = () => calls.filter((c) => c.method === "POST" && /\/(chats|boards|groups)$/.test(c.path));
  /** What the mock holds on a machine: the ids of its chats, boards and groups. */
  const held = (id) => mockEval(`return onServer(${J(id)}, () => ({ chats: Object.keys(chats), boards: Object.keys(boards), groups: groups.map((g) => g.id) }));`, url);
  const asked = async () => !!await byTid(page, "confirm-dialog").count();
  const nameBox = (root) => byTid(root, "name-input");
  await byTid(sec, "side-row").first().waitFor({ state: "attached", timeout: 15000 });
  const local0 = await held("local"), localRows = (await sideSeen(page, "local")).outline;

  /** One make from a "+": the menu's item, the call it must make, and where the new thing must be. kind: "chats" |
   *  "boards" | "groups"; want: the call's body, in part. Answers the id the server gave the thing. */
  const make = async (name, root, button, item, kind, want) => {
    await showList(page);
    const n = posts().length, before = await held(STUDIO);
    await sideMenu(page, root, button, item);
    if (!await until(() => posts().length === n + 1 && posts()[n].status !== undefined, 10000)) { fail(`${name}: ${posts().length - n} calls made a thing, not one: ${J(posts().slice(n).map((c) => `${c.method} ${c.path}`))}`); return ""; }
    const c = posts()[n];
    if (c.server !== STUDIO || c.path !== `/api/${kind}`) fail(`${name}: the call went to ${c.server} ${c.path}, not ${STUDIO} /api/${kind}`);
    for (const [k, v] of Object.entries(want)) if (J(c.body?.[k]) !== J(v)) fail(`${name}: the call's body has ${k} ${J(c.body?.[k])}, not ${J(v)}: ${J(c.body)}`);
    if (c.body && "server" in c.body) fail(`${name}: the call's body names a server: ${J(c.body)}`);
    if (c.status !== 200) fail(`${name}: the call was answered ${c.status}`);
    if (await asked()) fail(`${name}: the page asks something before or after the make`);
    const after = await held(STUDIO), made = after[kind].filter((x) => !before[kind].includes(x));
    if (made.length !== 1) fail(`${name}: Studio Mac has ${made.length} new ${kind} after it`);
    if (J(await held("local")) !== J(local0)) fail(`${name}: something was made on this computer`);
    // (a new group has its row in rename mode, a new board too where the list stays on screen: Esc ends it, and the row says the name the server gave)
    if (kind === "groups" || (kind === "boards" && layoutNow(page) !== "phone")) { await nameBox(sec).waitFor({ timeout: 10000 }).catch(() => fail(`${name}: the new row is not in rename mode in the section`)); await page.keyboard.press("Escape"); }
    return made[0] ?? "";
  };
  const placed = async (name, line) => { if (!await until(async () => (await sideSeen(page, STUDIO)).outline.includes(line), 10000)) fail(`${name}: the section has no row "${line}": ${J((await sideSeen(page, STUDIO)).outline)}`); };
  const savedChat = () => page.evaluate(() => JSON.parse(localStorage.getItem("aiwb.sel") ?? "{}").chat ?? "");

  // ---- from the section's head: on that server, outside any group
  const NEW_HEAD = "New on Studio Mac";
  const chat = await make("a chat from the section's head", head, NEW_HEAD, "Chat", "chats", { group: LOOSE });
  await placed("a chat from the section's head", "chat New chat");
  if (!await until(async () => (await savedChat()) === `${STUDIO}~${chat}`, 10000)) fail(`the chat made from the section's head is not open as a chat of Studio Mac: the selection is "${await savedChat()}"`);
  if (await mockEval(`return onServer("${STUDIO}", () => chats[${J(chat)}]?.cwd);`, url) !== "/Users/studio/work") fail("the chat made on Studio Mac does not start in that server's default folder");
  await make("a whiteboard from the section's head", head, NEW_HEAD, "Whiteboard", "boards", { group: LOOSE });
  await placed("a whiteboard from the section's head", "board untitled");
  await make("a group from the section's head", head, NEW_HEAD, "Group", "groups", {});
  await placed("a group from the section's head", "group New group");
  if (calls.filter((c) => c.method === "POST" && c.path.endsWith("/groups")).at(-1)?.body?.parent) fail("a group made from the section's head names a parent");

  // ---- from a group of the section: in that group, by its own id there
  const OLD = "New in Old takes";
  await make("a chat from a group", gHead("Old takes"), OLD, "Chat", "chats", { group: "g_old" });
  await placed("a chat from a group", "  chat New chat");
  await make("a whiteboard from a group", gHead("Old takes"), OLD, "Whiteboard", "boards", { group: "g_old" });
  await placed("a whiteboard from a group", "  board untitled");
  await make("a group from a group", gHead("Old takes"), OLD, "Group", "groups", { parent: "g_old" });
  await placed("a group from a group", "  group New group");
  // the section's group with the id of a local group: made there, and the local group has nothing new
  await make("a chat from the group that has a local group's id", gHead("Renders"), "New in Renders", "Chat", "chats", { group: "g_shop" });
  if (J((await sideSeen(page, "local")).outline) !== J(localRows)) fail(`a make in Studio Mac's group g_shop changed the local part: ${J((await sideSeen(page, "local")).outline.filter((x) => !localRows.includes(x)))}`);
  // a chat on a board of the section
  await make("a chat on a board of the section", rowNamed(page, "Storyboard", sec), "New chat on this board", undefined, "chats", { board: "b_arch" });

  // ---- a make that server refuses: its sentence, and nothing made
  await showList(page);
  const SAID = "Studio Mac has no agent this chat could use.";
  await mockEval(`flags.make = { server: "${STUDIO}", refuse: { status: 409, code: "no_agent", error: ${J(SAID)} } };`, url);
  for (const [item, kind] of [["Chat", "chats"], ["Whiteboard", "boards"], ["Group", "groups"]]) {
    await showList(page);
    const name = `a refused ${item.toLowerCase()}`, n = posts().length, before = await held(STUDIO), rows = (await sideSeen(page, STUDIO)).outline;
    await sideMenu(page, head, NEW_HEAD, item);
    const dialog = byTid(page, "confirm-dialog");
    if (!await until(async () => (await dialog.textContent().catch(() => "")).includes(SAID), 10000)) fail(`${name}: the page does not show the server's sentence: "${await dialog.textContent().catch(() => "")}"`);
    await until(() => posts()[n]?.status !== undefined, 5000); // (a call is heard of a moment after it was made)
    if (posts()[n]?.server !== STUDIO || posts()[n]?.path !== `/api/${kind}` || posts()[n]?.status !== 409) fail(`${name}: the call was ${J(posts()[n])}`);
    await press(page, dialog.getByText("Close", { exact: true }).first());
    if (!await until(async () => !await dialog.count(), 10000)) fail(`${name}: Close did not close the dialog`);
    if (J(await held(STUDIO)) !== J(before) || J(await held("local")) !== J(local0)) fail(`${name}: something was made all the same`);
    if (J((await sideSeen(page, STUDIO)).outline) !== J(rows)) fail(`${name}: the section changed: ${J((await sideSeen(page, STUDIO)).outline.filter((x) => !rows.includes(x)))}`);
    if (await nameBox(sec).count()) fail(`${name}: a row is in rename mode`);
  }
  await mockEval("delete flags.make;", url);

  // ---- the "+" of the sidebar's head: things of this computer, with servers in the list, and no question
  const studio0 = await held(STUDIO);
  for (const [item, kind, want] of [["New chat", "chats", { group: LOOSE }], ["New whiteboard", "boards", { group: LOOSE }], ["New group", "groups", {}]]) {
    await showList(page);
    const name = `the sidebar's + → ${item}`, n = posts().length, before = await held("local");
    await sideMenu(page, byTid(page, "side-head").first(), "New…", item);
    if (!await until(() => posts().length === n + 1 && posts()[n].status !== undefined, 10000)) { fail(`${name}: ${posts().length - n} calls made a thing`); continue; }
    const c = posts()[n];
    if (c.server !== "local" || c.path !== `/api/${kind}` || c.status !== 200) fail(`${name}: the call was ${c.method} ${c.path}, answered ${c.status}`);
    for (const [k, v] of Object.entries(want)) if (J(c.body?.[k]) !== J(v)) fail(`${name}: the call's body has ${k} ${J(c.body?.[k])}, not ${J(v)}`);
    if (c.body && "server" in c.body) fail(`${name}: the call's body names a server: ${J(c.body)}`);
    if (await asked()) fail(`${name}: the page asks where the thing should live`);
    const after = await held("local");
    if (after[kind].length !== before[kind].length + 1) fail(`${name}: this computer has ${after[kind].length - before[kind].length} new ${kind}`);
    if (kind === "groups" || (kind === "boards" && layoutNow(page) !== "phone")) {
      await nameBox(section(page, "local")).waitFor({ timeout: 10000 }).catch(() => fail(`${name}: the new row is not in rename mode in this computer's section`));
      if (await page.locator('[data-testid="side-section"]:not([data-server="local"]) [data-testid="name-input"]').count()) fail(`${name}: the new row is in another section`);
      await page.keyboard.press("Escape");
    }
  }
  if (J(await held(STUDIO)) !== J(studio0)) fail("the sidebar's own + made something on Studio Mac");

  note(`${posts().filter((c) => c.server === STUDIO && c.status === 200).length} things made on Studio Mac by calls to that server, 3 refused with the server's sentence and nothing made, 3 made on this computer by the sidebar's own +; no question, no server in a body`);
}, { viewports, page: false });

/** The phone's half: "+ New" and its sheet (see the head of the file). */
async function onPhone({ url, open, fail, note }) {
  await seed(url, "SEC");
  const { page } = await open({ wait: '[data-testid="home"]' });
  const calls = callsOf(page);
  const posts = () => calls.filter((c) => c.method === "POST" && /\/(chats|boards|groups)$/.test(c.path));
  const held = (id) => mockEval(`return onServer(${J(id)}, () => ({ chats: Object.keys(chats), boards: Object.keys(boards), groups: groups.map((g) => g.id) }));`, url);
  const asked = async () => !!await byTid(page, "confirm-dialog").count();
  const local0 = await held("local");
  const ITEM = { chats: "chat", boards: "board", groups: "group" };
  const TILE = { chats: "new-chat", boards: "new-board", groups: "new-group" }; // (the new sheet's parts, H2)
  let named = 0, lastNamed = "";
  /** The place a make starts from: a server's Home, or the screen of one of its groups (the group's key). */
  const goTo = async (server, group) => {
    await showHome(page, server);
    if (!group) return byTid(page, "home-new").first();
    await press(page, byTid(page, "home-row", { kind: "group", key: group }).first());
    await byTid(page, "group-screen", { key: group }).last().waitFor({ state: "visible", timeout: 10000 });
    return byTid(byTid(page, "group-screen", { key: group }).last(), "group-new").first();
  };
  /** "+ New" at the place, the sheet's item of `kind`; answers the call it made (or null). */
  const make = async (name, server, group, kind) => {
    const n = posts().length;
    await press(page, await goTo(server, group));
    const sheet = byTid(page, "home-new-sheet").last();
    if (!await until(() => sheet.isVisible(), 10000)) { fail(`${name}: "+ New" opened no sheet`); return null; }
    const seen = await newSheetSeen(page);
    if (seen?.page !== "what" || (seen.group !== "") !== !!group || !seen.where) fail(`${name}: the new sheet is ${J(seen)}, not the first page with the Where card for ${group ? `the group ${group}` : "the top of the server"}`);
    await press(page, byTid(sheet, TILE[kind]).first());
    if (!await until(() => posts().length === n + 1 && posts()[n].status !== undefined, 10000)) { fail(`${name}: ${posts().length - n} calls made a thing, not one`); return null; }
    return posts()[n];
  };
  /** A new group opens the Rename sheet at once: a name typed and saved there is the group's name on its server. Answers that name. */
  const nameIt = async (name, server, id) => {
    const sheet = byTid(page, "rename-sheet").last();
    if (!await until(() => sheet.isVisible(), 10000)) { fail(`${name}: a new group did not open the Rename sheet`); return ""; }
    const label = `Named ${++named}`;
    await byTid(page, "rename-input").last().fill(label);
    await press(page, byTid(sheet, "sheet-right").first());
    if (!await until(async () => !await byTid(page, "rename-sheet").count(), 10000)) fail(`${name}: Save did not close the Rename sheet`);
    const got = () => mockEval(`return onServer(${J(server)}, () => groups.find((g) => g.id === ${J(id)})?.name);`, url);
    if (!await until(async () => (await got()) === label, 10000)) fail(`${name}: the group is named "${await got()}" on ${server}, not "${label}"`);
    return label;
  };
  const made = async (name, server, group, kind, want) => {
    const before = await held(server), c = await make(name, server, group, kind);
    if (!c) return "";
    if (c.server !== server || c.path !== `/api/${kind}` || c.status !== 200) fail(`${name}: the call went to ${c.server} ${c.path}, answered ${c.status}, not ${server} /api/${kind}`);
    for (const [k, v] of Object.entries(want)) if (J(c.body?.[k]) !== J(v)) fail(`${name}: the call's body has ${k} ${J(c.body?.[k])}, not ${J(v)}: ${J(c.body)}`);
    if (c.body && "server" in c.body) fail(`${name}: the call's body names a server: ${J(c.body)}`);
    if (await asked()) fail(`${name}: the page asks something before or after the make`);
    const after = await held(server), fresh = after[kind].filter((x) => !before[kind].includes(x));
    if (fresh.length !== 1) fail(`${name}: ${server} has ${fresh.length} new ${kind} after it`);
    if (server !== "local" && J(await held("local")) !== J(local0)) fail(`${name}: something was made on this computer`);
    if (kind === "groups" && fresh[0]) { const label = await nameIt(name, server, fresh[0]); if (label) lastNamed = label; }
    return fresh[0] ?? "";
  };
  const listed = async (name, server, group, line) => {
    await showHome(page, server);
    if (group) await press(page, byTid(page, "home-row", { kind: "group", key: group }).first());
    if (!await until(async () => (await homeOf(page, group ?? null)).outline.includes(line), 10000)) fail(`${name}: ${group ?? server} lists no "${line}": ${J((await homeOf(page, group ?? null)).outline)}`);
  };
  const savedChat = () => page.evaluate(() => JSON.parse(localStorage.getItem("aiwb.sel") ?? "{}").chat ?? "");

  // ---- "+ New" on Studio Mac's Home: on that server, outside any group
  if (!await until(async () => { await showHome(page, STUDIO); return (await homeOf(page)).rows.length > 0; }, 15000)) fail("Studio Mac's Home has no row");
  const chat = await made("a chat from Studio Mac's Home", STUDIO, null, "chats", { group: LOOSE });
  if (!await until(async () => (await savedChat()) === `${STUDIO}~${chat}`, 10000)) fail(`the chat made from Studio Mac's Home is not open as a chat of Studio Mac: the selection is "${await savedChat()}"`);
  if (await mockEval(`return onServer("${STUDIO}", () => chats[${J(chat)}]?.cwd);`, url) !== "/Users/studio/work") fail("the chat made on Studio Mac does not start in that server's default folder");
  await listed("a chat from Studio Mac's Home", STUDIO, null, "chat New chat");
  await made("a whiteboard from Studio Mac's Home", STUDIO, null, "boards", { group: LOOSE });
  await listed("a whiteboard from Studio Mac's Home", STUDIO, null, "board untitled");
  await made("a group from Studio Mac's Home", STUDIO, null, "groups", {});
  if (posts().at(-1)?.body?.parent) fail("a group made from Studio Mac's Home names a parent");
  await listed("a group from Studio Mac's Home", STUDIO, null, `group ${lastNamed}`);

  // ---- "+ New" on a group's screen: in that group, by its own id there
  const OLD = `${STUDIO}~g_old`;
  await made("a chat from a group's screen", STUDIO, OLD, "chats", { group: "g_old" });
  await listed("a chat from a group's screen", STUDIO, OLD, "chat New chat");
  await made("a whiteboard from a group's screen", STUDIO, OLD, "boards", { group: "g_old" });
  await listed("a whiteboard from a group's screen", STUDIO, OLD, "board untitled");
  await made("a group from a group's screen", STUDIO, OLD, "groups", { parent: "g_old" });
  await listed("a group from a group's screen", STUDIO, OLD, `group ${lastNamed}`);
  const localShop = async () => { await showHome(page, "local"); await press(page, byTid(page, "home-row", { kind: "group", key: "g_shop" }).first()); await page.waitForTimeout(300); return (await homeOf(page, "g_shop")).outline; };
  const shop0 = await localShop();
  await made("a chat from the group that has a local group's id", STUDIO, `${STUDIO}~g_shop`, "chats", { group: "g_shop" });
  if (J(await localShop()) !== J(shop0)) fail(`a make in Studio Mac's group g_shop changed this computer's group g_shop: ${J(await localShop())}`);

  // ---- Change → the Where page: into a child level, "Put it in", and the thing lands in the chosen group (and Done leaves the choice as it was)
  {
    const name = "a chat made with Change → Where";
    await press(page, await goTo(STUDIO, null));
    const sheet = byTid(page, "home-new-sheet").last();
    await sheet.waitFor({ state: "visible", timeout: 10000 });
    await press(page, byTid(sheet, "new-change").first());
    if (!await until(async () => (await newSheetSeen(page))?.page === "where", 10000)) fail(`${name}: Change did not open the Where page: ${J(await newSheetSeen(page))}`);
    const level = (await newSheetSeen(page))?.levels.find((l) => /Old takes/.test(l.text));
    if (!level) { fail(`${name}: the Where page at the top lists no group "Old takes": ${J(await newSheetSeen(page))}`); }
    else {
      await press(page, byTid(sheet, "new-level", { group: level.group }).first());
      if (!await until(async () => (await newSheetSeen(page))?.crumbs.some((c) => c.group === ""), 10000)) fail(`${name}: going into a level shows no crumb back to the top: ${J(await newSheetSeen(page))}`);
      await press(page, byTid(sheet, "sheet-right").first()); // Done: back to the first page, the choice as it was (the top)
      if (!await until(async () => (await newSheetSeen(page))?.page === "what", 10000)) fail(`${name}: Done did not go back to the first page`);
      if ((await newSheetSeen(page))?.group !== "") fail(`${name}: Done changed the place to "${(await newSheetSeen(page))?.group}": it was the top of the server`);
      await press(page, byTid(sheet, "new-change").first());
      await byTid(sheet, "new-level", { group: level.group }).first().waitFor({ state: "visible", timeout: 10000 });
      await press(page, byTid(sheet, "new-level", { group: level.group }).first());
      const put = byTid(sheet, "new-put").first();
      await put.waitFor({ state: "visible", timeout: 10000 });
      if (!/Old takes/.test((await put.innerText()) ?? "")) fail(`${name}: the row that puts the thing here says "${await put.innerText()}", not "Put it in Old takes"`);
      await press(page, put);
      if (!await until(async () => { const v = await newSheetSeen(page); return v?.page === "what" && v.group === level.group && /Old takes/.test(v.where ?? ""); }, 10000)) fail(`${name}: "Put it in" did not return to the first page with Old takes chosen: ${J(await newSheetSeen(page))}`);
      const n = posts().length, before = await held(STUDIO);
      await press(page, byTid(sheet, "new-chat").first());
      if (!await until(() => posts().length === n + 1 && posts()[n].status !== undefined, 10000)) fail(`${name}: ${posts().length - n} calls made a thing, not one`);
      else {
        const c = posts()[n], fresh = (await held(STUDIO)).chats.filter((x) => !before.chats.includes(x));
        if (c.server !== STUDIO || c.path !== "/api/chats" || c.body?.group !== "g_old") fail(`${name}: the call was ${J({ server: c.server, path: c.path, group: c.body?.group })}, not a chat in g_old on ${STUDIO}`);
        if (fresh.length !== 1 || await mockEval(`return onServer("${STUDIO}", () => chats[${J(fresh[0])}]?.group);`, url) !== "g_old") fail(`${name}: the new chat is not in the group Old takes`);
      }
    }
  }

  // ---- a make that server refuses: its sentence, and nothing made
  const SAID = "Studio Mac has no agent this chat could use.";
  await mockEval(`flags.make = { server: "${STUDIO}", refuse: { status: 409, code: "no_agent", error: ${J(SAID)} } };`, url);
  for (const kind of ["chats", "boards", "groups"]) {
    const name = `a refused ${ITEM[kind]}`, before = await held(STUDIO);
    const c = await make(name, STUDIO, null, kind);
    const dialog = byTid(page, "confirm-dialog");
    if (!await until(async () => (await dialog.textContent().catch(() => "")).includes(SAID), 10000)) fail(`${name}: the page does not show the server's sentence: "${await dialog.textContent().catch(() => "")}"`);
    if (c && (c.server !== STUDIO || c.path !== `/api/${kind}` || c.status !== 409)) fail(`${name}: the call was ${J(c)}`);
    await press(page, dialog.getByText("Close", { exact: true }).first()).catch(() => {});
    if (!await until(async () => !await dialog.count(), 10000)) fail(`${name}: Close did not close the dialog`);
    if (await byTid(page, "rename-sheet").count()) fail(`${name}: the Rename sheet opened for a group that was not made`);
    if (J(await held(STUDIO)) !== J(before) || J(await held("local")) !== J(local0)) fail(`${name}: something was made all the same`);
  }
  await mockEval("delete flags.make;", url);

  // ---- "+ New" on this computer's Home: things of this computer, and no question
  const studio0 = await held(STUDIO);
  for (const kind of ["chats", "boards", "groups"]) await made(`this computer's "+ New" → ${ITEM[kind]}`, "local", null, kind, kind === "groups" ? {} : { group: LOOSE });
  if (J(await held(STUDIO)) !== J(studio0)) fail("this computer's \"+ New\" made something on Studio Mac");

  note(`${posts().filter((c) => c.server === STUDIO && c.status === 200).length} things made on Studio Mac by "+ New" (Home and a group's screen), 3 refused with the server's sentence, 3 made on this computer; no question, no server in a body`);
}
