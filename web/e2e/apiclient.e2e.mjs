// The real page beside an API client (plans/multiple-remote-servers.md, phase 2, AC13).
//
// An API client is another person's local server that uses this server's remote listener: HTTPS
// with the secret and a client id, a table of named routes. AC13 says it takes nothing from a
// page: the page keeps the board it holds and the chats it follows. The Go tests show that with
// stand-in pages; this script shows it with the page itself in a headless Chrome (Playwright),
// beside an API client written here in Node.
//
// It spends no money: the server runs the stand-in agent internal/agenttest/fake-claude and has no
// Cursor and no pi. It never touches the installed app: the script builds its own binary into a
// temp folder, runs it on a temp data folder and on free ports, and stops it at the end.
// Not part of `npm test`.
//
//   cd web && npm ci && npm run build && npm install --no-save playwright && npx playwright install chromium
//   node web/e2e/apiclient.e2e.mjs
//
// Part 1: the page makes a board, draws a rectangle and sends a message in a chat of its own (on
//   the board). The API client connects its stream, creates a chat whose first message asks
//   permission, reads the items, answers the ask, sends a second message and interrupts it;
//   meanwhile the page draws a second rectangle, a third after the second message and a fourth
//   after the interrupt, and then sends a second message in its chat. Checked: both of the page's
//   messages are answered on the page, the page never shows the take-over panel, the four
//   rectangles are in the board's file, the API client's stream got no event that is a page's
//   alone, the sidebar shows the group "Remote" with the API client's chat, the page's console
//   has no error.
// Part 2: the page makes a run, starts it and opens its orchestrator's transcript. A second API
//   client connects, follows that same chat and creates a chat of its own. Checked: the transcript
//   on the page still gets its new items afterwards.
//
// It prints one line per check and exits with 1 when a check failed (2 when it could not run).
//
// Environment (all optional):
//   AIWB_E2E_BIN       server binary                    (default: built into the temp folder)
//   AIWB_E2E_CLIENT    built web client                 (default web/dist)
//   AIWB_E2E_NO_RUN=1  leave part 2 out (reported as skipped, never silently dropped)
//   AIWB_E2E_KEEP=1    keep the temp folder (server log, screenshots) after a run that passed;
//                      after a failed run it is always kept, and its path is printed
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLIENT = path.resolve(process.env.AIWB_E2E_CLIENT || path.join(repo, "web/dist"));
const WITH_RUN = process.env.AIWB_E2E_NO_RUN !== "1";

