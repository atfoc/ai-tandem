// Proves that the app's storage holds nothing of a section's chat or whiteboard
// (plans/remote-server-sections-goal.md, 3.8 "Text that was typed…", 3.12, section 5 "Nothing on disk"; the contract's
// 3.10 "No content of a remote server in the browser's storage").
// A chat of a section is open from the saved selection: while its server is connected, while it is not, and after a reload, the storage has
// no key of that chat (no "aiwb.draft.…" of a section's key) and no value with what that server holds of it (its draft, its drawing).
// After all of it the storage holds the selection, the collapse, the widths and the app's other settings, and of the section only the keys
// that name what is selected and what is collapsed. A reload during an outage knows nothing of that server's chat.
// Every storage a page has is read each time: localStorage, sessionStorage and every IndexedDB database.
// Ports dev/checks/SEC.9-storage.mjs (S1) to the new build, at the three viewports (A-LY-05, A-SG-01, A-SG-05). Deviations: the widths are saved by
// the pane's resizer, which the desktop has (a finger's resize is L2's); the phone's list is the screen below the chat, so the chat is left to
// reach it and the selection kept names none; the section's board is drawn on by the viewport's pointer (boarddraw.mjs: a finger on a touch
// viewport) and its banner and canvas are read by their testIDs.
// From the sweep (D-SV-09): the page asks before it unloads (`beforeunload` is prevented) only while a drawing waits: not with the board open and
// nothing drawn, not once the drawing is saved, and with the drawing waiting for its server the reload is met by the browser's dialog (asserted,
// where the check had only accepted it).
// On the phone (package H1) the list is Home: a reload is waited for by Home (under the chat in the stack, or alone), and in the place of a
// section's collapse Home's chip of another server is pressed: Home's place (`aiwb.home`, h1-design.md §2) is what the browser keeps of it,
// keys only. The phone has no collapse (Home lists one server at a time).
import { callMatcher, check, dragResizer, mockEval, seed, until } from "../shot.mjs";
import { byTid, openChat, press, showHome, showList } from "./sel.mjs";
import { drawer, editHere } from "./boarddraw.mjs";
import { section, sectionToggle } from "./side.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const J = JSON.stringify;
const DRAFT = callMatcher(/\/draft\?/), SCENE = callMatcher(/\/boards\/b_loose\/scene\?/); // (the app's calls, held on their way)
const STUDIO = "s_studio", KEY = `${STUDIO}~c_note`;
// what the page may keep: its settings, what is selected and collapsed, the chat a board reopens with (a key),
// and of this computer's chats and folders their unsaved drafts and the recent folders; on the phone the server and groups Home shows
const SETTINGS = ["aiwb.sel", "aiwb.collapsed", "aiwb.widths", "aiwb.archived", "aiwb.side", "aiwb.theme", "aiwb.lastChat", "aiwb.dirs", "aiwb.home", "aiwb.search.opened", "aiwb.search.recent"];

