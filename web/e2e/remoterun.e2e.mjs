// A run and a whiteboard of a remote server's section, through the real pages
// (plans/remote-server-sections-goal.md, sections 3.4 to 3.9 and 7).
//
// A run made in a section is on that server from the moment it is made, before it starts; a
// whiteboard made there is on that server at once. Both open in the views a local one has. When
// the server drops, an open run view stays as it was, read-only, under a warning, and an open
// whiteboard can still be drawn on, under the banner that its changes are not saved. The Go
// tests show that with stand-in pages; this script shows it with the pages themselves in a
// headless Chrome (Playwright), against two real servers:
//
//   A   the local server. Its page is "the page": the client.
//   B   the remote server, an entry of A's server list ("Studio B"). Its own page, on its own
//       port, is "the owner's page". Its work folder is a git repository: the run's folder.
//
// Between A and B stands a link the script owns (a TCP relay: A dials it in the place of B's
// remote listener, by the server's test hook AIWB_TEST_DIAL_VIA), so that the script can pull
// the network while B and its owner go on. A's waits between two attempts to connect are lowered
// (AIWB_TEST_WAITS), so that a return is seen in seconds; every other wait is the production one.
//
// It spends no money: both servers run the stand-in agent internal/agenttest/fake-claude and have
// no Cursor and no pi; the run's goal carries the stand-in's directives, so the run adds one task
// that writes a file and then ends as achieved. It never touches the installed app: the script
// builds its own binary into a temp folder, runs both servers on temp data folders and on free
// ports, and stops them at the end. Not part of `npm test`.
//
//   cd web && npm ci && npm run build && npm install --no-save playwright && npx playwright install chromium
//   node web/e2e/remoterun.e2e.mjs
//
// Steps (goal section in brackets):
//   1 B is added in the Servers dialog; the owner makes a group on B's own page
//   2 "Run" from the "+" of that group in the section: the run is on B at once, in that group,
//     before it starts, and nothing offers a choice of a server; its agents, models and folders
//     are B's; the goal that is typed is the run's on B, and the owner's page shows the run that
//     has not started, with its goal                                                    [3.4, D16]
//   3 the goal, Enter: the run starts on B, in B's repository; turn 1 shows; A keeps nothing of it  [3.4, 3.12]
//   4 the orchestrator's transcript ("Transcript ›") has text and is read-only          [3.6]
//   5 the link is pulled while the task works: the run view stays as it was, read-only, under the
//     warning that names B; the section has no row. Back: the view is level again and the run
//     ends on the page with no reload and no click; B's repository has the result       [3.8, 3.9]
//   6 "+" on the run's row: a chat on the run, on B at once, answered in the run's folder  [3.4]
//   7 a run that has not started is open when the link is pulled: its goal box is read-only and
//     keeps what was typed, which is saved when B is back                                [3.8, 3.9]
//   8 the run is deleted on B's own page during an outage: back, its view says that it is no
//     longer on that server                                                              [3.5, 3.9]
//   9 "Whiteboard" from the section's "+": on B at once, nothing asks; a drawing is saved on B,
//     and an agent on B reads the board through the page that holds it. The link is pulled: the board can still be drawn on, under the "not saved" banner. Back,
//     with nobody having changed it there: the drawing is saved                          [3.4, 3.8, 3.9]
//   V1 the local server restarts during an outage while the page holds the board with a drawing
//     that is not saved: the page keeps it, and it is saved when B is back                [3.8, V1]
//   10 pulled again and drawn on, and changed on B's own page meanwhile. The owner's page is
//     closed by then: back, the drawing made here is dropped with the notice, and B's drawing
//     stands. The owner's page still has the board open: back, the page shows the take-over
//     panel and keeps its drawing until "Use here", which drops it with the same notice   [3.6, 3.9]
//   11 one draws at a time: the owner opens the board and the page shows the take-over panel;
//     "Use here" takes it back                                                            [3.6]
//   12 the board is deleted on B during an outage: back, its view says that it is no longer there  [3.5]
//
// It prints one line per check, `ok <n> <what>` or `FAIL <n> <what> — <what was seen>`, saves a
// screenshot for a failed check, and exits with 1 when a check failed (2 when it could not run).
//
// Environment (all optional):
//   AIWB_E2E_BIN       server binary                    (default: built into the temp folder)
//   AIWB_E2E_CLIENT    built web client                 (default web/dist)
//   AIWB_E2E_KEEP=1    keep the temp folder (server logs, screenshots) after a run that passed;
//                      after a failed run it is always kept, and its path is printed
//   AIWB_E2E_SHOTS     a folder that gets a picture of the page after each check, named by the check's number, to
//                      judge by eye what the checks read (the run view and the board under an outage, the panels)
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLIENT = path.resolve(process.env.AIWB_E2E_CLIENT || path.join(repo, "web/dist"));