// Everything the run makes: the binary, the data folder, the work folder, the log, screenshots.
// realpath: on macOS the temp folder is a symlink, and the server reports folders resolved.
const OUT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-e2e-apiclient-")));
const BIN = path.resolve(process.env.AIWB_E2E_BIN || path.join(OUT, "aiwb"));
const HOME = path.join(OUT, "home");
const WORK = path.join(OUT, "work"); // the chats' and the run's folder: a git repository, outside the data folder
const FAKE = path.join(OUT, "bin", "fake-claude");
const CURSOR_CFG = path.join(OUT, "cursor-config"); // empty: the server must not write into ~/.cursor
const LOG = path.join(OUT, "server.log");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, fn, { timeout = 15000, every = 100 } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try { last = await fn(); if (last) return last; } catch (e) { last = "threw: " + e.message; }
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what} (last: ${JSON.stringify(last)?.slice(0, 300)})`);
    await sleep(every);
  }
}

// ---- checks: one line each

let failed = 0;
function check(name, pass, detail = "") {
  if (!pass) failed++;
  const d = String(detail).replace(/\s+/g, " ").trim();
  console.log(`${pass ? "ok  " : "FAIL"} - ${name}${d ? `  (${d})` : ""}`);
  return pass;
}
const skipped = (name, why) => console.log(`skip - ${name}  (${why})`);

// ---- the scratch server

function freePort() {
  return new Promise((resolve, reject) => {
    const l = net.createServer();
    l.once("error", reject);
    l.listen(0, "127.0.0.1", () => { const { port } = l.address(); l.close(() => resolve(port)); });
  });
}
function portFree(port) {
  return new Promise((resolve) => {
    const c = net.connect({ port, host: "127.0.0.1" });
    c.once("connect", () => { c.destroy(); resolve(false); });
    c.once("error", () => resolve(true));
  });
}

let PORT = 0;        // the app's port: the page
let REMOTE_PORT = 0; // the remote listener: the API client
let BASE = "";
let server = null;

function prepare() {
  for (const d of [HOME, WORK, path.dirname(FAKE), CURSOR_CFG]) fs.mkdirSync(d, { recursive: true });
  if (!process.env.AIWB_E2E_BIN) execFileSync("go", ["build", "-o", BIN, "./cmd/ai-whiteboard"], { cwd: repo, stdio: ["ignore", "inherit", "inherit"] });
  fs.copyFileSync(path.join(repo, "internal/agenttest/fake-claude"), FAKE);
  fs.chmodSync(FAKE, 0o755);
  // A run starts only in a folder that is a git repository with a commit.
  const git = (...args) => execFileSync("git", args, { cwd: WORK, stdio: ["ignore", "pipe", "pipe"] });
  fs.writeFileSync(path.join(WORK, "README.md"), "scratch\n");
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "first");
}

async function startServer() {
  PORT = await freePort();
  REMOTE_PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  // The remote listener's certificate, secret and port are made before the start; every command
  // names the data folder and the ports, so none can reach the installed app.
  execFileSync(BIN, ["remote", "setup", "-home", HOME, "-port", String(REMOTE_PORT), "-name", "127.0.0.1", "-server-port", String(PORT)],
    { stdio: ["ignore", "pipe", "pipe"] });
  const fd = fs.openSync(LOG, "a");
  const p = spawn(BIN, ["serve", "-home", HOME, "-port", String(PORT), "-client", CLIENT, "-cwd", WORK,
    "-claude", FAKE, "-cursor", "/nonexistent/agent", "-pi", "/nonexistent/pi", "-cursor-cost", "/nonexistent/cursor-cost"],
    { cwd: WORK, env: { ...process.env, AIWB_MCP_PORT: "0", AIWB_REMOTE_BIND: "127.0.0.1", CURSOR_CONFIG_DIR: CURSOR_CFG }, stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  server = { p, exited: new Promise((r) => p.once("exit", r)) };
  await waitFor("the server answers /api/hello", async () => {
    if (p.exitCode !== null) throw new Error(`the server exited with ${p.exitCode}`);
    const r = await fetch(`${BASE}/api/hello`, { signal: AbortSignal.timeout(1000) });
    return r.ok;
  }, { timeout: 20000 });
}

async function stopServer() {
  if (!server) return;
  const { p, exited } = server;
  server = null;
  if (p.exitCode !== null || p.signalCode !== null) return;
  p.kill("SIGTERM");
  if (await Promise.race([exited.then(() => true), sleep(15000).then(() => false)])) return;
  p.kill("SIGKILL");
  await exited;
}

const state = async () => (await fetch(`${BASE}/api/state`)).json();

// ---- the API client: HTTPS on the remote listener, the server's certificate pinned

function apiClient() {
  const id = randomUUID();
  const ca = fs.readFileSync(path.join(HOME, "remote-cert.pem"));
  const secret = fs.readFileSync(path.join(HOME, "remote-secret"), "utf8").trim();
  // Only this certificate is trusted, and only for these requests: verification stays on.
  const agent = new https.Agent({ ca, keepAlive: false });
  const options = (method, p, extra = {}) => ({
    host: "127.0.0.1", port: REMOTE_PORT, path: p, method, agent,
    headers: { "X-AIWB-Secret": secret, "X-AIWB-Client": id, ...extra },
  });
  const events = [];
  let stream = null;

  function call(method, p, body) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const req = https.request(options(method, p, data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}), (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { text += c; });
        res.on("end", () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, text, json }); });
      });
      req.setTimeout(15000, () => req.destroy(new Error(`${method} ${p}: no answer in 15 s`)));
      req.on("error", reject);
      req.end(data ?? undefined);
    });
  }

  // connect opens GET /api/events and resolves when the snapshot has arrived.
  function connect() {
    return new Promise((resolve, reject) => {
      const req = https.request(options("GET", "/api/events", { Accept: "text/event-stream" }), (res) => {
        if (res.statusCode !== 200) { res.resume(); reject(new Error(`GET /api/events -> ${res.statusCode}`)); return; }
        stream = { req, res, at: Date.now() };
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          buf += c;
          for (let i; (i = buf.indexOf("\n\n")) >= 0;) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
            if (!data) continue; // ": ping"
            let ev; try { ev = JSON.parse(data); } catch { ev = { type: "?", raw: data }; }
            events.push(ev);
            if (ev.type === "snapshot") resolve(ev);
          }
        });
        res.on("error", () => {});
      });
      req.on("error", (e) => { if (!stream) reject(e); });
      req.end();
      setTimeout(() => reject(new Error("GET /api/events: no snapshot in 10 s")), 10000).unref();
    });
  }
  const close = () => { stream?.req.destroy(); stream = null; agent.destroy(); };
  return { id, events, call, connect, close, connectedAt: () => stream?.at ?? 0 };
}

// ---- the page

let browser = null;
// openPage opens the app and keeps what its console says. errors: console errors and uncaught
// exceptions; failedRequests: requests that failed or were answered with 400 or more.
async function openPage() {
  let chromium;
  try { ({ chromium } = await import("playwright")); }
  catch { throw new Error("playwright is not installed: cd web && npm install --no-save playwright && npx playwright install chromium"); }
  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  page.errors = [];
  page.failedRequests = [];
  page.on("console", (m) => { if (m.type() === "error") page.errors.push(`console: ${m.text()}`); });
  page.on("pageerror", (e) => page.errors.push(`uncaught: ${e.message}`));
  page.on("requestfailed", (r) => page.failedRequests.push(`${r.method()} ${new URL(r.url()).pathname} ${r.failure()?.errorText}`));
  page.on("response", (r) => { if (r.status() >= 400) page.failedRequests.push(`${r.request().method()} ${new URL(r.url()).pathname} -> ${r.status()}`); });
  // The take-over panel may come and go between two looks, so the page itself remembers it.
  await page.addInitScript(() => {
    window.__takeoverSeen = 0;
    const look = () => { if (document.querySelector(".board-canvas .takeover-panel")) window.__takeoverSeen++; };
    new MutationObserver(look).observe(document, { childList: true, subtree: true });
  });
  await page.goto(BASE);
  await page.waitForSelector("#root *", { timeout: 15000 });
  return page;
}
const shot = (page, label) => page.screenshot({ path: path.join(OUT, `${label}.png`) }).catch(() => {});
const sel = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("aiwb.sel") ?? "{}"));
const menuItem = (page, text) => page.locator(".menu .menu-item", { hasText: text });
const takeover = async (page) => ({ now: await page.locator(".board-canvas .takeover-panel").count(), seen: await page.evaluate(() => window.__takeoverSeen) });

// rectangles: the rectangles in the board's file on disk.
function rectangles(board) {
  try {
    const scene = JSON.parse(fs.readFileSync(path.join(HOME, "boards", board, "drawing.excalidraw"), "utf8"));
    return (scene.elements ?? []).filter((e) => !e.isDeleted && e.type === "rectangle");
  } catch { return []; }
}
async function newBoard(page) {
  const before = new Set((await state()).boards.map((b) => b.id));
  await page.click("button.icon-btn.new");
  await menuItem(page, /^\s*New whiteboard\s*$/).click();
  const id = await waitFor("the page selects its new board", async () => { const b = (await sel(page)).board; return b && !before.has(b) ? b : null; });
  await page.locator(".board-canvas").waitFor();
  await page.locator('[data-testid="toolbar-rectangle"]').waitFor({ state: "attached", timeout: 20000 });
  return id;
}
// drawRect draws a rectangle on the canvas at a fraction of its size and waits until a new
// rectangle is in the board's file; returns its id.
async function drawRect(page, board, fx, fy) {
  const before = new Set(rectangles(board).map((e) => e.id));
  const b = await page.locator(".board-canvas").boundingBox();
  await page.keyboard.press("Escape");
  await page.locator("label", { has: page.locator('[data-testid="toolbar-rectangle"]') }).click();
  const x = b.x + b.width * fx, y = b.y + b.height * fy;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y + 40, { steps: 4 });
  await page.mouse.move(x + 120, y + 70, { steps: 4 });
  await page.mouse.up();
  return (await waitFor("the new rectangle is in the board's file", () => rectangles(board).find((e) => !before.has(e.id)) ?? null, { timeout: 10000 })).id;
}

// The page's own chat: one on the board it holds, in the panel beside the canvas.
const pageBox = (page) => page.locator(".board-panel .composer .composer-input");
async function pageChat(page) {
  const before = new Set((await state()).chats.map((c) => c.id));
  await page.locator(".board-bar button", { hasText: /^\+ Chat on this board$/ }).click();
  const id = await waitFor("the page selects its new chat", async () => { const c = (await sel(page)).chat; return c && !before.has(c) ? c : null; });
  await pageBox(page).waitFor();
  return id;
}
// pageSays sends text in the chat on the page and waits for a new reply of the stand-in agent in
// the thread on screen; returns that reply, or { err }.
async function pageSays(page, text) {
  const replies = () => page.locator(".board-panel .thread .msg.assistant").allInnerTexts();
  const before = (await replies()).length;
  await pageBox(page).click();
  await pageBox(page).fill(text);
  await pageBox(page).press("Enter");
  return waitFor(`the reply to "${text}" on the page`, async () => {
    const now = await replies();
    return now.length > before && now.slice(before).find((t) => /FAKE\(/.test(t) && t.includes(text)) || null;
  }, { timeout: 20000 }).then((reply) => ({ reply }), (e) => ({ err: e.message }));
}

// The events that go to a page alone: an API client's stream never carries them.
const PAGE_ONLY = ["rpc", "held", "release_request", "superseded", "groups", "board"];

// ---- what the API client reads

const items = async (api, chat) => (await api.call("GET", `/api/chats/${chat}/items`)).json?.items ?? [];
const textOf = (list) => JSON.stringify(list);
const chatOf = async (api, chat) => (await api.call("GET", `/api/chats/${chat}`)).json;

// ---- part 1: a board the page holds, beside an API client's chat

async function part1(page) {
  const board = await newBoard(page);
  const first = await drawRect(page, board, 0.3, 0.3);
  check("the page made a board and its first rectangle is in the board's file", rectangles(board).some((e) => e.id === first), `board ${board}`);

  // A chat of the page's own, before the API client is there.
  const own = await pageChat(page);
  const said1 = await pageSays(page, "page before the API client");
  check("the page sends a message in a chat of its own and the reply shows", !!said1.reply, said1.err ?? `chat ${own}: ${said1.reply}`);

  const api = apiClient();
  try {
    const snap = await api.connect();
    check("the API client's stream gives hello with its id, then a snapshot",
      api.events[0]?.type === "hello" && api.events[0]?.client === api.id && api.events[1]?.type === "snapshot",
      `events: ${api.events.slice(0, 2).map((e) => e.type).join(", ")}; snapshot fields: ${Object.keys(snap).filter((k) => k !== "type").join(", ")}`);

    const chat = randomUUID();
    const name = "API client chat";
    const made = await api.call("POST", "/api/chats", { id: chat, agent: "claude", cwd: WORK, name, userNamed: true, text: '[[ask Bash {"command":"ls"}]] go' });
    check("the API client creates a chat with its first message in one call",
      made.status === 200 && made.json?.ok === true && made.json?.started === true && made.json?.sent === true && made.json?.chat?.id === chat,
      `${made.status} ${made.text.slice(0, 160)}`);

    // Meanwhile the page draws: it starts now and is awaited after the ask is answered.
    const second = drawRect(page, board, 0.55, 0.55).then((id) => ({ id }), (e) => ({ err: e.message }));

    const ask = await waitFor("the ask shows in the items the API client reads", async () =>
      (await items(api, chat)).find((it) => it.requestId) ?? null).catch((e) => ({ err: e.message }));
    check("the API client reads the items and finds the permission ask", !!ask.requestId, ask.err ?? `item kind ${ask.kind ?? ask.type}, requestId ${ask.requestId}`);

    const decided = await api.call("POST", `/api/chats/${chat}/permission`, { requestId: ask.requestId, allow: true });
    const reply = await waitFor("the agent's reply after the answer", async () => /ask Bash -> allow/.test(textOf(await items(api, chat))), { timeout: 15000 }).catch(() => false);
    check("the API client answers the ask and the turn goes on", decided.status === 200 && reply === true, `permission -> ${decided.status} ${decided.text.slice(0, 120)}`);

    const drawn = await second;
    check("the page drew a second rectangle meanwhile and it is in the board's file", !!drawn.id, drawn.err ?? `rectangle ${drawn.id}`);

    await waitFor("the first turn ends", async () => (await chatOf(api, chat))?.status === "ready").catch(() => {});
    const sent = await api.call("POST", `/api/chats/${chat}/messages`, { text: "[[sleep 30]] second" });
    const busy = await waitFor("the second turn runs", async () => { const c = await chatOf(api, chat); return c?.status && c.status !== "ready" ? c.status : null; }).catch((e) => e.message);
    // The page draws while the API client's second turn runs.
    const third = await drawRect(page, board, 0.3, 0.6).then((id) => ({ id }), (e) => ({ err: e.message }));
    const still = (await chatOf(api, chat))?.status;
    check("the page drew a third rectangle after the API client's second message, while that turn ran", !!third.id && !!still && still !== "ready", third.err ?? `rectangle ${third.id}, the API client's chat is "${still}"`);
    const t0 = Date.now();
    const stopped = await api.call("POST", `/api/chats/${chat}/interrupt`);
    // The message asked for 30 s: a turn that ends within 3 s was ended by the interrupt.
    const idle = await waitFor("the turn ends after the interrupt", async () => (await chatOf(api, chat))?.status === "ready", { timeout: 3000 }).catch(() => false);
    const fourth = await drawRect(page, board, 0.6, 0.3).then((id) => ({ id }), (e) => ({ err: e.message }));
    check("the page drew a fourth rectangle after the API client's interrupt", !!fourth.id, fourth.err ?? `rectangle ${fourth.id}`);
    const after = textOf(await items(api, chat));
    check("the API client sends a second message and interrupts it",
      sent.status === 200 && stopped.status === 200 && idle === true && !/FAKE\([^)]*\): second/.test(after),
      `messages -> ${sent.status}, status then "${busy}", interrupt -> ${stopped.status}, the turn ended ${Date.now() - t0} ms later`);
    check("the stream gave the API client events of its chat", api.events.length > 2, `${api.events.length} events: ${[...new Set(api.events.map((e) => e.type))].join(", ")}`);

    // The page's own chat again, after the API client's work.
    const said2 = await pageSays(page, "page after the API client");
    check("the page sends a second message in its own chat and the new reply shows", !!said2.reply && said2.reply !== said1.reply, said2.err ?? `chat ${own}: ${said2.reply}`);

    // The checks of AC13 on the page.
    const tk = await takeover(page);
    check("the page never showed the take-over panel", tk.now === 0 && tk.seen === 0, `on screen now ${tk.now}, seen ${tk.seen} times`);
    const rects = [first, drawn.id, third.id, fourth.id];
    const onDisk = rectangles(board).map((e) => e.id);
    check("the four rectangles are in the board's file on disk", rects.every((id) => !!id && onDisk.includes(id)) && onDisk.length === 4, `${onDisk.length} rectangles`);
    // The page drew, saved and chatted meanwhile: none of that reached the API client's stream.
    const pageOnly = api.events.filter((e) => PAGE_ONLY.includes(e.type));
    check(`no event of the API client's stream has a type of a page's alone (${PAGE_ONLY.join(", ")})`, pageOnly.length === 0,
      `${api.events.length} events: ${[...new Set(api.events.map((e) => e.type))].join(", ")}${pageOnly.length ? `; of a page's alone: ${pageOnly.map((e) => e.type).join(", ")}` : ""}`);
    check("the page still shows its board", (await sel(page)).board === board && (await page.locator(".board-canvas").count()) === 1);

    const group = page.locator(".side-group").filter({ has: page.locator(".side-group-name", { hasText: /^Remote$/ }) });
    const row = group.locator(".side-row", { hasText: name });
    const shown = await waitFor("the group and the chat in the sidebar", async () => (await group.count()) === 1 && (await row.count()) === 1, { timeout: 5000 }).catch(() => false);
    check('the sidebar shows a group "Remote" with the API client\'s chat in it', shown === true,
      `groups: ${(await page.locator(".side-group-name").allInnerTexts()).join(", ") || "none"}; rows in Remote: ${(await group.locator(".side-row").allInnerTexts().catch(() => [])).map((t) => t.replace(/\n/g, " ")).join(" | ") || "none"}`);
    const st = await state();
    const remote = st.groups?.find((g) => g.name === "Remote");
    check('the server has the chat in the group "Remote", off every board', !!remote && st.chats.find((c) => c.id === chat)?.group === remote.id && !st.chats.find((c) => c.id === chat)?.board);
    await shot(page, "part1");
    return { board, rects };
  } finally {
    api.close();
  }
}

