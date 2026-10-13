// A remote server as a section of the sidebar, through the real pages
// (plans/remote-server-sections-goal.md, sections 2, 3 and 7).
//
// A remote server is one place in the sidebar: a fixed section under the local part that shows
// that machine's whole tree, the same tree to its owner and to every client, and nothing while
// the server is not connected. The Go tests show that with stand-in pages; this script shows it
// with the pages themselves in a headless Chrome (Playwright), against two real servers:
//
//   A   the local server. Its page is "the page": the client.
//   B   the remote server, an entry of A's server list ("Studio B"). Its own page, on its own
//       port, is "the owner's page".
//
// Between A and B stands a link the script owns (a TCP relay: A dials it in the place of B's
// remote listener, by the server's test hook AIWB_TEST_DIAL_VIA), so that the script can pull
// the network while B goes on, hold B's answers back, and put another server behind the
// entry's address. A's waits between two attempts to connect are lowered (AIWB_TEST_WAITS), so
// that a return is seen in seconds; every other wait is the production one.
//
// It spends no money: both servers run the stand-in agent internal/agenttest/fake-claude and have
// no Cursor and no pi. It never touches the installed app: the script builds its own binary into
// a temp folder, runs both servers on temp data folders and on free ports, and stops them at the
// end. Not part of `npm test`.
//
//   cd web && npm ci && npm run build && npm install --no-save playwright && npx playwright install chromium
//   node web/e2e/remotechat.e2e.mjs
//
// Steps (goal section in brackets):
//   1 the sidebar with no server in the list has no section, and "+" asks nothing and offers no
//     server; B is added in the Servers dialog: a section under the local part with B's name and
//     state: connecting (the line is made slow), then connected with nothing on it; A keeps
//     nothing of B on disk                                                              [3.1, 3.2, 3.12]
//   2 the owner makes a group, chats and a board on B's own page: A's section shows the same tree
//     with no reload, and no row names a server                                         [3.3, 3.11]
//   3 a chat, a whiteboard and a group from the section's "+", a chat and a group from a
//     group's "+" inside the section: each is on B at once, in its place, nothing asks where it
//     should live, and the owner's page shows it                                        [3.4]
//   4 a group of the section is renamed, moved, archived, unarchived and deleted from the page,
//     and the owner's page follows; the owner renames, makes and deletes one, and the page follows [3.5]
//   5 a board is moved by its menu, which lists the section's groups alone; a chat by a drag; a
//     drag from the section to the local part and from the local part into the section is not
//     taken and makes no request; a section's head is no group                          [3.2, 3.5]
//   6 collapse of the section and of a group in it: in localStorage, kept across a reload, sent
//     nowhere, and nothing changes for the owner; "Show archived" is one switch; two more entries
//     that never connect ("Certificate not accepted", "Fingerprint not accepted"): a section each,
//     in the order of the list; one collapses and stays so; removed, their sections go   [3.1, 3.2, 3.13]
//   7 a chat of the section: a folder of B's machine, a first message with a permission ask
//     answered on the page; the group's defaults are B's, the same for the page and the owner; an
//     image, which B alone keeps; a second message which both pages follow while the agent works,
//     an ask answered by the owner, a message of the owner's, the draft mark, and two writers in
//     one draft                                                                          [3.3, 3.4, 3.6, 5]
//     then a chat that has not started, open on both pages: the effort the owner picks shows in the
//     page's composer and the model the page picks in the owner's; and a Stop pressed on one page
//     while the agent works ends the turn on the other                                   [3.3, 3.6]
//   8 the link is pulled with the chat open: it stays, read-only, under the warning; what was
//     typed stays and is saved when B is back; left, the chat cannot be opened; a reload knows
//     nothing of B; a chat deleted on B meanwhile says so                                [3.7 to 3.9]
//   9 B's process stops; a server that is too old stands behind the entry's address (a stand-in
//     with B's certificate that reports level 4); then, each with a stand-in of its own, what the
//     list calls "Secret not accepted", "Not an AI Whiteboard server", "Another server", "Name not
//     known there" and "Certificate changed": the section says the dialog's words and the one line;
//     and then the real B again                                                          [3.2, 3.7, 3.10]
//   M a make and a first message whose answers do not arrive (B's answers are held back): the
//     page says so, nothing is cleaned up, and what was made shows when the answers flow [3.4]
//   10 the entry is removed in the Servers dialog: the question says that everything stays there
//     and counts nothing; the section goes; B still has everything                       [3.12]
//
// It prints one line per check, `ok <n> <what>` or `FAIL <n> <what> — <what was seen>`, saves a
// screenshot for a failed check, and exits with 1 when a check failed (2 when it could not run).
//
// Environment (all optional):
//   AIWB_E2E_BIN       server binary                    (default: built into the temp folder)
//   AIWB_E2E_CLIENT    built web client                 (default web/dist)
//   AIWB_E2E_KEEP=1    keep the temp folder (server logs, screenshots) after a run that passed;
//                      after a failed run it is always kept, and its path is printed
//   AIWB_E2E_SHOTS     a folder that gets a picture of the sidebar in each state the script brings a section to (no
//                      server, connecting, connected and empty, a tree, collapsed, not connected, too old and every
//                      other state of the list), numbered in the order they were taken, to be judged by eye
import { spawn, execFileSync } from "node:child_process";
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

// ---- pictures, to judge the sidebar by eye (AIWB_E2E_SHOTS): no check reads them
const SHOTS = process.env.AIWB_E2E_SHOTS ? path.resolve(process.env.AIWB_E2E_SHOTS) : "";
let shots = 0;
/** A picture of a page's sidebar as it is now; whole: of the whole page. */
async function shot(name, p, whole = false) {
  if (!SHOTS || !p) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `${String(++shots).padStart(2, "0")}-${name}.png`);
  await (whole ? p.screenshot({ path: file }) : p.locator("nav.side").screenshot({ path: file })).catch(() => {});
}

// ---- checks: one line each

let failed = 0;
let n = 0;
let page = null;  // A's page: a failed check takes its screenshot and what it logged since the last check
let owner = null; // B's own page
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
const B = scratch("b", "Studio B");      // the remote one, an entry of A's server list
const B_ONLY = "only-on-b";
/** A PNG of one pixel: the image a chat of the section is given. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");

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
  // A alone: the link, and short waits between its attempts to connect (the last step 3 s for 30 s, Stable with it) and
  // before a server that is too old is asked again (4 s for 5 min).
  ...(s === A ? { AIWB_TEST_DIAL_VIA: `127.0.0.1:${link.port}`, AIWB_TEST_WAITS: "backoff=3s,tooold=4s" } : {}),
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
  fs.mkdirSync(path.join(B.work, B_ONLY)); // a folder of B's machine: a group of B remembers it
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
const census = async () => { const s = await stateOf(B); return { groups: s.groups.length, boards: s.boards.length, chats: s.chats.length }; };

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

/** The tree a page shows, as lines: of B's section (of: B.name), or of the page's local part (of: ""). A group and a
 *  board are followed by what is in them, two spaces further in. The same code reads A's section and the
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
    if (el.matches(".side-board")) {
      const row = el.querySelector(":scope > .side-row");
      out.push(`${pad}board ${named(row)}${tags(row)}`);
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
/** Types a name into the rename box that is open in a scope (a new board or group opens with one). */
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

// ---- the steps

const HERE = "Here", LOCAL_GROUP = "Local only";
const FILMS = "Films", OWNER_CHAT = "Owner chat", OWNER_LOOSE = "Owner loose", OWNER_BOARD = "storyboard"; // one word: a board's name is also its folder's
const TWO = "Two pages";
const MY_CHAT = "Made by A", MY_BOARD = "plan", MY_GROUP = "Shared", INNER = "Inner", IN_GROUP = "In the group";
const AWAY = `${B.name} is not connected`;
const WHY = `${AWAY}: nothing can be sent or changed until it is back.`;
const ONE_LINE = "Its chats show when the server is back.";
let chat0 = "", chatLoose = "", chatGroup = "", boardKey = "";

async function step1() {
  // No server but this computer: no section, and the "+" of the head asks nothing and offers no server.
  const none = await page.locator(".side-section").count();
  await page.click("button.icon-btn.new");
  const offered = (await page.locator(".menu .menu-item").allInnerTexts()).map((t) => t.trim());
  await page.keyboard.press("Escape");
  await check("1 with no server in the list the sidebar has no section, and its \"+\" offers a chat, a whiteboard and a group", none === 0 && one(offered) === one(["New chat", "New whiteboard", "New group"]),
    `sections ${none}; "+" offers ${one(offered)}`);
  await shot("no-server-in-the-list", page);
  chat0 = await selected(page, "chat", async () => { await page.click("button.icon-btn.new"); await menuItem(page, "New chat").click(); });
  await box(page).waitFor();
  await check("1 a new chat is made here at once and nothing asks where it should live", !!(await chatOn(A, chat0)) && (await asksWhere(page)) === 0, `A has the chat: ${!!(await chatOn(A, chat0))}; choices shown ${await asksWhere(page)}`);
  await renameChat(page, HERE);
  await page.locator("button.side-addgroup").click();
  await nameIt(side(page), LOCAL_GROUP);

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
  const shown = (await form.locator(".servers-result .servers-fp").last().innerText()).trim();
  await check("1 the form shows the fingerprint that `remote setup` printed", shown === B.fingerprint, `shown ${shown}, printed ${B.fingerprint}`);
  await accept.click();
  const save = form.locator("button.primary", { hasText: /^Save$/ });
  await waitFor("Save is enabled after the accepted test", async () => !(await save.isDisabled()));
  // The line is slow from here on: every answer of B takes a second and a half, so the entry's first connection takes seconds.
  setLink("slow");
  await save.click();
  const connecting = await holds('the section says "Connecting…" and shows no row, no line and no "+"', async () => { const l = await sectionLook(); return !!l && l.state === "Connecting…" && l.tone === "wait" && l.rows === 0 && l.lines.length === 0 && !l.add; }, { timeout: 60000, every: 30 });
  await check('1 B is added, and while its first connection is being made its section says "Connecting…" and shows nothing else', connecting, one(await sectionLook()));
  await shot("connecting", page);
  setLink("pass");
  const row = dlg.locator(".servers-row").filter({ has: page.locator(".servers-name", { hasText: exact(B.name) }) });
  const ok = await holds("the row reads Connected", async () => (await row.locator(".servers-state").innerText()) === "Connected", { timeout: 60000 });
  await check('1 the link passes again: the entry connects by itself, and its row in the Servers dialog reads "Connected"', ok, `row: ${(await row.innerText().catch(() => "no row")).replace(/\n/g, " / ")}`);
  await dlg.locator("button", { hasText: /^Close$/ }).click();
  await dlg.waitFor({ state: "detached" });
  ENTRY = (await entry())?.id ?? "";
  B.instance = (await entry())?.instanceId ?? "";

  // The section: under the local part, with the name and the state, and the line of a server with nothing on it.
  const empty = await holds("the section says that B has nothing on it", async () => (await sectionLook())?.lines.join("|") === "Nothing on this server yet.", { timeout: 20000 });
  const look = await sectionLook();
  const order = await page.evaluate(() => [...document.querySelector(".side-tree").children].map((e) => (e.matches(".side-section") ? "section" : e.matches(".side-addgroup") ? "new-group" : "local")).join(","));
  await check("1 B has a section under the local part and \"New group\", with its name, the state \"Connected\", the line that nothing is on it, and a \"+\"",
    empty === true && look?.name === B.name && look.state === "Connected" && look.tone === "ok" && look.rows === 0 && look.add && /^(local,)+new-group,section$/.test(order), `${one(look)}; order ${order}`);
  await shot("connected-nothing-on-it", page);
  // What A's own API says and keeps: the tree is in "sections" under the entry's id, A's own lists have nothing of B, and the data folder holds the list alone.
  const st = await stateOf(A);
  const files = fs.readdirSync(A.home, { recursive: true }).map(String).filter((f) => /remote|record|makes/i.test(f) && !/^servers/.test(f));
  await check("1 A's snapshot has B's tree under \"sections\" by the entry's id, no thing of A's own names a server, and A's data folder has no file of a remote thing",
    !!ENTRY && !!st.sections?.[ENTRY] && Array.isArray(st.sections[ENTRY].chats) && [...st.chats, ...st.boards].every((x) => !("server" in x)) && files.length === 0,
    `entry ${ENTRY}; sections ${one(Object.keys(st.sections ?? {}))}; files ${one(files)}`);
}

