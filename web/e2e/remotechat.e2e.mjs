// A remote chat through the real page (plans/multiple-remote-servers.md, phase 5).
//
// A remote chat runs on another AI Whiteboard server and shows in this one's sidebar. The Go
// tests show that with two scratch servers and no page; this script shows it with the page itself
// in a headless Chrome (Playwright): two scratch servers, A (the local one, whose page is driven)
// and B (the remote one, reached through its remote listener).
//
// It spends no money: both servers run the stand-in agent internal/agenttest/fake-claude and have
// no Cursor and no pi. It never touches the installed app: the script builds its own binary into
// a temp folder, runs both servers on temp data folders and on free ports, and stops them at the
// end. Not part of `npm test`.
//
//   cd web && npm ci && npm run build && npm install --no-save playwright && npx playwright install chromium
//   node web/e2e/remotechat.e2e.mjs
//
// Steps (the page is A's):
//   1 add B in the Servers dialog, opened from the chat's server choice
//   2 pick B for the chat: its agents, a folder of its machine
//   3 the first message, with a permission ask answered on the page
//   4 a second message; the server and agent choices are fixed
//   5 B stops: the row, the bar over the kept thread, a send that keeps its text, and on a
//     second page that opens the chat fresh the "server unreachable" view
//   6 B is back: with no reload and no click both pages are current, the refusal's line is gone,
//     and a message is answered
//   F5 the first message of another chat while B does not answer (SIGSTOP): the thread shows the
//     text and "Sending to …", A keeps the draft; B goes on (SIGCONT) and the reply arrives
//   7 the chat is archived on B by an API client: A's row shows it; unarchived from A's page
//   8 a second remote chat is deleted while B is down: "Remove from this sidebar only"
//   W26 a first message to a folder that is no longer on B: refused, the text stays in the box and
//     the chat stays a draft with its server choice; with a folder that is there it is answered
//   W28 a chat on a board: its server is a fixed chip, "This computer"
//   FM the first message of a chat while B does not answer for the whole wait (45 s): the line
//     says it is not known whether it arrived and the text is back in the box; the text is edited,
//     B goes on, and with no click the thread has the message once and the box the edited text
//   9 B stops with an unstarted chat on B open: no agent choice, the "not connected" line, no
//     Send (W17). B's entry is removed: its chats leave the sidebar, an unstarted one is back on
//     this computer, B still has its chats
//
// It prints one line per check, `ok <n> <what>` or `FAIL <n> <what> — <what was seen>`, saves a
// screenshot for a failed check, and exits with 1 when a check failed (2 when it could not run).
//
// Environment (all optional):
//   AIWB_E2E_BIN       server binary                    (default: built into the temp folder)
//   AIWB_E2E_CLIENT    built web client                 (default web/dist)
//   AIWB_E2E_KEEP=1    keep the temp folder (server logs, screenshots) after a run that passed;
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

// Everything the run makes: the binary, both servers' folders, the logs, screenshots.
// realpath: on macOS the temp folder is a symlink, and the server reports folders resolved.
const OUT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-e2e-remotechat-")));
const BIN = path.resolve(process.env.AIWB_E2E_BIN || path.join(OUT, "aiwb"));
const FAKE = path.join(OUT, "bin", "fake-claude");

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
/** true when fn turned true in time, else the sentence of what was last seen. */
const holds = (what, fn, o) => waitFor(what, fn, o).then(() => true, (e) => e.message);

// ---- checks: one line each

let failed = 0;
let n = 0;
let page = null; // A's page: a failed check takes its screenshot and what it logged since the last check
let told = { errors: 0, requests: 0 };
async function check(what, pass, seen = "") {
  n++;
  const d = String(seen).replace(/\s+/g, " ").trim();
  if (pass === true) { console.log(`ok ${n} ${what}${d ? `  (${d})` : ""}`); }
  else {
    failed++;
    const extra = [];
    if (typeof pass === "string") extra.push(pass);
    if (page) {
      const errs = page.errors.slice(told.errors), reqs = page.failedRequests.slice(told.requests);
      if (errs.length) extra.push(`console: ${errs.slice(-4).join(" ; ")}`);
      if (reqs.length) extra.push(`requests: ${reqs.slice(-6).join(" ; ")}`);
      const file = path.join(OUT, `fail-${n}.png`);
      await page.screenshot({ path: file }).then(() => extra.push(`screenshot ${file}`), () => {});
    }
    console.log(`FAIL ${n} ${what} — ${[d, ...extra].filter(Boolean).join(" | ").replace(/\s+/g, " ") || "not as expected"}`);
  }
  if (page) told = { errors: page.errors.length, requests: page.failedRequests.length };
  return pass === true;
}
/** A step that threw: one failed check, and the script goes on with the next step. */
async function step(name, fn) {
  try { await fn(); }
  catch (e) { await check(`${name}: the step ran to its end`, false, e.message); await page?.keyboard.press("Escape").catch(() => {}); }
}

// ---- the two scratch servers

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

const scratch = (tag, name) => ({
  tag, name, home: path.join(OUT, tag, "home"), work: path.join(OUT, tag, "work"), cursorCfg: path.join(OUT, tag, "cursor-config"),
  log: path.join(OUT, `server-${tag}.log`), port: 0, remotePort: 0, base: "", proc: null, pids: [],
});
const A = scratch("a", "This computer"); // the local server: the page is its
const B = scratch("b", "Studio B");      // the remote one, an entry of A's server list
const B_ONLY = "only-on-b";              // a folder in B's work folder: the folder picker must list it

const envOf = (s) => ({ ...process.env, AIWB_MCP_PORT: "0", AIWB_REMOTE_BIND: "127.0.0.1", CURSOR_CONFIG_DIR: s.cursorCfg });