// Everything the run makes: the binary, both servers' folders, the logs, screenshots.
// realpath: on macOS the temp folder is a symlink, and the server reports folders resolved.
const OUT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-e2e-remoterun-")));
const BIN = path.resolve(process.env.AIWB_E2E_BIN || path.join(OUT, "aiwb"));
const FAKE = path.join(OUT, "bin", "fake-claude");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, fn, { timeout = 20000, every = 100 } = {}) {
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

const SHOTS = process.env.AIWB_E2E_SHOTS ? path.resolve(process.env.AIWB_E2E_SHOTS) : ""; // pictures to judge by eye: no check reads them
let failed = 0;
let n = 0;
let page = null;  // A's page: a failed check takes its screenshot and what it logged since the last check
let owner = null; // B's own page
let told = { errors: 0, requests: 0 };
async function check(what, pass, seen = "") {
  n++;
  if (SHOTS && page) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${String(n).padStart(2, "0")}.png`) }).catch(() => {}); }
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
      if (owner) await owner.screenshot({ path: path.join(OUT, `fail-${n}-owner.png`) }).catch(() => {});
    }
    console.log(`FAIL ${n} ${what} — ${[d, ...extra].filter(Boolean).join(" | ").replace(/\s+/g, " ") || "not as expected"}`);
  }
  if (page) told = { errors: page.errors.length, requests: page.failedRequests.length };
  return pass === true;
}
/** A step that threw: one failed check, and the script goes on with the next step. */
async function step(name, fn) {
  try { await fn(); }
  catch (e) {
    await check(`${name}: the step ran to its end`, false, e.message);
    for (const p of [page, owner]) await p?.keyboard.press("Escape").catch(() => {});
  }
}
/** all(...): true when every part is true, else the first that is not (its sentence). */
const all = (...parts) => parts.find((x) => x !== true) ?? true;

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
const B = scratch("b", "Studio B");      // the remote one, an entry of A's server list; its work folder is the run's repository
const B_ONLY = "only-on-b";              // a folder in B's work folder: the folder picker must list it

// git for B's repository, away from the user's and the system's config.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
const git = (dir, ...args) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: dir, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// ---- the link between A and B's remote listener. A dials it whatever the entry's address is
// (AIWB_TEST_DIAL_VIA; TLS, the pin and the Host header stay the entry's), and it passes the
// bytes on to `target`. pass: as a wire. cut: every connection ends and none is taken (the
// network is pulled; B goes on). hold: a connection is taken and nothing is passed on (a server
// that does not answer the dial). mute: what A sends arrives, what the other side answers is
// held back until pass (answers that are late or lost). stall: nothing passes either way on the
// connections that are open, until pass (what A sends has not arrived yet). slow: what the other
// side answers arrives `delay` later (a slow line: a connection takes seconds to be made).
const link = { port: 0, target: 0, mode: "pass", delay: 1500, pairs: new Set(), server: null };
/** Passes what the other side answers on to A: at once, or `delay` later while the link is slow, in the order it came. */
function answersTo(pair) {
  pair.u.on("data", (d) => {
    const due = Math.max(Date.now() + (link.mode === "slow" ? link.delay : 0), pair.due ?? 0);
    pair.due = due;
    if (due <= Date.now()) { if (!pair.c.destroyed) pair.c.write(d); return; }
    setTimeout(() => { if (!pair.c.destroyed) pair.c.write(d); }, due - Date.now());
  });
}
async function openLink() {
  link.port = await freePort();
  link.server = net.createServer((c) => {
    c.on("error", () => {});
    if (link.mode === "cut") { c.destroy(); return; }
    const pair = { c, u: null, muted: false };
    link.pairs.add(pair);
    c.on("close", () => { pair.u?.destroy(); link.pairs.delete(pair); });
    if (link.mode === "hold") return;
    const u = net.connect({ host: "127.0.0.1", port: link.target });
    pair.u = u;
    u.on("error", () => {});
    u.on("close", () => c.destroy());
    answersTo(pair);
    if (link.mode === "stall") { pair.stalled = true; pair.muted = true; c.pause(); u.pause(); return; }
    c.pipe(u);
    if (link.mode === "mute") { pair.muted = true; u.pause(); }
  });
  await new Promise((resolve, reject) => { link.server.once("error", reject); link.server.listen(link.port, "127.0.0.1", resolve); });
}
function setLink(mode) {
  link.mode = mode;
  for (const p of [...link.pairs]) {
    if (mode === "cut" || mode === "hold") { p.c.destroy(); p.u?.destroy(); link.pairs.delete(p); }
    else if (mode === "mute" && p.u && !p.muted) { p.u.pause(); p.muted = true; }
    else if (mode === "stall" && p.u && !p.stalled) { p.c.unpipe(p.u); p.c.pause(); p.u.pause(); p.stalled = p.muted = true; }
    else if (mode === "pass" && p.u && (p.muted || p.stalled)) {
      if (p.stalled) { p.stalled = false; p.c.pipe(p.u); p.c.resume(); }
      p.muted = false; p.u.resume();
    }
    else if (mode === "pass" && !p.u) { p.c.destroy(); link.pairs.delete(p); } // one that was held: A dials anew
  }
}

const envOf = (s) => ({
  ...process.env, AIWB_MCP_PORT: "0", AIWB_REMOTE_BIND: "127.0.0.1", CURSOR_CONFIG_DIR: s.cursorCfg,
  // A alone: the link, and short waits between its attempts to connect (the last step 3 s for 30 s, Stable with it).
  ...(s === A ? { AIWB_TEST_DIAL_VIA: `127.0.0.1:${link.port}`, AIWB_TEST_WAITS: "backoff=3s" } : {}),
});

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
  fs.writeFileSync(path.join(B.work, B_ONLY, "note.txt"), "a folder of B\n");
  // B's work folder is a git repository with one commit on main: the run delivers its result there.
  git(B.work, "init", "-q", "-b", "main");
  for (const [k, v] of [["user.name", "Run Tester"], ["user.email", "run-tester@localhost"], ["commit.gpgsign", "false"]]) git(B.work, "config", k, v);
  git(B.work, "add", "-A");
  git(B.work, "commit", "-q", "-m", "start");
  // B's remote listener: the certificate, secret and port are made before its start. The command
  // names the data folder and both ports, so it cannot reach the installed app. It prints the
  // fingerprint; the secret it writes to a file of the data folder and does not print.
  B.remotePort = await freePort();
  const out = execFileSync(BIN, ["remote", "setup", "-home", B.home, "-server-port", String(B.port), "-port", String(B.remotePort), "-name", "127.0.0.1"],
    { env: envOf(B), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  B.fingerprint = /^Fingerprint:\s*(\S+)/m.exec(out)?.[1] ?? "";
  B.secret = fs.readFileSync(path.join(B.home, "remote-secret"), "utf8").trim();
  if (!B.fingerprint || !B.secret) throw new Error(`remote setup gave no fingerprint or no secret: ${out}`);
  link.target = B.remotePort;
  await openLink();
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
  }, { timeout: 30000 });
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

const get = async (s, p) => { const r = await fetch(s.base + p, { signal: AbortSignal.timeout(8000) }); return { status: r.status, json: await r.json().catch(() => null) }; };
const stateOf = async (s) => (await get(s, "/api/state")).json;
const chatOn = async (s, id) => (await stateOf(s))?.chats?.find((c) => c.id === id) ?? null;
const groupOn = async (s, name) => (await stateOf(s))?.groups?.find((g) => g.name === name) ?? null;
/** The user messages of a chat, as a server's own loopback API gives them. */
const userTexts = async (s, id) => ((await get(s, `/api/chats/${id}/items`)).json?.items ?? []).filter((it) => it.kind === "user").map((it) => String(it.text ?? ""));
/** The draft B has of a chat's main branch, and its counter. */
const draftOn = async (id) => { const st = (await get(B, `/api/chats/${id}/items`)).json?.state; return { text: st?.draft?.text ?? "", rev: st?.draftRev ?? 0 }; };
/** B's entry in A's server list. */
const entry = async () => ((await get(A, "/api/servers")).json?.servers ?? []).find((v) => v.name === B.name) ?? null;
const connected = (timeout = 60000) => holds("A is connected to B", async () => (await entry())?.state === "connected" && !!(await stateOf(A))?.sections?.[ENTRY], { timeout, every: 200 });
/** How many things B has: nothing of it may go by what a client's page does to its own list. */
const census = async () => { const s = await stateOf(B); return { groups: s.groups.length, boards: s.boards.length, chats: s.chats.length, runs: (s.runs ?? []).length }; };

let ENTRY = ""; // the id of B's entry in A's list, once it is added
/** A thing's id on B, of the page's key of it ("<entry id>~<id>"). */
const own = (key) => String(key ?? "").split("~").pop();
const inB = (key) => String(key ?? "").startsWith(`${ENTRY}~`);

// ---- the pages

let browser = null;
// openPage opens a server's app in a context of its own and keeps what it does. errors: console
// errors and uncaught exceptions; failedRequests: requests that failed or were answered with 400 or
// more; calls: every request to /api that is no read of the stream, with its body and, once it
// is answered, its status.
async function openPage(s = A) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const p = await ctx.newPage();
  p.setDefaultTimeout(10000);
  p.errors = [];
  p.failedRequests = [];
  p.calls = [];
  p.on("console", (m) => { if (m.type() === "error") p.errors.push(m.text()); });
  p.on("pageerror", (e) => p.errors.push(`uncaught: ${e.message}`));
  p.on("requestfailed", (r) => p.failedRequests.push(`${r.method()} ${new URL(r.url()).pathname} ${r.failure()?.errorText}`));
  p.on("request", (r) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith("/api/") || u.pathname === "/api/events") return;
    const call = { method: r.method(), path: u.pathname + u.search, body: r.postData() ?? "", status: 0, code: "" };
    r.call = call;
    p.calls.push(call);
  });
  p.on("response", (r) => {
    if (r.status() >= 400) p.failedRequests.push(`${r.request().method()} ${new URL(r.url()).pathname} -> ${r.status()}`);
    const call = r.request().call;
    if (!call) return;
    call.status = r.status();
    if (r.status() >= 400) r.json().then((j) => { call.code = j?.code ?? j?.error ?? ""; }, () => {});
  });
  await p.goto(s.base);
  await p.waitForSelector("#root .side-tree", { timeout: 20000 });
  return p;
}
/** The calls a page made from now on that change something (no GET), as "METHOD path". */
const writesFrom = (p) => { const at = p.calls.length; return () => p.calls.slice(at).filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`); };
const callsFrom = (p) => { const at = p.calls.length; return () => p.calls.slice(at); };
const sel = (p) => p.evaluate(() => JSON.parse(localStorage.getItem("aiwb.sel") ?? "{}"));
const stored = (p, key) => p.evaluate((k) => localStorage.getItem(k), key);
const one = (o) => JSON.stringify(o);
const exact = (s) => new RegExp(`^\\s*${String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
const menuItem = (p, text) => p.locator(".menu .menu-item", { hasText: exact(text) });
const box = (p) => p.locator(".composer .composer-input");
const boxText = (p) => box(p).evaluate((el) => el.innerText);
const msgs = async (p) => ({ user: await p.locator(".thread .msg.user").allInnerTexts(), assistant: await p.locator(".thread .msg.assistant").allInnerTexts() });
const counts = (m) => `${m.user.length} user, ${m.assistant.length} assistant`;
const noneTwice = (m) => new Set(m.user).size === m.user.length && new Set(m.assistant).size === m.assistant.length;
const replied = (p, text, timeout = 40000) => holds(`the reply to "${text}"`, async () => (await msgs(p)).assistant.some((t) => t.includes(text)), { timeout });
/** The question about where a new chat or a new board should live: it is gone, and must never show. */
const asksWhere = (p) => p.locator("main.board-choice, .board-choice").count();

/** B's section on A's page. */
const section = (p = page) => p.locator(`.side-section[aria-label="${B.name}"]`);
const sectionLook = (p = page) => p.evaluate((name) => {
  const s = document.querySelector(`.side-section[aria-label="${name}"]`);
  if (!s) return null;
  return {
    name: s.querySelector(".side-section-name")?.textContent ?? "", state: s.querySelector(".side-section-state")?.textContent ?? "",
    tone: ["ok", "wait", "bad"].find((t) => s.classList.contains(t)) ?? "", collapsed: s.classList.contains("collapsed"),
    lines: [...s.querySelectorAll(".side-section-line")].map((e) => e.textContent ?? ""), rows: s.querySelectorAll(".side-row, .side-group-head").length,
    add: !!s.querySelector(".side-section-head button[title^='New on']"),
  };
}, B.name);

/** The tree a page shows, as lines: of B's section (of: B.name), or of the page's local part (of: ""). A group, a
 *  board and a run are followed by what is in them, two spaces further in. The same code reads A's section and the
 *  owner's own sidebar, so "the same tree" is the same lines. */
const outline = (p, of = "") => p.evaluate((of) => {
  const tops = of
    ? [...(document.querySelector(`.side-section[aria-label="${of}"] .side-section-body`)?.children ?? [])]
    : [...(document.querySelector(".side-tree")?.children ?? [])].filter((e) => !e.matches(".side-section, .side-addgroup"));
  const out = [];
  const named = (row) => (row.querySelector(".side-name, .side-group-name")?.textContent ?? row.querySelector(".name-input")?.value ?? "?").trim();
  const tags = (row) => (row.querySelector(".archived-tag") ? " [archived]" : "") + (row.querySelector(".draft-tag") ? " [draft]" : "");
  const walk = (el, depth) => {
    const pad = "  ".repeat(depth);
    if (el.matches(".side-loose, .side-group-body, .side-board-chats")) { for (const c of el.children) walk(c, depth); return; }
    if (el.matches(".side-group")) {
      const head = el.querySelector(":scope > .side-group-head");
      out.push(`${pad}group ${named(head)}${tags(head)}`);
      const body = el.querySelector(":scope > .side-group-body");
      if (body) walk(body, depth + 1);
      return;
    }
    if (el.matches(".side-board, .side-run")) {
      const row = el.querySelector(":scope > .side-row");
      out.push(`${pad}${el.matches(".side-board") ? "board" : "run"} ${named(row)}${tags(row)}`);
      const chats = el.querySelector(":scope > .side-board-chats");
      if (chats) walk(chats, depth + 1);
      return;
    }
    if (el.matches(".side-row.is-chat")) out.push(`${pad}chat ${named(el)}${tags(el)}`);
  };
  for (const t of tops) walk(t, 0);
  return out;
}, of);
const lines = (o) => (o ?? ["(none)"]).map((l) => l.trim()).join(" / ");
/** Whether A's section of B and the owner's own sidebar show the same tree, each without a reload. A draft mark is
 *  each page's own word about the chat it has open, so it is left out. */
const plain = (o) => (o ?? []).map((l) => l.replace(" [draft]", ""));
const sameTree = (timeout = 20000) => holds("A's section shows the tree of the owner's page", async () => {
  const a = plain(await outline(page, B.name)), b = plain(await outline(owner));
  return a.length > 0 && one(a) === one(b);
}, { timeout });
const bothTrees = async () => `A's section: ${lines(await outline(page, B.name))} || the owner's page: ${lines(await outline(owner))}`;

/** A row by its name, within a scope (a page's sidebar, or B's section). */
const rowOf = (scope, kind, name) => scope.locator(`.side-row.is-${kind}`).filter({ has: scope.page().locator(".side-name", { hasText: exact(name) }) });
const groupHead = (scope, name) => scope.locator(".side-group-head").filter({ has: scope.page().locator(".side-group-name", { hasText: exact(name) }) });
const side = (p) => p.locator(".side-tree");

/** Opens the "+" of a head (the sidebar's, a section's, a group's) and picks an item of its menu. */
async function plus(p, head, item) {
  await head.hover();
  await head.locator("button[title^='New']").first().click();
  await menuItem(p, item).click();
}
/** Opens a row's or a group head's "More" menu and picks an item; with `then`, an item of the list that item opens. */
async function more(p, row, item, then) {
  await row.hover();
  await row.locator("button[title='More']").first().click();
  await menuItem(p, item).click();
  if (then) await menuItem(p, then).click();
}
/** Types a name into the rename box that is open in a scope (a new board, run or group opens with one). */
async function nameIt(scope, name) {
  const input = scope.locator(".name-input").first();
  await input.waitFor();
  await input.fill(name);
  await input.press("Enter");
  await input.waitFor({ state: "detached" });
}
/** Names the chat on screen through its header, so that its row can be found by name. */
async function renameChat(p, name) {
  await p.locator("button.chat-head-name").click();
  const input = p.locator(".chat-head .name-input");
  await input.fill(name);
  await input.press("Enter");
  await rowOf(side(p), "chat", name).first().waitFor({ timeout: 15000 });
}
/** The key of the thing a page selects after `act`, which it did not select before. */
async function selected(p, kind, act) {
  const before = (await sel(p))[kind] ?? null;
  await act();
  return waitFor(`the page selects its new ${kind}`, async () => { const k = (await sel(p))[kind]; return k && k !== before ? k : null; }, { timeout: 45000 });
}
async function send(p, text) {
  await box(p).click();
  await box(p).fill(text);
  await box(p).press("Enter");
}
async function showArchived(p, on) {
  const sw = p.locator(".side-archived input");
  if ((await sw.isChecked()) !== on) await sw.click();
}
const dialogDo = async (p, label) => { await p.locator(".dialog button", { hasText: exact(label) }).click(); };

// ---- the run: its goal for the stand-in agent, and what B says about it

const RUN_FILE = "result.txt", RUN_TEXT = "written by the run";
const TASK_SLEEP = 14; // seconds the task's agent waits before it writes: the link is pulled in that time
const FIRST_LINE = "Write the result file.";
/** The goal: turn 1 sets the notes and adds one writing task; the turn that starts when nothing
 *  is left running finishes the run as achieved. As apiGoal of cmd/ai-whiteboard/apiruns_test.go. */
function goal() {
  const brief = `Write ${RUN_FILE}, and change nothing else. <<if You have one task.>> <<sleep ${TASK_SLEEP}>> <<write ${RUN_FILE} ${RUN_TEXT}>> <<cost 0.01>> <<block completed>>`;
  const task = JSON.stringify({ brief, kind: "implement", tier: "standard", tier_reason: "A later task checks it.", title: "Write the file", writes: true });
  if (task.includes("]]")) throw new Error("the task's arguments would end the directive early");
  return `${FIRST_LINE} [[if This is turn 1.]] [[mcp set_notes {"notes":"Done means: the file is written. T01 writes it."}]] [[mcp add_task ${task}]] ` +
    `[[if Nothing is running and nothing can start]] [[mcp finish_run {"outcome":"achieved","summary":"Everything the goal asked for is there."}]] [[if]]`;
}
const runOn = async (s, id) => (await stateOf(s))?.runs?.find((r) => r.id === id) ?? null;
const detailOn = async (s, id) => (await get(s, `/api/runs/${id}/detail`)).json;
const runBox = (p) => p.locator(".composer.run-composer .composer-input");
const short = (s, n = 300) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const barChat = (p) => p.locator(".run-bar button.run-bar-chat"); // the run bar's "+ Chat on this run"
const runBar = (p) => p.locator(".remote-bar.run-remote-bar");

// ---- a board: its drawing on B, and a rectangle drawn on a page

const LIVE = ".excalidraw:not(.excalidraw--view-mode) canvas.interactive";
/** The shapes B has stored for a board (not deleted), by id. */
const shapesOn = async (id) => (((await get(B, `/api/boards/${id}/scene`)).json?.elements) ?? []).filter((e) => !e.isDeleted).map((e) => e.id);
const drawn = new Map(); // by page: how many rectangles the script drew on it
/** Draws one more rectangle on the canvas of a page, by the tool's key and a drag. off: where on the canvas the page's own grid starts. */
async function draw(p, off = 0) {
  const b = await p.locator(LIVE).boundingBox(), k = drawn.get(p) ?? 0;
  drawn.set(p, k + 1);
  const x = b.x + 260 + (k % 4) * 110, y = b.y + 200 + off + Math.floor(k / 4) * 90;
  await p.mouse.click(b.x + 160, b.y + b.height - 120); // (an empty place of the canvas, which takes the keys)
  await p.keyboard.press("r");
  await p.mouse.move(x, y); await p.mouse.down(); await p.mouse.move(x + 40, y + 30, { steps: 4 }); await p.mouse.move(x + 80, y + 60, { steps: 4 }); await p.mouse.up();
}

// ---- the steps

const GROUP = "Jobs", RUN_NAME = "Remote result", RUN_TWO = "Not started", BOARD = "sketch"; // one word: a board's name is also its folder's
const AWAY = `${B.name} is not connected`;
const ONE_LINE = "Its chats show when the server is back.";
let run = "", run2 = "", runChat = "", board = "";

/** The section while B is not connected: the state's words, the one line, no row and no "+". */
const awayLook = () => holds("the section says that B is not connected and the one line, with no row", async () => {
  const l = await sectionLook();
  return !!l && l.state === "Unreachable" && l.tone === "bad" && l.rows === 0 && !l.add && one(l.lines) === one([ONE_LINE]);
}, { timeout: 30000 });
const backLook = (has) => holds("the section shows B's tree again", async () => (await sectionLook())?.state === "Connected" && (!has || (await outline(page, B.name)).some((l) => l.includes(has))), { timeout: 60000 });

async function step1() {
  await page.locator("button.servers-btn").click();
  const dlg = page.locator(".servers-dialog");
  await dlg.waitFor();
  await dlg.locator("button", { hasText: /^Add server$/ }).click();
  const form = dlg.locator(".servers-form");
  const fields = form.locator(".servers-field input");
  await fields.nth(0).fill(B.name);
  await fields.nth(1).fill(`https://127.0.0.1:${B.remotePort}`);
  await fields.nth(2).fill(B.secret);
  await form.locator(".servers-check input").check();
  await form.locator("button", { hasText: /^Test connection$/ }).click();
  const accept = form.locator("button", { hasText: /^Accept fingerprint$/ });
  await accept.waitFor({ timeout: 30000 });
  await accept.click();
  const save = form.locator("button.primary", { hasText: /^Save$/ });
  await waitFor("Save is enabled after the accepted test", async () => !(await save.isDisabled()));
  await save.click();
  const row = dlg.locator(".servers-row").filter({ has: page.locator(".servers-name", { hasText: exact(B.name) }) });
  const ok = await holds("the row reads Connected", async () => (await row.locator(".servers-state").innerText()) === "Connected", { timeout: 60000 });
  await dlg.locator("button", { hasText: /^Close$/ }).click();
  await dlg.waitFor({ state: "detached" });
  ENTRY = (await entry())?.id ?? "";
  owner = await openPage(B);
  await owner.locator("button.side-addgroup").click();
  await nameIt(side(owner), GROUP);
  const seen = await holds("the section has the owner's group", async () => (await outline(page, B.name)).includes(`group ${GROUP}`));
  await check("1 B is added in the Servers dialog, and its section shows the group the owner made on B's own page", all(ok, seen), `${one(await sectionLook())}; ${lines(await outline(page, B.name))}`);
}

