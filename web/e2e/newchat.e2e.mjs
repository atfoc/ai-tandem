// "+" without an agent, and the defaults a group keeps, through the real page
// (plans/multiple-remote-servers.md, phase 3: AC28 and AC31).
//
// "+" makes a chat at once, with no agent menu: the agent is chosen in the chat's composer. A
// group remembers the folder, the model and the agent of the last first message, and the next "+"
// in that group starts with them; a "+" outside any group does not. The web unit tests read the
// five places as source (web/test/newchat.test.ts) and the paid suite (app.e2e.mjs) clicks some of
// them; this script clicks all five on the page itself in a headless Chrome (Playwright).
//
// The page is served by the test host (web/dev/host.mjs), which does for it what the app's main process does: it
// holds the server list, finds or starts this computer's server with the server program (--local-bin) and passes the
// page's calls, events and pictures on, over HTTPS with the secret and the pinned certificate. Nothing is injected into
// the page.
//
// It spends no money: the server runs the stand-in agent internal/agenttest/fake-claude and has
// no Cursor and no pi. It never touches the installed app: the script builds its own binary into a
// temp folder, sets a server up there (remote access: the certificate and the secret), starts it on a temp data folder
// and on free ports (the MCP listener too), and stops it at the end. Not part of `npm test`.
//
//   cd web && npm ci && npm run build && npm install --no-save playwright && npx playwright install chromium
//   node web/e2e/newchat.e2e.mjs
//
// Steps:
//   1 the five places that make a chat, each clicked: the empty state's "New chat", the sidebar's
//     "+", a group's "+", a board row's "+" and the board bar's "+ Chat on this board". Checked at
//     each: no menu item names an agent, exactly one chat is added, it is where the place says and
//     it is the one on screen
//   2 in the group: "+", a folder and a model picked in the composer, a first message answered by
//     the stand-in. Checked: the next "+" in the group starts with that folder and model, a "+"
//     outside any group starts with the server's default folder and model
//
// It prints one line per check, `ok <n> <what>` or `FAIL <n> <what> — <what was seen>`, saves a
// screenshot for a failed check, and exits with 1 when a check failed (2 when it could not run).
// A check whose line in this file is marked KNOWN-FAIL is a product fault that is known: it is
// printed as `KNOWN-FAIL <n> …`, counted at the end, and does not fail the script.
//
// Environment (all optional):
//   AIWB_E2E_BIN       server binary                    (default: built into the temp folder)
//   AIWB_E2E_CLIENT    built web client                 (default web/dist)
//   AIWB_E2E_KEEP=1    keep the temp folder (server log, screenshots) after a run that passed;
//                      after a failed run it is always kept, and its path is printed
import fs from "node:fs";
import path from "node:path";
import { Scratch, finish, holds as holdsFor, hostCall, hostFor, loadChromium, makeOut, onSignal, openPage as openHostPage, serverBinary, sleep, standInAgent, waitFor } from "./lib/rig.mjs";

// Everything the run makes: the binary, the server's folders, the log, screenshots.
const OUT = makeOut("newchat");

/** true when fn turned true in time, else the sentence of what was last seen. */
const holds = holdsFor;

// ---- checks: one line each

let failed = 0;
let known = 0; // checks that failed and are marked KNOWN-FAIL: printed, counted, not a failure of the script
let n = 0;
let page = null; // a failed check takes its screenshot and what it logged since the last check
let told = { errors: 0, requests: 0 };
async function check(what, pass, seen = "", { knownFail = false } = {}) {
  n++;
  const d = String(seen).replace(/\s+/g, " ").trim();
  if (pass === true) { console.log(`ok ${n} ${what}${d ? `  (${d})` : ""}`); }
  else {
    if (knownFail) known++; else failed++;
    const extra = [];
    if (typeof pass === "string") extra.push(pass);
    if (page) {
      const errs = page.errors.slice(told.errors), reqs = page.failedRequests.slice(told.requests);
      if (errs.length) extra.push(`console: ${errs.slice(-4).join(" ; ")}`);
      if (reqs.length) extra.push(`requests: ${reqs.slice(-6).join(" ; ")}`);
      const file = path.join(OUT, `fail-${n}.png`);
      await page.screenshot({ path: file }).then(() => extra.push(`screenshot ${file}`), () => {});
    }
    console.log(`${knownFail ? "KNOWN-FAIL" : "FAIL"} ${n} ${what} — ${[d, ...extra].filter(Boolean).join(" | ").replace(/\s+/g, " ") || "not as expected"}`);
  }
  if (page) told = { errors: page.errors.length, requests: page.failedRequests.length };
  return pass === true;
}
const skipped = (what, why) => console.log(`skip - ${what}  (${why})`);
/** A step that threw: one failed check, and the script goes on with the next step. */
async function step(name, fn) {
  try { await fn(); }
  catch (e) { await check(`${name}: the step ran to its end`, false, e.message); await page?.keyboard.press("Escape").catch(() => {}); }
}