async function step2() {
  owner = await openPage(B);
  // The owner's page is the page it always was: a group, a chat in it, a loose chat and a board, each made by a click there.
  await owner.locator("button.side-addgroup").click();
  await nameIt(side(owner), FILMS);
  await selected(owner, "chat", () => plus(owner, groupHead(side(owner), FILMS), "Chat"));
  await box(owner).waitFor();
  await renameChat(owner, OWNER_CHAT);
  await selected(owner, "chat", async () => { await owner.click("button.icon-btn.new"); await menuItem(owner, "New chat").click(); });
  await box(owner).waitFor();
  await renameChat(owner, OWNER_LOOSE);
  await selected(owner, "board", async () => { await owner.click("button.icon-btn.new"); await menuItem(owner, "New whiteboard").click(); });
  await nameIt(side(owner), OWNER_BOARD);
  const same = await sameTree();
  const a = await outline(page, B.name);
  await check("2 what the owner made on B's own page shows in A's section with no reload: the same groups, the same things in them, the loose ones first",
    same === true && one(plain(a)) === one([`board ${OWNER_BOARD}`, `chat ${OWNER_LOOSE}`, `group ${FILMS}`, `  chat ${OWNER_CHAT}`]), await bothTrees());
  await shot("connected-the-owners-tree", page);
  await shot("the-owners-own-page", owner);
  const rows = await section().locator(".side-row, .side-group-head").evaluateAll((els) => els.map((e) => `${e.textContent} ${e.getAttribute("title") ?? ""}`));
  await check("2 no row of the section names the server, and no row says who made it", rows.length === 4 && rows.every((t) => !t.includes(B.name) && !/owner\b.*made|made by/i.test(t.replace(OWNER_CHAT, "").replace(OWNER_LOOSE, ""))), one(rows));
  const local = await outline(page);
  await check("2 the local part holds what lives on this computer alone", one(local) === one([`chat ${HERE}`, `group ${LOCAL_GROUP}`]), lines(local));
  const none = await owner.locator(".side-section").count(), remote = await groupOn(B, "Remote");
  await check('2 the owner\'s page has no group "Remote" and no section', none === 0 && !remote, `sections on the owner's page ${none}; a group "Remote" on B: ${!!remote}`);
}

async function step3() {
  const made = callsFrom(page);
  // The section's "+": a chat, a whiteboard and a group, each on B, outside any group.
  await section().locator(".side-section-head").hover();
  await section().locator(".side-section-head button[title^='New on']").click();
  const offered = (await page.locator(".menu .menu-item").allInnerTexts()).map((t) => t.trim());
  await shot("the-plus-of-a-sections-head", page, true);
  await page.keyboard.press("Escape");
  chatLoose = await selected(page, "chat", () => plus(page, section().locator(".side-section-head"), "Chat"));
  await box(page).waitFor();
  const asked1 = await asksWhere(page);
  const c1 = await chatOn(B, own(chatLoose));
  await check("3 the section's \"+\" offers a chat, a whiteboard and a group; \"Chat\" makes one on B at once, in no group, unstarted, and A has none of it",
    one(offered) === one(["Chat", "Whiteboard", "Group"]) && inB(chatLoose) && !!c1 && c1.locked === false && (c1.group ?? "__ungrouped__") === "__ungrouped__" && !(await chatOn(A, own(chatLoose))) && asked1 === 0,
    `offered ${one(offered)}; key ${chatLoose}; B's chat ${one(c1 && { group: c1.group, locked: c1.locked })}; asked where: ${asked1}`);
  await renameChat(page, MY_CHAT);

  boardKey = await selected(page, "board", () => plus(page, section().locator(".side-section-head"), "Whiteboard"));
  const asked2 = await asksWhere(page);
  await nameIt(section(), MY_BOARD);
  const b1 = await holds("B has the board under its name", async () => (await stateOf(B)).boards.some((b) => b.id === own(boardKey) && b.name === MY_BOARD && (b.group ?? "__ungrouped__") === "__ungrouped__"));
  await check("3 \"Whiteboard\" makes a board on B at once and asks nothing", inB(boardKey) && b1 === true && asked2 === 0 && (await stateOf(A)).boards.length === 0, `key ${boardKey}; on B: ${b1}; asked where: ${asked2}; boards of A: ${(await stateOf(A)).boards.length}`);

  await plus(page, section().locator(".side-section-head"), "Group");
  await nameIt(section(), MY_GROUP);
  const g1 = await holds("B has the group", async () => { const g = await groupOn(B, MY_GROUP); return !!g && !g.parent; });
  await check("3 \"Group\" makes a group on B, at the top level, and A has none of it", g1 === true && !(await groupOn(A, MY_GROUP)), `on B: ${g1}; on A: ${!!(await groupOn(A, MY_GROUP))}`);

  // A group's "+" inside the section: the chat and the group are made in that group.
  const gid = (await groupOn(B, MY_GROUP))?.id;
  chatGroup = await selected(page, "chat", () => plus(page, groupHead(section(), MY_GROUP), "Chat"));
  await box(page).waitFor();
  const asked3 = await asksWhere(page);
  const c2 = await chatOn(B, own(chatGroup));
  await renameChat(page, IN_GROUP);
  await plus(page, groupHead(section(), MY_GROUP), "Group");
  await nameIt(section(), INNER);
  const g2 = await holds("B has the nested group", async () => (await groupOn(B, INNER))?.parent === gid);
  await check("3 a group's \"+\" in the section makes a chat and a group in that group, on B, and asks nothing", inB(chatGroup) && c2?.group === gid && g2 === true && asked3 === 0,
    `B's chat ${one(c2 && { group: c2.group })}, the group ${gid}; nested on B: ${g2}; asked where: ${asked3}`);

  // Every make was one call under /api/on/<entry>/ with B's own ids, and none named a server or a collapse.
  const posts = made().filter((c) => c.method === "POST" && /\/(chats|boards|groups)$/.test(c.path));
  const bad = made().filter((c) => c.method !== "GET" && (!c.path.startsWith(`/api/on/${ENTRY}/`) || /"(server|collapsed)"/.test(c.body) || c.body.includes(`${ENTRY}~`)));
  await check("3 each was made by one call under /api/on/<entry id>/, with B's own ids, naming no server", posts.length === 5 && posts.every((c) => c.status === 200) && bad.length === 0,
    `makes ${one(posts.map((c) => `${c.method} ${c.path} ${c.status} ${c.body}`))}; others ${one(bad.map((c) => `${c.method} ${c.path} ${c.body}`))}`);
  const same = await sameTree();
  await check("3 the owner's page shows what the client made, in the group it was made in, with no reload", same === true && plain(await outline(owner)).includes(`  chat ${IN_GROUP}`), await bothTrees());
  await shot("connected-a-tree-with-groups", page, true);
}