await check("SEC.9 the app's storage holds nothing of a section's chat or whiteboard", async ({ url, viewport, open, fail, note }) => {
  await seed(url, "SEC");
  const phone = viewport === "phone";
  /** What a reload is waited for by: the list (the sidebar's sections; on the phone Home, drawn under an open chat too). */
  const LIST = phone ? "home" : "side-section";
  const p = await open({ sel: { chat: KEY }, wait: '[data-testid="chat-head"]' }), { page } = p;
  const storeOf = (pg) => pg.evaluate(() => Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])));
  const store = () => storeOf(page);
  const box = () => byTid(page, "composer-input").first();
  const typedSoFar = [];
  /** The caret at the end of the whole text (End goes to the end of the line only: the phone's box is narrow and wraps). */
  const toEnd = () => page.keyboard.press("End").then(() => page.evaluate(() => { const el = document.activeElement; if (el?.isContentEditable) { const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } }));
  /** What a page keeps besides localStorage: sessionStorage, and everything in every IndexedDB database, as text. */
  const otherOf = (pg) => pg.evaluate(async () => {
    const out = {};
    for (const k of Object.keys(sessionStorage)) out[`sessionStorage ${k}`] = sessionStorage.getItem(k) ?? "";
    for (const { name } of await indexedDB.databases()) {
      const db = await new Promise((ok, no) => { const r = indexedDB.open(name); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
      for (const st of db.objectStoreNames) {
        const all = await new Promise((ok) => { const r = db.transaction(st).objectStore(st).getAll(); r.onsuccess = () => ok(r.result); r.onerror = () => ok([]); });
        const keys = await new Promise((ok) => { const r = db.transaction(st).objectStore(st).getAllKeys(); r.onsuccess = () => ok(r.result); r.onerror = () => ok([]); });
        out[`indexedDB ${name}/${st}`] = JSON.stringify([keys, all]);
      }
      db.close();
    }
    return out;
  });
  /** What the servers of the seed hold of the things this check opens: none of it is in a storage of the page. */
  const THEIRS = ["remember the LUTs", "sec_rect"];
  /** The page's storage now: no key of a section's thing but the selection and the collapse, no draft of one, nothing that server holds.
   *  pg: the page (the first one, when none is named). */
  const clean = async (when, pg = page) => {
    const s = await storeOf(pg), other = await otherOf(pg);
    for (const [k, v] of Object.entries(s)) {
      if (k.startsWith("aiwb.draft.") && (k.includes("~") || k.includes(STUDIO) || k.includes("c_note"))) fail(`${when}: localStorage has the key ${k} = ${v.slice(0, 80)}`);
      if (k.startsWith("aiwb.dirs.")) fail(`${when}: localStorage has the recent folders of a server: ${k}`);
      if ((k + v).includes(STUDIO) && k !== "aiwb.sel" && k !== "aiwb.collapsed" && k !== "aiwb.lastChat" && k !== "aiwb.home" && k !== "aiwb.search.opened") fail(`${when}: localStorage names Studio Mac under ${k}: ${v.slice(0, 120)}`);
      if (k === "aiwb.home" && (() => { const h = JSON.parse(v); return Object.keys(h).some((x) => x !== "server" && x !== "groups") || ![h.server, ...(h.groups ?? [])].every((x) => x === null || /^[\w~-]+$/.test(x)); })()) fail(`${when}: aiwb.home holds more than keys: ${v.slice(0, 120)}`);
      // (H2's search keeps the things opened as keys and kinds, never a title; the words searched for are typed by the person, and this check types none)
      if (k === "aiwb.search.opened" && (() => { const o = JSON.parse(v); return !Array.isArray(o) || o.some((x) => Object.keys(x).sort().join() !== "key,kind" || !/^[\w~-]+$/.test(x.key) || !["board", "chat"].includes(x.kind)); })()) fail(`${when}: aiwb.search.opened holds more than keys and kinds: ${v.slice(0, 160)}`);
      if (k === "aiwb.search.recent" && (() => { const w = JSON.parse(v); return !Array.isArray(w) || w.length > 0; })()) fail(`${when}: aiwb.search.recent holds words this check never typed: ${v.slice(0, 160)}`);
      if (k === "aiwb.lastChat" && Object.entries(JSON.parse(v)).some(([owner, chat]) => typeof chat !== "string" || !/^[\w~-]+$/.test(owner + chat))) fail(`${when}: aiwb.lastChat holds more than keys: ${v.slice(0, 120)}`);
    }
    for (const [k, v] of [...Object.entries(s), ...Object.entries(other)]) {
      for (const t of THEIRS) if (v.includes(t)) fail(`${when}: the browser has what Studio Mac holds ("${t}"), under ${k}`);
      for (const t of typedSoFar) if (v.includes(t)) fail(`${when}: the browser has what was typed, under ${k}: ${v.slice(0, 120)}`);
      if (/"type":"(rectangle|ellipse|text|arrow|line|freedraw)"/.test(v)) fail(`${when}: the browser has elements of a drawing, under ${k}: ${v.slice(0, 120)}`);
    }
    for (const [k, v] of Object.entries(other)) if ((k + v).includes(STUDIO) || (k + v).includes("~")) fail(`${when}: the browser names a thing of a section under ${k}: ${v.slice(0, 120)}`);
    return s;
  };
  const there = (code) => mockEval(`return onServer("${STUDIO}", () => { ${code} });`, url);
  // the chat is open, and the app has read its draft from its server (the store holds it: the storage does not)
  if (!await until(async () => await there("return chats.c_note.draft?.text;") === "remember the LUTs", 10000)) fail("the seed's chat of Studio Mac has not the draft the check is about");
  await clean("the chat open with its server's draft");
  await page.waitForTimeout(500); // (a moment for whatever the app would keep of what it has read)
  await clean("the chat open with its server's draft, a moment later");

  // ---- typed, the save held on its way: no copy in the app's storage; and then saved
  if (!await until(async () => (await box().textContent()) === "remember the LUTs", 10000)) fail(`the chat does not open with the draft its server has: "${await box().textContent()}"`);
  let hold = null, held = 0;
  await page.route(DRAFT, async (route) => { held++; await new Promise((ok) => { hold = ok; }); await route.continue(); });
  typedSoFar.push(" and the gamma");
  await press(page, box()); await page.keyboard.press("End"); await page.keyboard.type(" and the gamma");
  if (!await until(() => held === 1, 10000)) fail("typing in the section's chat started no save of its draft");
  await clean("the save of the section's draft on its way");
  hold();
  if (!await until(async () => await there("return chats.c_note.draft?.text;") === "remember the LUTs and the gamma", 10000)) fail(`the draft was not saved on Studio Mac: ${J(await there("return chats.c_note.draft;"))}`);
  await clean("the section's draft saved");
  // the same in a chat of this computer: its unsaved copy is in the app's storage while the save is on its way (so the check sees one)
  await openChat(page, "c_plain");
  await press(page, box()); await page.keyboard.type("a local thought");
  if (!await until(() => held === 2, 10000)) fail("typing in this computer's chat started no save of its draft");
  const localCopy = await store();
  if (!Object.keys(localCopy).some((k) => k.startsWith("aiwb.draft.c_plain") && localCopy[k].includes("a local thought"))) fail(`a chat of this computer has no unsaved copy in localStorage while its save is on its way: ${J(Object.keys(localCopy))}`);
  hold();
  if (!await until(async () => !Object.keys(await store()).some((k) => k.startsWith("aiwb.draft.")), 10000)) fail(`the local chat's unsaved copy stays after its save: ${J(Object.keys(await store()))}`);
  await page.unroute(DRAFT);
  await openChat(page, KEY);

  // ---- a reload: the section's chat opens again from the selection
  await page.reload(); await byTid(page, LIST).first().waitFor({ state: "attached", timeout: 15000 });
  if ((JSON.parse(await page.evaluate(() => localStorage.getItem("aiwb.sel") ?? "{}"))).chat !== KEY) fail("after a reload the selection is not the section's chat");
  await clean("after a reload");
  if (!await until(async () => (await box().textContent().catch(() => "")) === "remember the LUTs and the gamma", 10000)) fail(`after a reload the section's chat does not open with its server's draft: "${await box().textContent().catch(() => "")}"`);

  // ---- its server not connected: nothing is kept for it
  // (what is typed just before the drop and not yet taken by the server — its save is held, and never arrives — stays in the box, which is read-only
  // from the drop on, and nowhere in the app's storage)
  await mockEval(`flags.draft = { hold: true };`, url);
  typedSoFar.push(" typed in the dark");
  await press(page, box()); await toEnd(); await page.keyboard.type(" typed in the dark");
  await page.waitForTimeout(600); // (the save's debounce of 400 ms: the save is on its way)
  await mockEval(`setServerState("${STUDIO}", "unreachable", { detail: "connection refused" }); release("draft"); delete flags.draft;`, url);
  // (the phone has no banner: its header's sub-line says the server is off)
  if (phone) await page.waitForFunction(() => /offline/.test(document.querySelector('[data-testid="chat-head-sub"]')?.textContent ?? ""), null, { timeout: 15000 });
  else await byTid(page, "remote-bar").first().waitFor({ state: "attached", timeout: 15000 });
  // (two frames and the save's debounce of 400 ms: what the app would keep, it has kept by then)
  await until(async () => Object.keys(await store()).some((k) => k.startsWith("aiwb.draft.")), 1500);
  await clean("typed just before the server dropped, and not saved");
  if ((await box().textContent()) !== "remember the LUTs and the gamma typed in the dark") fail(`the box has "${await box().textContent()}"`);
  await box().click({ force: true }).catch(() => {}); await toEnd(); await page.keyboard.type(" and after");
  if ((await box().textContent()) !== "remember the LUTs and the gamma typed in the dark") fail(`the read-only box took what was typed during the outage: "${await box().textContent()}"`);
  if (phone) await showHome(page, "s_empty"); // (another server's Home, so that the browser keeps the place Home shows)
  else {
    await until(async () => await byTid(section(page, "s_empty"), "side-section-state").count() > 0, 5000);
    await showList(page);
    await press(page, sectionToggle(page, "s_empty")); // a collapse, so that the browser keeps what it is to keep
  }
  if (viewport === "desktop") await dragResizer(page, '[data-testid="side-pane"] [data-testid="resizer"]', 30); // and a width
  const kept = await clean("with a collapse and a width saved");
  // (the phone's list is the screen below the chat: to reach it the chat is left, and the selection with it)
  const kept_ = JSON.parse(kept["aiwb.sel"] ?? "{}").chat ?? null;
  if (viewport === "phone" ? kept_ !== null : kept_ !== KEY) fail(`the selection kept is ${kept["aiwb.sel"]}, not ${viewport === "phone" ? "none, the chat left for the list" : "the section's chat"}`);
  if (phone) { if (J(JSON.parse(kept["aiwb.home"] ?? "{}")) !== J({ server: "s_empty", groups: [] })) fail(`Home's place kept is ${kept["aiwb.home"]}, not the server chosen by its chip`); }
  else if (J(JSON.parse(kept["aiwb.collapsed"] ?? "[]")) !== J(["s_empty"])) fail(`the collapse kept is ${kept["aiwb.collapsed"]}`);
  if (viewport === "desktop" && !kept["aiwb.widths"]) fail("no width is kept");
  const others = Object.keys(kept).filter((k) => !SETTINGS.includes(k));
  if (others.length) fail(`localStorage has other keys than the selection, the collapse, the widths and the app's settings: ${J(others)}`);

  // ---- a reload during the outage: nothing of the chat is known
  await page.reload(); await byTid(page, LIST).first().waitFor({ state: "attached", timeout: 15000 });
  if (await byTid(page, "chat-head").count()) fail("after a reload during the outage the section's chat is on the page");
  if ((await page.content()).includes("typed in the dark")) fail("after a reload during the outage what was typed in the section's chat is on the page");
  await clean("after a reload during the outage");
  await mockEval(`setServerState("${STUDIO}", "connected");`, url);
  await openChat(page, KEY);
  if (!await until(async () => (await box().textContent().catch(() => "")) === "remember the LUTs and the gamma", 10000)) fail(`back, the chat opens with "${await box().textContent().catch(() => "")}", not the draft its server has`);
  const end = await clean("at the end");

  for (const e of p.errors) fail(`page error: ${e}`);
  await p.ctx.close(); // (the mock has one stream: two pages open take it from each other)
  // ---- a whiteboard of a section: what is drawn on it
  let boardKeys = [], boardOther = [];
  {
    await seed(url, "SEC");
    const q = await open({ sel: { board: `${STUDIO}~b_loose`, chat: null }, wait: '[data-testid="board-bar"]' }), pg = q.page;
    await editHere(pg); // (a board opens as a reader's: the button makes the window its writer)
    const count = () => mockEval(`return onServer("${STUDIO}", () => scenes.b_loose.scene.elements.filter((e) => !e.isDeleted).length);`, url);
    const draw = drawer(pg);
    /** Whether the page, asked whether it may unload, asks the user not to (a `beforeunload` nobody has prevented is not asking). */
    const asks = () => pg.evaluate(() => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
    await clean("the section's board open with its server's drawing", pg);
    if (await asks()) fail("with the section's board open and nothing drawn the page asks before it unloads");
    let hold = null, held = 0;
    await pg.route(SCENE, async (route) => { held++; await new Promise((ok) => { hold = ok; }); await route.continue(); });
    await draw();
    if (!await until(() => held === 1, 15000)) fail("drawing on the section's board started no save of it");
    await clean("the save of the section's drawing on its way", pg);
    hold();
    if (!await until(async () => await count() === 2, 15000)) fail(`the drawing was not saved on Studio Mac: it has ${await count()} shapes, not 2`);
    await pg.unroute(SCENE);
    await clean("the section's drawing saved", pg);
    if (!await until(async () => !await asks(), 10000)) fail("the section's drawing is saved and the page still asks before it unloads");
    // its server not connected: the drawing waits in the window, under the banner, and in no storage
    await mockEval(`setServerState("${STUDIO}", "unreachable", { detail: "connection refused" });`, url);
    await draw();
    if (!await until(async () => (await byTid(pg, "save-banner").first().textContent().catch(() => "")).includes("Not saved"), 15000)) fail("a drawing made while the board's server is away shows no banner that it is not saved");
    await draw();
    const waits = await clean("a drawing that waits for a server that is not connected", pg);
    if (await count() !== 2) fail("Studio Mac got a drawing while it was not connected");
    boardKeys = Object.keys(waits).sort(); boardOther = Object.keys(await otherOf(pg)).sort();
    const others = boardKeys.filter((k) => !SETTINGS.includes(k) && !k.startsWith("excalidraw"));
    if (others.length) fail(`with a section's board open localStorage has other keys than the app's settings and the canvas library's own: ${J(others)}`);
    // (the page asks before it unloads with a drawing that is not saved: the reload is the user's answer)
    if (!await asks()) fail("a drawing waits for its server and the page does not ask before it unloads");
    const dialogs = [];
    pg.on("dialog", (d) => { dialogs.push(d.type()); void d.accept().catch(() => {}); });
    await pg.reload(); await byTid(pg, LIST).first().waitFor({ state: "attached", timeout: 15000 });
    if (!dialogs.includes("beforeunload")) fail(`a drawing waits for its server and the reload was not met by the browser's dialog (dialogs: ${J(dialogs)})`);
    if (await pg.locator(".excalidraw").count() || await byTid(pg, "board-off").count() || await byTid(pg, "board-role").count() || await byTid(pg, "board-canvas").count()) fail("after a reload during the outage the section's board is on the page");
    await clean("after a reload during the board's outage", pg);
    await mockEval(`setServerState("${STUDIO}", "connected");`, url);
  }
  note(`localStorage at the end: ${Object.keys(end).sort().join(", ")}; no draft of the section's chat at any moment, a local chat's while its save was on its way. `
    + `A section's board, drawn on and not saved: localStorage ${boardKeys.join(", ")}; sessionStorage and IndexedDB: ${boardOther.join(", ") || "nothing"}`);
}, { viewports, page: false, allowConsole: [/^saving board /] }); // (a failed save is logged by the board side: the outage is what the check makes)