async function prepare() {
  fs.mkdirSync(path.dirname(FAKE), { recursive: true });
  if (!process.env.AIWB_E2E_BIN) execFileSync("go", ["build", "-o", BIN, "./cmd/ai-whiteboard"], { cwd: repo, stdio: ["ignore", "inherit", "inherit"] });
  fs.copyFileSync(path.join(repo, "internal/agenttest/fake-claude"), FAKE);
  fs.chmodSync(FAKE, 0o755);
  for (const s of [A, B]) {
    for (const d of [s.home, s.work, s.cursorCfg]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(s.work, "README.md"), `scratch ${s.tag}\n`);
    s.port = await freePort();
    s.base = `http://127.0.0.1:${s.port}`;
  }
  fs.mkdirSync(path.join(B.work, B_ONLY));
  // B's remote listener: the certificate, secret and port are made before its start. The command
  // names the data folder and both ports, so it cannot reach the installed app. It prints the
  // fingerprint; the secret it writes to a file of the data folder and does not print.
  B.remotePort = await freePort();
  const out = execFileSync(BIN, ["remote", "setup", "-home", B.home, "-server-port", String(B.port), "-port", String(B.remotePort), "-name", "127.0.0.1"],
    { env: envOf(B), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  B.fingerprint = /^Fingerprint:\s*(\S+)/m.exec(out)?.[1] ?? "";
  B.secret = fs.readFileSync(path.join(B.home, "remote-secret"), "utf8").trim();
  if (!B.fingerprint || !B.secret) throw new Error(`remote setup gave no fingerprint or no secret: ${out}`);
}

async function start(s) {
  const fd = fs.openSync(s.log, "a");
  const p = spawn(BIN, ["serve", "-home", s.home, "-port", String(s.port), "-client", CLIENT, "-cwd", s.work,
    "-claude", FAKE, "-cursor", "/nonexistent/agent", "-pi", "/nonexistent/pi", "-cursor-cost", "/nonexistent/cursor-cost"],
    { cwd: s.work, env: envOf(s), stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  s.proc = { p, exited: new Promise((r) => p.once("exit", r)) };
  s.pids.push(p.pid);
  await waitFor(`server ${s.tag} answers /api/hello`, async () => {
    if (p.exitCode !== null) throw new Error(`server ${s.tag} exited with ${p.exitCode}`);
    return (await fetch(`${s.base}/api/hello`, { signal: AbortSignal.timeout(1000) })).ok;
  }, { timeout: 20000 });
}

async function stop(s) {
  if (!s.proc) return;
  const { p, exited } = s.proc;
  s.proc = null;
  if (p.exitCode !== null || p.signalCode !== null) return;
  p.kill("SIGTERM");
  if (await Promise.race([exited.then(() => true), sleep(15000).then(() => false)])) return;
  p.kill("SIGKILL");
  await exited;
}

const get = async (s, p) => { const r = await fetch(s.base + p, { signal: AbortSignal.timeout(5000) }); return { status: r.status, json: await r.json().catch(() => null) }; };
const stateOf = async (s) => (await get(s, "/api/state")).json;
const chatOn = async (s, id) => (await stateOf(s))?.chats?.find((c) => c.id === id) ?? null;
/** The user messages of a chat, as B's own loopback API gives them. */
const userTexts = async (s, id) => ((await get(s, `/api/chats/${id}/items`)).json?.items ?? []).filter((it) => it.kind === "user").map((it) => String(it.text ?? ""));
/** B's entry in A's server list. */
const entry = async () => ((await get(A, "/api/servers")).json?.servers ?? []).find((v) => v.name === B.name) ?? null;
const connected = (timeout) => holds("A is connected to B", async () => (await entry())?.state === "connected", { timeout, every: 250 });

// ---- an API client of B: HTTPS on its remote listener, the server's certificate pinned

function apiClient(s) {
  const id = randomUUID();
  // Only this certificate is trusted, and only for these requests: verification stays on.
  const agent = new https.Agent({ ca: fs.readFileSync(path.join(s.home, "remote-cert.pem")), keepAlive: false });
  const options = (method, p, extra = {}) => ({
    host: "127.0.0.1", port: s.remotePort, path: p, method, agent,
    headers: { "X-AIWB-Secret": s.secret, "X-AIWB-Client": id, ...extra },
  });
  let stream = null;
  function call(method, p, body) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const req = https.request(options(method, p, data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}), (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { text += c; });
        res.on("end", () => resolve({ status: res.statusCode, text }));
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
        stream = req;
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { buf += c; if (/"type":\s*"snapshot"/.test(buf)) resolve(); if (buf.length > 1 << 20) buf = buf.slice(-1024); });
        res.on("error", () => {});
      });
      req.on("error", (e) => { if (!stream) reject(e); });
      req.end();
      setTimeout(() => reject(new Error("GET /api/events: no snapshot in 10 s")), 10000).unref();
    });
  }
  const close = () => { stream?.destroy(); stream = null; agent.destroy(); };
  return { call, connect, close };
}

// ---- the page