async function step4() {
  // From the page: rename, move to the top level (a drag), archive, unarchive, delete with what is in it.
  await more(page, groupHead(section(), MY_GROUP), "Rename");
  await nameIt(section(), "Shared work");
  const renamed = await holds("B and the owner's page have the new name", async () => !!(await groupOn(B, "Shared work")) && (await outline(owner)).includes("group Shared work"));
  await check("4 a group of the section is renamed from the page: B has the name and the owner's page shows it with no reload", renamed, await bothTrees());
  await more(page, groupHead(section(), "Shared work"), "Rename");
  await nameIt(section(), MY_GROUP);
  await waitFor("the name is back", async () => !!(await groupOn(B, MY_GROUP)));

  // The nested group is dragged to the section's ungrouped area: it is at the top level on B.
  const drag = writesFrom(page);
  await groupHead(section(), INNER).dragTo(section().locator(".side-loose"));
  const top = await holds("the group is at B's top level", async () => { const g = await groupOn(B, INNER); return !!g && !g.parent; }, { timeout: 15000 });
  await check("4 a nested group is dragged to the top level of the section: moved on B, by one call, and the owner's page follows", top === true && (await sameTree()) === true && drag().length === 1 && /\/groups\/[^/]+\/move$/.test(drag()[0]),
    `on B: ${top}; calls ${one(drag())}; ${await bothTrees()}`);
  // And back into the group, by a drag onto it.
  await groupHead(section(), INNER).dragTo(groupHead(section(), MY_GROUP), { targetPosition: { x: 60, y: 22 } });
  const gid = (await groupOn(B, MY_GROUP))?.id;
  const nested = await holds("the group is nested on B again", async () => (await groupOn(B, INNER))?.parent === gid, { timeout: 15000 });
  await check("4 and dragged into a group of the section: nested on B, and the owner's page follows", nested === true && (await sameTree()) === true, `on B: ${nested}; ${await bothTrees()}`);

  await more(page, groupHead(section(), INNER), "Archive");
  const archived = await holds("B has the group archived", async () => (await groupOn(B, INNER))?.archived === true);
  const hidden = await holds("the row is gone from both pages", async () => !(await outline(page, B.name)).some((l) => l.includes(INNER)) && !(await outline(owner)).some((l) => l.includes(INNER)));
  await showArchived(page, true);
  await showArchived(owner, true);
  const tagged = await holds("both pages show it as archived", async () => (await outline(page, B.name)).includes(`  group ${INNER} [archived]`) && (await outline(owner)).includes(`  group ${INNER} [archived]`));
  await check("4 a group of the section is archived from the page: archived on B, gone from both pages, and shown as archived with \"Show archived\"", all(archived, hidden, tagged), await bothTrees());
  await more(page, groupHead(section(), INNER), "Unarchive");
  const back = await holds("B has the group unarchived", async () => (await groupOn(B, INNER))?.archived !== true && !!(await groupOn(B, INNER)));
  await showArchived(page, false);
  await showArchived(owner, false);
  await check("4 and unarchived from the page", all(back, await sameTree()), await bothTrees());

  // Deleted with what is in it: a chat is made in it first, by the owner.
  await selected(owner, "chat", () => plus(owner, groupHead(side(owner), INNER), "Chat"));
  await box(owner).waitFor();
  await renameChat(owner, "Doomed");
  await rowOf(section(), "chat", "Doomed").waitFor({ timeout: 15000 });
  const doomed = (await stateOf(B)).chats.find((c) => c.name === "Doomed")?.id;
  await more(page, groupHead(section(), INNER), "Delete");
  const body = await page.locator(".dialog .dialog-body").innerText().catch(() => "");
  await dialogDo(page, "Delete everything in it");
  const gone = await holds("B has neither the group nor the chat in it", async () => !(await groupOn(B, INNER)) && !(await chatOn(B, doomed)));
  await check("4 a group of the section is deleted from the page with everything in it: the question says that it is deleted on B for everyone, B has neither, and the owner's page follows",
    all(gone, await sameTree()) === true && body.includes(B.name) && body.includes("for everyone"), `question: "${body}"; ${await bothTrees()}`);

  // The reverse: the owner renames a group, makes one and deletes it.
  await more(owner, groupHead(side(owner), FILMS), "Rename");
  await nameIt(side(owner), "Movies");
  const seen = await holds("A's section has the owner's name for the group", async () => (await outline(page, B.name)).includes("group Movies") && !(await outline(page, B.name)).includes(`group ${FILMS}`));
  await owner.locator("button.side-addgroup").click();
  await nameIt(side(owner), "Passing");
  const came = await holds("A's section has the owner's new group", async () => (await outline(page, B.name)).includes("group Passing"));
  await more(owner, groupHead(side(owner), "Passing"), "Delete");
  await dialogDo(owner, "Delete everything in it");
  const went = await holds("A's section lost the group the owner deleted", async () => !(await outline(page, B.name)).includes("group Passing"));
  await more(owner, groupHead(side(owner), "Movies"), "Rename");
  await nameIt(side(owner), FILMS);
  await check("4 the reverse: the owner renames a group, makes one and deletes it, and the page's section follows each with no reload", all(seen, came, went, await sameTree()), await bothTrees());
}

async function step5() {
  // A board by its menu: "Move to…" lists the groups of its own section, and nothing of this computer or of a server.
  const row = rowOf(section(), "board", MY_BOARD);
  await row.hover();
  await row.locator("button[title='More']").first().click();
  await menuItem(page, "Move to…").click();
  const targets = (await page.locator(".menu .menu-item").allInnerTexts()).map((t) => t.trim());
  const moved = writesFrom(page);
  await menuItem(page, MY_GROUP).click();
  const gid = (await groupOn(B, MY_GROUP))?.id;
  const there = await holds("B has the board in the group", async () => (await stateOf(B)).boards.find((b) => b.id === own(boardKey))?.group === gid);
  await check("5 a board of the section is moved by its menu: the list has the section's groups alone, and the board is in the group on B",
    there === true && one([...targets].sort()) === one([FILMS, MY_GROUP].sort()) && moved().length === 1 && moved()[0] === `PATCH /api/on/${ENTRY}/boards/${own(boardKey)}`, `targets ${one(targets)}; calls ${one(moved())}; on B: ${there}`);

  // A chat by a drag onto a group of its own section.
  const dragged = writesFrom(page);
  await rowOf(section(), "chat", MY_CHAT).dragTo(groupHead(section(), FILMS), { targetPosition: { x: 60, y: 22 } });
  const films = (await groupOn(B, FILMS))?.id;
  const inFilms = await holds("B has the chat in the group", async () => (await chatOn(B, own(chatLoose)))?.group === films, { timeout: 15000 });
  await check("5 a chat of the section is moved by a drag onto another group of the section: one call, and B has it there", inFilms === true && dragged().length === 1 && dragged()[0] === `PATCH /api/on/${ENTRY}/chats/${own(chatLoose)}` && (await sameTree()) === true,
    `calls ${one(dragged())}; on B: ${inFilms}; ${await bothTrees()}`);

  // Across: from the section to the local part, and from the local part into the section. Neither is taken, and no request is made.
  const before = { a: await outline(page), b: await outline(page, B.name) };
  const across = callsFrom(page);
  const lit = async () => page.locator(".side-tree .drop, .side-tree .drop-before").count();
  const drops = [
    ["a chat of the section onto a local group", rowOf(section(), "chat", MY_CHAT), groupHead(side(page), LOCAL_GROUP)],
    ["a chat of the section onto the local ungrouped area", rowOf(section(), "chat", OWNER_LOOSE), page.locator(".side-tree > .side-loose")],
    ["a group of the section onto a local group", groupHead(section(), FILMS), groupHead(side(page), LOCAL_GROUP)],
    ["a local chat onto a group of the section", rowOf(side(page), "chat", HERE), groupHead(section(), MY_GROUP)],
    ["a local group onto the section's ungrouped area", groupHead(side(page), LOCAL_GROUP), section().locator(".side-loose")],
    ["a local chat onto the section's head", rowOf(side(page), "chat", HERE), section().locator(".side-section-head")],
  ];
  const litDuring = [];
  for (const [what, from, to] of drops) {
    // (by hand, to look at the drop mark while the pointer is over the target)
    const f = await from.boundingBox(), t = await to.boundingBox();
    await page.mouse.move(f.x + 40, f.y + f.height / 2);
    await page.mouse.down();
    await page.mouse.move(f.x + 50, f.y + f.height / 2 + 4, { steps: 3 });
    await page.mouse.move(t.x + 60, t.y + Math.min(t.height - 4, 22), { steps: 6 });
    await sleep(150);
    if (await lit()) litDuring.push(what);
    await page.mouse.up();
    await sleep(150);
  }
  await sleep(800);
  const after = { a: await outline(page), b: await outline(page, B.name) };
  const reqs = across().filter((c) => c.method !== "GET");
  await check("5 a drag from the section to the local part, and from the local part into the section, is not taken: no zone lights, nothing moves and no request is made",
    litDuring.length === 0 && reqs.length === 0 && one(before) === one(after), `lit for: ${one(litDuring)}; requests ${one(reqs.map((c) => `${c.method} ${c.path}`))}; before ${one(before)}; after ${one(after)}`);

  // The head of a section is not a group's: no menu, no rename, not dragged, and "+" alone beside its name.
  const head = section().locator(".side-section-head");
  await head.dblclick();
  const rename = await section().locator(".side-section-head .name-input").count();
  if ((await sectionLook()).collapsed) await head.click(); // (two clicks collapse and expand; one more if a click was lost)
  const looks = { draggable: await head.getAttribute("draggable"), buttons: await head.locator("button").evaluateAll((els) => els.map((e) => e.getAttribute("title"))), rename };
  await check("5 a section's head is no group's: it is not dragged, has no menu and no rename, and its one button is the \"+\"", looks.draggable !== "true" && one(looks.buttons) === one([`New on ${B.name}`]) && rename === 0, one(looks));
}