// ---- the scratch server and the host

let A = null;    // this computer's server
let host = null; // the test host: the app's main process, for the page
const PICKED_NAME = "picked"; // the second folder: the one picked in the group's chat
let PICKED = "";

async function prepare() {
  const bin = serverBinary(OUT);
  A = new Scratch({ out: OUT, bin, agent: standInAgent(OUT), tag: "a", name: "This computer" });
  PICKED = path.join(A.work, PICKED_NAME);
  fs.mkdirSync(PICKED, { recursive: true });
  await A.setUp();
  // (the host starts this computer's server itself, as the app does, with the program wrapped to add the stand-in agent's flags)
  host = await hostFor({ out: OUT, name: "a", local: A });
}

const stateOf = async () => (await hostCall(host, "local", "GET", "/api/state")).json;
const chatOn = async (id) => (await stateOf())?.chats?.find((c) => c.id === id) ?? null;

// ---- the page

let browser = null;
// openPage opens the page of the host in a context of its own and keeps what its console says. errors: console
// errors and uncaught exceptions; failedRequests: requests that failed or were answered with 400 or more.
async function openPage() {
  const p = await openHostPage(browser, host, { wait: "#root *", timeout: 8000 });
  // A menu may come and go between two looks, so the page itself remembers every menu item it showed.
  await p.addInitScript(() => {
    window.__menuItems = [];
    const look = () => { for (const el of document.querySelectorAll(".menu .menu-item")) { const t = (el.textContent ?? "").replace(/\s+/g, " ").trim(); if (!window.__menuItems.includes(t)) window.__menuItems.push(t); } };
    new MutationObserver(look).observe(document, { childList: true, subtree: true, characterData: true });
  });
  await p.reload(); // (the init script is there from the next load)
  await p.waitForSelector("#root *", { timeout: 15000 });
  // This computer's section fills when the host has found or started the server and read its snapshot.
  await p.locator('.side-section[data-server="local"] .side-section-state', { hasText: /^Connected$/ }).waitFor({ timeout: 90000 });
  await p.locator("button.icon-btn.new:not([disabled])").waitFor({ timeout: 20000 });
  return p;
}
const sel = (p) => p.evaluate(() => JSON.parse(localStorage.getItem("aiwb.sel") ?? "{}"));
const menuItem = (p, text) => p.locator(".menu .menu-item", { hasText: text });
const one = (o) => JSON.stringify(o);
const box = (p) => p.locator(".composer .composer-input");
const groupHead = (p, name) => p.locator(".side-group-head").filter({ has: p.locator(".side-group-name", { hasText: new RegExp(`^${name}$`) }) });
const rowOf = (p, kind, name) => p.locator(`.side-row.is-${kind}`).filter({ has: p.locator(".side-name", { hasText: new RegExp(`^${name}$`) }) });
/** The composer of the chat on screen: in the panel beside a board, or on the chat's own page. */
const chatBox = (p) => p.locator(".board-panel .composer-input, .chat-col .composer-input");
const assistant = (p) => p.locator(".thread .msg.assistant").allInnerTexts();

async function hoverClick(row, button) {
  await row.hover();
  await row.locator(button).first().click();
}
/** The row or group head that opened in rename mode gets its name. */
async function nameIt(p, where, name) {
  const input = p.locator(`${where} .name-input`);
  await input.waitFor();
  await input.fill(name);
  await input.press("Enter");
  await input.waitFor({ state: "detached" });
}