let browser = null;
// openPage opens A's app in a context of its own and keeps what its console says. errors: console
// errors and uncaught exceptions; failedRequests: requests that failed or were answered with 400 or more.
async function openPage() {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const p = await ctx.newPage();
  p.setDefaultTimeout(8000);
  p.errors = [];
  p.failedRequests = [];
  p.on("console", (m) => { if (m.type() === "error") p.errors.push(m.text()); });
  p.on("pageerror", (e) => p.errors.push(`uncaught: ${e.message}`));
  p.on("requestfailed", (r) => p.failedRequests.push(`${r.method()} ${new URL(r.url()).pathname} ${r.failure()?.errorText}`));
  p.on("response", (r) => { if (r.status() >= 400) p.failedRequests.push(`${r.request().method()} ${new URL(r.url()).pathname} -> ${r.status()}`); });
  await p.goto(A.base);
  await p.waitForSelector("#root *", { timeout: 15000 });
  return p;
}
const sel = (p) => p.evaluate(() => JSON.parse(localStorage.getItem("aiwb.sel") ?? "{}"));
const menuItem = (p, text) => p.locator(".menu .menu-item", { hasText: text });
const rowOf = (p, name) => p.locator(".side-row.is-chat").filter({ has: p.locator(".side-name", { hasText: new RegExp(`^${name}$`) }) });
const rowLook = async (row) => ({ cls: (await row.getAttribute("class").catch(() => null)) ?? "no row", sub: await row.locator(".side-sub").innerText().catch(() => ""), title: (await row.getAttribute("title").catch(() => "")) ?? "" });
const one = (o) => JSON.stringify(o);
const box = (p) => p.locator(".composer .composer-input");
const boxText = (p) => box(p).evaluate((el) => ("value" in el ? el.value : el.innerText));
const serverChip = (p) => p.locator(".composer .server-pick button.tchip");
const msgs = async (p) => ({ user: await p.locator(".thread .msg.user").allInnerTexts(), assistant: await p.locator(".thread .msg.assistant").allInnerTexts() });
const counts = (m) => `${m.user.length} user, ${m.assistant.length} assistant`;
const noneTwice = (m) => new Set(m.user).size === m.user.length && new Set(m.assistant).size === m.assistant.length;
const replied = (p, text, timeout = 20000) => holds(`the reply to "${text}"`, async () => (await msgs(p)).assistant.some((t) => t.includes(`): ${text}`) || t.includes(text)), { timeout });

async function newChat(p) {
  const before = new Set((await stateOf(A)).chats.map((c) => c.id));
  await p.click("button.icon-btn.new");
  await menuItem(p, /^\s*New chat\s*$/).click();
  const id = await waitFor("the page selects its new chat", async () => { const c = (await sel(p)).chat; return c && !before.has(c) ? c : null; });
  await box(p).waitFor();
  return id;
}
async function pickServer(p, name) {
  await p.locator('.composer button.tchip[title^="Server"]').click();
  await p.locator('.composer .server-pick [role="option"]', { hasText: name }).click();
  await waitFor(`the server chip shows ${name}`, async () => (await serverChip(p).innerText()).includes(name));
}
/** Picks a folder of B in the folder picker of the chat on screen; `has` is a folder in it, which the picker must list first. */
async function pickFolder(p, dir, has) {
  await p.locator('.composer button.tchip[title^="Folder on"]').click();
  const dirs = p.locator(".composer .menu.dirs");
  await dirs.locator(".dir-input").fill(dir);
  await dirs.locator(".dir-input").press("Enter");
  await waitFor(`the picker lists ${has}`, async () => (await dirs.locator(".dir-list .menu-item.dir").allInnerTexts()).some((t) => t.includes(has)));
  await dirs.locator(".dir-foot button").click();
}
/** The text A keeps as a chat's draft. */
const draftOn = async (id) => (await get(A, `/api/chats/${id}/items`)).json?.state?.draft?.text ?? (await chatOn(A, id))?.draft?.text ?? "";
async function send(p, text) {
  await box(p).click();
  await box(p).fill(text);
  await box(p).press("Enter");
}
/** Names the chat on screen through its header, so that its row can be found by name. */
async function rename(p, id, name) {
  await p.locator("button.chat-head-name").click();
  const input = p.locator(".chat-head .name-input");
  await input.fill(name);
  await input.press("Enter");
  await waitFor(`chat ${id} is named ${name}`, async () => (await chatOn(A, id))?.name === name);
  await rowOf(p, name).waitFor();
}
async function rowMenu(p, row, item) {
  await row.hover();
  await row.locator("button.side-hover").first().click();
  await p.locator(".menu .menu-item", { hasText: new RegExp(`^\\s*${item}\\s*$`) }).click();
}
async function showArchived(p, on) {
  const sw = p.locator(".side-archived input");
  if ((await sw.isChecked()) !== on) await sw.click();
}

// ---- the steps

const FIRST = "Remote one", SECOND = "Remote two", THIRD = "Unstarted on B";
let chat1 = "", chat2 = "", chat3 = "", chatF = "", chatK = "", chatM = "";
let frozenStarted = false; // the chat of stepFrozen started on B: A has a record of it
const GONE_DIR = "gone-soon", BOARD = "blueprint"; // one word: a board's name is also its folder's
const UNCONFIRMED = `${B.name} did not answer: it is not known whether the first message arrived. Send again: it is sent only once.`;
let page2 = null;

async function step1() {
  chat1 = await newChat(page);
  await page.locator('.composer button.tchip[title^="Server"]').click();
  const more = page.locator(".composer .server-pick button.menu-more");
  const label = await more.innerText();
  await more.click();
  const dlg = page.locator(".servers-dialog");
  await dlg.waitFor();
  await check('1 the server choice ends with "Servers…", which opens the Servers dialog', label.trim() === "Servers…" && (await dlg.locator(".dialog-title").innerText()) === "Servers", `item "${label.trim()}"`);

  await dlg.locator("button", { hasText: /^Add server$/ }).click();
  const form = dlg.locator(".servers-form");
  const fields = form.locator(".servers-field input");
  await fields.nth(0).fill(B.name);
  await fields.nth(1).fill(`https://127.0.0.1:${B.remotePort}`);
  await fields.nth(2).fill(B.secret);
  await form.locator(".servers-check input").check();
  await form.locator("button", { hasText: /^Test connection$/ }).click();
  const accept = form.locator("button", { hasText: /^Accept fingerprint$/ });
  await accept.waitFor();
  const shown = (await form.locator(".servers-result .servers-fp").last().innerText()).trim();
  await check("1 the form shows the fingerprint that `remote setup` printed", shown === B.fingerprint, `shown ${shown}, printed ${B.fingerprint}`);
  await accept.click();
  const save = form.locator("button.primary", { hasText: /^Save$/ });
  await waitFor("Save is enabled after the accepted test", async () => !(await save.isDisabled()));
  await save.click();
  const row = dlg.locator(".servers-row").filter({ has: page.locator(".servers-name", { hasText: new RegExp(`^${B.name}$`) }) });
  const state = row.locator(".servers-state");
  const ok = await holds("the row reads Connected", async () => (await state.innerText()) === "Connected", { timeout: 20000 });
  await check('1 B is added and its row reads "Connected"', ok, `row: ${(await row.innerText().catch(() => "no row")).replace(/\n/g, " / ")}`);
  await dlg.locator("button", { hasText: /^Close$/ }).click();
  await dlg.waitFor({ state: "detached" });
}