async function step6() {
  const head = section().locator(".side-section-head");
  const ownerSees = await outline(owner);
  const quiet = callsFrom(page);
  await head.click();
  const closed = await holds("the section is collapsed", async () => { const l = await sectionLook(); return l.collapsed && l.rows === 0; });
  const kept1 = await stored(page, "aiwb.collapsed");
  await check("6 a click on the section's head collapses it: no row is drawn, and the entry's id is in localStorage \"aiwb.collapsed\"", closed === true && JSON.parse(kept1 ?? "[]").includes(ENTRY), `stored ${kept1}; ${one(await sectionLook())}`);
  await shot("collapsed", page);
  await head.click();
  await waitFor("the section is expanded", async () => !(await sectionLook()).collapsed);
  await groupHead(section(), FILMS).click();
  const gid = (await groupOn(B, FILMS))?.id;
  const folded = await holds("the group of the section is collapsed", async () => !(await outline(page, B.name)).some((l) => l === `  chat ${OWNER_CHAT}`) && JSON.parse((await stored(page, "aiwb.collapsed")) ?? "[]").includes(`${ENTRY}~${gid}`));
  await head.click();
  await waitFor("the section is collapsed again", async () => (await sectionLook()).collapsed);
  await sleep(1000);
  const sent = quiet().filter((c) => c.method !== "GET");
  const there = (await stateOf(B)).groups.find((g) => g.id === gid);
  await check("6 a group of the section collapses the same way, and nothing of it is sent: no request at all, B's group is as it was, and the owner's page shows it open",
    folded === true && sent.length === 0 && !there?.collapsed && one(await outline(owner)) === one(ownerSees), `requests ${one(sent.map((c) => `${c.method} ${c.path} ${c.body}`))}; B's group ${one(there)}; stored ${await stored(page, "aiwb.collapsed")}`);

  await page.reload();
  await page.waitForSelector("#root .side-tree");
  const still = await holds("after a reload the section is collapsed", async () => (await sectionLook())?.collapsed === true && (await sectionLook()).state === "Connected", { timeout: 20000 });
  await section().locator(".side-section-head").click();
  const group = await holds("and the group in it too", async () => { const o = await outline(page, B.name); return o.includes(`group ${FILMS}`) && !o.includes(`  chat ${OWNER_CHAT}`) && o.includes(`group ${MY_GROUP}`); }, { timeout: 15000 });
  await check("6 the collapse of the section and of the group in it survives a reload of the page", all(still, group), `${one(await sectionLook())}; ${lines(await outline(page, B.name))}`);
  await shot("a-group-of-the-section-collapsed", page);
  await groupHead(section(), FILMS).click();
  const open = await holds("the group is open again", async () => (await outline(page, B.name)).includes(`  chat ${OWNER_CHAT}`));
  await check("6 expanded again, the section shows B's tree as the owner's page does, and the storage holds no collapse", all(open, await sameTree()) === true && (await stored(page, "aiwb.collapsed")) === "[]", `stored ${await stored(page, "aiwb.collapsed")}; ${await bothTrees()}`);

  // "Show archived" is one switch for the local part and the section.
  await more(page, rowOf(section(), "chat", OWNER_LOOSE), "Archive");
  await more(page, rowOf(side(page), "chat", HERE), "Archive");
  const off = await holds("both archived chats are hidden", async () => !(await outline(page, B.name)).some((l) => l.includes(OWNER_LOOSE)) && !(await outline(page)).some((l) => l.includes(HERE)));
  const switches = await page.locator(".side-archived input").count();
  await showArchived(page, true);
  const on = await holds("both show as archived", async () => (await outline(page, B.name)).includes(`chat ${OWNER_LOOSE} [archived]`) && (await outline(page)).includes(`chat ${HERE} [archived]`));
  const onB = (await stateOf(B)).chats.find((c) => c.name === OWNER_LOOSE)?.archived === true;
  await shot("show-archived", page);
  await more(page, rowOf(section(), "chat", OWNER_LOOSE), "Unarchive");
  await more(page, rowOf(side(page), "chat", HERE), "Unarchive");
  const undone = await holds("both are unarchived", async () => (await stateOf(B)).chats.find((c) => c.name === OWNER_LOOSE)?.archived !== true && (await stateOf(A)).chats.find((c) => c.name === HERE)?.archived !== true);
  await showArchived(page, false);
  await check('6 "Show archived" is one switch: a chat of the section archived from the page is archived on B, and it and an archived local chat hide and show together', all(off, on, undone) === true && switches === 1 && onB, `switches ${switches}; archived on B: ${onB}; hidden ${off}; shown ${on}; undone ${undone}`);
}

/** What a section of a page shows, by the entry's name: sectionLook for any entry. */
const lookOf = (name, p = page) => p.evaluate((name) => {
  const s = document.querySelector(`.side-section[aria-label="${name}"]`);
  if (!s) return null;
  return { state: s.querySelector(".side-section-state")?.textContent ?? "", tone: ["ok", "wait", "bad"].find((t) => s.classList.contains(t)) ?? "", collapsed: s.classList.contains("collapsed"),
    lines: [...s.querySelectorAll(".side-section-line")].map((e) => e.textContent ?? ""), rows: s.querySelectorAll(".side-row, .side-group-head").length, add: !!s.querySelector(".side-section-head button[title^='New on']") };
}, name);

/** Two more entries of the list, which never connect: one whose certificate is not accepted (no self-signed box: the
 *  link leads to B, whose certificate no authority signed) and one whose fingerprint was never accepted. The sections
 *  stand in the order of the list, each with the words of its state; one of them collapses and stays so; and removing
 *  an entry takes its section and its collapse away. */
async function step6b() {
  const ATTIC = "Attic", CELLAR = "Cellar";
  const dlg = page.locator(".servers-dialog");
  const rowIn = (name) => dlg.locator(".servers-row").filter({ has: page.locator(".servers-name", { hasText: exact(name) }) });
  const add = async (name, selfSigned) => {
    await page.locator("button.servers-btn").click();
    await dlg.waitFor();
    await dlg.locator("button", { hasText: /^Add server$/ }).click();
    const form = dlg.locator(".servers-form");
    const fields = form.locator(".servers-field input");
    await fields.nth(0).fill(name);
    await fields.nth(1).fill(`https://127.0.0.1:${await freePort()}`); // never dialed: A dials the link, whatever the address
    await fields.nth(2).fill("a-secret-of-no-server");
    if (selfSigned) await form.locator(".servers-check input").check();
    await form.locator("button", { hasText: /^Save anyway$/ }).click();
    await rowIn(name).waitFor({ timeout: 15000 });
    await dlg.locator("button", { hasText: /^Close$/ }).click();
    await dlg.waitFor({ state: "detached" });
  };
  await add(ATTIC, false);
  await add(CELLAR, true);
  const said = (name, words) => holds(`the section of ${name} says "${words}" and the one line, with no row`, async () => {
    const l = await lookOf(name);
    return !!l && l.state === words && l.tone === "bad" && l.rows === 0 && !l.add && one(l.lines) === one([ONE_LINE]);
  }, { timeout: 60000 });
  const attic = await said(ATTIC, "Certificate not accepted"), cellar = await said(CELLAR, "Fingerprint not accepted");
  const order = await page.locator(".side-section").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  const listed = ((await get(A, "/api/servers")).json?.servers ?? []).filter((v) => !v.local).map((v) => v.name);
  const st = await stateOf(A);
  await check("6 two more entries that never connect: each has its section, in the order of the list, with the words of its state and the one line; A holds a tree of B alone",
    all(attic, cellar) === true && one(order) === one([B.name, ATTIC, CELLAR]) && one(order) === one(listed) && one(Object.keys(st.sections ?? {})) === one([ENTRY]) && (await sectionLook()).rows > 0,
    `sections ${one(order)}; the list ${one(listed)}; ${ATTIC} ${one(await lookOf(ATTIC))}; ${CELLAR} ${one(await lookOf(CELLAR))}; trees ${one(Object.keys(st.sections ?? {}))}`);
  await shot("three-sections-in-the-order-of-the-list", page, true);

  // A section of a server that is not connected collapses, and stays collapsed across a reload.
  const atticId = ((await get(A, "/api/servers")).json?.servers ?? []).find((v) => v.name === ATTIC)?.id ?? "";
  await page.locator(`.side-section[aria-label="${ATTIC}"] .side-section-head`).click();
  await section().locator(".side-section-head").click();
  const folded = await holds("both are collapsed", async () => (await lookOf(ATTIC)).collapsed && (await sectionLook()).collapsed && (await lookOf(ATTIC)).lines.length === 0);
  await shot("a-connected-section-and-one-that-is-not-collapsed", page);
  await page.reload();
  await page.waitForSelector("#root .side-tree");
  const kept = await holds("after a reload both are collapsed, and the third is not", async () => (await lookOf(ATTIC))?.collapsed === true && (await sectionLook())?.collapsed === true && (await lookOf(CELLAR))?.collapsed === false, { timeout: 20000 });
  const storedNow = JSON.parse((await stored(page, "aiwb.collapsed")) ?? "[]");
  await check("6 a section of a server that is not connected collapses as a connected one does, says its state in its head alone, and both stay collapsed across a reload",
    all(folded, kept) === true && storedNow.includes(atticId) && storedNow.includes(ENTRY) && (await lookOf(ATTIC)).state === "Certificate not accepted", `stored ${one(storedNow)}; ${ATTIC} ${one(await lookOf(ATTIC))}`);
  await section().locator(".side-section-head").click();
  await waitFor("B's section is expanded again", async () => !(await sectionLook()).collapsed && (await sectionLook()).rows > 0);

  // Removing the two entries takes their sections away, and the collapse of the one that was collapsed.
  const before = await census();
  for (const name of [ATTIC, CELLAR]) {
    await page.locator("button.servers-btn").click();
    await rowIn(name).locator("button", { hasText: /^Remove$/ }).click();
    await page.locator(".dialog").filter({ has: page.locator(".dialog-title", { hasText: /^Remove server$/ }) }).locator("button", { hasText: /^Remove$/ }).click();
    await rowIn(name).waitFor({ state: "detached", timeout: 15000 });
    await dlg.locator("button", { hasText: /^Close$/ }).click();
    await dlg.waitFor({ state: "detached" });
  }
  const gone = await holds("B's section alone is left", async () => one(await page.locator(".side-section").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))) === one([B.name]), { timeout: 15000 });
  const left = await stored(page, "aiwb.collapsed");
  await check("6 the two entries are removed in the Servers dialog: their sections go, the collapse of the removed one goes with it, and B's section and B are as they were",
    gone === true && left === "[]" && one(await census()) === one(before) && (await sameTree()) === true, `stored collapse ${left}; ${await bothTrees()}`);
}

