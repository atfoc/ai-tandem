// Proves that the browser's storage holds nothing of a section's chat or whiteboard
// (plans/remote-server-sections-goal.md, 3.8 "Text that was typed…", 3.12, section 5 "Nothing on disk"; the contract's
// 3.10 "No content of a remote server in the browser's storage").
// A chat: while a draft typed in a chat of a section is on its way to the server, when it is saved, while
// its server is not connected and after a reload, localStorage has no key of that chat (no "aiwb.draft.…" of a
// section's key) and no value with what was typed. A chat of this computer still has its unsaved copy there while
// its save is on its way, which shows that the check would see one. After all of it localStorage holds the selection,
// the collapse, the widths and the page's other settings, and of the section only the keys that name what is selected
// and what is collapsed. What was typed just before an outage and not saved is given up by a reload.
// A whiteboard: what is drawn on a section's board is in no storage while its save is on its way, when it is saved, and
// while it waits in the window for a server that is not connected; a reload during the outage gives it up.
// Every storage a page has is read each time: localStorage, sessionStorage and every IndexedDB database.
import { check, dragResizer, mockEval, openPage, seed, until } from "../shot.mjs";

const J = JSON.stringify;
const STUDIO = "s_studio", KEY = `${STUDIO}~c_note`;
// what the page may keep: its settings, what is selected and collapsed, the chat a board reopens with (a key),
// and of this computer's chats and folders their unsaved drafts and the recent folders
const SETTINGS = ["aiwb.sel", "aiwb.collapsed", "aiwb.widths", "aiwb.archived", "aiwb.side", "aiwb.theme", "aiwb.lastChat", "aiwb.dirs"];