// ---- part 2: a run's orchestrator transcript on the page, beside a new API client

// transcript: what the run's agent pane shows on the page (null: no transcript on screen).
const transcript = (page) => page.evaluate(() => {
  const foot = document.querySelector(".agent-foot");
  const t = foot?.parentElement?.querySelector(".thread");
  return t ? { blocks: t.querySelectorAll("*").length, text: t.innerText } : null;
});

async function part2(page, held) {
  // A run through the page: New run, the goal, Enter.
  const before = new Set((await state()).runs.map((r) => r.id));
  await page.click("button.icon-btn.new");
  await menuItem(page, /^\s*New run\s*$/).click();
  const run = await waitFor("the page selects its new run", async () => { const r = (await sel(page)).run; return r && !before.has(r) ? r : null; });
  const goal = page.locator(".run-composer .composer-input");
  await goal.waitFor();
  // The orchestrator's first message holds the goal twice, so the stand-in agent sleeps twice:
  // its first turn takes about 20 s.
  await goal.fill("[[if This is turn 1.]] [[sleep 10]] work");
  const send = page.locator(".run-composer button.send");
  const ready = await waitFor("the run's start is not blocked", async () => !(await send.isDisabled()), { timeout: 15000 }).catch(() => false);
  if (!ready) {
    check("the page starts a run", false, `blocked: ${await send.getAttribute("title")}; folder: ${await page.locator(".run-composer .ctx-chip").innerText().catch(() => "?")}`);
    await shot(page, "part2-blocked");
    return;
  }
  await goal.press("Enter");
  // The orchestrator's transcript: turn 1 in the timeline's lane, then "Transcript ›" in its detail.
  const turn = page.locator('.tl button[data-turn="1"]');
  const started = await turn.waitFor({ timeout: 20000 }).then(() => true, () => false);
  check("the page starts a run and its first turn shows in the timeline", started, started ? `run ${run}` : (await page.locator(".composer-err, .run-note").allInnerTexts()).join(" ; "));
  if (!started) { await shot(page, "part2-not-started"); return; }
  await turn.click();
  const link = page.locator("button.link[data-agent]", { hasText: "Transcript" });
  await link.waitFor();
  const orch = await link.getAttribute("data-agent");
  // The turn shows before its agent's chat exists (internal/runs/turn.go: the turn is committed,
  // the chat is made after). A click in that gap leaves the pane on "Couldn't load this agent's
  // transcript: no such chat" until Retry, which is not what this script is about: wait for the chat.
  await waitFor("the orchestrator's chat exists", async () => (await fetch(`${BASE}/api/chats/${orch}`)).ok, { timeout: 20000 });
  await link.click();
  const open = await waitFor("the transcript on the page", async () => (await transcript(page))?.text.includes("This is turn 1.")).catch(() => false);
  check("the page opens the orchestrator's transcript", open === true, `chat ${orch}`);
  if (!open) { await shot(page, "part2-no-transcript"); return; }

  // A new API client: a stream of its own, a follow of the very chat the page reads, a chat of its own.
  const api = apiClient();
  try {
    await api.connect();
    const read = await api.call("GET", `/api/chats/${orch}/items`);
    const chat = randomUUID();
    const made = await api.call("POST", "/api/chats", { id: chat, agent: "claude", cwd: WORK, name: "Second API chat", userNamed: true, text: "hello from the API client" });
    const answered = await waitFor("the API client's chat is answered", async () => /FAKE\([^)]*\): hello from the API client/.test(textOf(await items(api, chat)))).catch(() => false);
    check("a second API client connects, reads the orchestrator's chat and creates a chat of its own",
      read.status === 200 && made.status === 200 && made.json?.sent === true && answered === true,
      `items -> ${read.status} (${read.json?.items?.length ?? "?"} items), POST /api/chats -> ${made.status}`);

    // The orchestrator still sleeps here (about 20 s from its start). What the page shows from now on
    // can only come over the page's own follow.
    const at = await transcript(page);
    check("the orchestrator's turn is still running when the API client is connected", !!at && !/FAKE\(/.test(at.text), `${at?.blocks} nodes in the transcript`);
    const later = await waitFor("the transcript on the page gets the orchestrator's reply", async () => {
      const t = await transcript(page);
      return t && /FAKE\(/.test(t.text) && t.text !== at.text ? t : null;
    }, { timeout: 40000, every: 250 }).catch((e) => ({ err: e.message }));
    check("the transcript on the page still updates after the API client's connect", !later.err,
      later.err ?? `${at.blocks} -> ${later.blocks} nodes, the reply came ${Math.round((Date.now() - api.connectedAt()) / 100) / 10} s after the connect`);
    const seen = await waitFor("the API client's stream has events of the orchestrator's chat", () => api.events.some((e) => JSON.stringify(e).includes(orch) && e.type !== "snapshot"), { timeout: 3000 }).catch(() => false);
    check("the API client got the same chat's events on its own stream", seen === true, `${api.events.length} events`);

    const tk = await takeover(page);
    const onDisk = rectangles(held.board).map((e) => e.id);
    check("the board is as the page left it: no take-over panel, the four rectangles on disk", tk.seen === 0 && held.rects.every((id) => onDisk.includes(id)) && onDisk.length === held.rects.length, `panel seen ${tk.seen} times, ${onDisk.length} rectangles`);
    await shot(page, "part2");
  } finally {
    api.close();
  }
}

// ---- main

let code = 0;
try {
  prepare();
  await startServer();
  console.log(`# server on ${BASE}, remote listener on https://127.0.0.1:${REMOTE_PORT}, files in ${OUT}`);
  const page = await openPage();
  const held = await part1(page);
  if (WITH_RUN) await part2(page, held);
  else skipped("part 2: the run's transcript beside an API client", "AIWB_E2E_NO_RUN=1");
  check("the page's console has no error", page.errors.length === 0, page.errors.slice(0, 5).join(" ; "));
  check("no request of the page failed", page.failedRequests.length === 0, page.failedRequests.slice(0, 5).join(" ; "));
  code = failed ? 1 : 0;
} catch (e) {
  console.log(`FAIL - the script could not go on: ${e.stack || e}`);
  code = 2;
} finally {
  if (browser) await browser.close().catch(() => {});
  await stopServer();
}
const free = (await portFree(PORT)) && (await portFree(REMOTE_PORT));
if (PORT && !check("the server is stopped and its ports are free", free, `ports ${PORT} and ${REMOTE_PORT}`) && !code) code = 1;
if (code === 0 && process.env.AIWB_E2E_KEEP !== "1") fs.rmSync(OUT, { recursive: true, force: true });
else console.log(`# files kept in ${OUT}`);
console.log(code === 0 ? "# passed" : code === 2 ? "# could not run to the end" : `# failed (${failed} checks)`);
process.exit(code);