async function step7() {
  // The chat made in the group: a first message whose agent asks for a permission, answered on the page.
  await rowOf(section(), "chat", IN_GROUP).click();
  await box(page).waitFor();
  const id = own(chatGroup);
  // A folder of B's machine is picked for the chat before its first message: the group on B remembers it from that message on.
  const dir = path.join(B.work, B_ONLY);
  await page.locator('.composer button.tchip[title^="Folder on"]').click();
  const dirs = page.locator(".composer .menu.dirs");
  const head = ((await dirs.locator(".menu-head").textContent()) ?? "").trim(); // not innerText: the head is drawn in capitals
  await dirs.locator(".dir-input").fill(B.work);
  await dirs.locator(".dir-input").press("Enter");
  await waitFor("the picker lists the folder of B's machine", async () => (await dirs.locator(".dir-list .menu-item.dir").allInnerTexts()).some((t) => t.includes(B_ONLY)));
  await dirs.locator(".dir-input").fill(dir);
  await dirs.locator(".dir-input").press("Enter");
  await sleep(300);
  await dirs.locator(".dir-foot button").click();
  const picked = await holds("B's chat has the folder", async () => (await chatOn(B, id))?.cwd === dir);
  await check(`7 the folder picker of a chat of the section is titled "Folder on ${B.name}", lists folders of B's machine, and the pick is the chat's folder on B`, head === `Folder on ${B.name}` && picked === true, `head "${head}"; B's chat: ${(await chatOn(B, id))?.cwd}`);
  await send(page, '[[ask Bash {"command":"ls"}]] hello');
  const card = page.locator(".thread .perm-title");
  const asked = await card.waitFor({ timeout: 40000 }).then(() => true, (e) => e.message.split("\n")[0]);
  const cls = (await rowOf(section(), "chat", IN_GROUP).getAttribute("class")) ?? "";
  await check("7 a first message in a chat of the section: the permission card shows, and the row shows that the chat waits or works", asked === true && /\bst-(approval|working|busy|thinking)\b/.test(cls), `card: ${asked}; row class "${cls}"`);
  if (asked === true) await page.locator(".thread .perm-actions button", { hasText: /^Allow$/ }).click();
  const reply = await replied(page, "ask Bash -> allow");
  const onB = await holds("B has the user message once", async () => (await userTexts(B, id)).length === 1);
  await check("7 Allow is clicked on the page: the reply arrives, and B has the message once", all(reply, onB), `thread ${one(await msgs(page)).slice(0, 300)}`);
  await waitFor("the first turn ends", async () => (await chatOn(B, id))?.status === "ready", { timeout: 30000 }).catch(() => {});

  // The defaults of a group in a section are that server's, shared by all who use it: the next chat in the group starts
  // in that folder, made from the page or by the owner; a chat outside the group does not; and A remembers none.
  const gid = (await groupOn(B, MY_GROUP))?.id;
  const next = await selected(page, "chat", () => plus(page, groupHead(section(), MY_GROUP), "Chat"));
  await box(page).waitFor();
  const byOwner = await selected(owner, "chat", () => plus(owner, groupHead(side(owner), MY_GROUP), "Chat"));
  await box(owner).waitFor();
  const loose = await selected(page, "chat", () => plus(page, section().locator(".side-section-head"), "Chat"));
  await box(page).waitFor();
  const cw = [(await chatOn(B, own(next)))?.cwd, (await chatOn(B, byOwner))?.cwd, (await chatOn(B, own(loose)))?.cwd];
  const mineKept = one((await stateOf(A)).defaults ?? {});
  await check("7 the group on B remembers the folder of that first message: the next chat in the group starts in it, made from the page or by the owner; one outside the group starts in B's own folder; A remembers nothing of it",
    cw[0] === dir && cw[1] === dir && cw[2] === B.work && !mineKept.includes(gid) && !mineKept.includes(B_ONLY) && !mineKept.includes(ENTRY),
    `in the group, from the page: ${cw[0]}; by the owner: ${cw[1]}; outside: ${cw[2]}; A's defaults: ${mineKept.slice(0, 200)}`);
  await rowOf(section(), "chat", IN_GROUP).click();
  await page.locator(".thread .msg.assistant").first().waitFor();

  // An image in the chat: uploaded to B through A, shown from A's own address for it, and kept by B alone.
  const ups = callsFrom(page);
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".composer button.attach-btn").click();
  await (await chooser).setFiles({ name: "dot.png", mimeType: "image/png", buffer: PNG });
  const thumb = page.locator(".composer .composer-images .img-thumb:not(.busy) img");
  const up = await holds("the thumbnail of the uploaded image shows", async () => (await thumb.count()) === 1 && (await thumb.evaluate((el) => el.complete && el.naturalWidth > 0)), { timeout: 30000 });
  const post = ups().find((c) => c.method === "POST" && /\/images\?/.test(c.path));
  const hash = await waitFor("B's draft names the image", async () => (await get(B, `/api/chats/${id}/items`)).json?.state?.draft?.images?.[0]?.id ?? null, { timeout: 15000 }).catch(() => "");
  const got = hash ? await fetch(`${A.base}/api/on/${ENTRY}/chats/${id}/images/${hash}`, { headers: { "Sec-Fetch-Site": "same-origin" } }) : null;
  const local = fs.readdirSync(A.home, { recursive: true }).map(String).filter((f) => hash && f.includes(hash));
  await check("7 an image added to the chat is uploaded to B under the section's address, is named by B's draft, is served by A under its own headers as an image, and A keeps no file of it",
    up === true && post?.path.startsWith(`/api/on/${ENTRY}/chats/${id}/images?`) && post.status === 200 && /^[0-9a-f]{64}$/.test(hash) && got?.status === 200 && got.headers.get("content-type") === "image/png" && got.headers.get("x-content-type-options") === "nosniff" && local.length === 0,
    `upload ${one(post && { path: post.path.slice(0, 80), status: post.status })}; B's draft names ${hash.slice(0, 12)}…; GET -> ${got?.status} ${got?.headers.get("content-type")} nosniff: ${got?.headers.get("x-content-type-options")}; files of A: ${one(local)}`);
  await page.locator(".composer .composer-images .img-thumb-remove").click();
  await holds("the draft has no image again", async () => !((await get(B, `/api/chats/${id}/items`)).json?.state?.draft?.images?.length), { timeout: 15000 });

  // The owner opens the same chat on B's own page. A second message from A: both pages follow it while the agent works.
  await rowOf(side(owner), "chat", IN_GROUP).click();
  await owner.locator(".thread .msg.assistant").first().waitFor({ timeout: 20000 });
  await send(page, "[[sleep 4]] again");
  const working = await holds("both pages show the chat at work", async () => {
    const a = (await rowOf(section(), "chat", IN_GROUP).getAttribute("class")) ?? "", b = (await rowOf(side(owner), "chat", IN_GROUP).getAttribute("class")) ?? "";
    return /\bst-(working|busy|thinking)\b/.test(a) && /\bst-(working|busy|thinking)\b/.test(b) && (await msgs(owner)).user.some((t) => t.includes("again"));
  }, { timeout: 20000, every: 50 });
  const both = all(await replied(page, "again"), await replied(owner, "again"));
  const ma = await msgs(page), mo = await msgs(owner);
  await check("7 a second message: while the agent works both pages show the chat at work and the message, and both get the reply, none twice",
    all(working, both) === true && ma.user.length === 2 && mo.user.length === 2 && ma.assistant.length === 2 && mo.assistant.length === 2 && noneTwice(ma) && noneTwice(mo), `working: ${working}; A ${counts(ma)}; the owner ${counts(mo)}`);
  await waitFor("the second turn ends", async () => (await chatOn(B, id))?.status === "ready", { timeout: 30000 }).catch(() => {});

  // Anyone who has the chat open can answer and send: an ask of A's message is answered by the owner, then the owner sends.
  await send(page, '[[ask Bash {"command":"pwd"}]] third');
  const ownerCard = owner.locator(".thread .perm-actions button", { hasText: /^Allow$/ });
  const shown = await ownerCard.waitFor({ timeout: 40000 }).then(() => true, (e) => e.message.split("\n")[0]);
  if (shown === true) await ownerCard.click();
  const answered = all(await replied(page, "third"), await holds("the card on A's page is decided", async () => (await page.locator(".thread .perm-actions").count()) === 0 && (await page.locator(".thread .perm-done").allInnerTexts()).filter((t) => t === "Approved").length === 2));
  await check("7 a permission asked by the page's message is answered on the owner's page: the page's card is decided and its reply arrives", all(shown, answered), `the owner's card: ${shown}; ${one(await page.locator(".thread .perm-done").allInnerTexts())}`);
  await waitFor("the third turn ends", async () => (await chatOn(B, id))?.status === "ready", { timeout: 30000 }).catch(() => {});
  await send(owner, "from the owner");
  const fromOwner = all(await replied(page, "from the owner"), await replied(owner, "from the owner"));
  const m4 = await msgs(page);
  await check("7 the owner sends in the same chat: the page's thread grows by the message and its reply", fromOwner === true && m4.user.length === 4 && m4.assistant.length === 4 && noneTwice(m4), counts(m4));
  await waitFor("the fourth turn ends", async () => (await chatOn(B, id))?.status === "ready", { timeout: 30000 }).catch(() => {});

  // The draft: what A types is the chat's draft on B, the owner's composer gets it, and the row carries the mark once the chat is left.
  await box(page).click();
  await box(page).fill("a thought from A");
  const drafted = await holds("B has the text as the chat's draft", async () => (await draftOn(id)).text === "a thought from A");
  const mirrored = await holds("the owner's composer shows it", async () => (await boxText(owner)).trim() === "a thought from A");
  await rowOf(side(page), "chat", HERE).click();
  await rowOf(side(owner), "chat", OWNER_CHAT).click();
  const marked = await holds("both rows carry the draft mark", async () => (await outline(page, B.name)).includes(`  chat ${IN_GROUP} [draft]`) && (await outline(owner)).includes(`  chat ${IN_GROUP} [draft]`));
  await check("7 what the page types is the chat's draft on B, the owner's composer shows it, and the chat's row carries the draft mark on both pages", all(drafted, mirrored, marked), `${await bothTrees()}; B's draft ${one(await draftOn(id))}`);
  const kept = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("aiwb.draft.")).map((k) => `${k}=${localStorage.getItem(k)}`));
  await check("7 the browser's storage holds no draft of the section's chat", kept.every((k) => !k.includes(id) && !k.includes("a thought from A")), one(kept));

  // Two writers in one draft: B's answers to A are held back while A saves, the owner saves meanwhile, and A's save,
  // which names the counter A typed on, is refused as stale when it arrives. A is told, and its text is not replaced silently.
  await rowOf(section(), "chat", IN_GROUP).click();
  await rowOf(side(owner), "chat", IN_GROUP).click();
  await waitFor("both composers hold the draft", async () => (await boxText(page)).trim() === "a thought from A" && (await boxText(owner)).trim() === "a thought from A");
  const base = (await draftOn(id)).rev;
  const saves = callsFrom(page);
  const theirs = callsFrom(owner);
  const isSave = (c) => c.method === "PUT" && c.path.includes(`/chats/${id}/draft`);
  const p = B.proc.p;
  p.kill("SIGSTOP"); // B takes nothing for a moment: both saves wait at its door, each on the counter its page typed on
  let stale = null;
  try {
    await box(owner).click();
    await box(owner).fill("the owner's words");
    await waitFor("the owner's save is on its way", async () => theirs().some(isSave), { timeout: 10000 });
    await box(page).click();
    await box(page).fill("A's later words");
    await waitFor("A's save is on its way", async () => saves().some(isSave), { timeout: 10000 });
  } finally { p.kill("SIGCONT"); }
  stale = await holds("one of the two saves is refused as stale", async () =>
    [...saves(), ...theirs()].filter((c) => isSave(c) && c.status === 409 && c.code === "stale").length === 1, { timeout: 20000 });
  await sleep(2500); // the refused one saved its text again on the counter it was told, or took the other's
  const end = await draftOn(id), a = (await boxText(page)).trim(), o = (await boxText(owner)).trim();
  const whose = saves().some((c) => c.status === 409 && c.code === "stale") ? "A's page" : "the owner's page";
  const told = whose === "A's page" ? "A's later words" : "the owner's words"; // the one that was told saved its text again on the counter it was told: it was typed after the draft it was told of
  await check("7 two writers in one draft: the later save is refused as stale and told the stored draft, no text is lost without a word, and both pages end with the draft B has",
    stale === true && end.rev === base + 2 && end.text === told && a === end.text && o === end.text,
    `refused: ${stale === true ? whose : stale}; B's draft ${one(end)} (counter was ${base}); A's box "${a}"; the owner's box "${o}"`);
  await box(page).fill("");
  await holds("the draft is gone on B", async () => (await draftOn(id)).text === "", { timeout: 15000 });
}