// ---- step 1: the five places

/** The names an agent menu would show (the agent choice's labels). */
const AGENT_NAME = /^(Claude Code|Cursor|Pi)$/i;

/** Clicks one place that makes a chat and checks it. opener does the click; menu is the text of
 *  the chat item when the place opens a menu first (its other items are `others`), else null: the
 *  click itself makes the chat. placed says whether the chat's record is where the place puts it. */
async function place(p, name, { opener, menu = null, others = [], placed }) {
  const before = new Set((await stateOf()).chats.map((c) => c.id));
  const made = async () => { const c = (await sel(p)).chat; return c && !before.has(c) ? c : null; };
  await p.evaluate(() => { window.__menuItems = []; });
  await opener();
  if (menu) await menuItem(p, new RegExp(`^\\s*${menu}\\s*$`)).click();
  const id = await waitFor("a new chat is selected", made).catch(() => null);
  await chatBox(p).waitFor().catch(() => {});
  await sleep(400); // a menu or a second chat that came late would be here by now
  const items = await p.evaluate(() => window.__menuItems);
  const open = await p.locator(".menu").count();
  const agents = items.filter((t) => AGENT_NAME.test(t));
  const expected = menu ? [menu, ...others] : [];
  await check(`1 ${name}: no agent menu`,
    agents.length === 0 && open === 0 && items.length === expected.length && expected.every((t) => items.includes(t)),
    `menu items shown: ${items.join(", ") || "none"}; menus open after the click: ${open}`);
  const st = await stateOf();
  const added = st.chats.filter((c) => !before.has(c.id));
  const c = added[0] ?? null;
  const now = await sel(p);
  // (a chat's key on this computer is its own id, as it has always been)
  const where = c ? await placed(c, st) : false;
  await check(`1 ${name}: exactly one chat is added, where the place says, and it is the one on screen`,
    added.length === 1 && !!id && c.id === id && now.chat === id && where === true && !c.locked && (await chatBox(p).count()) === 1,
    `added ${added.length}; chat composers on screen ${await chatBox(p).count()}; selected ${one(now)}; the chat: ${c ? one({ id: c.id, group: c.group, board: c.board, agent: c.agent, locked: c.locked }) : "none"}`);
  return id;
}

const GROUP = "Research", BOARD = "blueprint"; // one word each: a board's name is also its folder's
let group = "";    // the group's id
let groupChat = ""; // the chat step 1 made in the group: unstarted, with the defaults the group had then

async function step1() {
  const ungrouped = (c) => c.group === "__ungrouped__" && !c.board;

  // The empty state shows only while nothing is selected: a fresh page on a fresh server.
  const home = page.locator("main.home");
  if (await home.locator("button.btn.primary", { hasText: /^\s*New chat\s*$/ }).waitFor({ timeout: 8000 }).then(() => true, () => false)) {
    await place(page, 'the empty state\'s "New chat"', { opener: () => home.locator("button.btn.primary", { hasText: /^\s*New chat\s*$/ }).click(), placed: ungrouped });
  } else skipped('1 the empty state\'s "New chat"', "the fresh page did not show the empty state");

  await place(page, 'the sidebar\'s "+"', {
    opener: () => page.click("button.icon-btn.new"), menu: "New chat", others: ["New whiteboard", "New group"], placed: ungrouped,
  });

  // A group: the sidebar's "+" offers "New group", and the new group's name opens in a box.
  await page.click("button.icon-btn.new");
  await menuItem(page, /^\s*New group\s*$/).click();
  await nameIt(page, ".side-group-head", GROUP);
  group = (await waitFor("the group exists", async () => (await stateOf()).groups?.find((g) => g.name === GROUP) ?? null)).id;
  groupChat = await place(page, `a group's "+"`, {
    opener: () => hoverClick(groupHead(page, GROUP), `button[title="New in ${GROUP}"]`), menu: "Chat", others: ["Whiteboard", "Group"],
    placed: (c) => c.group === group && !c.board,
  });

  // A board: made through the sidebar's "+", its row opens in rename mode.
  await page.click("button.icon-btn.new");
  await menuItem(page, /^\s*New whiteboard\s*$/).click();
  const board = await waitFor("the page selects its new board", async () => (await sel(page)).board ?? null);
  await nameIt(page, ".side-row.is-board", BOARD);
  await page.locator(".board-bar").waitFor();
  const onBoard = (c) => c.board === board;
  await place(page, `a board row's "+"`, { opener: () => hoverClick(rowOf(page, "board", BOARD), 'button[title="New chat on this board"]'), placed: onBoard });
  await place(page, 'the board bar\'s "+ Chat on this board"', { opener: () => page.locator(".board-bar button", { hasText: /^\+ Chat on this board$/ }).click(), placed: onBoard });

  const st = await stateOf();
  await check("1 the five places made five chats, none with a menu of agents", st.chats.length === 5, `${st.chats.length} chats on the server`);
}

