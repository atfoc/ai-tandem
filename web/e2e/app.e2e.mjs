// End-to-end verification of the app (implementation spec, section 7.3).
//
// Simulates the user with no human: a headless Chrome (Playwright) does everything the user does
// in the app; the HTTP API and shell commands are used only for what is functional; files on disk
// are checked directly. Real Claude runs on Haiku and real Cursor on its cheapest model, using the
// logins already on the machine, so a run spends a little money. Not part of `npm test`.
//
//   cd web && npm install --no-save playwright && npx playwright install chromium
//   node web/e2e/app.e2e.mjs
//
// Environment (all optional):
//   AIWB_E2E_BIN     server binary        (default bin/ai-whiteboard)
//   AIWB_E2E_CLIENT  built web client     (default web/dist)
//   AIWB_E2E_HOME    data folder          (default a new temp folder)
//   AIWB_E2E_PORT    port                 (default 4749)
//
// Step 15 (Reveal in Finder) is checked by hand, not here. Exit code 0 only when every step passed.

import { chromium } from "playwright";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = path.resolve(process.env.AIWB_E2E_BIN || path.join(repo, "bin/ai-whiteboard"));
const CLIENT = path.resolve(process.env.AIWB_E2E_CLIENT || path.join(repo, "web/dist"));
const HOME = path.resolve(process.env.AIWB_E2E_HOME || fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-e2e-home-")));
const PORT = Number(process.env.AIWB_E2E_PORT || 4749);
const BASE = `http://127.0.0.1:${PORT}`;

// Everything the run makes besides the data folder: work folders, screenshots, the server log.
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-e2e-run-"));
const WORK = path.join(OUT, "work");
const LOG = path.join(OUT, "server.log");
const dir = (...p) => { const d = path.join(WORK, ...p); fs.mkdirSync(d, { recursive: true }); return d; };

const CLAUDE_MODEL_LABEL = "Haiku 4.5";
const CURSOR_MODEL_LABEL = "GPT-5.4 Nano"; // the cheapest model in Cursor's list
const TURN_TIMEOUT = 300_000;
const NUNITO = 6; // FONT_FAMILY.Nunito, Excalidraw's normal font

// ---------------------------------------------------------------- reporting

class Fail extends Error {
  constructor(expected, saw) { super(expected); this.expected = expected; this.saw = saw; }
}

let current = "";
let shotPage = null; // the page a failure screenshot is taken of
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const show = (v) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));
const log = (...a) => console.log(...a);

function check(cond, expected, saw) {
  if (!cond) throw new Fail(expected, typeof saw === "function" ? saw() : saw);
  log(`    ok  ${expected}`);
}

/** Marks what a waitFor condition saw when it is not met yet (shown if it never is). */
class Saw { constructor(v) { this.v = v; } }
const saw = (v) => new Saw(v);

async function waitFor(what, fn, { timeout = 30_000, every = 250 } = {}) {
  const until = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last instanceof Saw) last = last.v;
      else if (last) return last;
    } catch (e) { if (e instanceof Fail) throw e; last = e; }
    if (Date.now() > until) throw new Fail(what, last instanceof Error ? `error: ${last.message}` : last === undefined ? "(nothing)" : last);
    await sleep(every);
  }
}

async function step(n, title, fn) {
  current = `${n}. ${title}`;
  log(`\n== Step ${current}`);
  await fn();
}

// ---------------------------------------------------------------- server

let server = null;
let serverEnv = process.env;

function serverArgs() { return ["-home", HOME, "-port", String(PORT), "-client", CLIENT, "-no-open"]; }

async function hello() {
  try {
    const r = await fetch(`${BASE}/api/hello`, { signal: AbortSignal.timeout(1000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function startServer(env = process.env) {
  serverEnv = env;
  const fd = fs.openSync(LOG, "a");
  fs.writeSync(fd, `\n---- start ${new Date().toISOString()}\n`);
  const p = spawn(BIN, serverArgs(), { cwd: dir("default"), env, stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  const exited = new Promise((r) => p.once("exit", (code, sig) => r({ code, sig })));
  server = { p, exited };
  await waitFor("the server answers /api/hello", async () => {
    const h = await hello();
    if (h?.app === "ai-whiteboard" && h.pid === p.pid) return h;
    if (p.exitCode !== null) throw new Error(`server exited with ${p.exitCode}; log: ${tail(LOG)}`);
    return null;
  }, { timeout: 20_000 });
}

async function stopServer() {
  if (!server) return;
  const s = server;
  server = null;
  if (s.p.exitCode === null && s.p.signalCode === null) {
    s.p.kill("SIGTERM");
    const r = await Promise.race([s.exited, sleep(10_000).then(() => null)]);
    if (!r) { s.p.kill("SIGKILL"); await s.exited; }
  }
  await waitFor("the port is free after the server stops", async () => !(await hello()), { timeout: 10_000 });
}

function tail(file, n = 30) {
  try { return fs.readFileSync(file, "utf8").trimEnd().split("\n").slice(-n).join("\n"); } catch { return "(no log)"; }
}

// ---------------------------------------------------------------- HTTP API (functional checks only)

async function get(p) {
  const r = await fetch(BASE + p);
  const body = await r.text();
  if (!r.ok) throw new Error(`GET ${p}: ${r.status} ${body}`);
  return JSON.parse(body);
}
const state = () => get("/api/state");
const chatView = (id) => get(`/api/chats/${id}`);
const chatItems = async (id) => (await get(`/api/chats/${id}/items`)).items;
const BUSY = new Set(["thinking", "writing", "tool", "approval"]);

/** The assistant's text after the last user message. */
function lastReply(items) {
  let i = items.length - 1;
  while (i >= 0 && items[i].kind !== "user") i--;
  return items.slice(i + 1).filter((it) => it.kind === "text").map((it) => it.text ?? "").join("\n").trim();
}

async function turnsOf(id) { return (await chatView(id)).usage?.turns ?? 0; }

/** Waits for the turn after `before` turns to end, and returns the chat and its items. */
async function waitTurn(id, before, what = "the agent's turn ends") {
  await waitFor(what, async () => {
    const v = await chatView(id);
    if (v.status === "error") throw new Fail(what, `the chat is in error: ${v.error}`);
    return (v.usage?.turns ?? 0) > before && !BUSY.has(v.status) ? v : null;
  }, { timeout: TURN_TIMEOUT, every: 1000 });
  return { view: await chatView(id), items: await chatItems(id) };
}

// ---------------------------------------------------------------- files

const boardDir = (id) => path.join(HOME, "boards", id);
const drawingPath = (id) => path.join(boardDir(id), "drawing.excalidraw");
const readJSON = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
function liveElements(board) {
  try { return (readJSON(drawingPath(board)).elements ?? []).filter((e) => !e.isDeleted); } catch { return []; }
}
function listFiles(root) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); out.push(p); if (e.isDirectory()) walk(p); } };
  walk(root);
  return out.sort();
}
const brief = (e) => ({ id: e.id, type: e.type, roughness: e.roughness, roundness: e.roundness, fontFamily: e.fontFamily, strokeStyle: e.strokeStyle, text: e.text });

// ---------------------------------------------------------------- processes

function pgrep(pattern) {
  const r = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean).filter((pid) => Number(pid) !== process.pid);
}
function argsOf(pid) { return spawnSync("ps", ["-o", "args=", "-p", pid], { encoding: "utf8" }).stdout.trim(); }
const claudeProcs = (sid) => pgrep(sid).map((pid) => ({ pid, args: argsOf(pid) })).filter((p) => /claude/.test(p.args));

/** A PATH in which no folder has a sqlite3; every other program stays reachable. */
function pathWithoutSqlite() {
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  const out = dirs.map((d, i) => {
    if (!fs.existsSync(path.join(d, "sqlite3"))) return d;
    const farm = dir("nosqlite", String(i));
    for (const name of fs.readdirSync(d)) if (name !== "sqlite3") fs.symlinkSync(path.join(d, name), path.join(farm, name));
    return farm;
  });
  return out.join(":");
}

// ---------------------------------------------------------------- browser

let browser, context;
const clientIds = new WeakMap(); // page → the X-AIWB-Client its requests carry

async function openTab() {
  const page = await context.newPage();
  page.on("request", (r) => { const id = r.headers()["x-aiwb-client"]; if (id) clientIds.set(page, id); });
  page.on("pageerror", (e) => log(`    [page error] ${e.message}`));
  await page.goto(BASE + "/");
  shotPage = page;
  return page;
}

async function screenshot() {
  const p = shotPage && !shotPage.isClosed() ? shotPage : context?.pages().find((x) => !x.isClosed());
  if (!p) return "(no open page)";
  const f = path.join(OUT, `failure-${Date.now()}.png`);
  try { await p.screenshot({ path: f }); return f; } catch (e) { return `(screenshot failed: ${e.message})`; }
}

const sel = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("aiwb.sel") ?? "{}"));
const groupHead = (page, name) => page.locator(".side-group-head").filter({ has: page.locator(".side-group-name", { hasText: new RegExp(`^${name}$`) }) });
const groupBox = (page, name) => page.locator(".side-group").filter({ has: groupHead(page, name) });
const boardRow = (page, name) => page.locator(".side-row.is-board").filter({ has: page.locator(".side-name", { hasText: new RegExp(`^${name}$`) }) });
const menuItem = (page, text) => page.locator(".menu .menu-item", { hasText: text });