/** What one page changes of a chat shows on the other with no reload: the choices of a chat that has not started,
 *  and a Stop while its agent works. Each way: the owner's change on the client's page, the client's on the owner's. */
async function step7b() {
  const key = await selected(page, "chat", () => plus(page, groupHead(section(), MY_GROUP), "Chat"));
  await box(page).waitFor();
  await renameChat(page, TWO);
  const id = own(key);
  await rowOf(side(owner), "chat", TWO).click();
  await box(owner).waitFor();
  const chip = (p, title) => p.locator(`.composer button.tchip[title^="${title}"]`);
  const label = async (p, title) => ((await chip(p, title).locator(".tchip-name").textContent().catch(() => "")) ?? "").trim();
  /** Picks, in a picker of a page's composer, the first option that is not the chat's, and answers its id. */
  const pickOther = async (p, title) => {
    await chip(p, title).click();
    const opt = p.locator(".composer .menu.up .menu-item.pick:not(.on):not([aria-disabled])").first();
    const picked = await opt.getAttribute("data-option-id");
    await opt.click();
    return picked;
  };
  await waitFor("both composers offer the effort", async () => !!(await label(page, "Effort")) && !!(await label(owner, "Effort")), { timeout: 20000 });
  const e0 = await label(page, "Effort");
  const effort = await pickOther(owner, "Effort");
  const eB = await holds("B's chat has the effort the owner picked", async () => (await chatOn(B, id))?.effort === effort);
  const eA = await holds("the page's composer shows the owner's pick", async () => { const a = await label(page, "Effort"); return !!a && a !== e0 && a === await label(owner, "Effort"); });
  await check("7 the owner picks another effort for a chat that has not started: the page's composer shows it with no reload", all(eB, eA), `effort ${effort}; the page's chip "${e0}" -> "${await label(page, "Effort")}"; the owner's "${await label(owner, "Effort")}"`);
  const m0 = await label(owner, "Model");
  const calls = callsFrom(page);
  const model = await pickOther(page, "Model");
  const mB = await holds("B's chat has the model the page picked", async () => (await chatOn(B, id))?.model === model);
  const mO = await holds("the owner's composer shows the page's pick", async () => { const o = await label(owner, "Model"); return !!o && o !== m0 && o === await label(page, "Model"); });
  const patch = calls().filter((c) => c.method !== "GET" && !/\/draft\b/.test(c.path));
  await check("7 the page picks another model for it: one call under the section's address, B has the model, and the owner's composer shows it with no reload",
    all(mB, mO) === true && patch.length === 1 && patch[0].method === "PATCH" && patch[0].path.startsWith(`/api/on/${ENTRY}/chats/${id}`),
    `model ${model}; the owner's chip "${m0}" -> "${await label(owner, "Model")}"; the page's "${await label(page, "Model")}"; calls ${one(patch.map((c) => `${c.method} ${c.path} ${c.status}`))}`);

  // A Stop made on the other page: the agent sleeps far longer than the check waits, so only the Stop ends the turn.
  const stopOf = (p) => p.locator(".composer button.send.stop");
  const atWork = (cls) => /\bst-(working|busy|thinking)\b/.test(cls ?? "");
  const works = (p, scope) => holds("the page shows the chat at work, with Stop", async () => (await stopOf(p).count()) === 1 && atWork(await rowOf(scope, "chat", TWO).getAttribute("class")), { timeout: 30000 });
  const rests = (p, scope) => holds("the page shows the chat stopped: no Stop, the row at rest", async () => (await stopOf(p).count()) === 0 && !atWork(await rowOf(scope, "chat", TWO).getAttribute("class")), { timeout: 20000 });
  await send(page, "[[sleep 120]] a long one");
  const w1 = all(await works(page, section()), await works(owner, side(owner)));
  let t = Date.now();
  if (w1 === true) await stopOf(owner).click();
  const s1 = all(await rests(page, section()), await holds("B's chat is at rest", async () => (await chatOn(B, id))?.status === "ready", { timeout: 20000 }));
  await check("7 the owner presses Stop while the page's message is being answered: the page's chat stops with no reload", all(w1, s1) === true && Date.now() - t < 60000, `at work on both: ${w1}; stopped: ${s1}; after ${Date.now() - t} ms`);
  await send(owner, "[[sleep 120]] the owner's long one");
  const w2 = all(await works(owner, side(owner)), await works(page, section()));
  const stops = callsFrom(page);
  t = Date.now();
  if (w2 === true) await stopOf(page).click();
  const s2 = all(await rests(owner, side(owner)), await holds("B's chat is at rest", async () => (await chatOn(B, id))?.status === "ready", { timeout: 20000 }));
  const call = stops().filter((c) => c.method !== "GET" && !/\/draft\b/.test(c.path)).map((c) => `${c.method} ${c.path.split("?")[0]} ${c.status}`);
  await check("7 the page presses Stop while the owner's message is being answered: one call under the section's address, and the owner's page stops with no reload",
    all(w2, s2) === true && Date.now() - t < 60000 && one(call) === one([`POST /api/on/${ENTRY}/chats/${id}/interrupt 200`]), `at work on both: ${w2}; stopped: ${s2}; after ${Date.now() - t} ms; calls ${one(call)}`);
  await rowOf(side(page), "chat", HERE).click();
  await rowOf(side(owner), "chat", OWNER_CHAT).click();
}

/** The section while B is not connected: the state's words, the one line, no row and no "+". */
const awayLook = (state = "Unreachable") => holds(`the section says "${state}" and the one line, with no row`, async () => {
  const l = await sectionLook();
  return !!l && l.state === state && l.tone === "bad" && l.rows === 0 && !l.add && one(l.lines) === one([ONE_LINE]);
}, { timeout: 30000 });