async function step2() {
  const made = callsFrom(page);
  run = await selected(page, "run", () => plus(page, groupHead(section(), GROUP), "Run"));
  await nameIt(section(), RUN_NAME);
  await runBox(page).waitFor();
  const gid = (await groupOn(B, GROUP))?.id;
  const onB = await holds("B has the run in the group, not started", async () => { const r = await runOn(B, own(run)); return !!r && r.name === RUN_NAME && r.group === gid && r.status === "draft" && !r.started; });
  const posts = made().filter((c) => c.method === "POST" && /\/runs$/.test(c.path));
  const choice = await page.locator('.run-composer .server-pick, .run-composer button.tchip[title^="Server"]').count();
  await check('2 "Run" from a group\'s "+" in the section: the run is on B at once, in that group, before it starts; A has none, and nothing offers a choice of a server',
    inB(run) && onB === true && ((await stateOf(A)).runs ?? []).length === 0 && choice === 0 && (await asksWhere(page)) === 0 && posts.length === 1 && posts[0].path === `/api/on/${ENTRY}/runs`,
    `key ${run}; on B: ${onB}; runs of A ${((await stateOf(A)).runs ?? []).length}; server choices ${choice}; makes ${one(posts.map((c) => `${c.path} ${c.body}`))}`);

  // The agents, the models and the folders are B's.
  await page.locator('.composer button.tchip[title^="Agent"]').click();
  const options = page.locator('.composer .menu [role="option"]');
  await options.first().waitFor();
  const listed = (await options.allInnerTexts()).map((t) => short(t));
  const offered = (await entry())?.agents ?? [];
  await options.first().click();
  const folder = page.locator('.composer button.tchip[title^="Folder on"]');
  await folder.click();
  const dirs = page.locator(".composer .menu.dirs");
  const head = (await dirs.locator(".menu-head").textContent()) ?? ""; // not innerText: the head is drawn in capitals
  await dirs.locator(".dir-input").fill(B.work);
  await dirs.locator(".dir-input").press("Enter");
  const there = await holds("the picker lists the folder made in B's repository", async () => (await dirs.locator(".dir-list .menu-item.dir").allInnerTexts()).some((t) => t.includes(B_ONLY)));
  await dirs.locator(".dir-foot button").click();
  const picked = await holds("B's run has the repository as its folder, as a git folder", async () => { const r = await runOn(B, own(run)); return r?.cwd === B.work; });
  const chip = page.locator(".composer.run-composer .context-row .ctx-chip");
  const git1 = await holds('the chip above the box says "git"', async () => short(await chip.locator(".git").innerText().catch(() => "")) === "git");
  await check(`2 the agent choice lists B's agents, the folder picker is titled "Folder on ${B.name}" and lists B's folders, and B's repository is picked for the run on B`,
    listed.length === offered.length && listed.length > 0 && listed.every((t) => /Claude/.test(t)) && head.trim() === `Folder on ${B.name}` && all(there, picked, git1) === true,
    `agents ${listed.join(", ")} (B's entry: ${offered.join(", ")}); head "${head.trim()}"; listed ${there}; picked ${picked}; chip "${short(await chip.innerText().catch(() => "no chip"))}"`);

  // The goal being typed is the run's on B, and the owner's page shows the run with it.
  await runBox(page).click();
  await runBox(page).fill("a goal that is still being typed");
  const drafted = await holds("B has the typed goal as the run's draft", async () => (await runOn(B, own(run)))?.draft?.text === "a goal that is still being typed");
  const row = rowOf(side(owner), "run", RUN_NAME);
  const listedThere = await holds("the owner's page lists the run in the group", async () => (await outline(owner)).some((l) => l.startsWith(`  run ${RUN_NAME}`)));
  await row.click();
  const shown = await holds("the owner's page shows the goal in the run's box", async () => (await runBox(owner).innerText().catch(() => "")).trim() === "a goal that is still being typed", { timeout: 15000 });
  await check("2 the goal that is typed is the run's draft on B, and the owner's page shows the run that has not started, with its goal", all(drafted, listedThere, shown), `B's draft ${one((await runOn(B, own(run)))?.draft ?? null)}; the owner's tree: ${lines(await outline(owner))}`);
  await owner.locator("button.icon-btn.new").click();
  await menuItem(owner, "New chat").click(); // the owner goes elsewhere: its goal box saves nothing over the page's
  await box(owner).waitFor();
  await renameChat(owner, "Owner elsewhere");
}