async function chatRow(page, id) {
  const v = await waitFor(`chat ${id} has a name`, async () => { const c = await chatView(id); return c.name ? c : null; }, { timeout: 60_000 });
  const rows = page.locator(".side-row.is-chat").filter({ has: page.locator(".side-name", { hasText: new RegExp(`^${v.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) });
  await waitFor(`one sidebar row for "${v.name}"`, async () => (await rows.count()) === 1 || saw(`${await rows.count()} rows`));
  return rows;
}
async function openChat(page, id) {
  await (await chatRow(page, id)).click();
  await waitFor(`chat ${id} is selected`, async () => (await sel(page)).chat === id || saw(`selection: ${show(await sel(page))}`));
}

async function hoverClick(page, row, button) {
  await row.hover();
  await row.locator(button).first().click();
}

/** Creates a chat through the sidebar or board bar and returns its id. */
async function newChatVia(page, opener, agentLabel) {
  const before = new Set((await state()).chats.map((c) => c.id));
  await opener();
  await menuItem(page, agentLabel).click();
  const id = await waitFor(`a new ${agentLabel} is created and selected`, async () => {
    const s = (await sel(page)).chat;
    return s && !before.has(s) ? s : null;
  });
  await page.locator(".composer .composer-input").waitFor();
  return id;
}

async function pickModel(page, label) {
  await page.locator('.composer button.tchip[title^="Model"]').click();
  await page.locator(".menu .menu-item.pick", { hasText: label }).click();
}
async function pickEffort(page, label) {
  await page.locator('.composer button.tchip[title^="Effort"]').click();
  await page.locator(".menu .menu-item.pick", { hasText: new RegExp(`^${label}`) }).click();
}
async function pickFolder(page, chatId, folder) {
  await page.locator('.composer button.tchip[title^="Working directory"], .composer button.tchip[title^="Folder not found"]').click();
  await page.locator(".dir-list").waitFor(); // the browser has loaded its first listing
  const input = page.locator(".dir-input");
  await input.fill(folder);
  await page.locator(".dir-sub", { hasText: path.basename(folder) }).first().waitFor().catch(() => {});
  await input.press("Enter");
  await page.locator(".dir-foot button", { hasText: `Use ${path.basename(folder)}` }).click();
  await waitFor(`the chat's folder is ${folder}`, async () => { const v = await chatView(chatId); return v.cwd === folder || saw(`cwd ${v.cwd}`); });
}

async function send(page, chatId, text) {
  const before = await turnsOf(chatId);
  const ta = page.locator(".composer .composer-input");
  await ta.fill(text);
  await ta.press("Enter");
  await waitFor(`the message "${text.slice(0, 40)}" is sent`, async () => (await chatItems(chatId)).some((i) => i.kind === "user" && i.text === text));
  return before;
}

async function canvasBox(page) {
  const b = await page.locator(".board-canvas").boundingBox();
  if (!b) throw new Fail("the board canvas is on screen", "no .board-canvas");
  return b;
}
/** Picks an Excalidraw tool (its radio input is covered by its icon, so the label is clicked). */
async function tool(page, name) {
  await page.locator("label", { has: page.locator(`[data-testid="toolbar-${name}"]`) }).click();
}
async function drawRect(page, fx, fy) {
  const b = await canvasBox(page);
  await tool(page, "rectangle");
  const x = b.x + b.width * fx, y = b.y + b.height * fy;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y + 40, { steps: 4 });
  await page.mouse.move(x + 120, y + 70, { steps: 4 });
  await page.mouse.up();
}
async function newElement(board, before, type, what) {
  return waitFor(what, () => liveElements(board).find((e) => e.type === type && !before.has(e.id)) ?? null, { timeout: 10_000, every: 100 });
}
const idSet = (board) => new Set(liveElements(board).map((e) => e.id));

// ---------------------------------------------------------------- the run

const ids = {};  // chats and boards made along the way
const folders = {};

async function run() {
  log(`AI Whiteboard end-to-end run\n  bin    ${BIN}\n  client ${CLIENT}\n  home   ${HOME}\n  port   ${PORT}\n  output ${OUT}`);
  for (const f of [BIN, path.join(CLIENT, "index.html")]) if (!fs.existsSync(f)) throw new Fail(`${f} exists (build first)`, "missing");
  if (await hello()) throw new Fail(`nothing is listening on port ${PORT}`, `a server answers at ${BASE}`);
  folders.p1 = dir("p1");
  folders.A = dir("ungrouped-a");
  folders.B = dir("research-b");
  fs.writeFileSync(path.join(folders.B, "README.md"), "A folder for the e2e run.\n");

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });

  await step(1, "Start the server; a second start prints \"already running\" and exits 0", async () => {
    await startServer();
    const r = spawnSync(BIN, serverArgs(), { encoding: "utf8", timeout: 15_000, cwd: dir("default") });
    check(r.status === 0, "the second start exits 0", { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr });
    check(/already running/.test(r.stdout + r.stderr), 'the second start prints "already running"', { stdout: r.stdout, stderr: r.stderr });
  });

  let page = await openTab();
  await page.locator(".side").waitFor();

  await step(2, "Group Research, a plain Claude chat: pickers change, the first message starts and locks it", async () => {
    await page.locator(".side-addgroup").click();
    const input = page.locator(".side-group-head .name-input");
    await input.waitFor({ timeout: 5000 }).catch(() => {});
    check(await input.isVisible(), "the new group opens in rename mode", "no name input in the group header");
    await input.fill("Research");
    await input.press("Enter");
    const g = await waitFor('the group is named "Research"', async () => (await state()).groups.find((x) => x.name === "Research") ?? null);
    ids.research = g.id;
    await groupHead(page, "Research").waitFor();

    ids.chat1 = await newChatVia(page, () => hoverClick(page, groupHead(page, "Research"), 'button[title="New in Research"]'), "Claude Code chat");
    const c0 = await chatView(ids.chat1);
    check(c0.group === ids.research && !c0.locked, "the chat is in Research and not locked", c0);
    await pickEffort(page, "Low");
    await pickModel(page, CLAUDE_MODEL_LABEL);
    await pickFolder(page, ids.chat1, folders.p1);
    const c1 = await chatView(ids.chat1);
    check(c1.model === "haiku" && !c1.effort && c1.cwd === folders.p1, "the pickers changed the chat (haiku, no effort, folder p1)", c1);
    check(await page.locator('.composer button.tchip[title^="Model"]', { hasText: CLAUDE_MODEL_LABEL }).isVisible(), `the model picker shows ${CLAUDE_MODEL_LABEL}`, await page.locator(".composer-tools").innerText());
    ids.sid1 = readJSON(path.join(HOME, "chats", ids.chat1, "chat.json")).sessionId;
    check(!!ids.sid1, "chat.json has a session id", readJSON(path.join(HOME, "chats", ids.chat1, "chat.json")));
    check(claudeProcs(ids.sid1).length === 0, "no claude process runs for the chat yet", claudeProcs(ids.sid1));

    const q = "Do you have any tools containing board?";
    const before = await send(page, ids.chat1, q);
    const procs = await waitFor("a claude process runs with the chat's session id", async () => { const p = claudeProcs(ids.sid1); return p.length ? p : null; }, { timeout: 15_000 });
    check(!procs.some((p) => /mcp-config/.test(p.args)), "the plain chat's process has no board MCP server", procs);
    await waitFor("the pickers are locked", async () => (await page.locator('.composer button.tchip[title^="Model"]').count()) === 0 && (await chatView(ids.chat1)).locked);
    check(await page.locator(".composer .tchip.static", { hasText: CLAUDE_MODEL_LABEL }).isVisible(), "the composer shows the model as fixed", await page.locator(".composer-tools").innerText());
    const { items } = await waitTurn(ids.chat1, before);
    const reply = lastReply(items);
    check(/^\W*no\b/i.test(reply) || /\b(no|don't|do not|none)\b/i.test(reply.split("\n")[0]), 'the reply is "No"', reply);
    check(!items.some((i) => i.kind === "tool" && /^mcp__board__/.test(i.name ?? "")), "no board tool was called", items);
    const named = await waitFor("the chat gets a name", async () => (await chatView(ids.chat1)).name || null, { timeout: 60_000 });
    await (await chatRow(page, ids.chat1)).waitFor();
    log(`    chat named "${named}"`);
  });

  await step(3, "A folder change in Research carries to the next chat there, not to ungrouped", async () => {
    // Ungrouped keeps its own defaults: give it some first, so the Research change can't leak into it.
    ids.u1 = await newChatVia(page, async () => { await page.locator("button.icon-btn.new").click(); }, "Claude Code chat");
    await pickModel(page, "Sonnet 5");
    await pickEffort(page, "Medium");
    await pickFolder(page, ids.u1, folders.A);

    ids.chat2 = await newChatVia(page, () => hoverClick(page, groupHead(page, "Research"), 'button[title="New in Research"]'), "Claude Code chat");
    await pickFolder(page, ids.chat2, folders.B);
    const c2 = await chatView(ids.chat2);

    ids.chat3 = await newChatVia(page, () => hoverClick(page, groupHead(page, "Research"), 'button[title="New in Research"]'), "Claude Code chat");
    const c3 = await chatView(ids.chat3);
    check(c3.cwd === folders.B, "the third chat starts in the folder picked in the second", { third: c3.cwd, picked: folders.B });
    check(c3.model === c2.model && (c3.effort ?? "") === (c2.effort ?? ""), "the third chat has the second's model and effort", { second: [c2.model, c2.effort], third: [c3.model, c3.effort] });
    // name it, so later steps can find it in the sidebar
    await page.locator(".chat-head-name").click();
    await page.locator(".chat-head .name-input").fill("codeword chat");
    await page.locator(".chat-head .name-input").press("Enter");
    await waitFor("the third chat is renamed", async () => (await chatView(ids.chat3)).name === "codeword chat");

    ids.u2 = await newChatVia(page, async () => { await page.locator("button.icon-btn.new").click(); }, "Claude Code chat");
    const u2 = await chatView(ids.u2);
    check(u2.group === "__ungrouped__" && u2.cwd !== folders.B, "a new ungrouped chat does not start in Research's folder", u2);
    check(!(u2.model === c3.model && (u2.effort ?? "") === (c3.effort ?? "")), "a new ungrouped chat does not get Research's model and effort", { ungrouped: [u2.model, u2.effort], research: [c3.model, c3.effort] });
  });

  await step(4, "New whiteboard in Research: files at once; rename to arch keeps the folder", async () => {
    await hoverClick(page, groupHead(page, "Research"), 'button[title="New in Research"]');
    const t0 = Date.now();
    await menuItem(page, "Whiteboard").click();
    ids.arch = await waitFor("a new board is selected", async () => (await sel(page)).board ?? null);
    const files = await waitFor("board.json and drawing.excalidraw exist", () =>
      fs.existsSync(path.join(boardDir(ids.arch), "board.json")) && fs.existsSync(drawingPath(ids.arch)) ? Date.now() - t0 : null, { timeout: 2000, every: 50 });
    check(files < 2000, "the board's files exist at once", `${files} ms`);
    const input = page.locator(".side-board .name-input");
    check(await input.isVisible(), "the new board opens in rename mode", "no name input");
    await input.fill("arch");
    await input.press("Enter");
    await waitFor("board.json has the name arch", () => readJSON(path.join(boardDir(ids.arch), "board.json")).name === "arch" || saw(readJSON(path.join(boardDir(ids.arch), "board.json"))));
    const bj = readJSON(path.join(boardDir(ids.arch), "board.json"));
    check(bj.id === ids.arch && bj.group === ids.research && fs.existsSync(drawingPath(ids.arch)), "the renamed board keeps its folder", bj);
    await boardRow(page, "arch").waitFor();
  });

  await step(5, "Claude board chat draws client → server → database cleanly", async () => {
    ids.claudeBoard = await newChatVia(page, () => page.locator(".board-bar button", { hasText: "+ Chat on this board" }).click(), "Claude Code chat");
    const v = await chatView(ids.claudeBoard);
    check(v.board === ids.arch && v.model === "haiku", "a Claude chat on arch with Research's model (haiku)", v);
    const presence = page.locator(".presence").first().waitFor({ timeout: TURN_TIMEOUT }).then(() => true, () => false);
    let flashAt = 0;
    const flash = page.locator(".flash").first().waitFor({ timeout: TURN_TIMEOUT }).then(() => { flashAt = Date.now(); return true; }, () => false);
    const saved = flash.then(async (ok) => {
      if (!ok) return null;
      const t = await waitFor("x", () => liveElements(ids.arch).some((e) => e.type === "rectangle") ? Date.now() : null, { timeout: 10_000, every: 50 }).catch(() => null);
      return t && t - flashAt;
    });
    const before = await send(page, ids.claudeBoard, "Draw client → server → database");
    check(await presence, "the working pill shows while the agent works", "no .presence");
    check(await flash, "the agent outline shows where it drew", "no .flash");
    const lag = await saved;
    check(lag !== null && lag <= 1500, "drawing.excalidraw on disk has the elements within about a second", lag === null ? "not saved within 10 s" : `${lag} ms`);
    await waitTurn(ids.claudeBoard, before);
    await sleep(800);
    const els = liveElements(ids.arch);
    const rects = els.filter((e) => e.type === "rectangle");
    const texts = els.filter((e) => e.type === "text");
    check(rects.length >= 3, "at least three rectangles are drawn", els.map(brief));
    check(rects.every((e) => e.roughness === 0 && e.roundness === null), "the rectangles are sharp and not rough", rects.map(brief));
    check(texts.length > 0 && texts.every((e) => e.fontFamily === NUNITO), "the text is in the normal font", texts.map(brief));
    const labels = texts.map((t) => t.text.toLowerCase()).join(" ");
    check(["client", "server", "database"].every((w) => labels.includes(w)), "the boxes read client, server and database", labels);
  });

  await step(6, "Drawing by hand: sharp, roughness 0, normal font; a stroke style change carries to another board", async () => {
    await page.keyboard.press("Escape");
    let before = idSet(ids.arch);
    await drawRect(page, 0.62, 0.62);
    const r = await newElement(ids.arch, before, "rectangle", "the hand-drawn rectangle is saved");
    check(r.roughness === 0 && r.roundness === null, "the hand-drawn rectangle is sharp with roughness 0", brief(r));
    // the rectangle is selected: change its stroke style through Excalidraw's own panel
    await page.locator('label[title="Dashed"]').click();
    await waitFor("the rectangle turns dashed", () => liveElements(ids.arch).find((e) => e.id === r.id)?.strokeStyle === "dashed" || saw(brief(liveElements(ids.arch).find((e) => e.id === r.id) ?? {})), { timeout: 10_000 });

    before = idSet(ids.arch);
    const b = await canvasBox(page);
    await page.keyboard.press("Escape");
    await tool(page, "text");
    await page.mouse.click(b.x + b.width * 0.62, b.y + b.height * 0.85);
    await page.keyboard.type("hand note");
    await page.keyboard.press("Escape");
    const t = await newElement(ids.arch, before, "text", "the hand-written text is saved");
    check(t.fontFamily === NUNITO, "hand-written text is in the normal font", brief(t));

    // another board: a new one, "scratch"
    await hoverClick(page, groupHead(page, "Research"), 'button[title="New in Research"]');
    await menuItem(page, "Whiteboard").click();
    ids.scratch = await waitFor("the second board is selected", async () => { const b = (await sel(page)).board; return b && b !== ids.arch ? b : null; });
    const input = page.locator(".side-board .name-input");
    await input.fill("scratch");
    await input.press("Enter");
    await page.locator('[data-testid="toolbar-rectangle"]').waitFor();
    before = idSet(ids.scratch);
    await drawRect(page, 0.5, 0.5);
    const r2 = await newElement(ids.scratch, before, "rectangle", "the rectangle on the other board is saved");
    check(r2.strokeStyle === "dashed", "the stroke style change is kept on another board", brief(r2));
    check(r2.roughness === 0 && r2.roundness === null, "it is still sharp with roughness 0", brief(r2));
  });

  await step(7, "Cursor board chat adds a cache; context meter; then sqlite3 off the PATH", async () => {
    await boardRow(page, "arch").click();
    await waitFor("arch is open", async () => (await sel(page)).board === ids.arch);
    ids.cursorBoard = await newChatVia(page, () => page.locator(".board-bar button", { hasText: "+ Chat on this board" }).click(), "Cursor chat");
    await waitFor("Cursor's model list is loaded", async () => (await page.locator('.composer button.tchip[title^="Model"]').count()) > 0, { timeout: 60_000 });
    await pickModel(page, CURSOR_MODEL_LABEL);
    const v = await chatView(ids.cursorBoard);
    check(v.agent === "cursor" && v.board === ids.arch && v.model === "gpt-5.4-nano", `a Cursor chat on arch with ${CURSOR_MODEL_LABEL}`, v);
    const filesBefore = listFiles(v.cwd);
    const elsBefore = idSet(ids.arch);
    const before = await send(page, ids.cursorBoard, "Add a cache next to the server");
    const { items, view } = await waitTurn(ids.cursorBoard, before);
    const added = liveElements(ids.arch).filter((e) => !elsBefore.has(e.id));
    check(added.length > 0, "the edit lands on arch", { added: added.map(brief), items });
    const labels = await page.locator(".tool .tool-label").allInnerTexts();
    check(labels.some((l) => /^Edited arch · \+\d+/.test(l)), 'a tool card reads "Edited arch · +N"', labels);
    log(`    tool cards: ${labels.join(" | ")}`);
    check(!items.some((i) => i.kind === "perm") && (await page.locator(".perm").count()) === 0, "no approval card appears", items.filter((i) => i.kind === "perm"));
    const filesAfter = listFiles(view.cwd);
    check(show(filesAfter) === show(filesBefore), "the chat's folder has no new files", { before: filesBefore, after: filesAfter });
    const u = await waitFor("the context usage is read", async () => { const c = await chatView(ids.cursorBoard); return c.usage.ctxIn > 0 && c.usage.ctxWindow > 0 && !c.usage.ctxError ? c.usage : null; }, { timeout: 30_000 });
    const meter = page.locator(".composer .ctx-meter");
    await waitFor("the meter shows a share of the window", async () => /\d+(\.\d+)?%/.test(await meter.innerText()) || saw(await meter.innerText()));
    log(`    meter: ${(await meter.innerText()).replace(/\s+/g, " ")} (${u.ctxIn} of ${u.ctxWindow})`);

    await stopServer();
    const PATH = pathWithoutSqlite();
    const env = { ...process.env, PATH };
    const which = spawnSync("/bin/sh", ["-c", "command -v sqlite3; command -v claude; command -v agent"], { env, encoding: "utf8" }).stdout.trim().split("\n");
    check(which.length === 2 && !which.some((w) => /sqlite3/.test(w)), "the new PATH has claude and agent but no sqlite3", which);
    await startServer(env);
    await waitFor("the page reconnects", async () => (await page.locator(".offline").count()) === 0 && (await page.locator(".composer .composer-input").count()) > 0, { timeout: 30_000 });
    const b2 = await send(page, ids.cursorBoard, "Reply with just OK.");
    await waitTurn(ids.cursorBoard, b2);
    const err = await waitFor("the chat reports the context error", async () => (await chatView(ids.cursorBoard)).usage.ctxError || null, { timeout: 30_000 });
    check(err === "sqlite3 not found; the context meter needs it", "the error is the sqlite3 one", err);
    const m = page.locator(".composer .ctx-meter");
    await waitFor('the meter shows "Context unavailable"', async () => (await m.innerText()).includes("Context unavailable") || saw(await m.innerText()));
    const title = await m.getAttribute("title");
    check(title === "sqlite3 not found; the context meter needs it", "the meter says why", title);
    const txt = await m.innerText();
    check(!/\d/.test(txt), "the meter shows no number", txt);
  });

  await step(8, "The Claude board chat can't read the board's file with cat", async () => {
    await openChat(page, ids.claudeBoard);
    const file = drawingPath(ids.arch);
    const before = await send(page, ids.claudeBoard, `read ${file} with cat`);
    const { items } = await waitTurn(ids.claudeBoard, before);
    const sinceUser = items.slice(items.map((i) => i.kind).lastIndexOf("user"));
    check(!sinceUser.some((i) => i.kind === "perm") && (await page.locator(".perm.pending").count()) === 0, "no approval card appears", sinceUser);
    // Only the board tools may touch a board; any other tool that reached for the file must have been stopped.
    const fileTools = sinceUser.filter((i) => i.kind === "tool" && !/^mcp__board__/.test(i.name ?? "") && /drawing\.excalidraw|ai-whiteboard|boards\//.test(JSON.stringify(i.input ?? i.partial ?? "")));
    const got = fileTools.filter((i) => !i.isError && !i.denied);
    check(got.length === 0, "no file or shell tool read the board's file (refused or denied)", { fileTools, reply: lastReply(items) });
    const leaked = sinceUser.filter((i) => i.kind === "tool" && !/^mcp__board__/.test(i.name ?? "") && typeof i.result === "string" && /"elements"\s*:/.test(i.result));
    check(leaked.length === 0, "the file's content is not read", leaked);
    log(`    ${fileTools.length ? fileTools.map((i) => `${i.name} ${i.denied ? "denied" : "failed"} (${String(i.result ?? "").replace(/\s+/g, " ").slice(0, 120)})`).join(", ") : "no file tool was tried"}; reply: ${lastReply(items).slice(0, 160)}`);
  });

  await step(9, "A second tab takes over after the first writes its pending edits; Use here takes it back", async () => {
    await boardRow(page, "arch").click();
    await page.locator('[data-testid="toolbar-rectangle"]').waitFor();
    const before = idSet(ids.arch);
    await page.keyboard.press("Escape");
    await drawRect(page, 0.3, 0.75);
    const savedAlready = liveElements(ids.arch).some((e) => !before.has(e.id));
    const page2 = await openTab();
    await page.locator(".takeover h2", { hasText: "Opened in another window" }).waitFor({ timeout: 15_000 }).catch(() => {});
    check(await page.locator(".takeover h2", { hasText: "Opened in another window" }).isVisible(), 'the first tab shows "Opened in another window"', await page.locator("body").innerText());
    const added = liveElements(ids.arch).filter((e) => !before.has(e.id) && e.type === "rectangle");
    check(added.length === 1, `the first tab's pending edit is in the file${savedAlready ? " (it was already saved before the takeover)" : ""}`, liveElements(ids.arch).map(brief));
    await page2.locator(".side").waitFor();
    await page.locator(".takeover button", { hasText: "Use here" }).click();
    await page.locator(".side").waitFor({ timeout: 15_000 });
    await page2.locator(".takeover h2", { hasText: "Opened in another window" }).waitFor({ timeout: 15_000 }).catch(() => {});
    check(await page2.locator(".takeover h2", { hasText: "Opened in another window" }).isVisible(), "Use here takes it back: the second tab shows the takeover screen", await page2.locator("body").innerText());
    shotPage = page;
    await page2.close();
  });

  await step(10, "With all tabs closed, a board chat asked through the API says the board isn't open", async () => {
    await page.close();
    await sleep(1000);
    const cid = randomUUID();
    const sse = await new Promise((resolve, reject) => {
      const req = http.get(`${BASE}/api/events?client=${cid}`, (res) => {
        let buf = "";
        res.on("data", (d) => { buf += d; const m = /data: (.*)\n\n/.exec(buf); if (m) resolve({ req, hello: JSON.parse(m[1]) }); });
      });
      req.on("error", reject);
      setTimeout(() => reject(new Error("no hello on the event stream")), 5000);
    });
    check(sse.hello.type === "hello" && sse.hello.active === true, "the fresh client is the active one (no tab is open)", sse.hello);
    const before = await turnsOf(ids.claudeBoard);
    const r = await fetch(`${BASE}/api/chats/${ids.claudeBoard}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-AIWB-Client": cid },
      body: JSON.stringify({ text: "Read the board again now with read_board (don't rely on earlier reads) and tell me in one sentence what is on it.", context: "" }),
    });
    const body = await r.text();
    sse.req.destroy(); // no client from here on
    check(r.status === 200, "the message is accepted", { status: r.status, body });
    const { items } = await waitTurn(ids.claudeBoard, before);
    const sinceUser = items.slice(items.map((i) => i.kind).lastIndexOf("user"));
    const reads = sinceUser.filter((i) => i.kind === "tool" && /^mcp__board__/.test(i.name ?? ""));
    check(reads.length > 0 && reads.every((i) => i.isError), "the board call fails (no window is open)", reads);
    const reply = lastReply(items);
    check(/isn't open|is not open|not open|must be open|window is closed|closed/i.test(reply), "the reply says the board isn't open", reply);
  });

  await step(11, "Stop the server mid-turn; after a restart the chat shows Stopped and continues its session", async () => {
    page = await openTab();
    await page.locator(".side").waitFor();
    await openChat(page, ids.chat3);
    let b = await send(page, ids.chat3, "Remember this codeword: PELICAN-42. Reply with just OK.");
    await waitTurn(ids.chat3, b);
    b = await send(page, ids.chat3, "Write the numbers from 1 to 300, each on its own line, with no other text.");
    await waitFor("the agent is working", async () => BUSY.has((await chatView(ids.chat3)).status), { every: 100 });
    await sleep(1500);
    const mid = await chatView(ids.chat3);
    check(BUSY.has(mid.status), "the turn is still running when the server stops", mid.status);
    await stopServer();
    await startServer();
    await waitFor("the page reconnects", async () => (await page.locator(".offline").count()) === 0 && (await groupHead(page, "Research").count()) > 0, { timeout: 30_000 });
    const v = await chatView(ids.chat3);
    check(v.group === ids.research && v.status === "stopped", "the chat is in Research and Stopped", v);
    const row = await chatRow(page, ids.chat3);
    check((await groupBox(page, "Research").locator(".side-row.is-chat", { hasText: "codeword chat" }).count()) === 1, "the sidebar shows it in Research", await groupBox(page, "Research").innerText());
    check((await row.locator(".side-sub").innerText()).trim() === "Stopped", 'its row says "Stopped"', await row.innerText());
    const users = page.locator(".msg.user", { hasText: "PELICAN-42" });
    await users.first().waitFor({ timeout: 10_000 }).catch(() => {});
    check(await users.count() === 1, "its history is shown", await page.locator(".thread").innerText());
    b = await send(page, ids.chat3, "What was the codeword I asked you to remember? Reply with just the codeword.");
    const { items } = await waitTurn(ids.chat3, b);
    check(/PELICAN-42/.test(lastReply(items)), "the resumed session remembers the codeword", lastReply(items));
  });

  await step(12, "A locked chat whose folder moved shows the folder error; another folder continues the session", async () => {
    check(claudeProcs(ids.sid1).length === 0, "the chat's agent is not running", claudeProcs(ids.sid1));
    const moved = folders.p1 + "-moved";
    fs.renameSync(folders.p1, moved);
    await openChat(page, ids.chat1);
    const err = page.locator(".composer .composer-err");
    await waitFor("the folder error shows", async () => (await err.count()) > 0 && /Folder not found/.test(await err.innerText()) || saw(await page.locator(".composer").innerText()));
    log(`    ${await err.innerText()}`);
    await pickFolder(page, ids.chat1, moved);
    const v = await chatView(ids.chat1);
    check(!v.folderMissing && v.status !== "error", "the folder error clears", v);
    const b = await send(page, ids.chat1, "What exact question did I ask you in my first message? Quote it.");
    const procs = await waitFor("the agent resumes the chat's session", async () => { const p = claudeProcs(ids.sid1); return p.length ? p : null; }, { timeout: 15_000 });
    check(procs.some((p) => p.args.includes(`--resume ${ids.sid1}`)), "the process resumes the same session id", procs);
    const { items } = await waitTurn(ids.chat1, b);
    check(/board/i.test(lastReply(items)), "the session continues (it recalls the first question)", lastReply(items));
  });

  await step(13, "Archive the board; show archived; read-only; unarchiving one chat brings the board back", async () => {
    const boardRowArch = boardRow(page, "arch");
    await hoverClick(page, boardRowArch, 'button[title="More"]');
    await menuItem(page, "Archive").click();
    await waitFor("the board is archived", async () => (await state()).boards.find((b) => b.id === ids.arch)?.archived);
    const sc = await state();
    const archChats = sc.chats.filter((c) => c.board === ids.arch);
    check(archChats.length === 2 && archChats.every((c) => c.archived), "its chats are archived", archChats);
    await waitFor("the board and its chats disappear from the sidebar", async () => (await boardRow(page, "arch").count()) === 0 || saw(await page.locator(".side-tree").innerText()));
    await page.locator(".side-foot input").check();
    const row = boardRow(page, "arch");
    await row.waitFor();
    const archivedChats = groupBox(page, "Research").locator(".side-board.archived .side-row.is-chat.archived");
    check(await archivedChats.count() === 2, "Show archived shows the board's chats greyed in place under it", await groupBox(page, "Research").innerHTML());
    await row.click();
    await page.locator(".archived-note", { hasText: "read-only" }).waitFor();
    check(await page.locator('[data-testid="toolbar-rectangle"]').count() === 0, "the archived board opens read-only (no drawing tools)", "the rectangle tool is shown");
    const claudeRow = await chatRow(page, ids.claudeBoard);
    await hoverClick(page, claudeRow, 'button[title="More"]');
    await menuItem(page, "Unarchive").click();
    await waitFor("the board comes back", async () => !(await state()).boards.find((b) => b.id === ids.arch)?.archived);
    const s2 = await state();
    check(!s2.chats.find((c) => c.id === ids.claudeBoard).archived, "the unarchived chat is back", s2.chats.find((c) => c.id === ids.claudeBoard));
    check(s2.chats.find((c) => c.id === ids.cursorBoard).archived === true, "the other chat stays archived", s2.chats.find((c) => c.id === ids.cursorBoard));
    await page.locator(".side-foot input").uncheck();
    await waitFor("the board shows unarchived", async () => (await boardRow(page, "arch").count()) === 1 && !(await page.locator(".side-board.archived").count()));
  });

  await step(14, "Delete Research moving its contents to ungrouped; delete a board with confirmation", async () => {
    await hoverClick(page, groupHead(page, "Research"), 'button[title="More"]');
    await menuItem(page, "Delete").click();
    await page.locator(".dialog button", { hasText: "Move contents to ungrouped" }).click();
    await waitFor("Research is gone", async () => !(await state()).groups.some((g) => g.id === ids.research));
    const s = await state();
    const moved = [...s.boards.filter((b) => [ids.arch, ids.scratch].includes(b.id)).map((b) => b.group), ...s.chats.filter((c) => [ids.chat1, ids.chat2, ids.chat3].includes(c.id)).map((c) => c.group)];
    check(moved.length === 5 && moved.every((g) => g === "__ungrouped__"), "its boards and chats are now ungrouped", moved);
    check(await groupHead(page, "Research").count() === 0, "the group is gone from the sidebar", await page.locator(".side-tree").innerText());

    const archChats = s.chats.filter((c) => c.board === ids.arch).map((c) => c.id);
    await hoverClick(page, boardRow(page, "arch"), 'button[title="More"]');
    await menuItem(page, "Delete").click();
    const dlg = page.locator(".dialog");
    await dlg.waitFor();
    check(/Delete arch\?/.test(await dlg.innerText()), "a confirmation asks to delete arch", await dlg.innerText());
    await dlg.locator("button", { hasText: /^Delete$/ }).click();
    await waitFor("the board is deleted", async () => !(await state()).boards.some((b) => b.id === ids.arch));
    check(!fs.existsSync(boardDir(ids.arch)), "the board's folder and file are gone", fs.existsSync(boardDir(ids.arch)) ? fs.readdirSync(boardDir(ids.arch)) : []);
    const left = archChats.filter((id) => fs.existsSync(path.join(HOME, "chats", id)));
    check(archChats.length === 2 && left.length === 0, "its chats' folders are gone", { chats: archChats, left });
    check(!(await state()).chats.some((c) => archChats.includes(c.id)), "its chats are gone from the app", archChats);
    check(await boardRow(page, "arch").count() === 0, "the board is gone from the sidebar", await page.locator(".side-tree").innerText());
  });

  await step(16, "The Cursor CLI config has the two deny rules once after two server starts", async () => {
    const cfgPath = path.join(process.env.CURSOR_CONFIG_DIR || path.join(os.homedir(), ".cursor"), "cli-config.json");
    const cfg = readJSON(cfgPath);
    const deny = cfg.permissions?.deny ?? [];
    for (const rule of [`Read(${HOME}/**)`, `Write(${HOME}/**)`]) {
      check(deny.filter((r) => r === rule).length === 1, `${rule} is there exactly once`, deny);
    }
  });

  await step(17, "While the agent works, send is greyed out and Enter does nothing; the text sends after; the API gets 409", async () => {
    await openChat(page, ids.chat3);
    const cid = clientIds.get(page);
    check(!!cid, "the tab's client id is known", cid);
    const b = await send(page, ids.chat3, "Write the numbers from 1 to 400, each on its own line, with no other text.");
    await waitFor("the agent is working", async () => BUSY.has((await chatView(ids.chat3)).status), { every: 100 });
    const sendBtn = page.locator(".composer button.send:not(.stop)");
    await waitFor("send is greyed out", async () => await sendBtn.isDisabled());
    const ta = page.locator(".composer .composer-input");
    const later = "Reply with just DONE.";
    await ta.fill(later);
    await ta.press("Enter");
    await sleep(500);
    const busyNow = BUSY.has((await chatView(ids.chat3)).status);
    check(busyNow, "the agent is still working during the checks", (await chatView(ids.chat3)).status);
    check(await ta.innerText() === later, "the box still holds the text after Enter", await ta.innerText());
    check(!(await chatItems(ids.chat3)).some((i) => i.kind === "user" && i.text === later), "Enter did not send", "the text was sent");
    check(await sendBtn.isDisabled(), "send stays greyed out with text in the box", "enabled");
    const r = await fetch(`${BASE}/api/chats/${ids.chat3}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-AIWB-Client": cid }, body: JSON.stringify({ text: "hi", context: "" }),
    });
    const body = await r.text();
    check(r.status === 409 && /still working/.test(body), "a POST to /messages mid-turn gets 409 (busy)", { status: r.status, body });
    await waitTurn(ids.chat3, b);
    await waitFor("send is enabled once the turn ends", async () => !(await sendBtn.isDisabled()));
    const b2 = await turnsOf(ids.chat3);
    await ta.press("Enter");
    await waitFor("the waiting text sends", async () => (await chatItems(ids.chat3)).some((i) => i.kind === "user" && i.text === later));
    await waitTurn(ids.chat3, b2);
  });

  await step(18, "Claude subagents: two rows run then complete; the drawer; Esc closes it only; a reload keeps them", async () => {
    ids.claudeSubs = await newChatVia(page, async () => { await page.locator("button.icon-btn.new").click(); }, "Claude Code chat");
    await pickModel(page, CLAUDE_MODEL_LABEL);
    await pickFolder(page, ids.claudeSubs, folders.B); // it has a README.md
    const v0 = await chatView(ids.claudeSubs);
    check(v0.agent === "claude" && v0.model === "haiku" && !v0.board, "a plain Claude chat on Haiku", v0);
    const before = await send(page, ids.claudeSubs, "Use the Agent tool twice in parallel: one subagent runs `ls`, the other reads README.md. Then summarise.");

    // Rows appear where the Agent calls are; each is watched from its first sight on.
    const rows = page.locator(".thread .subagent");
    const seenDot = [];
    const marks = await waitFor("two subagent rows show ✓", async () => {
      const now = await rows.evaluateAll((els) => els.map((e) => ({
        dot: !!e.querySelector(".sub-mark .sub-dot"), mark: e.querySelector(".sub-mark")?.textContent ?? "", cls: e.className,
        line: e.querySelector(".sub-line")?.textContent ?? "",
      })));
      now.forEach((r, i) => { if (r.dot) seenDot[i] = true; });
      return now.length === 2 && now.every((r) => r.mark === "✓" && /st-completed/.test(r.cls)) ? now : saw(now);
    }, { timeout: TURN_TIMEOUT, every: 100 });
    check(await rows.count() === 2, "there are two subagent rows", await rows.count());
    check(seenDot[0] && seenDot[1], "each row showed a pulsing dot while running", { seenDot, marks });
    log(`    rows: ${marks.map((m) => m.line).join(" | ")}`);
    await waitTurn(ids.claudeSubs, before, "the parent's turn ends");
    const subs = (await get(`/api/chats/${ids.claudeSubs}/items`)).subagents;
    check(subs.length === 2 && subs.every((s) => s.status === "completed"), "the server has two completed subagents", subs);

    // The drawer.
    const drawer = page.locator(".sub-drawer");
    await rows.first().click();
    await drawer.waitFor({ timeout: 10_000 });
    check(/\bon\b/.test(await rows.first().getAttribute("class")), "the open row is highlighted", await rows.first().getAttribute("class"));
    await waitFor("the drawer shows at least one tool card", async () => (await drawer.locator(".tool").count()) > 0 || saw(await drawer.innerText()), { timeout: 15_000 });
    const prompt = (await drawer.locator(".sub-prompt .sub-prompt-text").innerText().catch(() => "")).trim();
    check(prompt.length > 0 && subs.some((s) => s.prompt?.trim() === prompt), "the drawer shows the prompt the parent wrote", { prompt, subs: subs.map((s) => s.prompt) });
    check((await drawer.locator(".sub-nav").innerText()).includes("1/2"), 'the drawer shows "1/2"', await drawer.locator(".sub-drawer-head").innerText());
    await drawer.locator('.sub-nav button[title="Next subagent"]').click();
    await waitFor('› shows "2/2"', async () => (await drawer.locator(".sub-nav").innerText()).includes("2/2") || saw(await drawer.locator(".sub-nav").innerText()), { timeout: 5000 });

    // Esc closes the drawer only (the composer has the focus, where Esc would stop a running chat).
    const notesBefore = await page.locator(".thread .note", { hasText: /^Stopped\.$/ }).count();
    await page.locator(".composer .composer-input").focus();
    await page.keyboard.press("Escape");
    await waitFor("Esc closes the drawer", async () => (await drawer.count()) === 0, { timeout: 5000 });
    await sleep(1000);
    const st = (await chatView(ids.claudeSubs)).status;
    check(st !== "stopped" && (BUSY.has(st) || st === "ready"), "the chat is not stopped (busy, or ready: Idle)", st);
    const notesAfter = await page.locator(".thread .note", { hasText: /^Stopped\.$/ }).count();
    check(notesAfter === notesBefore && !(await chatItems(ids.claudeSubs)).some((i) => i.kind === "note" && i.text === "Stopped."), 'no "Stopped." note', { notesBefore, notesAfter });

    // A reload: completed rows; opening one fetches its thread from its own folder.
    await page.reload();
    await page.locator(".side").waitFor();
    await waitFor("the chat is selected after the reload", async () => (await sel(page)).chat === ids.claudeSubs || saw(await sel(page)));
    const after = await waitFor("two completed rows after the reload", async () => {
      const now = await rows.evaluateAll((els) => els.map((e) => e.querySelector(".sub-mark")?.textContent ?? ""));
      return now.length === 2 && now.every((m) => m === "✓") ? now : saw(now);
    }, { timeout: 15_000 });
    check(after.length === 2, "the rows show as completed after the reload", after);
    const fetched = page.waitForResponse((r) => new RegExp(`/api/chats/${ids.claudeSubs}/subagents/[^/]+/items$`).test(new URL(r.url()).pathname), { timeout: 15_000 });
    await rows.first().click();
    const res = await fetched;
    const sid = new URL(res.url()).pathname.split("/").at(-2);
    const body = await res.json();
    const folder = path.join(HOME, "chats", ids.claudeSubs, "subagents", sid);
    check(res.ok() && fs.existsSync(path.join(folder, "subagent.json")) && fs.existsSync(path.join(folder, "items.jsonl")), "opening a row fetches its thread; it is kept in its own folder", { status: res.status(), folder, files: fs.existsSync(folder) ? fs.readdirSync(folder) : [] });
    check(readJSON(path.join(folder, "subagent.json")).status === "completed", "its subagent.json says completed", readJSON(path.join(folder, "subagent.json")));
    check((body.items ?? []).some((i) => i?.kind === "tool"), "the fetched thread has its tool calls", body.items);
    await waitFor("the drawer shows the fetched thread", async () => (await drawer.locator(".tool").count()) > 0 || saw(await drawer.innerText().catch(() => "(no drawer)")), { timeout: 10_000 });
    await page.keyboard.press("Escape");
    await waitFor("the drawer closes", async () => (await drawer.count()) === 0, { timeout: 5000 });
  });

  await step(19, "Cursor subagents: meters while running; Stop stops both; still stopped after a reload", async () => {
    ids.cursorSubs = await newChatVia(page, async () => { await page.locator("button.icon-btn.new").click(); }, "Cursor chat");
    await waitFor("Cursor's model list is loaded", async () => (await page.locator('.composer button.tchip[title^="Model"]').count()) > 0, { timeout: 60_000 });
    await pickModel(page, CURSOR_MODEL_LABEL);
    const v0 = await chatView(ids.cursorSubs);
    check(v0.agent === "cursor" && v0.model === "gpt-5.4-nano" && !v0.board, `a plain Cursor chat on ${CURSOR_MODEL_LABEL}`, v0);
    await send(page, ids.cursorSubs, "Use the Task tool to start two subagents in parallel, each runs `sleep 20` then `ls`.");

    const rows = page.locator(".thread .subagent");
    const running = async () => rows.evaluateAll((els) => els.map((e) => ({
      running: /st-running/.test(e.className) && !!e.querySelector(".sub-mark .sub-dot"),
      meter: e.querySelector(".sub-meter")?.textContent ?? "", line: e.querySelector(".sub-line")?.textContent ?? "",
    })));
    await waitFor("two subagent rows show running", async () => {
      const now = await running();
      return now.length === 2 && now.every((r) => r.running) ? now : saw(now);
    }, { timeout: 120_000, every: 200 });
    // Each is linked (the agent reported it), so it is really running, not just an unlinked call.
    await waitFor("the server has both subagents running", async () => {
      const s = (await get(`/api/chats/${ids.cursorSubs}/items`)).subagents;
      return s.length === 2 && s.every((x) => x.status === "running") ? s : saw(s);
    }, { timeout: 15_000 });
    const t0 = Date.now();
    const meters = await waitFor("each running row's meter shows a token count", async () => {
      const now = await running();
      if (!now.every((r) => r.running)) throw new Fail("the rows are still running while the meters are read", now);
      return now.length === 2 && now.every((r) => /\d/.test(r.meter)) ? now : saw(now);
    }, { timeout: 12_000, every: 200 });
    log(`    meters after ${((Date.now() - t0) / 1000).toFixed(1)} s: ${meters.map((m) => m.meter).join(" | ")}`);

    await page.locator(".composer button.send.stop").click();
    const stopped = async () => rows.evaluateAll((els) => els.map((e) => ({
      mark: e.querySelector(".sub-mark")?.textContent ?? "", cls: e.className, line: e.querySelector(".sub-line")?.textContent ?? "",
    })));
    const allStopped = (now) => now.length === 2 && now.every((r) => r.mark === "■" && /st-stopped/.test(r.cls) && r.line === "Stopped");
    const s1 = await waitFor('both rows show ■ and "Stopped"', async () => { const now = await stopped(); return allStopped(now) ? now : saw(now); }, { timeout: 30_000 });
    check(allStopped(s1), 'both rows are stopped', s1);
    await page.locator(".thread .note", { hasText: /^Stopped\.$/ }).first().waitFor({ timeout: 15_000 }).catch(() => {});
    check(await page.locator(".thread .note", { hasText: /^Stopped\.$/ }).count() > 0, 'the thread gets "Stopped."', await page.locator(".thread").innerText());
    const subs = (await get(`/api/chats/${ids.cursorSubs}/items`)).subagents;
    check(subs.length === 2 && subs.every((s) => s.status === "stopped"), "the server has both subagents stopped", subs);
    await waitFor("the chat is no longer busy", async () => !BUSY.has((await chatView(ids.cursorSubs)).status), { timeout: 30_000 });

    await page.reload();
    await page.locator(".side").waitFor();
    await waitFor("the chat is selected after the reload", async () => (await sel(page)).chat === ids.cursorSubs || saw(await sel(page)));
    const s2 = await waitFor("both rows are still stopped after the reload", async () => { const now = await stopped(); return allStopped(now) ? now : saw(now); }, { timeout: 15_000 });
    check(allStopped(s2), "both rows show ■ and Stopped after the reload", s2);
    for (const s of subs) {
      const f = path.join(HOME, "chats", ids.cursorSubs, "subagents", s.id, "subagent.json");
      check(fs.existsSync(f) && readJSON(f).status === "stopped", `subagent ${s.id} is saved as stopped in its folder`, fs.existsSync(f) ? readJSON(f) : "(no subagent.json)");
    }
  });
}

// ---------------------------------------------------------------- main

let code = 0;
try {
  await run();
  log("\nALL STEPS PASSED (step 15 is checked by hand)");
} catch (e) {
  code = 1;
  const shot = await screenshot().catch(() => "(no screenshot)");
  log(`\nFAILED at step ${current}`);
  if (e instanceof Fail) {
    log(`  expected: ${e.expected}`);
    log(`  saw:      ${show(e.saw).split("\n").join("\n            ")}`);
  } else {
    log(`  error:    ${e?.stack ?? e}`);
  }
  log(`  screenshot: ${shot}`);
  log(`  server log (${LOG}):\n${tail(LOG).split("\n").map((l) => "    " + l).join("\n")}`);
} finally {
  await browser?.close().catch(() => {});
  await stopServer().catch(() => {});
}
process.exit(code);