async function step8() {
  const id = own(chatGroup);
  await rowOf(section(), "chat", IN_GROUP).click();
  await page.locator(".thread .msg.assistant").first().waitFor();
  await rowOf(side(owner), "chat", OWNER_CHAT).click(); // the owner is elsewhere: its composer saves nothing into this chat
  const thread = await msgs(page);
  // Text that is typed and not yet taken by B: nothing passes the link while it is typed, then the link is pulled.
  const typed = "typed just before the drop";
  const saves = callsFrom(page);
  setLink("stall");
  await box(page).click();
  await box(page).fill(typed);
  await waitFor("the save of the typed text is on its way", async () => saves().some((c) => c.method === "PUT" && c.path.includes("/draft")), { timeout: 10000 });
  setLink("cut");
  const bar = page.locator(".thread .remote-bar.off .remote-bar-text");
  const warned = await holds("the warning names B", async () => (await bar.innerText().catch(() => "")) === `${AWAY}. This chat is shown as it was when the connection ended.`, { timeout: 30000 });
  const m = await msgs(page);
  await check("8 the link is pulled with the chat open: the thread stays on screen as it was, under a warning that names the server", warned === true && one(m) === one(thread), `bar "${await bar.innerText().catch(() => "none")}"; ${counts(m)} (was ${counts(thread)})`);
  await check("8 the section says that B is not connected and the one line; no row is left, the open chat's neither", await awayLook(), one(await sectionLook()));
  await shot("not-connected-with-a-chat-open", page, true);
  const sendBtn = page.locator(".composer button.send:not(.stop)");
  const why = { disabled: await sendBtn.isDisabled(), title: await sendBtn.getAttribute("title"), line: (await page.locator(".composer .agent-reason").allInnerTexts()).join(" / "), choices: await page.locator(".composer button.tchip:not(.static):not([disabled])").count() };
  await check("8 nothing can be sent or changed, and the composer says why: Send is off with the reason, the line under the toolbar says it, and no choice is a choice",
    why.disabled === true && why.title === WHY && why.line === WHY && why.choices === 0, one(why));
  // Read-only: the box keeps what was typed and takes no more.
  const during = callsFrom(page);
  await box(page).click({ force: true }).catch(() => {});
  await page.keyboard.press("End");
  await page.keyboard.type(" and more");
  await page.keyboard.press("Enter");
  await sleep(800);
  const kept = (await boxText(page)).trim();
  const tried = during().filter((c) => c.method !== "GET");
  const ro = await box(page).getAttribute("aria-readonly");
  await check("8 the text typed before the drop stays in the box; the box is read-only and takes no more, and no call is made for it", kept === typed && ro === "true" && tried.length === 0 && (await msgs(page)).user.length === thread.user.length,
    `box "${kept}"; aria-readonly ${ro}; calls during the outage ${one(tried.map((c) => `${c.method} ${c.path} ${c.status}`))}`);
  await check("8 B has none of the typed text yet", (await draftOn(id)).text === "", `B's draft ${one(await draftOn(id))}`);

  // Meanwhile on B: the owner sends in that chat, and makes another one.
  await rowOf(side(owner), "chat", IN_GROUP).click();
  await send(owner, "while A was away");
  await replied(owner, "while A was away");
  await waitFor("its turn ends", async () => (await chatOn(B, id))?.status === "ready", { timeout: 30000 }).catch(() => {});
  await rowOf(side(owner), "chat", OWNER_CHAT).click();
  await selected(owner, "chat", async () => { await owner.click("button.icon-btn.new"); await menuItem(owner, "New chat").click(); });
  await box(owner).waitFor();
  await renameChat(owner, "Made meanwhile");
  await rowOf(side(owner), "chat", OWNER_CHAT).click();

  // Back: the section's tree as it is now, the open chat level with B, the warning gone, the composer at work, the typed text saved.
  setLink("pass");
  const tree = await holds("the section shows B's tree as it is now", async () => (await sectionLook())?.state === "Connected" && (await outline(page, B.name)).includes("chat Made meanwhile"), { timeout: 60000 });
  await check("8 B is back: the section shows the tree as it is now, with what was made there meanwhile", all(tree, await sameTree()), await bothTrees());
  const level = await holds("the open chat has what was sent there meanwhile, and no warning", async () => (await msgs(page)).user.some((t) => t.includes("while A was away")) && (await page.locator(".thread .remote-bar").count()) === 0, { timeout: 30000 });
  const m2 = await msgs(page);
  await check("8 the open chat is brought level with B and the warning goes", level === true && m2.user.length === thread.user.length + 1 && noneTwice(m2), `${counts(m2)}; bar ${await page.locator(".thread .remote-bar").count()}`);
  const saved = await holds("B has the typed text as the chat's draft", async () => (await draftOn(id)).text === typed, { timeout: 30000 });
  const editable = await holds("the box takes text again", async () => (await box(page).getAttribute("aria-readonly")) !== "true");
  await check("8 the text that was typed is saved on B once it is back, is still in the box, and the box takes text again", all(saved, editable) === true && (await boxText(page)).trim() === typed, `B's draft ${one(await draftOn(id))}; box "${(await boxText(page)).trim()}"`);
  await box(page).press("Enter");
  const works = await replied(page, typed);
  await check("8 the composer works again: the text is sent and answered", works, counts(await msgs(page)));
  await waitFor("its turn ends", async () => (await chatOn(B, id))?.status === "ready", { timeout: 30000 }).catch(() => {});

  // Left during an outage, the chat cannot be opened again; a reload during the outage knows nothing of B.
  setLink("cut");
  await bar.waitFor({ timeout: 30000 });
  await rowOf(side(page), "chat", HERE).click();
  const left = await holds("the chat of this computer is on screen and nothing of B", async () => (await sel(page)).chat === chat0 && (await page.locator(".thread .remote-bar, .chat-head-server").count()) === 0);
  const look = await sectionLook();
  await shot("not-connected", page);
  await check("8 the chat is left during an outage: it is closed, the section has no row to open it from, and the selection names nothing of B", left === true && look.rows === 0 && !one(await sel(page)).includes(ENTRY), `${one(look)}; selection ${one(await sel(page))}`);
  await page.reload();
  await page.waitForSelector("#root .side-tree");
  const blank = await awayLook();
  const st = await stateOf(A);
  await check("8 a reload of the page during the outage: nothing of B is known, the section says so, and A's snapshot has no tree of it", blank === true && !st.sections?.[ENTRY] && (await page.locator(".thread .remote-bar, .chat-head-server").count()) === 0,
    `${one(await sectionLook())}; sections in A's snapshot ${one(Object.keys(st.sections ?? {}))}`);
  setLink("pass");
  const again = await holds("the section has its rows again", async () => (await sectionLook())?.state === "Connected" && (await outline(page, B.name)).includes(`  chat ${IN_GROUP}`), { timeout: 60000 });
  await rowOf(section(), "chat", IN_GROUP).click();
  const opens = await holds("the chat opens with its thread", async () => (await msgs(page)).user.length === thread.user.length + 2 && (await page.locator(".thread .remote-bar").count()) === 0, { timeout: 30000 });
  await check("8 B is back: the chat is in the section again and opens as usual", all(again, opens), counts(await msgs(page)));

  // A reload during an outage with a chat of B selected: the chat that was open is closed.
  setLink("cut");
  await bar.waitFor({ timeout: 30000 });
  await page.reload();
  await page.waitForSelector("#root .side-tree");
  await awayLook();
  const closed = (await page.locator(".thread .msg, .thread .remote-bar, .chat-head-server").count()) === 0;
  await check("8 a reload during an outage with a chat of B open: the chat is closed, and nothing of it is on screen", closed, `selection ${one(await sel(page))}; main: ${(await page.locator("main").first().innerText().catch(() => "")).slice(0, 120)}`);
  setLink("pass");
  await waitFor("the section has its rows again", async () => (await sectionLook())?.state === "Connected" && (await outline(page, B.name)).includes(`  chat ${IN_GROUP}`), { timeout: 60000 });

  // Deleted on B during an outage: back, the view says that the chat is no longer on that server.
  const reads = callsFrom(page);
  await rowOf(section(), "chat", "Made meanwhile").click();
  await box(page).waitFor();
  await page.locator(".chat-head-server").waitFor();
  await waitFor("the chat's thread is read", async () => reads().some((c) => c.method === "GET" && /\/items\?/.test(c.path) && c.status === 200));
  setLink("cut");
  await bar.waitFor({ timeout: 30000 });
  await more(owner, rowOf(side(owner), "chat", "Made meanwhile"), "Delete");
  await dialogDo(owner, "Delete");
  await waitFor("B no longer has the chat", async () => !(await stateOf(B)).chats.some((c) => c.name === "Made meanwhile"));
  setLink("pass");
  const gone = page.locator(".remote-bar.gone .remote-bar-text, .remote-off.gone .remote-off-text");
  const says = await holds("the view says that the chat is no longer on B", async () => (await gone.first().innerText().catch(() => "")) === `This chat is no longer on ${B.name}.`, { timeout: 60000 });
  const row = await rowOf(section(), "chat", "Made meanwhile").count();
  await check("8 a chat deleted on B during the outage: back, its view says that it is no longer on that server, Send stays off, and no row is left for it",
    says === true && row === 0 && (await page.locator(".composer button.send:not(.stop)").isDisabled().catch(() => true)), `"${await gone.first().innerText().catch(() => "none")}"; rows ${row}`);
  await shot("a-chat-that-is-no-longer-on-its-server", page, true);
  await rowOf(side(page), "chat", HERE).click();
}

/** "Test connection" of B's row in the Servers dialog, which makes an entry that waits for the user look again.
 *  true when the row then says `words` of the entry, else what it says. */
async function testEntry(words) {
  await page.locator("button.servers-btn").click();
  const dlg = page.locator(".servers-dialog");
  const row = dlg.locator(".servers-row").filter({ has: page.locator(".servers-name", { hasText: exact(B.name) }) });
  const said = () => row.locator(".servers-state").innerText().catch(() => "");
  await row.locator("button", { hasText: /^Test connection$/ }).click();
  const ok = await holds(`the row says "${words}"`, async () => (await said()).split(": ")[0] === words, { timeout: 60000 });
  const seen = await said();
  await dlg.locator("button", { hasText: /^Close$/ }).click();
  await dlg.waitFor({ state: "detached" });
  return ok === true ? true : `the row says "${seen}"`;
}