async function step3() {
  await runBox(page).click();
  await runBox(page).fill(goal());
  const send = page.locator(".composer.run-composer button.send");
  const can = await holds("Start is enabled", async () => !(await send.isDisabled()), { timeout: 15000 });
  if (can !== true) await check("3 Start is enabled with the goal typed", false, `title "${await send.getAttribute("title")}"; line "${short(await page.locator(".composer-err, .run-note").allInnerTexts())}"`);
  const starts = callsFrom(page);
  await runBox(page).press("Enter");
  const started = await holds("the run is started on B", async () => { const r = await runOn(B, own(run)); return !!r && r.status !== "draft" && !!r.started; }, { timeout: 60000 });
  const call = starts().find((c) => c.method === "POST" && /\/start$/.test(c.path));
  const turn = await page.locator('.run-follow .tl-lane .tl-turn[data-turn="1"]').waitFor({ timeout: 40000 }).then(() => true, (e) => e.message.split("\n")[0]);
  const row = rowOf(section(), "run", RUN_NAME);
  const look = { cls: (await row.getAttribute("class").catch(() => "")) ?? "", text: short(await row.innerText().catch(() => "no row")) };
  await check("3 the goal, Enter: the run starts on B by the start call of the section, its row is in the section with no server's name, and turn 1 shows in the timeline",
    all(started, turn) === true && call?.path === `/api/on/${ENTRY}/runs/${own(run)}/start` && call.status === 200 && !look.text.includes(B.name), `start ${one(call && { path: call.path, status: call.status })}; row ${one(look)}; turn 1: ${turn}`);
  const there = await runOn(B, own(run));
  const mine = await stateOf(A);
  await check("3 B has the run in the picked folder; A lists no run, and its data folder has no folder for it", there?.cwd === B.work && (mine.runs ?? []).length === 0 && !fs.existsSync(path.join(A.home, "runs", own(run))),
    `B's run ${one(there && { status: there.status, cwd: there.cwd })}; runs of A ${(mine.runs ?? []).length}; ${path.join(A.home, "runs", own(run))} exists: ${fs.existsSync(path.join(A.home, "runs", own(run)))}`);
  const chatBtn = await holds('the bar offers "+ Chat on this run"', async () => (await barChat(page).count()) === 1, { timeout: 15000 });
  const follows = await holds("the owner's page shows the run as started", async () => (await outline(owner)).some((l) => l === `  run ${RUN_NAME}`) && /\bst-/.test((await rowOf(side(owner), "run", RUN_NAME).getAttribute("class")) ?? ""), { timeout: 15000 });
  await check('3 the started run\'s bar offers "+ Chat on this run", and the owner\'s page shows the run at work with no reload', all(chatBtn, follows), `the owner's row "${await rowOf(side(owner), "run", RUN_NAME).getAttribute("class").catch(() => "none")}"`);
}