await check("SEC.9 the browser's storage holds nothing of a section's chat or whiteboard", async ({ url, browser, fail, note }) => {
  await seed(url, "SEC");
  const p = await openPage({ url, browser, sel: { chat: KEY }, size: [1280, 900] }), { page } = p;
  const box = page.locator(".composer .composer-input");
  const storeOf = (pg) => pg.evaluate(() => Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])));
  const store = () => storeOf(page);
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
  const typedSoFar = [];
  /** What the servers of the seed hold of the things this check opens: none of it is in a storage of the page. */
  const THEIRS = ["remember the LUTs", "sec_rect"];
  /** The page's storage now: no key of a section's thing but the selection and the collapse, no draft of one, nothing typed,
   *  nothing drawn, and nothing that server holds. pg: the page (the first one, when none is named). */
  const clean = async (when, pg = page) => {
    const s = await storeOf(pg), other = await otherOf(pg);
    for (const [k, v] of Object.entries(s)) {
      if (k.startsWith("aiwb.draft.") && (k.includes("~") || k.includes(STUDIO) || k.includes("c_note"))) fail(`${when}: localStorage has the key ${k} = ${v.slice(0, 80)}`);
      if (k.startsWith("aiwb.dirs.")) fail(`${when}: localStorage has the recent folders of a server: ${k}`);
      if ((k + v).includes(STUDIO) && k !== "aiwb.sel" && k !== "aiwb.collapsed" && k !== "aiwb.lastChat") fail(`${when}: localStorage names Studio Mac under ${k}: ${v.slice(0, 120)}`);
      if (k === "aiwb.lastChat" && Object.entries(JSON.parse(v)).some(([owner, chat]) => typeof chat !== "string" || !/^[\w~-]+$/.test(owner + chat))) fail(`${when}: aiwb.lastChat holds more than keys: ${v.slice(0, 120)}`);
    }
    for (const [k, v] of [...Object.entries(s), ...Object.entries(other)]) {
      for (const t of typedSoFar) if (v.includes(t)) fail(`${when}: the browser has what was typed, under ${k}: ${v.slice(0, 120)}`);
      for (const t of THEIRS) if (v.includes(t)) fail(`${when}: the browser has what Studio Mac holds ("${t}"), under ${k}`);
      if (/"type":"(rectangle|ellipse|text|arrow|line|freedraw)"/.test(v)) fail(`${when}: the browser has elements of a drawing, under ${k}: ${v.slice(0, 120)}`);
    }
    for (const [k, v] of Object.entries(other)) if ((k + v).includes(STUDIO) || (k + v).includes("~")) fail(`${when}: the browser names a thing of a section under ${k}: ${v.slice(0, 120)}`);
    return s;
  };
  const there = (code) => mockEval(`return onServer("${STUDIO}", () => { ${code} });`, url);
  await page.waitForSelector(".thread .msg.user");
  if (!await until(async () => (await box.textContent()) === "remember the LUTs", 10000)) fail(`the chat does not open with the draft its server has: "${await box.textContent()}"`);
  await clean("the chat open with its server's draft");

  // ---- typed, the save held on its way: no copy in the browser; and then saved
  let hold = null, held = 0;
  await page.route(/\/draft\?/, async (route) => { held++; await new Promise((ok) => { hold = ok; }); await route.continue(); });
  typedSoFar.push(" and the gamma");
  await box.click(); await page.keyboard.press("End"); await page.keyboard.type(" and the gamma");
  if (!await until(() => held === 1, 10000)) fail("typing in the section's chat started no save of its draft");
  await clean("the save of the section's draft on its way");
  hold();
  if (!await until(async () => await there("return chats.c_note.draft?.text;") === "remember the LUTs and the gamma", 10000)) fail(`the draft was not saved on Studio Mac: ${J(await there("return chats.c_note.draft;"))}`);
  await clean("the section's draft saved");

  // the same in a chat of this computer: its unsaved copy is in the browser while the save is on its way (so the check sees one)
  await page.locator('.side-tree > .side-group .side-row:has(.side-name:text-is("Why is the build slow"))').click();
  await page.waitForFunction(() => !document.querySelector(".chat-head .chat-head-server") && document.querySelector(".thread .msg.user"), null, { timeout: 10000 });
  await box.click(); await page.keyboard.type("a local thought");
  if (!await until(() => held === 2, 10000)) fail("typing in this computer's chat started no save of its draft");
  const localCopy = await store();
  if (!Object.keys(localCopy).some((k) => k.startsWith("aiwb.draft.c_plain") && localCopy[k].includes("a local thought"))) fail(`a chat of this computer has no unsaved copy in localStorage while its save is on its way: ${J(Object.keys(localCopy))}`);
  hold();
  if (!await until(async () => !Object.keys(await store()).some((k) => k.startsWith("aiwb.draft.")), 10000)) fail(`the local chat's unsaved copy stays after its save: ${J(Object.keys(await store()))}`);
  await page.unroute(/\/draft\?/);

  // ---- a reload: the section's chat opens again from the selection, with the draft its server has
  await page.locator(`.side-section[data-server="${STUDIO}"] .side-row:has(.side-name:text-is("Scratch"))`).click();
  await page.waitForSelector(".chat-head .chat-head-server");
  await page.reload(); await page.waitForSelector(".side-tree .side-section");
  if (!await until(async () => (await box.textContent().catch(() => "")) === "remember the LUTs and the gamma", 10000)) fail(`after a reload the section's chat does not open with its server's draft: "${await box.textContent().catch(() => "")}"`);
  await clean("after a reload");

  // ---- its server not connected: what is typed is in the box alone
  // Typed just before the drop and not yet taken by the server (its save is held, and never arrives): it stays in the
  // box, which is read-only from the drop on, and nowhere in the browser's storage.
  await mockEval(`flags.draft = { hold: true };`, url);
  typedSoFar.push(" typed in the dark");
  await box.click(); await page.keyboard.press("End"); await page.keyboard.type(" typed in the dark");
  await page.waitForTimeout(600); // (the save's debounce of 400 ms: the save is on its way)
  await mockEval(`setServerState("${STUDIO}", "unreachable", { detail: "connection refused" }); release("draft"); delete flags.draft;`, url);
  await page.waitForSelector(".remote-bar.off");
  // (two frames and the save's debounce of 400 ms: what the page would keep, it has kept by then)
  await until(async () => Object.keys(await store()).some((k) => k.startsWith("aiwb.draft.")), 1500);
  await clean("typed just before the server dropped, and not saved");
  if ((await box.textContent()) !== "remember the LUTs and the gamma typed in the dark") fail(`the box has "${await box.textContent()}"`);
  await box.click({ force: true }).catch(() => {}); await page.keyboard.press("End"); await page.keyboard.type(" and after");
  if ((await box.textContent()) !== "remember the LUTs and the gamma typed in the dark") fail(`the read-only box took what was typed during the outage: "${await box.textContent()}"`);
  // a collapse and a width, so that the browser keeps what it is to keep
  await page.locator('.side-section[data-server="s_empty"] > .side-section-head').click();
  await dragResizer(page, ".side-pane .resizer", 30);
  const kept = await clean("with a collapse and a width saved");
  if (JSON.parse(kept["aiwb.sel"] ?? "{}").chat !== KEY) fail(`the selection kept is ${kept["aiwb.sel"]}, not the section's chat`);
  if (J(JSON.parse(kept["aiwb.collapsed"] ?? "[]")) !== J(["s_empty"])) fail(`the collapse kept is ${kept["aiwb.collapsed"]}`);
  if (!kept["aiwb.widths"]) fail("no width is kept");
  const others = Object.keys(kept).filter((k) => !SETTINGS.includes(k));
  if (others.length) fail(`localStorage has other keys than the selection, the collapse, the widths and the page's settings: ${J(others)}`);

  // ---- a reload during the outage: nothing of the chat is known, and what was typed in the dark is given up
  await page.reload(); await page.waitForSelector(".side-tree .side-section");
  if (await page.locator(".chat-head .chat-head-server, .remote-bar").count() || (await page.content()).includes("typed in the dark")) fail("after a reload during the outage the section's chat, or what was typed in it, is on the page");
  await clean("after a reload during the outage");
  await mockEval(`setServerState("${STUDIO}", "connected");`, url);
  const row = page.locator(`.side-section[data-server="${STUDIO}"] .side-row:has(.side-name:text-is("Scratch"))`);
  await row.click({ timeout: 10000 });
  if (!await until(async () => (await box.textContent().catch(() => "")) === "remember the LUTs and the gamma", 10000)) fail(`back, the chat opens with "${await box.textContent().catch(() => "")}", not the draft its server has`);
  const end = await clean("at the end");

  for (const e of p.errors) fail(`page error: ${e}`);
  await p.ctx.close();

  // ---- a whiteboard of a section: what is drawn on it
  let boardKeys = [], boardOther = [];
  {
    await seed(url, "SEC");
    const q = await openPage({ url, browser, sel: { board: `${STUDIO}~b_loose`, chat: null }, size: [1280, 900] }), pg = q.page;
    const live = ".excalidraw:not(.excalidraw--view-mode) canvas.interactive";
    await pg.waitForSelector(live, { timeout: 15000 });
    const count = () => mockEval(`return onServer("${STUDIO}", () => scenes.b_loose.scene.elements.filter((e) => !e.isDeleted).length);`, url);
    let drawn = 0;
    /** Draws one more rectangle on the canvas, by the tool's key and a drag (as SEC.7 does). */
    const draw = async () => {
      const b = await pg.locator(live).boundingBox(), x = b.x + 420 + (drawn % 3) * 110, y = b.y + 300 + Math.floor(drawn / 3) * 110;
      drawn++;
      await pg.mouse.click(b.x + 200, b.y + b.height - 150);
      await pg.keyboard.press("r");
      await pg.mouse.move(x, y); await pg.mouse.down(); await pg.mouse.move(x + 40, y + 30, { steps: 4 }); await pg.mouse.move(x + 80, y + 60, { steps: 4 }); await pg.mouse.up();
    };
    await clean("the section's board open with its server's drawing", pg);
    let hold = null, held = 0;
    await pg.route(/\/boards\/b_loose\/scene\?/, async (route) => { held++; await new Promise((ok) => { hold = ok; }); await route.continue(); });
    await draw();
    if (!await until(() => held === 1, 15000)) fail("drawing on the section's board started no save of it");
    await clean("the save of the section's drawing on its way", pg);
    hold();
    if (!await until(async () => await count() === 2, 15000)) fail(`the drawing was not saved on Studio Mac: it has ${await count()} shapes, not 2`);
    await pg.unroute(/\/boards\/b_loose\/scene\?/);
    await clean("the section's drawing saved", pg);
    // its server not connected: the drawing waits in the window, under the banner, and in no storage
    await mockEval(`setServerState("${STUDIO}", "unreachable", { detail: "connection refused" });`, url);
    await draw();
    if (!await until(async () => (await pg.locator(".canvas .save-banner").textContent().catch(() => "")).includes("Not saved"), 15000)) fail("a drawing made while the board's server is away shows no banner that it is not saved");
    await draw();
    const waits = await clean("a drawing that waits for a server that is not connected", pg);
    if (await count() !== 2) fail("Studio Mac got a drawing while it was not connected");
    boardKeys = Object.keys(waits).sort(); boardOther = Object.keys(await otherOf(pg)).sort();
    const others = boardKeys.filter((k) => !SETTINGS.includes(k) && !k.startsWith("excalidraw"));
    if (others.length) fail(`with a section's board open localStorage has other keys than the page's settings and the canvas library's own: ${J(others)}`);
    // (the page asks before it unloads with a drawing that is not saved: the reload is the user's answer)
    pg.on("dialog", (d) => void d.accept().catch(() => {}));
    await pg.reload(); await pg.waitForSelector(".side-tree .side-section");
    if (await pg.locator(".excalidraw, .board-off, .takeover-panel").count()) fail("after a reload during the outage the section's board is on the page");
    await clean("after a reload during the board's outage", pg);
    await mockEval(`setServerState("${STUDIO}", "connected");`, url);
    for (const e of q.errors) fail(`page error: ${e}`);
    await q.ctx.close();
  }
  note(`localStorage at the end: ${Object.keys(end).sort().join(", ")}; no draft of the section's chat at any moment, a local chat's while its save was on its way. `
    + `A section's board, drawn on and not saved: localStorage ${boardKeys.join(", ")}; sessionStorage and IndexedDB: ${boardOther.join(", ") || "nothing"}`);
});