async function step2() {
  await pickServer(page, B.name);
  const onB = await holds("the chat is on B's entry in A's state", async () => { const e = await entry(); return !!e && (await chatOn(A, chat1))?.server === e.id; });
  await check("2 B is picked: the chip shows its name", onB, `chip "${(await serverChip(page).innerText()).replace(/\s+/g, " ")}"`);

  const agentChip = page.locator('.composer button.tchip[title^="Agent"]');
  await agentChip.click();
  const options = page.locator('.composer .menu [role="option"]');
  await options.first().waitFor();
  const listed = (await options.allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
  const offered = (await entry())?.agents ?? [];
  await check("2 the agent choice lists B's agents", listed.length === offered.length && listed.length > 0 && listed.every((t) => /Claude/.test(t)), `listed: ${listed.join(", ")}; B's entry: ${offered.join(", ")}`);
  await options.first().click();

  const folder = page.locator('.composer button.tchip[title^="Folder on"]');
  await folder.click();
  const dirs = page.locator(".composer .menu.dirs");
  const head = (await dirs.locator(".menu-head").textContent()) ?? ""; // not innerText: the head is drawn in capitals
  await dirs.locator(".dir-input").fill(B.work);
  await dirs.locator(".dir-input").press("Enter");
  const there = await holds("the picker lists the folder made in B's work folder", async () => (await dirs.locator(".dir-list .menu-item.dir").allInnerTexts()).some((t) => t.includes(B_ONLY)));
  await check(`2 the folder picker is titled "Folder on ${B.name}" and lists folders of B's machine`, head.trim() === `Folder on ${B.name}` && there === true,
    `head "${head.trim()}"; listed: ${(await dirs.locator(".dir-list").innerText().catch(() => "")).replace(/\n/g, ", ")}`);
  await dirs.locator(".dir-foot button").click();
  const picked = await holds("the chat's folder is B's work folder", async () => (await chatOn(A, chat1))?.cwd === B.work);
  await check("2 B's work folder is picked for the chat", picked, `folder chip: ${await folder.getAttribute("title").catch(() => "?")}`);
}

async function step3() {
  await send(page, '[[ask Bash {"command":"ls"}]] hello');
  const card = page.locator(".thread .perm-title");
  const asked = await card.waitFor({ timeout: 20000 }).then(() => true, (e) => e.message.split("\n")[0]);
  const row = page.locator(".side-row.is-chat.on");
  const look = await rowLook(row);
  await check("3 the row shows the working or approval state and B's name", /\bst-(approval|working|busy)\b/.test(look.cls) && look.sub.endsWith(`· ${B.name}`), one(look));
  await check("3 the thread shows the permission card", asked, asked === true ? await card.innerText() : `composer: ${await page.locator(".composer-err").innerText().catch(() => "no error line")}`);
  if (asked === true) await page.locator(".thread .perm-actions button", { hasText: /^Allow$/ }).click();
  const reply = await replied(page, "ask Bash -> allow");
  await check("3 Allow is clicked and the reply arrives", reply, `thread: ${one(await msgs(page)).slice(0, 300)}`);
  const onB = await holds("B has the user message", async () => (await userTexts(B, chat1)).length > 0).then(() => userTexts(B, chat1), () => []);
  await check("3 B's own API has the same user message once", onB.length === 1 && onB[0].includes("hello"), `B's user messages: ${one(onB)}`);
  await waitFor("the first turn ends", async () => (await chatOn(B, chat1))?.status === "ready").catch(() => {});
  await rename(page, chat1, FIRST);
}

async function step4() {
  await send(page, "again");
  const reply = await replied(page, "again");
  const m = await msgs(page);
  await check('4 the reply to "again" shows', reply, one(m.assistant).slice(0, 300));
  await check("4 the thread has two user and two assistant messages, none twice", m.user.length === 2 && m.assistant.length === 2 && noneTwice(m), `${counts(m)}: ${one(m).slice(0, 400)}`);
  const fixedServer = page.locator('.composer .tchip.static.server-chip[title^="Server"]');
  const open = (await page.locator('.composer button.tchip[title^="Server"]').count()) + (await page.locator('.composer button.tchip[title^="Agent"]').count());
  await check("4 the server and agent choices are fixed chips", (await fixedServer.count()) === 1 && (await fixedServer.innerText()).includes(B.name) && open === 0,
    `fixed server chips ${await fixedServer.count()}, open server or agent choices ${open}`);
  await waitFor("the second turn ends", async () => (await chatOn(B, chat1))?.status === "ready").catch(() => {});
}

async function step5() {
  await stop(B);
  const row = rowOf(page, FIRST);
  const off = await holds("the row is off", async () => /\boff\b/.test((await rowLook(row)).cls), { timeout: 20000 });
  const look = await rowLook(row);
  await check('5 B is stopped: the row gets its "not connected" form', off === true && look.title === `${B.name} is not connected` && (await row.locator(".crow-dot.st-off").count()) === 1, one(look));
  const bar = page.locator(".thread .remote-bar.off");
  const barOn = await bar.waitFor({ timeout: 5000 }).then(() => true, () => false);
  const m = await msgs(page);
  await check("5 the thread stays on screen with the bar", barOn && m.user.length === 2 && m.assistant.length === 2 && (await bar.locator("button.remote-servers").count()) === 1,
    `bar "${await bar.innerText().catch(() => "none")}", ${counts(m)}`);

  const text = "sent while B is down";
  await send(page, text);
  const err = page.locator(".composer-err");
  const said = await err.waitFor({ timeout: 10000 }).then(() => err.innerText(), () => "");
  const kept = await boxText(page);
  await check("5 a send keeps the text in the box with the server's sentence", kept.trim() === text && said.trim() !== "" && (await msgs(page)).user.length === 2, `box "${kept.trim()}", sentence "${said.trim()}"`);

  // The chat opened fresh: a second page (a context of its own, so nothing is kept) that selects it.
  page2 = await openPage();
  await rowOf(page2, FIRST).click();
  const view = page2.locator(".thread .remote-off.unreachable");
  const seen = await view.waitFor({ timeout: 15000 }).then(() => true, () => false);
  await check('5 opened fresh, the chat shows the "server unreachable" view with a "Servers…" button',
    seen && (await view.locator("button.remote-servers").innerText().catch(() => "")) === "Servers…",
    seen ? (await view.innerText()).replace(/\n/g, " / ") : `thread: ${(await page2.locator(".thread").innerText().catch(() => "none")).slice(0, 200)}`);
}

async function step6() {
  await start(B);
  // No reload, no click, and no call that makes A dial: A's own next attempt is waited for (its
  // waits between attempts grow to 30 s).
  const row = rowOf(page, FIRST);
  const t0 = Date.now();
  const back = await holds("the row is no longer off", async () => !/\boff\b/.test((await rowLook(row)).cls), { timeout: 90000, every: 250 });
  await check("6 B is started again: the row turns back with no reload and no click", back, `${one(await rowLook(row))} after ${Math.round((Date.now() - t0) / 1000)} s`);
  const current = await holds("the bar is gone and the thread is as before", async () => {
    const m = await msgs(page);
    return (await page.locator(".thread .remote-bar").count()) === 0 && m.user.length === 2 && m.assistant.length === 2;
  }, { timeout: 10000 });
  await check("6 the chat on screen is current: the bar is gone, the thread is whole", current);
  if (page2) {
    const fresh = await holds("the second page shows the thread", async () => { const m = await msgs(page2); return m.user.length === 2 && m.assistant.length === 2 && noneTwice(m); }, { timeout: 15000 });
    await check('6 the page that showed "server unreachable" shows the thread, with no click', fresh,
      `second page's console: ${page2.errors.slice(-3).join(" ; ") || "no error"}; requests: ${page2.failedRequests.slice(-4).join(" ; ") || "none failed"}`);
  }
  // The refusal of step 5 was about a server that is connected again: its sentence is gone, and the text is still in the box.
  const err = page.locator(".composer-err");
  const cleared = await holds("the refusal's line is gone", async () => (await err.count()) === 0, { timeout: 5000 });
  await check("6 the refusal's line under the composer is gone", cleared === true, `line "${await err.innerText().catch(() => "none")}"; box "${(await boxText(page)).trim()}"`);
  await send(page, "back");
  const reply = await replied(page, "back");
  const m = await msgs(page);
  await check("6 a message sent now is answered on screen", reply === true && m.user.length === 3 && m.assistant.length === 3 && noneTwice(m), `${reply === true ? "" : reply + " "}${counts(m)}: ${one(m).slice(0, 400)}`);
  if (page2) {
    const also = await holds("the second page has the new turn", async () => { const m2 = await msgs(page2); return m2.user.length === 3 && m2.assistant.length === 3 && noneTwice(m2); }, { timeout: 15000 });
    await check("6 the second page gets the new turn too", also, counts(await msgs(page2)));
    await page2.context().close();
    page2 = null;
  }
  await waitFor("the third turn ends", async () => (await chatOn(B, chat1))?.status === "ready").catch(() => {});
}

/** The first message of a chat on B while B does not answer (frozen by SIGSTOP): the thread shows
 *  the text and that it is being sent, and A keeps the text as the chat's draft; B goes on
 *  (SIGCONT) and the reply arrives. */
async function stepFrozen() {
  const up = await connected(90000);
  chatF = await newChat(page);
  if (up === true && !(await serverChip(page).innerText()).includes(B.name)) await pickServer(page, B.name);
  const text = "first while B is frozen";
  const p = B.proc.p;
  p.kill("SIGSTOP");
  try {
    await send(page, text);
    await sleep(2000);
    const bubble = await page.locator(".thread .msg.user.starting").allInnerTexts();
    const line = (await page.locator(".thread .starting-line").innerText().catch(() => "")).trim();
    const empty = await page.locator(".thread .empty-thread").count();
    await check("F5 B does not answer: after 2 s the thread shows the text and that it is being sent", bubble.length === 1 && bubble[0].trim() === text && line === `Sending to ${B.name}…` && empty === 0,
      `bubbles ${one(bubble)}; line "${line}"; empty states ${empty}; box "${(await boxText(page)).trim()}"`);
    const r = await get(A, `/api/chats/${chatF}/items`);
    const draft = r.json?.state?.draft?.text ?? (await chatOn(A, chatF))?.draft?.text ?? "";
    await check("F5 A's chat still has the text as its draft", draft === text, `items -> ${r.status}; draft ${one(draft)}; state ${one(r.json?.state ?? null).slice(0, 300)}`);
  } finally {
    p.kill("SIGCONT");
  }
  const reply = await replied(page, text, 60000);
  const m = await msgs(page);
  const sendingGone = (await page.locator(".thread .msg.user.starting, .thread .starting-line").count()) === 0;
  frozenStarted = (await userTexts(B, chatF).catch(() => [])).length === 1;
  await check("F5 B goes on: the reply arrives, the message is once in the thread and the box is empty",
    reply === true && m.user.length === 1 && m.assistant.length === 1 && sendingGone && frozenStarted && (await boxText(page)).trim() === "",
    `${reply === true ? "" : reply + " "}${counts(m)}: ${one(m).slice(0, 300)}; "sending" gone: ${sendingGone}; on B: ${frozenStarted}; box "${(await boxText(page)).trim()}"`);
  await waitFor("its turn ends", async () => (await chatOn(B, chatF))?.status === "ready").catch(() => {});
}

async function step7() {
  await showArchived(page, true);
  const api = apiClient(B);
  try {
    await api.connect();
    const r = await api.call("POST", `/api/chats/${chat1}/archive`);
    const row = rowOf(page, FIRST);
    const shown = await holds("A's row is archived", async () => /\barchived\b/.test((await rowLook(row)).cls), { timeout: 15000 });
    await check("7 the chat is archived on B by an API client: A's row shows as archived", r.status === 200 && shown === true,
      `archive on B -> ${r.status} ${r.text.slice(0, 120)}; row ${one(await rowLook(row))}; tag "${await row.locator(".archived-tag").innerText().catch(() => "none")}"`);
    await rowMenu(page, row, "Unarchive");
    const undone = await holds("B's chat is unarchived", async () => (await chatOn(B, chat1))?.archived !== true && (await chatOn(B, chat1)) !== null, { timeout: 15000 });
    const rowBack = await holds("A's row is not archived", async () => !/\barchived\b/.test((await rowLook(row)).cls), { timeout: 10000 });
    await check("7 unarchived from A's page: B's chat is unarchived and A's row too", undone === true && rowBack === true, `B: ${undone}; row: ${one(await rowLook(row))}`);
  } finally {
    api.close();
  }
}

async function step8() {
  chat2 = await newChat(page);
  if (!(await serverChip(page).innerText()).includes(B.name)) await pickServer(page, B.name);
  await send(page, "second chat");
  const reply = await replied(page, "second chat");
  const onB = await holds("B has the second chat", async () => (await userTexts(B, chat2)).length === 1);
  await check("8 a second remote chat is made and answered", reply === true && onB === true, `reply: ${reply}; on B: ${onB}`);
  await waitFor("its turn ends", async () => (await chatOn(B, chat2))?.status === "ready").catch(() => {});
  await rename(page, chat2, SECOND);

  await stop(B);
  const row = rowOf(page, SECOND);
  await waitFor("the second chat's row is off", async () => /\boff\b/.test((await rowLook(row)).cls), { timeout: 20000 });
  await rowMenu(page, row, "Delete");
  const dlg = page.locator(".dialog");
  const first = await dlg.locator(".dialog-title").innerText();
  await dlg.locator("button", { hasText: /^Delete$/ }).click();
  const only = dlg.locator("button", { hasText: /^Remove from this sidebar only$/ });
  const offered = await only.waitFor({ timeout: 15000 }).then(() => true, () => false);
  await check('8 with B down the delete is refused and the dialog offers "Remove from this sidebar only"', first === `Delete ${SECOND}?` && offered,
    `first dialog "${first}"; then "${await dlg.locator(".dialog-title").innerText().catch(() => "closed")}": ${await dlg.locator(".dialog-body, .dialog-err").allInnerTexts().catch(() => [])}`);
  if (offered) await only.click(); else await page.keyboard.press("Escape");
  const gone = await holds("the row and A's record are gone", async () => (await row.count()) === 0 && (await chatOn(A, chat2)) === null, { timeout: 10000 });
  await check("8 the offer is taken: the row goes", gone);

  await start(B);
  const has = await holds("B still has the chat", async () => (await userTexts(B, chat2)).length === 1);
  await check("8 B is started again and still has the chat that left A's sidebar", has);
}

/** W26 (AC16 c): the first message of a chat whose folder is no longer on B is refused with the
 *  text kept and the chat still a draft; with a folder that is there it is sent. */
async function stepFolderGone() {
  const up = await connected(90000);
  chatK = await newChat(page);
  if (up === true && !(await serverChip(page).innerText()).includes(B.name)) await pickServer(page, B.name);
  const dir = path.join(B.work, GONE_DIR);
  fs.mkdirSync(path.join(dir, "inner"), { recursive: true });
  await pickFolder(page, dir, "inner");
  const picked = await holds("the chat's folder is the new folder of B", async () => (await chatOn(A, chatK))?.cwd === dir);
  fs.rmSync(dir, { recursive: true, force: true });
  const text = "kept text";
  await send(page, text);
  const err = page.locator(".composer-err");
  const said = await holds("the composer's line", async () => (await err.innerText()).trim() !== "", { timeout: 20000 }).then(() => err.innerText(), () => "");
  await sleep(500);
  const m = await msgs(page);
  const pickers = await serverChip(page).count();
  await check("W26 a first message to a folder that is no longer on B: a line under the composer, the text still in the box, no message in the thread, the server still a choice",
    picked === true && said.trim() !== "" && (await boxText(page)).trim() === text && m.user.length === 0 && pickers === 1 && (await userTexts(B, chatK)).length === 0,
    `folder picked: ${picked}; line "${said.trim()}"; box "${(await boxText(page)).trim()}"; ${counts(m)}; server pickers ${pickers}; on B: ${(await userTexts(B, chatK)).length} user messages`);

  await pickFolder(page, B.work, B_ONLY);
  await waitFor("the chat's folder is B's work folder", async () => (await chatOn(A, chatK))?.cwd === B.work);
  if ((await boxText(page)).trim() === text) await box(page).press("Enter"); else await send(page, text);
  const reply = await replied(page, text);
  const m2 = await msgs(page);
  const onB = await holds("B has the message once", async () => (await userTexts(B, chatK)).length === 1);
  await check("W26 B's work folder is picked and the kept text is sent: one user message and the reply", reply === true && m2.user.length === 1 && m2.assistant.length === 1 && onB === true,
    `${reply === true ? "" : reply + " "}${counts(m2)}: ${one(m2).slice(0, 300)}; on B: ${onB}; line "${(await err.innerText().catch(() => "")).trim()}"`);
  await waitFor("its turn ends", async () => (await chatOn(B, chatK))?.status === "ready").catch(() => {});
}

/** W28 (AC34): a chat on a board is on this computer, and its composer offers no server choice. */
async function stepBoard() {
  await page.click("button.icon-btn.new");
  await menuItem(page, /^\s*New whiteboard\s*$/).click();
  const board = await waitFor("the page selects its new board", async () => (await sel(page)).board ?? null);
  const input = page.locator(".side-row.is-board .name-input"); // the row opens in rename mode
  await input.waitFor();
  await input.fill(BOARD);
  await input.press("Enter");
  await input.waitFor({ state: "detached" });
  const before = new Set((await stateOf(A)).chats.map((c) => c.id));
  await page.locator(".board-bar button", { hasText: /^\+ Chat on this board$/ }).click();
  const id = await waitFor("the page selects the board's new chat", async () => { const c = (await sel(page)).chat; return c && !before.has(c) ? c : null; });
  await box(page).waitFor();
  const chip = page.locator(".composer .server-chip.static");
  const seen = { chips: await chip.count(), text: (await chip.first().innerText().catch(() => "")).trim(), title: (await chip.first().getAttribute("title").catch(() => "")) ?? "", pickers: await page.locator(".composer .server-pick").count() };
  const c = await chatOn(A, id);
  await check('W28 a chat on a board: one fixed server chip "This computer" with the board\'s reason, and no server choice',
    c?.board === board && !c?.server && seen.chips === 1 && seen.text === "This computer" && seen.title === "Server — Boards and their chats are on this computer" && seen.pickers === 0,
    `${one(seen)}; A's chat: ${one(c && { board: c.board, server: c.server ?? null })}`);
}

/** The first message of a chat on B while B does not answer for A's whole wait (45 s): the send
 *  ends with "not known whether the first message arrived" and the text is back in the box. The
 *  text is then edited and saved as A's draft; B goes on, and with no click the message is in the
 *  thread once, answered, and the box keeps the edited text. */
async function stepFrozenLong() {
  const up = await connected(90000);
  chatM = await newChat(page);
  if (up === true && !(await serverChip(page).innerText()).includes(B.name)) await pickServer(page, B.name);
  const text = "first M1", edited = "first M1 EDITED";
  const p = B.proc.p;
  let saved = false;
  p.kill("SIGSTOP");
  try {
    await send(page, text);
    const line = page.locator(".composer", { hasText: UNCONFIRMED });
    const t0 = Date.now();
    const said = await holds("the line of a first message that got no answer", async () => (await line.count()) > 0, { timeout: 75000, every: 250 });
    const back = await holds("the text is back in the box", async () => (await boxText(page)).trim() === text, { timeout: 10000 });
    await check("FM B does not answer for the whole wait: the line says it is not known whether the first message arrived, and the text is back in the box", said === true && back === true,
      `after ${Math.round((Date.now() - t0) / 1000)} s; box "${(await boxText(page)).trim()}"; composer: "${(await page.locator(".composer-err, .composer .agent-reason").allInnerTexts()).join(" / ")}"`);
    await box(page).click();
    await box(page).fill(edited);
    const kept = await holds("A has the edited text as the chat's draft", async () => (await draftOn(chatM)) === edited, { timeout: 15000 });
    saved = kept === true;
    if (!saved) await check("FM the edited text is saved as A's draft", kept, `draft ${one(await draftOn(chatM).catch(() => "?"))}`);
  } finally {
    p.kill("SIGCONT");
  }
  // Nothing is pressed from here on.
  const t1 = Date.now();
  const settled = await holds('the thread has "first M1" once and its reply', async () => { const m = await msgs(page); return m.user.length === 1 && m.user[0].trim() === text && m.assistant.length === 1 && m.assistant[0].includes(text); }, { timeout: 30000, every: 250 });
  const took = Math.round((Date.now() - t1) / 1000);
  await sleep(1500); // what the page does at the swap has happened by now
  const m = await msgs(page);
  const sendingGone = (await page.locator(".thread .msg.user.starting, .thread .starting-line").count()) === 0;
  const onB = await userTexts(B, chatM).catch(() => []);
  await check('FM B goes on, nothing is pressed: the thread shows "first M1" once and its reply', settled === true && m.user.length === 1 && m.assistant.length === 1 && sendingGone && onB.length === 1 && onB[0].trim() === text,
    `${settled === true ? `after ${took} s; ` : settled + " "}${counts(m)}: ${one(m).slice(0, 300)}; "sending" gone: ${sendingGone}; on B: ${one(onB)}`);
  const now = (await boxText(page)).trim();
  await check('FM the box holds the edited text "first M1 EDITED"', saved && now === edited, `box "${now}"; A's draft ${one(await draftOn(chatM).catch(() => "?"))}`);
  const under = (await page.locator(".composer-err, .composer .agent-reason").allInnerTexts()).join(" / ");
  const whole = await page.locator(".composer").first().innerText().catch(() => "");
  await check(`FM no line "${B.name} is not connected." is under the composer`, !under.includes(`${B.name} is not connected`) && !whole.includes(`${B.name} is not connected`) && !whole.includes(UNCONFIRMED), `lines "${under}"`);
  await waitFor("its turn ends", async () => (await chatOn(B, chatM))?.status === "ready").catch(() => {});
}

async function step9() {
  // A may still be in a wait between attempts: a look at the Servers dialog is not needed for the
  // removal, but the unstarted chat below can be put on B only while B is connected.
  const up = await connected(90000);
  chat3 = await newChat(page);
  if (up === true && !(await serverChip(page).innerText()).includes(B.name)) await pickServer(page, B.name);
  const e = await entry();
  const placed = await holds("the unstarted chat is on B", async () => !!e && (await chatOn(A, chat3))?.server === e.id, { timeout: 5000 });
  await rename(page, chat3, THIRD);
  await check("9 a third chat is put on B and left unstarted", up === true && placed === true, `connected: ${up}; on B: ${placed}`);

  // W17 (AC44): B stops with that chat open. Its agents are not known, and it takes no first message.
  await box(page).click();
  await box(page).fill("typed while B is down");
  await stop(B);
  const offLine = `${B.name} is not connected: its agents are not known.`;
  const reason = page.locator(".composer .agent-reason");
  const lineOn = await holds('the "not connected" line shows', async () => (await reason.allInnerTexts()).some((t) => t.trim() === offLine), { timeout: 20000 });
  const sendBtn = page.locator(".composer button.send:not(.stop)");
  const w17 = { agentButtons: await page.locator('.composer button.tchip[title^="Agent"]').count(), line: (await reason.allInnerTexts()).join(" / "), sendDisabled: await sendBtn.isDisabled().catch(() => null), sendTitle: await sendBtn.getAttribute("title").catch(() => "") };
  await check('9 W17 B is stopped with the unstarted chat open: no Agent button, the "not connected" line, Send disabled', lineOn === true && w17.agentButtons === 0 && w17.sendDisabled === true, one(w17));
  await box(page).fill("");
  await start(B);
  const again = await connected(90000);
  if (again !== true) await check("9 A is connected to B again before the removal", again);

  await page.locator("button.servers-btn").click();
  const dlg = page.locator(".servers-dialog");
  const row = dlg.locator(".servers-row").filter({ has: page.locator(".servers-name", { hasText: new RegExp(`^${B.name}$`) }) });
  await row.locator("button", { hasText: /^Remove$/ }).click();
  const ask = page.locator(".dialog").filter({ has: page.locator(".dialog-title", { hasText: /^Remove server$/ }) });
  const body = await ask.locator(".dialog-body").innerText();
  // B's chats here are the started ones A still lists (the second left A's sidebar in step 8); the unstarted one is still an object of this computer.
  let has = 0;
  for (const id of [chat1, chatF, chatK, chatM]) if (id && (await chatOn(A, id)) && (await userTexts(B, id).catch(() => [])).length > 0) has++;
  const n = has === 1 ? "1 chat" : `${has} chats`;
  await check("9 the confirmation names the count of chats", body.includes(`It has ${n} and 0 runs in this app`) && body.includes(`"${B.name}"`), `expected "${n}": ${body}`);
  await ask.locator("button", { hasText: /^Remove$/ }).click();
  const removed = await holds("the entry is gone", async () => (await entry()) === null && (await row.count()) === 0, { timeout: 10000 });
  await dlg.locator("button", { hasText: /^Close$/ }).click();
  await dlg.waitFor({ state: "detached" });
  const rowGone = await holds("the remote chat's row is gone", async () => (await rowOf(page, FIRST).count()) === 0 && (await chatOn(A, chat1)) === null, { timeout: 10000 });
  await check("9 B's entry is removed and the remote chat's row goes from the sidebar", removed === true && rowGone === true, `entry: ${removed}; row: ${rowGone}`);

  await rowOf(page, THIRD).click();
  const local = await holds("the unstarted chat is on this computer", async () => !(await chatOn(A, chat3))?.server && (await serverChip(page).innerText()).includes(A.name), { timeout: 10000 });
  await check('9 the chat that was unstarted on B is back on "This computer"', local,
    `row ${one(await rowLook(rowOf(page, THIRD)))}; chip "${(await serverChip(page).innerText().catch(() => "none")).replace(/\s+/g, " ")}"; A's record: server ${one((await chatOn(A, chat3))?.server ?? null)}`);
  const kept = [await userTexts(B, chat1), await userTexts(B, chat2)];
  await check("9 B still has its chats", kept[0].length === 3 && kept[1].length === 1, `user messages on B: ${kept[0].length} in the first chat, ${kept[1].length} in the second`);
}

// ---- main

let code = 0;
try {
  await prepare();
  await start(A);
  await start(B);
  console.log(`# A on ${A.base}; B on ${B.base}, remote listener on https://127.0.0.1:${B.remotePort}; files in ${OUT}`);
  let chromium;
  try { ({ chromium } = await import("playwright")); }
  catch { throw new Error("playwright is not installed: cd web && npm install --no-save playwright && npx playwright install chromium"); }
  browser = await chromium.launch({ headless: true });
  page = await openPage();
  await step("1 add B", step1);
  await step("2 pick B", step2);
  await step("3 first message", step3);
  await step("4 second message", step4);
  await step("5 outage", step5);
  if (!B.proc) await step("6 return", step6);
  else await check("6 return: B was stopped before", false, "step 5 did not stop B");
  await step("F5 first message while B does not answer", stepFrozen);
  await step("7 archive made on B", step7);
  await step("8 delete with B down", step8);
  if (!B.proc) await start(B).catch(() => {});
  await step("W26 a folder that is gone", stepFolderGone);
  await step("W28 a chat on a board", stepBoard);
  await step("FM first message, no answer in the whole wait", stepFrozenLong);
  if (!B.proc) await start(B).catch(() => {});
  await step("9 remove the entry", step9);
  // Not checks: the outage and the refused delete are answered 503 by design, and the browser logs those.
  console.log(`# the page's console errors (${page.errors.length}): ${[...new Set(page.errors)].slice(0, 8).join(" ; ") || "none"}`);
  console.log(`# the page's requests that failed (${page.failedRequests.length}): ${[...new Set(page.failedRequests)].slice(0, 12).join(" ; ") || "none"}`);
  code = failed ? 1 : 0;
} catch (e) {
  console.log(`FAIL - the script could not go on: ${e.stack || e}`);
  code = 2;
} finally {
  if (browser) await browser.close().catch(() => {});
  await stop(A);
  await stop(B);
}
const alive = [...A.pids, ...B.pids].filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
const free = (await Promise.all([A.port, B.port, B.remotePort].filter(Boolean).map(portFree))).every(Boolean);
page = null;
if (A.port && !(await check("both servers are stopped and their ports are free", free && alive.length === 0, `ports ${A.port}, ${B.port}, ${B.remotePort}; processes left: ${alive.join(", ") || "none"}`)) && !code) code = 1;
if (code === 0 && process.env.AIWB_E2E_KEEP !== "1") fs.rmSync(OUT, { recursive: true, force: true });
else console.log(`# files kept in ${OUT}`);
console.log(code === 0 ? "# passed" : code === 2 ? "# could not run to the end" : `# failed (${failed} checks)`);
process.exit(code);