async function step4() {
  await page.locator('.run-follow .tl-lane .tl-turn[data-turn="1"]').click();
  const pane = page.locator('.run-follow .run-turn[data-turn="1"]');
  await pane.waitFor();
  const link = pane.locator("button.link", { hasText: "Transcript ›" });
  // (the run's detail names a turn's agent a moment before that agent's chat is there: the click waits for the chat)
  const agent = await link.getAttribute("data-agent");
  await waitFor("B has the orchestrator's chat", async () => (await get(B, `/api/chats/${own(agent)}`)).status === 200, { timeout: 30000 });
  await link.click();
  const foot = page.locator(".agent-foot");
  await foot.waitFor();
  const has = await holds("the transcript has text", async () => { const m = await msgs(page); return m.user.length > 0 && m.assistant.length > 0; }, { timeout: 30000 });
  const m = await msgs(page);
  await check('4 "Transcript ›" of turn 1 opens the orchestrator\'s transcript, which has text and is read-only', has === true && m.user.some((t) => t.includes("turn 1")) && (await foot.innerText()).includes("Read-only") && (await page.locator(".agent-foot ~ .composer").count()) === 0,
    `${counts(m)}; user "${short(m.user[0], 100)}"; foot "${short(await foot.innerText())}"`);
  await page.keyboard.press("Escape");
  await foot.waitFor({ state: "detached" }).catch(() => {});
}

async function step5() {
  // The task works: its agent has been launched and waits TASK_SLEEP seconds before it writes.
  const working = await holds("T01 is running on B", async () => Object.values((await detailOn(B, own(run)))?.agents ?? {}).some((a) => a.task === "T01" && a.status === "running"), { timeout: 60000, every: 100 });
  const taskRow = page.locator(".run-follow .tl-rows .tl-id", { hasText: /^T01$/ });
  const rowThere = await taskRow.first().waitFor({ timeout: 20000 }).then(() => true, () => false);
  if (working !== true || !rowThere) await check("5 the task T01 works on B and has its row in the timeline", all(working, rowThere || "no row of T01"));
  page.reloads = 0;
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) page.reloads++; });

  setLink("cut");
  const bar = runBar(page);
  const warned = await holds("the run view's warning names B", async () => (await bar.locator(".remote-bar-text").innerText().catch(() => "")) === `${AWAY}. This run is shown as it was when the connection ended.` && /\boff\b/.test((await bar.getAttribute("class")) ?? ""), { timeout: 30000 });
  const kept = (await page.locator('.run-follow .tl-lane .tl-turn[data-turn="1"]').count()) === 1 && (await taskRow.count()) > 0;
  await check("5 the link is pulled while the task works: the run view stays on screen as it was, under the warning that names the server", warned === true && kept, `bar "${short(await bar.innerText().catch(() => "none"))}"; turn 1 and T01 on screen: ${kept}`);
  await check("5 the section has no row, the open run's neither", await awayLook(), one(await sectionLook()));
  const stopBtn = page.locator(".run-bar button.run-stop");
  const ro = { chat: await page.locator(".run-bar button.run-bar-chat:not([disabled])").count(), stop: (await stopBtn.count()) ? await stopBtn.isDisabled() : "none" };
  const quiet = callsFrom(page);
  await sleep(1500);
  const wrote = quiet().filter((c) => c.method !== "GET" && !/\/unfollow$/.test(c.path));
  await check("5 the view is read-only: nothing offers a chat on the run, Stop is off, and no call is made for it", ro.chat === 0 && ro.stop !== false && wrote.length === 0, `${one(ro)}; calls ${one(wrote.map((c) => `${c.method} ${c.path}`))}`);

  setLink("pass");
  const back = await backLook(`run ${RUN_NAME}`);
  const level = await holds("the warning is gone", async () => (await runBar(page).count()) === 0, { timeout: 30000 });
  await check("5 B is back: the section shows its tree again with the run, and the run view's warning goes", all(back, level), `${one(await sectionLook())}; bars ${await runBar(page).count()}`);
  const ended = await holds("the run's status on the page is completed", async () => (await page.locator(".run-bar .run-status.st-completed").count()) === 1, { timeout: 120000, every: 250 });
  const fin = await holds("the timeline shows the end", async () => (await page.locator(".run-follow .tl-lane .tl-turn").count()) >= 2 && (await page.locator(".run-follow .tl-opsum .fin").count()) === 1, { timeout: 30000 });
  await check("5 the run view is level with B again: the run ends on the page, with the finishing turn in the timeline, with no reload and no click", all(ended, fin) === true && page.reloads === 0,
    `status "${short(await page.locator(".run-bar .run-status").innerText().catch(() => "none"))}"; navigations ${page.reloads}`);
  const there = await runOn(B, own(run)), d = await detailOn(B, own(run));
  let onMain = "";
  try { onMain = git(B.work, "show", `main:${RUN_FILE}`); } catch (e) { onMain = "threw: " + short(e.message, 160); }
  await check(`5 B's own API: the run is completed as achieved and its result applied; B's repository has ${RUN_FILE} on main`, there?.status === "completed" && there?.outcome === "achieved" && d?.delivery?.state === "applied" && onMain === RUN_TEXT,
    `B: ${one({ status: there?.status, outcome: there?.outcome, delivery: d?.delivery?.state })}; main:${RUN_FILE} = ${one(onMain)}`);
}

async function step6() {
  const row = rowOf(section(), "run", RUN_NAME);
  const made = callsFrom(page);
  runChat = await selected(page, "chat", async () => { await row.hover(); await row.locator('[title="New chat on this run"]').click(); });
  await box(page).first().waitFor();
  const c = await chatOn(B, own(runChat));
  const post = made().find((x) => x.method === "POST" && /\/chats$/.test(x.path));
  await check('6 "+" on the run\'s row asks nothing and makes a chat of the run on B at once, unstarted', inB(runChat) && c?.run === own(run) && c?.locked === false && (await asksWhere(page)) === 0 && post?.path === `/api/on/${ENTRY}/chats` && post.body === one({ run: own(run) }),
    `key ${runChat}; B's chat ${one(c && { run: c.run, locked: c.locked })}; the make ${one(post && { path: post.path, body: post.body })}`);
  const text = "hello from the run's chat";
  await send(page, text);
  const reply = await replied(page, text);
  const cwd = (await chatOn(B, own(runChat)))?.cwd ?? "";
  await check("6 a first message in that chat is answered, and B has it once, in a folder of the run", reply === true && (await userTexts(B, own(runChat))).length === 1 && cwd !== "" && !cwd.startsWith(A.home),
    `${reply === true ? "" : reply + " "}${counts(await msgs(page))}; folder ${cwd}`);
  await waitFor("its turn ends", async () => (await chatOn(B, own(runChat)))?.status === "ready", { timeout: 30000 }).catch(() => {});
}