// ---- step 2: the group's defaults

const folderChip = (p) => p.locator('.composer button.tchip[title^="Working directory"]');
const modelChip = (p) => p.locator('.composer button.tchip[title^="Model"]');
/** What the composer on screen shows as the chat's folder and model. */
const shows = async (p) => ({
  folder: ((await folderChip(p).getAttribute("title").catch(() => "")) ?? "").replace(/ — .*$/, "").replace(/^Working directory: /, ""),
  model: (await modelChip(p).innerText().catch(() => "")).replace(/[▾\s]+$/, "").trim(),
});

async function newIn(p, opener, item) {
  const before = new Set((await stateOf()).chats.map((c) => c.id));
  await opener();
  await menuItem(p, new RegExp(`^\\s*${item}\\s*$`)).click();
  const id = await waitFor("the page selects its new chat", async () => { const c = (await sel(p)).chat; return c && !before.has(c) ? c : null; });
  await box(p).waitFor();
  return id;
}
const newInGroup = (p) => newIn(p, () => hoverClick(groupHead(p, GROUP), `button[title="New in ${GROUP}"]`), "Chat");
const newUngrouped = (p) => newIn(p, () => p.click("button.icon-btn.new"), "New chat");

async function step2() {
  if (!group) { group = (await stateOf()).groups?.find((g) => g.name === GROUP)?.id ?? ""; }
  if (!group) throw new Error(`step 1 made no group "${GROUP}"`);
  const cat = (await stateOf()).catalogs?.claude;
  const dflt = cat?.default?.model ?? "";
  const other = cat?.models?.find((m) => m.id !== dflt);
  if (!dflt || !other) throw new Error(`the stand-in's catalog has no default model or no second model: ${one(cat).slice(0, 300)}`);
  const label = (id) => cat.models.find((m) => m.id === id)?.label ?? id;

  // Before anything is chosen: the chat step 1 made in the group has the server's defaults.
  const c0 = groupChat ? await chatOn(groupChat) : null;
  if (c0) await check("2 before a first message, the group's chat has the server's default folder and model", c0.cwd === A.work && c0.model === dflt, `folder ${c0.cwd}, model ${c0.model}; defaults: ${A.work}, ${dflt}`);
  else skipped("2 before a first message, the group's chat has the server's default folder and model", "step 1 made no chat in the group");

  const first = await newInGroup(page);
  await folderChip(page).click();
  const dirs = page.locator(".composer .menu.dirs");
  await dirs.locator(".dir-list").waitFor(); // the browser has loaded its first listing
  await dirs.locator(".dir-input").fill(PICKED);
  await dirs.locator(".dir-input").press("Enter");
  // The button reads "Use <name>" only once the typed folder's listing has loaded.
  await dirs.locator(".dir-foot button", { hasText: new RegExp(`^Use ${path.basename(PICKED)}$`) }).click();
  await waitFor("the chat's folder is the picked one", async () => (await chatOn(first))?.cwd === PICKED);
  await modelChip(page).click();
  await page.locator(`.composer .menu .menu-item[data-model-id="${other.id}"]`).click();
  await waitFor("the chat's model is the picked one", async () => (await chatOn(first))?.model === other.id);
  const c1 = await chatOn(first);
  await holds("the composer shows the picked model", async () => (await shows(page)).model === label(other.id), { timeout: 5000 });
  const s1 = await shows(page);
  await check("2 in the group: a folder and a model are picked in the composer", c1.group === group && c1.cwd === PICKED && c1.model === other.id && s1.folder === PICKED && s1.model === label(other.id),
    `the chat: folder ${c1.cwd}, model ${c1.model}; the composer: ${one(s1)}`);

  const text = "hello from the group";
  await box(page).click();
  await box(page).fill(text);
  await box(page).press("Enter");
  // The stand-in's reply names the model it was started with.
  const reply = await holds("the stand-in's reply", async () => (await assistant(page)).some((t) => t.includes(`FAKE(${other.id}): ${text}`)), { timeout: 20000 });
  await check("2 the first message is sent and the stand-in replies, started on the picked model", reply, `assistant messages: ${one(await assistant(page)).slice(0, 300)}`);
  await waitFor("the first turn ends", async () => (await chatOn(first))?.status === "ready").catch(() => {});

  const next = await newInGroup(page);
  const c2 = await chatOn(next);
  const s2 = await shows(page);
  await check('2 the next "+" in the group starts with that folder', c2.group === group && next !== first && c2.cwd === PICKED && s2.folder === PICKED,
    `the chat: group ${c2.group}, folder ${c2.cwd}; the composer shows ${s2.folder || "no folder chip"}; picked ${PICKED}`);
  await check('2 the next "+" in the group starts with that model and agent', c2.model === other.id && c2.agent === c1.agent && s2.model === label(other.id),
    `the chat: agent ${c2.agent}, model ${c2.model}; the composer shows "${s2.model}"; picked ${other.id} ("${label(other.id)}")`);

  const out = await newUngrouped(page);
  const c3 = await chatOn(out);
  const s3 = await shows(page);
  await check('2 a "+" outside any group starts with the server\'s default folder, not the group\'s', c3.group === "__ungrouped__" && c3.cwd === A.work && s3.folder === A.work,
    `the chat: group ${c3.group}, folder ${c3.cwd}; the composer shows ${s3.folder || "no folder chip"}; default ${A.work}`);
  await check('2 a "+" outside any group starts with the server\'s default model, not the group\'s', c3.model === dflt && s3.model === label(dflt),
    `the chat: model ${c3.model}; the composer shows "${s3.model}"; default ${dflt} ("${label(dflt)}")`);
}