async function step9() {
  // B's own process stops: the same section, and B's own word in the list.
  await rowOf(section(), "chat", IN_GROUP).click();
  await page.locator(".thread .msg.assistant").first().waitFor();
  const before = await census();
  await owner.context().close();
  owner = null;
  await stop(B);
  await check("9 B's process stops: the section says that B is not connected and the one line, with no row", await awayLook(), one(await sectionLook()));
  const kept = (await page.locator(".thread .msg").count()) > 0 && (await page.locator(".thread .remote-bar.off").count()) === 1;
  await check("9 the open chat stays on screen under the warning", kept, `messages ${await page.locator(".thread .msg").count()}; bars ${await page.locator(".thread .remote-bar.off").count()}`);

  // A's own server restarts during the outage: it kept nothing of B, and the page that reloads knows nothing of B.
  await stop(A);
  const files = fs.readdirSync(A.home, { recursive: true }).map(String).filter((f) => !/^(servers|state|settings|server\.log|chats\/|library|instance|version)/.test(f));
  const named = fs.readdirSync(A.home, { recursive: true }).map(String).filter((f) => f.includes(own(chatGroup)) || f.includes(own(boardKey)) || /^remote\b/.test(f));
  await start(A);
  await page.reload();
  await page.waitForSelector("#root .side-tree");
  const blank = await awayLook();
  const st = await stateOf(A);
  await check("9 A's server restarts during the outage: its data folder has no file of a chat or a board of B, its snapshot has no tree of B, and the page shows the section with no row",
    blank === true && named.length === 0 && !st.sections?.[ENTRY] && [...st.chats, ...st.boards].every((x) => !("server" in x)) && (await page.locator(".thread .msg, .chat-head-server").count()) === 0,
    `${one(await sectionLook())}; files that name a thing of B ${one(named)}; other files ${one(files.slice(0, 12))}`);

  // A server that is too old: a stand-in with B's certificate that reports level 4 and a version.
  const old = https.createServer({ key: fs.readFileSync(path.join(B.home, "remote-key.pem")), cert: fs.readFileSync(path.join(B.home, "remote-cert.pem")) }, (req, res) => {
    const hello = req.url.startsWith("/api/hello");
    res.writeHead(hello ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(hello ? { app: "ai-whiteboard", version: "0.4.0-old", instanceId: B.instance, featureLevel: 4 } : { error: "not found" }));
  });
  const oldPort = await freePort();
  await new Promise((resolve) => old.listen(oldPort, "127.0.0.1", resolve));
  link.target = oldPort;
  const tooOld = await holds("the section says that the server is too old, with its version", async () => {
    const l = await sectionLook();
    return l.state === "Too old" && l.tone === "bad" && l.rows === 0 && !l.add && one(l.lines) === one(["Update the server on that machine.", "Version 0.4.0-old"]);
  }, { timeout: 60000 });
  await check("9 a server below the level: the section says that it is too old and must be updated on that machine, with the version it reports, and shows nothing else", tooOld, one(await sectionLook()));
  await shot("too-old", page);

  // Every other state of the list that what answers behind the address can bring about, each with a stand-in there:
  // the section says the words the Servers dialog has for the entry and the one line, and shows nothing else. An
  // entry in one of these states waits for the user: "Test connection" of its row makes it look again.
  const tls = { key: fs.readFileSync(path.join(B.home, "remote-key.pem")), cert: fs.readFileSync(path.join(B.home, "remote-cert.pem")) };
  const elsewhere = path.join(OUT, "c", "home"); // a certificate that is not B's: of a set-up of its own
  execFileSync(BIN, ["remote", "setup", "-home", elsewhere, "-server-port", String(await freePort()), "-port", String(await freePort()), "-name", "127.0.0.1"], { env: envOf(B), stdio: "ignore" });
  const json = (status, o) => [status, "application/json", JSON.stringify(o)];
  const STATES = [
    ["Secret not accepted", tls, () => json(401, { error: "unauthorized" })],
    ["Not an AI Whiteboard server", tls, () => [200, "text/html", "<html><body>It works!</body></html>"]],
    ["Another server", tls, (req) => (req.url.startsWith("/api/hello") ? json(200, { app: "ai-whiteboard", version: "9.9.9", instanceId: "0b9f4a52-6c1d-4e8a-9f3b-2d7c5a1e8f60", featureLevel: 5 }) : json(404, { error: "not found" }))],
    ["Name not known there", tls, () => json(403, { error: "bad host" })],
    ["Certificate changed", { key: fs.readFileSync(path.join(elsewhere, "remote-key.pem")), cert: fs.readFileSync(path.join(elsewhere, "remote-cert.pem")) }, () => json(401, { error: "unauthorized" })],
  ];
  for (const [words, tlsOf, answer] of STATES) {
    const srv = https.createServer(tlsOf, (req, res) => { const [status, type, body] = answer(req); res.writeHead(status, { "Content-Type": type }); res.end(body); });
    const port = await freePort();
    await new Promise((resolve) => srv.listen(port, "127.0.0.1", resolve));
    setLink("cut"); // no connection to what stood there before is left
    link.target = port;
    setLink("pass");
    const listed = await testEntry(words);
    const look = await awayLook(words);
    await check(`9 "${words}": the section says the words the Servers dialog has for the entry and the one line, and shows nothing else`, all(listed, look), `the dialog: ${listed}; ${one(await sectionLook())}`);
    await shot(words.toLowerCase().replace(/[^a-z]+/g, "-"), page);
    await new Promise((resolve) => { srv.closeAllConnections?.(); srv.close(resolve); });
  }
  // Updated: the real B is behind the address again, and the entry connects by itself.
  await start(B);
  setLink("cut");
  link.target = B.remotePort;
  setLink("pass");
  await new Promise((resolve) => { old.closeAllConnections?.(); old.close(resolve); });
  // An entry that saw another certificate waits for the user: with B's own certificate behind the address again, a
  // test of the entry leaves it as it is (its row offers the fingerprint to accept). A's server is started again, as
  // the app is: the entry then connects by itself.
  const waits = await testEntry("Certificate changed");
  await check('9 B\'s own certificate is behind the address again: the entry that saw another one still says "Certificate changed" after a test, and its section with it', all(waits, await awayLook("Certificate changed")), `the dialog: ${waits}; ${one(await sectionLook())}`);
  await stop(A);
  await start(A);
  await page.reload();
  await page.waitForSelector("#root .side-tree");
  const back = await holds("the section shows B's tree again", async () => (await sectionLook())?.state === "Connected" && (await outline(page, B.name)).includes(`  chat ${IN_GROUP}`), { timeout: 90000 });
  const after = await census();
  await check("9 the updated server is behind the address again: the entry connects by itself, and the section shows B's tree as it is", back === true && one(before) === one(after), `${one(await sectionLook())}; B had ${one(before)}, has ${one(after)}`);
  await rowOf(section(), "chat", IN_GROUP).click();
  const opens = await holds("the chat opens with its thread and no warning", async () => (await page.locator(".thread .msg.assistant").count()) > 0 && (await page.locator(".thread .remote-bar").count()) === 0 && !(await page.locator(".composer button.send:not(.stop)").getAttribute("title"))?.includes("not connected"), { timeout: 30000 });
  await check("9 a chat of the section opens as usual again", opens, `messages ${await page.locator(".thread .msg").count()}; bars ${await page.locator(".thread .remote-bar").count()}`);
  owner = await openPage(B);
}

/** Calls whose answers do not arrive: B takes them, and what it answers is held back by the link. */
async function stepLost() {
  const up = await connected();
  if (up !== true) await check("M A is connected to B", up);
  // A make: B makes the chat and A never hears the answer. The page says that B did not answer; nothing is cleaned up.
  const had = new Set((await stateOf(B)).chats.map((c) => c.id));
  setLink("mute");
  const t0 = Date.now();
  await plus(page, section().locator(".side-section-head"), "Chat");
  const dlg = page.locator(".dialog");
  const said = await holds("the page says that the chat could not be started", async () => (await dlg.innerText().catch(() => "")).includes("Couldn't start the chat"), { timeout: 60000, every: 250 });
  const text = (await dlg.innerText().catch(() => "")).replace(/\n/g, " / ");
  const made = (await stateOf(B)).chats.filter((c) => !had.has(c.id));
  await check("M a make whose answer is lost: the page says that B did not answer, with B's name", said === true && text.includes(`${B.name} did not answer.`) && made.length === 1, `after ${Math.round((Date.now() - t0) / 1000)} s: "${text}"; made on B: ${made.length}`);
  await page.keyboard.press("Escape");
  await dlg.waitFor({ state: "detached" }).catch(() => {});
  setLink("pass");
  const shows = await holds("the chat that was made shows in the section", async () => (await connected(1000)) === true && (await stateOf(A)).sections?.[ENTRY]?.chats.some((c) => c.id === made[0]?.id) && (await section().locator(".side-row.is-chat").count()) === (await stateOf(B)).chats.filter((c) => !c.board && !c.run && !c.archived).length, { timeout: 60000 });
  await sleep(3000);
  const still = (await stateOf(B)).chats.some((c) => c.id === made[0]?.id);
  await check("M the answers flow again: the chat that was made shows in the section like any other, and nothing deletes it", all(shows, still || "B no longer has the chat"), `on B: ${still}`);
}

async function step10() {
  // A chat of B is on screen when its entry is removed.
  await waitFor("the section has its rows", async () => (await sectionLook())?.state === "Connected" && (await rowOf(section(), "chat", IN_GROUP).count()) === 1, { timeout: 60000 });
  await rowOf(section(), "chat", IN_GROUP).click();
  await page.locator(".thread .msg.assistant").first().waitFor({ timeout: 20000 });
  const before = await census();
  await page.locator("button.servers-btn").click();
  const dlg = page.locator(".servers-dialog");
  const row = dlg.locator(".servers-row").filter({ has: page.locator(".servers-name", { hasText: exact(B.name) }) });
  await row.locator("button", { hasText: /^Remove$/ }).click();
  const ask = page.locator(".dialog").filter({ has: page.locator(".dialog-title", { hasText: /^Remove server$/ }) });
  const body = await ask.locator(".dialog-body").innerText();
  await check("10 the question before the removal says that everything stays on that server, and counts nothing",
    body.includes(`"${B.name}"`) && /stay there/.test(body) && /Nothing is deleted or stopped on that server/.test(body) && !/\d/.test(body.replace(B.name, "")), body);
  await ask.locator("button", { hasText: /^Remove$/ }).click();
  const removed = await holds("the entry is gone", async () => (await entry()) === null && (await row.count()) === 0, { timeout: 15000 });
  await dlg.locator("button", { hasText: /^Close$/ }).click();
  await dlg.waitFor({ state: "detached" });
  const gone = await holds("the section is gone", async () => (await page.locator(".side-section").count()) === 0, { timeout: 15000 });
  const st = await stateOf(A);
  await check("10 the entry is removed: its section leaves the sidebar, and A's snapshot has no tree of it", all(removed, gone) === true && Object.keys(st.sections ?? {}).length === 0, `sections on the page ${await page.locator(".side-section").count()}; in A's snapshot ${one(Object.keys(st.sections ?? {}))}`);
  const shut = await holds("the chat of B that was open is closed", async () => (await page.locator(".thread, .chat-head-server, .composer").count()) === 0 && !one(await sel(page)).includes(ENTRY), { timeout: 10000 });
  await check("10 the chat of that server that was open is closed with it: a removed entry is no outage, and nothing of it stays on screen", shut, `selection ${one(await sel(page))}; main: ${(await page.locator("main").first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 100)}`);
  await sleep(1500);
  const after = await census();
  await check("10 B still has everything: its groups, boards and chats", one(before) === one(after) && after.chats > 0, `before ${one(before)}; after ${one(after)}`);
  const local = await outline(page);
  await check("10 the local part is as it was", one(local) === one([`chat ${HERE}`, `group ${LOCAL_GROUP}`]) && (await stored(page, "aiwb.collapsed")) === "[]", `${lines(local)}; stored collapse ${await stored(page, "aiwb.collapsed")}`);
  const kept = await page.evaluate((entry) => Object.keys(localStorage).filter((k) => (localStorage.getItem(k) ?? "").includes(entry) || k.includes(entry)), ENTRY);
  await check("10 the browser's storage holds nothing of B", kept.length === 0, one(kept));
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
  await step("1 the sidebar alone; add B; an empty section", step1);
  if (!ENTRY) throw new Error("B was not added to A's server list: nothing else can be shown");
  await step("2 the owner's things", step2);
  await step("3 making from the section", step3);
  await step("4 groups", step4);
  await step("5 moving and dragging", step5);
  await step("6 collapse and Show archived", step6);
  await step("6 more entries, which never connect", step6b);
  await step("7 a chat with two pages", step7);
  if (B.proc) B.proc.p.kill("SIGCONT");
  await step("7 the other page's settings and Stop", step7b);
  if (B.proc) B.proc.p.kill("SIGCONT");
  await step("8 the link is pulled", step8);
  setLink("pass");
  await step("9 stopped, connecting, too old", step9);
  link.target = B.remotePort;
  setLink("pass");
  if (!B.proc) await start(B).catch(() => {});
  if (!owner) owner = await openPage(B).catch(() => null);
  await step("M answers that are lost", stepLost);
  setLink("pass");
  await step("10 remove the entry", step10);
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