async function step7() {
  // A second run, made from the section's "+" and left unstarted; its goal is typed while nothing passes the link.
  run2 = await selected(page, "run", () => plus(page, section().locator(".side-section-head"), "Run"));
  await nameIt(section(), RUN_TWO);
  await runBox(page).waitFor();
  await waitFor("B has the second run", async () => (await runOn(B, own(run2)))?.name === RUN_TWO);
  const typed = "a goal typed just before the drop";
  const saves = callsFrom(page);
  setLink("stall");
  await runBox(page).click();
  await runBox(page).fill(typed);
  await waitFor("the save of the goal is on its way", async () => saves().some((c) => c.method === "PUT" && /\/runs\/[^/]+\/draft$/.test(c.path)), { timeout: 10000 });
  setLink("cut");
  await awayLook();
  const send = page.locator(".composer.run-composer button.send");
  const off = await holds("Start is off and says why", async () => (await send.isDisabled()) && ((await send.getAttribute("title")) ?? "").includes(AWAY), { timeout: 15000 });
  await runBox(page).click({ force: true }).catch(() => {});
  await page.keyboard.press("End");
  await page.keyboard.type(" and more");
  await page.keyboard.press("Enter");
  await sleep(800);
  const kept = (await runBox(page).innerText()).trim(), ro = await runBox(page).getAttribute("aria-readonly");
  await check("7 a run that has not started is open when the link is pulled: Start is off with the reason, its goal box is read-only and keeps what was typed, and B has none of it yet",
    off === true && kept === typed && ro === "true" && !(await runOn(B, own(run2)))?.draft?.text, `Start "${await send.getAttribute("title")}"; box "${kept}"; aria-readonly ${ro}; B's draft ${one((await runOn(B, own(run2)))?.draft ?? null)}`);
  setLink("pass");
  await backLook(`run ${RUN_TWO}`);
  const saved = await holds("B has the goal that was typed", async () => (await runOn(B, own(run2)))?.draft?.text === typed, { timeout: 30000 });
  const open = await holds("the box takes text again", async () => (await runBox(page).getAttribute("aria-readonly")) !== "true");
  await check("7 B is back: the goal that was typed is saved on B, is still in the box, and the box takes text again", all(saved, open) === true && (await runBox(page).innerText()).trim() === typed, `B's draft ${one((await runOn(B, own(run2)))?.draft ?? null)}; box "${(await runBox(page).innerText()).trim()}"`);
}

async function step8() {
  // The run that ended is open; during an outage the owner deletes it on B's own page.
  await rowOf(section(), "run", RUN_NAME).first().click();
  await page.locator(".run-bar .run-status.st-completed").waitFor({ timeout: 30000 });
  await page.locator('.run-follow .tl-lane .tl-turn[data-turn="1"]').waitFor({ timeout: 30000 });
  setLink("cut");
  await runBar(page).waitFor({ timeout: 30000 });
  await more(owner, rowOf(side(owner), "run", RUN_NAME).first(), "Delete");
  await dialogDo(owner, "Delete");
  await waitFor("B no longer has the run", async () => !(await runOn(B, own(run))), { timeout: 60000 });
  setLink("pass");
  const says = await holds("the view says that the run is no longer on B", async () => (await page.locator(".remote-bar.run-remote-bar.gone .remote-bar-text, .remote-off.gone .remote-off-text").first().innerText().catch(() => "")) === `This run is no longer on ${B.name}.`, { timeout: 60000 });
  const rows = await rowOf(section(), "run", RUN_NAME).count();
  await check("8 the run is deleted on B's own page during an outage: back, its view says that it is no longer on that server, and the section has no row for it", says === true && rows === 0 && (await backLook(`run ${RUN_TWO}`)) === true,
    `"${short(await page.locator(".remote-bar, .remote-off").first().innerText().catch(() => "none"))}"; rows ${rows}; ${lines(await outline(page, B.name))}`);
}