// ---- main

let code = 0;
onSignal(async () => { await browser?.close().catch(() => {}); await host?.close().catch(() => {}); if (A) await A.stop(); });
try {
  await prepare();
  console.log(`# server on ${A.info?.address ?? `https://127.0.0.1:${A.port}`}, host on ${host.url}; files in ${OUT}`);
  browser = await (await loadChromium()).launch({ headless: true });
  page = await openPage();
  const pid = host.client.localInfo()?.pid;
  if (pid) A.pids.push(pid); // (the host started the server: finish() looks for its process)
  await step("1 the five places", step1);
  await step("2 the group's defaults", step2);
  await check("the page's console has no error", page.errors.length === 0, [...new Set(page.errors)].slice(0, 5).join(" ; "));
  await check("no request of the page failed", page.failedRequests.length === 0, [...new Set(page.failedRequests)].slice(0, 5).join(" ; "));
  code = failed ? 1 : 0;
} catch (e) {
  console.log(`FAIL - the script could not go on: ${e.stack || e}`);
  code = 2;
} finally {
  if (browser) await browser.close().catch(() => {});
  await host?.close().catch(() => {});
}
// (the host started the server; it ends it with the program's own command, so that no process is left)
page = null;
const end = A ? await finish([A]) : { alive: [], free: true };
if (A?.port && !(await check("the server is stopped and its port is free", end.free && end.alive.length === 0, `port ${A.port}; processes left: ${end.alive.join(", ") || "none"}`)) && !code) code = 1;
if (code === 0 && process.env.AIWB_E2E_KEEP !== "1") fs.rmSync(OUT, { recursive: true, force: true });
else console.log(`# files kept in ${OUT}`);
if (known) console.log(`# ${known} known failure${known === 1 ? "" : "s"} (KNOWN-FAIL above): product faults, not counted as failed`);
console.log(code === 0 ? `# passed (${n} checks${known ? `, ${known} KNOWN-FAIL` : ""})` : code === 2 ? "# could not run to the end" : `# failed (${failed} checks)`);
process.exit(code);