async function step9() {
  const made = callsFrom(page);
  board = await selected(page, "board", () => plus(page, section().locator(".side-section-head"), "Whiteboard"));
  const asked = await asksWhere(page);
  await nameIt(section(), BOARD);
  const id = own(board);
  const onB = await holds("B has the board under its name", async () => (await stateOf(B)).boards.some((b) => b.id === id && b.name === BOARD));
  const post = made().find((c) => c.method === "POST" && /\/boards$/.test(c.path));
  await page.waitForSelector(LIVE, { timeout: 30000 });
  await check('9 "Whiteboard" from the section\'s "+": the board is on B at once, nothing asks where it should live, A has none, and its canvas can be drawn on',
    inB(board) && onB === true && asked === 0 && (await stateOf(A)).boards.length === 0 && post?.path === `/api/on/${ENTRY}/boards` && !fs.existsSync(path.join(A.home, "boards", BOARD)), `key ${board}; on B: ${onB}; asked ${asked}; the make ${one(post && { path: post.path, body: post.body, status: post.status })}`);
  await draw(page);
  const first = await holds("B has one shape", async () => (await shapesOn(id)).length === 1, { timeout: 30000 });
  await check("9 a rectangle drawn on the page is saved on B", first, `shapes on B: ${(await shapesOn(id)).length}`);
  const seen = await holds("the owner's page lists the board", async () => (await outline(owner)).includes(`board ${BOARD}`));
  if (seen !== true) await check("9 the owner's page lists the board", seen, lines(await outline(owner)));

  // A chat on the board, whose agent works on B and reads the board: the tool call reaches the page that holds the
  // board (an `rpc` event with the entry's id and B's own ids), and the page's answer goes back to the agent.
  const tools = callsFrom(page);
  const boardChat = await selected(page, "chat", () => page.locator(".board-bar button", { hasText: /^\+ Chat on this board$/ }).click());
  await box(page).waitFor();
  const bc = await chatOn(B, own(boardChat));
  await send(page, "[[mcp read_board {}]] what is on it");
  const read = await holds("the agent's reply has the board as the page drew it", async () => (await msgs(page)).assistant.some((t) => t.includes(`${BOARD} (${id})`) && /\b1 elements\b/.test(t)), { timeout: 60000 });
  const reply = tools().filter((c) => c.method === "POST" && c.path === "/api/rpc-reply");
  await check("9 a chat on the board is on B at once, and its agent's read_board is answered by the page that holds the board: the call comes as that server's, and the answer goes back",
    inB(boardChat) && bc?.board === id && read === true && reply.length === 1 && reply[0].status === 200 && /"id":"far_/.test(reply[0].body), `B's chat ${one(bc && { board: bc.board })}; reply "${short((await msgs(page)).assistant.at(-1), 160)}"; rpc replies ${one(reply.map((c) => `${c.status} ${c.body.slice(0, 40)}`))}`);
  await waitFor("its turn ends", async () => (await chatOn(B, own(boardChat)))?.status === "ready", { timeout: 30000 }).catch(() => {});

  // The board's chat works when the link is pulled: until then the canvas says that an agent works on the board.
  await send(page, "[[sleep 6]] busy for a moment");
  const pill = page.locator(".presence");
  const atWork = await pill.waitFor({ timeout: 20000 }).then(() => true, (e) => e.message.split("\n")[0]);

  // The link is pulled with the board open: it can still be drawn on, under the banner.
  const saves = callsFrom(page);
  setLink("cut");
  await awayLook();
  const quiet = await holds("the canvas no longer says that an agent works on the board", async () => (await pill.count()) === 0, { timeout: 10000 });
  await check("9 the board's chat works when the link is pulled: the canvas said that an agent works on the board, and does not go on saying it of a server that is not connected", all(atWork, quiet), `said while connected: ${atWork}; during the outage: ${await pill.count()} pill`);
  await draw(page);
  const banner = page.locator(".canvas .save-banner");
  const said = await holds("the banner says that the drawing is not saved", async () => (await banner.innerText().catch(() => "")) === `Not saved, ${B.name} unreachable`, { timeout: 30000 });
  await draw(page);
  await sleep(1500);
  const live = (await page.locator(LIVE).count()) === 1 && (await page.locator(".board-off, .takeover-panel").count()) === 0;
  const refused = saves().filter((c) => c.method === "PUT" && /\/scene\?/.test(c.path));
  await check("9 the link is pulled with the board open: it can still be drawn on, under the banner that the changes are not saved; B has none of them",
    said === true && live && (await shapesOn(id)).length === 1 && refused.length > 0 && refused.every((c) => c.status === 503 || c.status === 504 || c.status === 0), `banner "${await banner.innerText().catch(() => "none")}"; canvas live: ${live}; shapes on B ${(await shapesOn(id)).length}; saves ${one(refused.map((c) => `${c.status} ${c.code}`))}`);
  await check("9 the section has no row, the open board's neither, and the board stays on screen", (await awayLook()) === true && (await page.locator(LIVE).count()) === 1, one(await sectionLook()));

  // Back, and nobody changed the board there: the drawing is saved.
  setLink("pass");
  const saved = await holds("B has the three shapes", async () => (await shapesOn(id)).length === 3, { timeout: 90000 });
  const clean = await holds("the banner is gone", async () => (await banner.count()) === 0, { timeout: 30000 });
  await check("9 B is back and nobody changed the board there: the drawing made during the outage is saved on B, the banner goes, and nothing says that changes were dropped",
    all(saved, clean) === true && (await page.locator(".canvas .canvas-note").count()) === 0 && (await page.locator(LIVE).count()) === 1, `shapes on B ${(await shapesOn(id)).length}; banner ${await banner.count()}; notes ${await page.locator(".canvas .canvas-note").count()}; saves since ${one(saves().filter((c) => /\/scene\?/.test(c.path)).map((c) => `${c.status} ${c.code}`))}`);

  // B comes back on a slow line: this computer's server takes a moment to take the board there again, and a save made
  // in that moment is answered "not yet" (503 not_held_there). The drawing waits under the banner, which no longer
  // says that the server is unreachable, nothing is dropped, and the `held` that ends the re-take saves it.
  const had = (await shapesOn(id)).length;
  setLink("cut");
  await awayLook();
  await draw(page);
  await banner.waitFor({ timeout: 30000 });
  const again = callsFrom(page);
  link.delay = 2500;
  setLink("slow");
  await waitFor("the section is connected again", async () => (await sectionLook())?.state === "Connected" && (await sectionLook()).rows > 0, { timeout: 90000, every: 30 });
  await draw(page);
  let waited = "";
  await waitFor("the save of that drawing is answered", async () => {
    const t = await banner.innerText().catch(() => "");
    if (t.startsWith("Not saved yet")) waited = t;
    return again().some((c) => c.method === "PUT" && /\/scene\?/.test(c.path) && c.status !== 0 && c.status !== 503 && c.status !== 504) || (await shapesOn(id)).length === had + 2;
  }, { timeout: 90000, every: 30 }).catch(() => {});
  const both = await holds("B has both drawings", async () => (await shapesOn(id)).length === had + 2, { timeout: 90000 });
  setLink("pass");
  link.delay = 1500;
  const met = again().filter((c) => c.method === "PUT" && /\/scene\?/.test(c.path) && c.code === "not_held_there").length;
  const calm = await holds("the banner is gone", async () => (await banner.count()) === 0, { timeout: 30000 });
  await check("9 B is back on a slow line: a save made while the board is being taken again there is \"not yet\" (503 not_held_there): the drawing waits under the banner, which says so, nothing is dropped, and it is saved when the board is held again",
    all(both, calm) === true && (await page.locator(".canvas .canvas-note, .takeover-panel").count()) === 0 && (await page.locator(LIVE).count()) === 1 && (met === 0 || waited === `Not saved yet, waiting for ${B.name}`),
    `saves answered not_held_there: ${met}${met ? "" : " (the save came after the re-take this time: the page's part is shown by SEC.7 on the mock)"}; banner meanwhile "${waited}"; shapes on B ${(await shapesOn(id)).length} (were ${had}); saves ${one(again().filter((c) => /\/scene\?/.test(c.path)).map((c) => `${c.status} ${c.code}`))}`);
}

/** The local server restarts during an outage while the page holds a board with a drawing that is not saved (the
 *  contract's V1): the page keeps the board, the drawing and its revision in its own memory, the restarted server
 *  knows nothing of them, and when B is back the page asks for the board and the same revision rule saves the drawing. */
async function stepRestart() {
  const id = own(board);
  await backLook(`board ${BOARD}`);
  const had = (await shapesOn(id)).length, loads = page.reloads ?? 0;
  const banner = page.locator(".canvas .save-banner");
  setLink("cut");
  await awayLook();
  await draw(page);
  await banner.waitFor({ timeout: 30000 });
  await stop(A);
  const lost = await holds("the page says that it is reconnecting", async () => (await page.locator(".side-head .offline").count()) === 1, { timeout: 30000 });
  await start(A);
  const again = await holds("the page's stream is open again, on a server that knows nothing of B's tree", async () => (await page.locator(".side-head .offline").count()) === 0 && (await sectionLook())?.rows === 0 && !(await stateOf(A)).sections?.[ENTRY], { timeout: 90000 });
  await sleep(1000);
  // (the new stream holds no board, and none can be taken while B is away: the board is shown with its drawing, and is drawn on again once B is back)
  const kept = (await page.locator(".canvas .excalidraw canvas").count()) > 0 && (await banner.count()) === 1 && (await page.locator(".board-off, .takeover-panel, .canvas .canvas-note").count()) === 0;
  const drawable = (await page.locator(LIVE).count()) === 1;
  const files = fs.readdirSync(A.home, { recursive: true }).map(String).filter((f) => f.includes(id) || /^boards\/./.test(f));
  await check("V1 the local server restarts during the outage, with a drawing that is not saved: the page keeps the board on screen under the banner, with no reload, and the restarted server has no file and no tree of it",
    all(lost, again) === true && kept && (page.reloads ?? 0) === loads && files.length === 0 && (await shapesOn(id)).length === had, `reconnecting seen: ${lost}; open again: ${again}; the drawing on screen with the banner: ${kept}; it can be drawn on meanwhile: ${drawable}; navigations ${(page.reloads ?? 0) - loads}; files ${one(files)}`);
  setLink("pass");
  const saved = await holds("B has the drawing", async () => (await shapesOn(id)).length === had + 1, { timeout: 120000 });
  const calm = await holds("the banner is gone", async () => (await banner.count()) === 0, { timeout: 30000 });
  await check("V1 B is back: the page asks for the board again, the drawing made before the restart is saved on B at the revision it was made on, nothing is dropped, and the board is drawn on again",
    all(saved, calm) === true && (await page.locator(".canvas .canvas-note, .takeover-panel").count()) === 0 && (await page.locator(LIVE).count()) === 1, `shapes on B ${(await shapesOn(id)).length} (were ${had}); banner ${await banner.count()}`);
}

async function step10() {
  const id = own(board);
  await backLook(`board ${BOARD}`);
  const banner = page.locator(".canvas .save-banner"), note = page.locator(".canvas .canvas-note");
  const DROPPED = `This board was changed while ${B.name} was unreachable. Your unsaved changes were dropped.`;
  const noteSays = () => holds("the page says that the unsaved changes were dropped", async () => ((await note.innerText().catch(() => "")).replace(/\s+/g, " ")).includes(DROPPED), { timeout: 90000 });

  // (a) Changed on B meanwhile, and free there when A is back: the owner draws on it and closes its page.
  let before = await shapesOn(id);
  setLink("cut");
  await awayLook();
  await draw(page);
  await banner.waitFor({ timeout: 30000 });
  await rowOf(side(owner), "board", BOARD).click(); // (free on B: A's hold there ended with the connection)
  await owner.waitForSelector(LIVE, { timeout: 30000 });
  await draw(owner, 260);
  const theirs = await holds("B has the owner's shape", async () => (await shapesOn(id)).length === before.length + 1, { timeout: 30000 });
  let mine = (await shapesOn(id)).filter((x) => !before.includes(x));
  await owner.context().close(); // the owner's page goes: the board is held by nobody on B
  owner = null;
  await sleep(1000);
  setLink("pass");
  const dropped = await noteSays();
  const gone = await holds("the banner is gone", async () => (await banner.count()) === 0, { timeout: 30000 });
  await sleep(1500);
  let after = await shapesOn(id);
  await check("10 the board was changed on B's own page during the outage: back, the drawing made here is dropped with the notice, and B's drawing stands with the owner's change",
    all(theirs, dropped, gone) === true && after.length === before.length + 1 && mine.every((x) => after.includes(x)) && (await page.locator(LIVE).count()) === 1,
    `note "${short(await note.innerText().catch(() => "none"))}"; shapes on B before ${before.length}, with the owner's ${before.length + 1}, now ${after.length}; the owner's still there: ${mine.every((x) => after.includes(x))}`);
  await note.locator("button").click().catch(() => {});
  await draw(page);
  const again = await holds("B has one more shape", async () => (await shapesOn(id)).length === before.length + 2, { timeout: 30000 });
  await check("10 the board can be drawn on again, and the next drawing is saved on B", again, `shapes on B ${(await shapesOn(id)).length}`);

  // (b) Changed on B meanwhile, and still open on the owner's page when A is back: the page gets the take-over panel
  // and keeps its drawing until "Use here", which then finds another revision and drops it with the notice.
  owner = await openPage(B);
  before = await shapesOn(id);
  setLink("cut");
  await awayLook();
  await draw(page);
  await banner.waitFor({ timeout: 30000 });
  await rowOf(side(owner), "board", BOARD).click();
  await owner.waitForSelector(LIVE, { timeout: 30000 });
  await draw(owner, 350);
  await waitFor("B has the owner's second shape", async () => (await shapesOn(id)).length === before.length + 1, { timeout: 30000 });
  mine = (await shapesOn(id)).filter((x) => !before.includes(x));
  setLink("pass");
  const panel = page.locator(".takeover-panel");
  const taken = await holds("the page shows the take-over panel", async () => (await panel.count()) === 1 && (await page.locator(LIVE).count()) === 0, { timeout: 90000 });
  await sleep(1000);
  const quiet = (await note.count()) === 0 && one(await shapesOn(id)) === one([...before, ...mine]);
  await check("10 the board is open on B's own page when A is back: the page shows the take-over panel, nothing is dropped or written meanwhile", taken === true && quiet && (await owner.locator(LIVE).count()) === 1,
    `panel "${short(await panel.innerText().catch(() => "none"), 120)}"; notes ${await note.count()}; shapes on B ${(await shapesOn(id)).length} (before ${before.length})`);
  await panel.locator("button", { hasText: /^Use here$/ }).click();
  const told = await noteSays();
  await sleep(1000);
  after = await shapesOn(id);
  await check('10 "Use here": the board is the page\'s again at the revision B has now, so the drawing made during the outage is dropped with the notice, and B\'s drawing stands',
    told === true && one(after) === one([...before, ...mine]) && (await page.locator(LIVE).count()) === 1 && (await holds("the owner's page shows the panel", async () => (await owner.locator(".takeover-panel").count()) === 1, { timeout: 30000 })) === true,
    `note "${short(await note.innerText().catch(() => "none"))}"; shapes on B ${after.length} (before ${before.length}, with the owner's ${before.length + 1})`);
  await note.locator("button").click().catch(() => {});
  await owner.locator("button.icon-btn.new").click();
  await menuItem(owner, "New chat").click();
  await box(owner).waitFor();
  await renameChat(owner, "Owner again");
}

async function step11() {
  // One draws at a time, across the owner's page and the client's.
  await rowOf(side(owner), "board", BOARD).click();
  const panel = page.locator(".takeover-panel");
  const lost = await holds("the page shows the take-over panel", async () => (await panel.count()) === 1 && (await page.locator(LIVE).count()) === 0, { timeout: 30000 });
  const text = short(await panel.innerText().catch(() => "none"));
  const theirs = await owner.waitForSelector(LIVE, { timeout: 30000 }).then(() => true, () => false);
  await check("11 the owner opens the board on B's own page: the owner draws, and the page shows the take-over panel, which names the server", lost === true && theirs && text.includes(B.name) && text.includes("Use here"), `panel "${text}"; the owner's canvas live: ${theirs}`);
  await panel.locator("button", { hasText: /^Use here$/ }).click();
  const mine = await page.waitForSelector(LIVE, { timeout: 30000 }).then(() => true, () => false);
  const theirPanel = await holds("the owner's page shows the panel", async () => (await owner.locator(".takeover-panel").count()) === 1, { timeout: 30000 });
  await check('11 "Use here" on the page takes the board back: the page draws, and the owner\'s page shows the panel', mine && theirPanel === true, `the page's canvas live: ${mine}; the owner's panel: ${theirPanel}`);
  await rowOf(side(owner), "chat", "Owner again").click();
}

async function step12() {
  const id = own(board);
  setLink("cut");
  await awayLook();
  await more(owner, rowOf(side(owner), "board", BOARD), "Delete");
  await dialogDo(owner, "Delete");
  await waitFor("B no longer has the board", async () => !(await stateOf(B)).boards.some((b) => b.id === id), { timeout: 30000 });
  setLink("pass");
  const off = page.locator(".board-off");
  const says = await holds("the view says that the board is no longer on B", async () => ((await off.innerText().catch(() => "")).replace(/\s+/g, " ")).includes(`No longer on ${B.name}`), { timeout: 60000 });
  const rows = await rowOf(section(), "board", BOARD).count();
  await check("12 the board is deleted on B during an outage: back, its view says that it is no longer on that server, and the section has no row for it", says === true && rows === 0, `"${short(await off.innerText().catch(() => "none"))}"; rows ${rows}`);
  // (the selection and the chat a run reopens with are kept as keys: an entry's id and a thing's id, and nothing of what the thing holds)
  const kept = await page.evaluate(([entry, words]) => Object.keys(localStorage).filter((k) => {
    const v = localStorage.getItem(k) ?? "";
    return words.some((w) => v.includes(w) || k.includes(w)) || (!["aiwb.sel", "aiwb.lastChat"].includes(k) && (v.includes(entry) || k.includes(entry)));
  }), [ENTRY, [RUN_NAME, RUN_TWO, BOARD, GROUP, "a goal", FIRST_LINE, "hello from the run", B.name]]);
  const files = fs.readdirSync(A.home, { recursive: true }).map(String).filter((f) => f.includes(own(run)) || f.includes(own(run2)) || f.includes(id) || /^remote\b/.test(f) || /^(runs|boards)\/./.test(f));
  await check("12 at the end the browser's storage holds no content of B (no name, no goal, no message, no drawing: keys of the selection alone), and A's data folder no file of B's runs or boards", kept.length === 0 && files.length === 0, `storage ${one(kept)}; files ${one(files)}`);
}

// ---- main

let code = 0;
try {
  await prepare();
  await start(A);
  await start(B);
  console.log(`# A on ${A.base}; B on ${B.base}, remote listener on https://127.0.0.1:${B.remotePort}, behind the link on ${link.port}; files in ${OUT}`);
  let chromium;
  try { ({ chromium } = await import("playwright")); }
  catch { throw new Error("playwright is not installed: cd web && npm install --no-save playwright && npx playwright install chromium"); }
  browser = await chromium.launch({ headless: true });
  page = await openPage(A);
  await step("1 add B", step1);
  if (!ENTRY || !owner) throw new Error("B was not added to A's server list, or its own page did not open: nothing else can be shown");
  await step("2 a run that has not started", step2);
  await step("3 the start", step3);
  await step("4 the transcript", step4);
  await step("5 the link is pulled while the run works", step5);
  setLink("pass");
  await step("6 a chat on the run", step6);
  await step("7 an unstarted run through an outage", step7);
  setLink("pass");
  await step("8 a run deleted during an outage", step8);
  setLink("pass");
  await step("9 a board through an outage", step9);
  setLink("pass");
  await step("V1 the local server restarts during an outage", stepRestart);
  setLink("pass");
  if (!A.proc) await start(A).catch(() => {});
  await step("10 a board changed there during an outage", step10);
  setLink("pass");
  await step("11 one draws at a time", step11);
  await step("12 a board deleted during an outage", step12);
  setLink("pass");
  // Not checks: an outage is answered 503 by design, and the browser logs those.
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
  for (const p of link.pairs) { p.c.destroy(); p.u?.destroy(); }
  if (link.server) await new Promise((r) => link.server.close(r));
}
const alive = [...A.pids, ...B.pids].filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
const free = (await Promise.all([A.port, B.port, B.remotePort, link.port].filter(Boolean).map(portFree))).every(Boolean);
page = null;
if (A.port && !(await check("both servers are stopped and their ports are free", free && alive.length === 0, `ports ${A.port}, ${B.port}, ${B.remotePort}, ${link.port}; processes left: ${alive.join(", ") || "none"}`)) && !code) code = 1;
if (code === 0 && process.env.AIWB_E2E_KEEP !== "1") fs.rmSync(OUT, { recursive: true, force: true });
else console.log(`# files kept in ${OUT}`);
console.log(code === 0 ? "# passed" : code === 2 ? "# could not run to the end" : `# failed (${failed} checks)`);
process.exit(code);
