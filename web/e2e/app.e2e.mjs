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
// Stop any running AI Whiteboard app first: the default run needs port 6006 exclusively for the
// real-Cursor MCP steps (Cursor's org allowlist approves only http://localhost:6006/mcp). If 6006
// is taken, the run fails fast with an explicit message instead of timing out.
//
// Environment (all optional):
//   AIWB_E2E_BIN     server binary        (default bin/ai-whiteboard)
//   AIWB_E2E_CLIENT  built web client     (default web/dist)
//   AIWB_E2E_HOME    data folder          (default a new temp folder)
//   AIWB_E2E_PORT    app port             (default 4749)
//   AIWB_E2E_SKIP_CURSOR_MCP=1  skip the real-Cursor-over-MCP steps (reported as skipped, never
//                               silently dropped) and start the app on the hidden test-only MCP
//                               port override, so a normal app instance may keep 6006.
//   AIWB_E2E_STEPS   run only these steps, e.g. "18,19,19b"; the others are reported as skipped.
//                    Step 1 always runs: it starts the server. Steps 18, 19 and 19b need nothing
//                    an earlier step made; most other steps do.
//
// The run gives the server and Cursor a copy of the Cursor CLI config ($CURSOR_CONFIG_DIR or
// ~/.cursor) in a temp folder, removed at the end, so the deny rules the server adds for the data
// folder never reach the user's config.
//
// Subagents on app chats go through the MCP spawn family (`spawn_subagent` / `stop_subagent`), not
// native Agent / Task / subagent; their results reach the agent as a message from the app. Steps
// 18, 19 and 19b drive that path on plain Claude and plain Cursor. Two scenarios, kept apart
// because a stopped subagent never sends a result:
//   delivery            the agent ends its turn while its subagents run; each result comes as a
//                       row and starts a turn of the agent's (step 18 on Claude, 19b on Cursor)
//   Stop while waiting  Stop on an idle chat stops its subagents and starts no turn (the closing
//                       part of step 18 on Claude, step 19 on Cursor)
// pi chats are created from the same "New chat" menu ("Pi chat") and use the same composer, so
// they would follow the Claude/Cursor steps below; no pi step is wired into this paid run yet. The
// adapter's own cheap, gated real-pi checks run separately, the two scenarios among them
// (TestE2ESubagentDelivery, which also needs AIWB_PI_E2E_SUBAGENT=1):
//   AIWB_PI_E2E=1 go test -count=1 -run TestE2E ./internal/pi/
// This full Playwright run stays manual.
//
// Step 15 (Reveal in Finder) is checked by hand, not here. Exit code 0 only when every step passed.

import { chromium } from "playwright";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
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
// Step 18's long-running subagent loops in a shell until this file exists; the run makes it once
// the Stop part is over, and again at the end, so a loop that outlived a failed run ends by itself.
const STOP_GATE = path.join(WORK, "stop-while-waiting-gate");
const openStopGate = () => { try { fs.writeFileSync(STOP_GATE, ""); } catch { /* the folder is gone */ } };

// The copy of the user's Cursor CLI config; every process the run starts inherits it.
const CURSOR_CFG = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-e2e-cursor-"));
{
  const real = path.join(process.env.CURSOR_CONFIG_DIR || path.join(os.homedir(), ".cursor"), "cli-config.json");
  if (fs.existsSync(real)) fs.copyFileSync(real, path.join(CURSOR_CFG, "cli-config.json"));
  process.env.CURSOR_CONFIG_DIR = CURSOR_CFG;
}

const CLAUDE_MODEL_ID = "haiku"; // Claude models are picked by id; the label comes from the server's catalog
const CURSOR_MODEL_LABEL = "GPT-5.4 Nano"; // the cheapest model in Cursor's list
const TURN_TIMEOUT = 300_000;
const NUNITO = 6; // FONT_FAMILY.Nunito, Excalidraw's normal font

// The fixed, org-policy-approved MCP URL. Cursor's org allowlist matches it exactly, so the
// default run needs exclusive 6006 (plan D1/D3/D14).
const MCP_PORT = 6006;
const SKIP_CURSOR_MCP = process.env.AIWB_E2E_SKIP_CURSOR_MCP === "1";
// In skip mode the app uses the hidden test-only MCP port override; a normal app instance may keep 6006.
// The default run must use the approved 6006, so an inherited override is dropped rather than letting
// the environment move the app off the policy-approved URL.
if (SKIP_CURSOR_MCP) process.env.AIWB_MCP_PORT = "0";
else delete process.env.AIWB_MCP_PORT;
// The adapter's redacted ACP trace (the cursor adapter writes it when AIWB_CURSOR_ACP_LOG is
// set). It holds only methods and the first prompt text; step 7 reads it. It is enabled only for
// the real-Cursor MCP steps, and removed at the end of the run. In skip mode an inherited value
// must go too, so the run never writes a trace it does not read.
const ACP_LOG = path.join(OUT, "cursor-acp.log");
if (!SKIP_CURSOR_MCP) process.env.AIWB_CURSOR_ACP_LOG = ACP_LOG;
else delete process.env.AIWB_CURSOR_ACP_LOG;
// Cursor's own debug log, where an MCP load failure or a team-policy block would appear (A.2/A.3).
const CURSOR_DEBUG_LOG = path.join(os.tmpdir(), `cursor-agent-logs-${process.getuid?.() ?? "0"}`, "latest.log");

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

// AIWB_E2E_STEPS: the steps to run, null for all of them.
const ONLY = process.env.AIWB_E2E_STEPS ? new Set(process.env.AIWB_E2E_STEPS.split(",").map((x) => x.trim()).filter(Boolean)) : null;

async function step(n, title, fn) {
  if (ONLY && n !== 1 && !ONLY.has(String(n))) return skipStep(n, title, "not in AIWB_E2E_STEPS");
  current = `${n}. ${title}`;
  log(`\n== Step ${current}`);
  await fn();
}

/** Reports a step as skipped (never silently dropped) and continues. */
async function skipStep(n, title, reason) {
  current = `${n}. ${title}`;
  log(`\n== Step ${current}`);
  log(`    SKIPPED: ${reason}`);
}

// ---------------------------------------------------------------- server

let server = null;
let serverEnv = process.env;

function serverArgs() { return ["-home", HOME, "-port", String(PORT), "-client", CLIENT]; }

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

const readIfExists = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
const shortId = (id) => id.slice(0, 8);

/**
 * Binds exactly 127.0.0.1:6006 and releases it. The default e2e run needs that port exclusively
 * for the real-Cursor MCP steps; a wildcard bind would not be authoritative (the listener and
 * Cursor both use 127.0.0.1 via the localhost spelling).
 */
function acquireMcpPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen({ host: "127.0.0.1", port: MCP_PORT, exclusive: true }, () => srv.close(() => resolve()));
  });
}

/** The first ACP session/prompt text sent to Cursor, from the adapter's redacted trace. */
function firstCursorPrompt(logText) {
  for (const line of logText.split("\n")) {
    if (!line.startsWith("-> ")) continue;
    let m;
    try { m = JSON.parse(line.slice(3)); } catch { continue; }
    if (m.method !== "session/prompt") continue;
    return (m.params?.prompt ?? []).map((b) => b.text ?? "").join("\n");
  }
  return "";
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

// ---------------------------------------------------------------- subagents

const chatSubs = async (id) => (await get(`/api/chats/${id}/items`)).subagents;
const resultItems = (items) => items.filter((i) => i.kind === "subresult");
const stoppedNotes = (items) => items.filter((i) => i.kind === "note" && i.text === "Stopped.").length;
const sinceLastUser = (items) => items.slice(items.map((i) => i.kind).lastIndexOf("user") + 1);

/**
 * The agent's own tool calls that wait for a subagent: a sleep, or the removed wait_subagents. An
 * agent that does not end its turn after spawning runs these. A spawn_subagent call may name a
 * sleep in the task it hands over.
 */
function waitingCalls(items) {
  return items.filter((i) => i.kind === "tool" && !/__(spawn|stop)_subagent$/.test(i.name ?? "")
    && /\bsleep\b|wait_subagents/i.test(`${i.name ?? ""} ${JSON.stringify(i.input ?? "")} ${i.partial ?? ""}`))
    .map((i) => ({ name: i.name, input: i.input ?? i.partial }));
}

/** Reads a chat's view in the background and keeps every change of its turn count, status and subagent counts. */
function watchChat(id, every = 100) {
  const seen = [];
  let on = true;
  const done = (async () => {
    while (on) {
      try {
        const v = await chatView(id);
        const e = { turns: v.usage?.turns ?? 0, status: v.status, running: v.subsRunning ?? 0, owed: v.subsOwed ?? 0 };
        const last = seen.at(-1);
        if (!last || last.turns !== e.turns || last.status !== e.status || last.running !== e.running || last.owed !== e.owed) seen.push(e);
      } catch { /* the server is restarting */ }
      await sleep(every);
    }
  })();
  return { seen, stop: async () => { on = false; await done; } };
}

/**
 * The delivery checks, on a chat whose agent was asked (in the turn after `before` turns) to spawn
 * `n` subagents and use their results: its turn ended while they still ran; each result came as a
 * row and reached the agent; the agent ran at least two turns and waited in none of them; its last
 * turn's text uses the reports (`uses`). `watch` has read the chat since before the message.
 */
async function checkDelivery(page, id, before, n, watch, uses) {
  const rowTexts = await waitFor(`${n} result rows say "sent to the agent"`, async () => {
    const now = (await page.locator(".thread .sub-result").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
    return now.length === n && now.every((t) => /sent to the agent$/.test(t)) ? now : saw(now);
  }, { timeout: TURN_TIMEOUT });
  log(`    result rows: ${rowTexts.join(" | ")}`);
  const view = await waitFor("every result has reached the agent and its last turn has ended", async () => {
    const v = await chatView(id);
    const subs = await chatSubs(id);
    const ok = !BUSY.has(v.status) && !v.subsRunning && !v.subsOwed && subs.length === n && subs.every((x) => x.delivery === "sent") && (v.usage?.turns ?? 0) >= before + 2;
    return ok ? v : saw({ status: v.status, turns: v.usage?.turns, subsRunning: v.subsRunning, subsOwed: v.subsOwed, subs: subs.map((x) => [x.id, x.status, x.delivery]) });
  }, { timeout: TURN_TIMEOUT, every: 500 });
  await watch.stop();
  log(`    the chat, change by change: ${watch.seen.map((e) => `${e.turns}/${e.status}/${e.running}/${e.owed}`).join(" ")} (turns/status/running/unsent)`);
  check(watch.seen.some((e) => e.turns > before && e.status === "ready" && e.running > 0),
    "the agent's first turn ended while its subagents were still running (chat ready, subagents running)", watch.seen);
  const items = await chatItems(id);
  const subs = await chatSubs(id);
  const results = resultItems(items).map((i) => i.subagent).sort();
  check(show(results) === show(subs.map((x) => x.id).sort()), "the thread has one result row per subagent", { results, subs: subs.map((x) => x.id) });
  check(view.usage.turns >= before + 2, `the agent ran at least two turns (${view.usage.turns - before})`, view.usage);
  const mine = sinceLastUser(items);
  check(waitingCalls(mine).length === 0, "the agent ran no sleep or polling command between its turns", waitingCalls(mine));
  const last = mine.slice(mine.map((i) => i.kind).lastIndexOf("subresult") + 1).filter((i) => i.kind === "text").map((i) => i.text ?? "").join("\n").trim();
  check(uses(last), "the agent's last turn uses the subagents' reports", last);
  log(`    last turn: ${last.replace(/\s+/g, " ").slice(0, 200)}`);
}

/**
 * Stop while a chat only waits on its subagents, and what must hold afterwards. The agent was
 * asked (in the turn after `before` turns) to spawn `n` long-running subagents. First the agent's
 * turn has ended and the chat is idle with them running, and the composer shows Stop. After Stop:
 * `rowsStopped(when)` (the caller's check of its rows), exactly one "Stopped." note, the server
 * has them stopped, and their processes have ended, with whatever they started and no other
 * process of the server's. Then no result row appears and the agent's turn count does not grow;
 * the same after a reload; and a message of the user's gets a normal reply. A turn that starts by
 * itself, or a second note, would be the agent's process answering a Stop that met no turn.
 */
async function stopWhileWaiting(page, id, before, n, rowsStopped) {
  const idle = await waitFor(`the agent's turn has ended and the chat is idle with ${n} subagent${n === 1 ? "" : "s"} running`, async () => {
    const v = await chatView(id);
    return (v.usage?.turns ?? 0) > before && v.status === "ready" && v.subsRunning === n ? v : saw({ turns: v.usage?.turns, status: v.status, subsRunning: v.subsRunning });
  }, { timeout: TURN_TIMEOUT, every: 200 });
  const turns = idle.usage.turns;
  const stop = page.locator(".composer button.send.stop");
  await waitFor("the composer shows Stop while the chat only waits", async () => await stop.isVisible(), { timeout: 10_000 });
  log(`    while waiting: thread "${(await page.locator(".thread .typing.waiting").innerText().catch(() => "")).trim()}", Stop is titled "${await stop.getAttribute("title")}"`);
  const itemsBefore = await chatItems(id);
  const results = resultItems(itemsBefore).length;
  check(stoppedNotes(itemsBefore) === 0, 'the thread has no "Stopped." note before Stop', itemsBefore.filter((i) => i.kind === "note"));
  check(waitingCalls(sinceLastUser(itemsBefore)).length === 0, "the agent ran no sleep or polling command before it ended its turn", waitingCalls(sinceLastUser(itemsBefore)));
  const running = (await chatSubs(id)).filter((x) => x.status === "running");
  check(running.length === n, `the server has ${n} running`, running);
  // The server's agent processes: one per chat with a live agent, one per running subagent.
  const agents = await agentProcs();
  const below = new Map(agents.map((pid) => [pid, descendantsOf(pid)]));
  check(agents.length > n, `the server runs the agent and its ${n} subagent${n === 1 ? "" : "s"} as processes`, agents.map((pid) => `${pid} ${argsOf(String(pid)).slice(0, 60)}`));

  await stop.click();
  await rowsStopped("after Stop");
  const note = page.locator(".thread .note", { hasText: /^Stopped\.$/ });
  await waitFor('the thread gets exactly one "Stopped." note', async () => (await note.count()) === 1 || saw(`${await note.count()} notes`), { timeout: 15_000 });
  const subs = await chatSubs(id);
  check(running.every((r) => { const now = subs.find((x) => x.id === r.id); return now?.status === "stopped" && !now.delivery; }), "the server has them stopped, with no result owed", subs);
  await waitFor("the chat is not busy", async () => !BUSY.has((await chatView(id)).status), { timeout: 30_000 });
  const gone = await waitFor(`${n} of the server's agent processes have ended`, async () => {
    const g = agents.filter((pid) => !alive(pid));
    return g.length >= n ? g : saw(agents.filter(alive));
  }, { timeout: 15_000 });
  await waitFor("nothing the subagents started is left running", async () => {
    const left = gone.flatMap((pid) => below.get(pid)).filter(alive);
    return left.length === 0 || saw(left.map((pid) => `${pid} ${argsOf(String(pid)).slice(0, 80)}`));
  }, { timeout: 15_000 });

  const quiet = async (when) => {
    const v = await chatView(id), items = await chatItems(id);
    const now = { turns: v.usage?.turns ?? 0, status: v.status, results: resultItems(items).length, notes: stoppedNotes(items), subsRunning: v.subsRunning ?? 0, subsOwed: v.subsOwed ?? 0 };
    if (now.turns !== turns || now.status !== "ready" || now.results !== results || now.notes !== 1 || now.subsRunning || now.subsOwed) {
      throw new Fail(`${when}: no result row appears, the agent's turn count does not grow, and there is one "Stopped." note`, { want: { turns, status: "ready", results, notes: 1 }, now });
    }
  };
  for (const until = Date.now() + 15_000; Date.now() < until; await sleep(1000)) await quiet("for 15 s after Stop");
  log('    ok  for 15 s after Stop: no result row appears, the turn count does not grow, one "Stopped." note');
  const stillGone = agents.filter((pid) => !alive(pid));
  check(stillGone.length === n, "only the subagents' processes ended: the agent's own is still running", { ended: stillGone, of: agents });

  await page.reload();
  await page.locator(".side").waitFor();
  await waitFor("the chat is selected after the reload", async () => (await sel(page)).chat === id || saw(await sel(page)));
  await rowsStopped("after the reload");
  await waitFor('one "Stopped." note after the reload', async () => (await note.count()) === 1 || saw(`${await note.count()} notes`), { timeout: 15_000 });
  check(await page.locator(".thread .sub-result").count() === results, "no result row after the reload", await page.locator(".thread .sub-result").allInnerTexts());
  await quiet("after the reload");

  const b = await send(page, id, "Reply with just the word PONG.");
  const { view, items } = await waitTurn(id, b);
  check(/pong/i.test(lastReply(items)), "a follow-up message gets a normal reply", lastReply(items));
  check(view.usage.turns === turns + 1 && stoppedNotes(items) === 1 && resultItems(items).length === results && !items.some((i) => i.kind === "note" && i.tone === "error"),
    'the follow-up ran one turn: still one "Stopped." note, no result row, no error note', { turns: view.usage.turns, was: turns, notes: items.filter((i) => i.kind === "note") });
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

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

/** Each process's children, from ps. */
function procChildren() {
  const r = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  const kids = new Map();
  for (const line of r.stdout.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || pid === r.pid) continue;
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  return kids;
}
/** Everything under a process: its children and theirs. */
function descendantsOf(pid) {
  const kids = procChildren(), out = [];
  for (let next = [...(kids.get(pid) ?? [])]; next.length;) { const p = next.shift(); out.push(p); next.push(...(kids.get(p) ?? [])); }
  return out;
}
/**
 * The agent processes the server runs: its own children that stay (seen in three readings), without
 * the short-lived helpers it also starts (the chat namer, the context meter's sqlite3). A subagent's
 * process is found this way and not by its arguments: Cursor's is a bare `agent acp`.
 */
async function agentProcs() {
  let stay = null;
  for (let i = 0; i < 3; i++) {
    if (i) await sleep(300);
    const now = new Set(procChildren().get(server.p.pid) ?? []);
    stay = stay ? stay.filter((pid) => now.has(pid)) : [...now];
  }
  return stay.filter((pid) => { const a = argsOf(String(pid)); return a && !/--no-session-persistence|sqlite3|cursor-cost/.test(a); });
}

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
  page.on("console", (m) => { if (m.type() === "error") log(`    [console error] ${m.text()}`); });
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
  await page.locator(".menu .menu-item.pick .menu-label", { hasText: label }).click();
}
async function pickModelId(page, id) {
  await page.locator('.composer button.tchip[title^="Model"]').click();
  await page.locator(`.menu .menu-item.pick[data-model-id="${id}"]`).click();
}
/** The label the server's snapshot gives a Claude model id. */
async function claudeLabel(id) {
  const m = (await state()).catalogs.claude?.models.find((x) => x.id === id);
  if (!m) throw new Error(`Claude catalog has no model ${id}`);
  return m.label;
}
async function pickEffort(page, label) {
  await page.locator('.composer button.tchip[title^="Effort"]').click();
  await page.locator(".menu .menu-item.pick .menu-label", { hasText: new RegExp(`^${label}`) }).click();
}
async function pickFolder(page, chatId, folder) {
  await page.locator('.composer button.tchip[title^="Working directory"], .composer button.tchip[title^="Folder not found"]').click();
  await page.locator(".dir-list").waitFor(); // the browser has loaded its first listing
  const input = page.locator(".dir-input");
  await input.fill(folder);
  await input.press("Enter");
  // The button reads "Use <name>" only once the typed folder's listing has loaded, so the click waits for it.
  const name = path.basename(folder).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await page.locator(".dir-foot button", { hasText: new RegExp(`^Use ${name}$`) }).click();
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
const token = () => randomUUID().slice(0, 8);
const TOKEN = { ls: token(), a: token(), b: token() }; // made per run, so no agent can know them

async function run() {
  log(`AI Whiteboard end-to-end run\n  bin    ${BIN}\n  client ${CLIENT}\n  home   ${HOME}\n  port   ${PORT}\n  output ${OUT}`);
  for (const f of [BIN, path.join(CLIENT, "index.html")]) if (!fs.existsSync(f)) throw new Fail(`${f} exists (build first)`, "missing");
  if (!SKIP_CURSOR_MCP) {
    try {
      await acquireMcpPort();
      log(`    port ${MCP_PORT} is free for the real-Cursor MCP steps`);
    } catch (e) {
      throw new Fail(
        `port ${MCP_PORT} is free: stop the running app or free the port`,
        `cannot bind 127.0.0.1:${MCP_PORT} (${e.code ?? e.message}). Port ${MCP_PORT} is probably held by a running AI Whiteboard app or another program. ` +
        `Stop that instance or free port ${MCP_PORT}, then run the e2e again; to skip the real-Cursor MCP steps, set AIWB_E2E_SKIP_CURSOR_MCP=1.`);
    }
  } else {
    log(`    AIWB_E2E_SKIP_CURSOR_MCP=1: the real-Cursor MCP steps will be reported as skipped; the app uses the hidden test-only MCP port override`);
  }
  if (await hello()) throw new Fail(`nothing is listening on port ${PORT}`, `a server answers at ${BASE}`);
  folders.p1 = dir("p1");
  folders.A = dir("ungrouped-a");
  folders.B = dir("research-b");
  fs.writeFileSync(path.join(folders.B, "README.md"), "A folder for the e2e run.\n");
  // What only a subagent's report can tell the agent that spawned it (steps 18 and 19b).
  fs.writeFileSync(path.join(folders.B, `note-${TOKEN.ls}.txt`), "A note.\n");
  folders.C = dir("subagents-c");
  fs.writeFileSync(path.join(folders.C, "a.txt"), `${TOKEN.a}\n`);
  fs.writeFileSync(path.join(folders.C, "b.txt"), `${TOKEN.b}\n`);

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
    await pickModelId(page, CLAUDE_MODEL_ID);
    await pickFolder(page, ids.chat1, folders.p1);
    const c1 = await chatView(ids.chat1);
    check(c1.model === "haiku" && !c1.effort && c1.cwd === folders.p1, "the pickers changed the chat (haiku, no effort, folder p1)", c1);
    const claudeModelLabel = await claudeLabel(CLAUDE_MODEL_ID);
    check(await page.locator('.composer button.tchip[title^="Model"]', { hasText: claudeModelLabel }).isVisible(), `the model picker shows ${claudeModelLabel}`, await page.locator(".composer-tools").innerText());
    ids.sid1 = readJSON(path.join(HOME, "chats", ids.chat1, "chat.json")).sessionId;
    check(!!ids.sid1, "chat.json has a session id", readJSON(path.join(HOME, "chats", ids.chat1, "chat.json")));
    check(claudeProcs(ids.sid1).length === 0, "no claude process runs for the chat yet", claudeProcs(ids.sid1));

    const q = "Do you have any whiteboard tools named list_boards, read_board, or apply? Reply with just yes or no.";
    const before = await send(page, ids.chat1, q);
    const procs = await waitFor("a claude process runs with the chat's session id", async () => { const p = claudeProcs(ids.sid1); return p.length ? p : null; }, { timeout: 15_000 });
    check(procs.some((p) => /mcp-config/.test(p.args)), "the plain chat's process has MCP config (spawn family)", procs);
    await waitFor("the pickers are locked", async () => (await page.locator('.composer button.tchip[title^="Model"]').count()) === 0 && (await chatView(ids.chat1)).locked);
    check(await page.locator(".composer .tchip.static", { hasText: claudeModelLabel }).isVisible(), "the composer shows the model as fixed", await page.locator(".composer-tools").innerText());
    const { items } = await waitTurn(ids.chat1, before);
    const reply = lastReply(items);
    check(/^\W*no\b/i.test(reply) || /\b(no|don't|do not|none)\b/i.test(reply.split("\n")[0]), 'the reply is "No"', reply);
    check(!items.some((i) => i.kind === "tool" && /^mcp__board__(list_boards|read_board|get_view|apply|delete_elements|create_board|show_board)$/.test(i.name ?? "")), "no board tool was called", items);
    const named = await waitFor("the chat gets a name", async () => (await chatView(ids.chat1)).name || null, { timeout: 60_000 });
    await (await chatRow(page, ids.chat1)).waitFor();
    log(`    chat named "${named}"`);
  });

  await step(3, "A folder change in Research carries to the next chat there, not to ungrouped", async () => {
    // Ungrouped keeps its own defaults: give it some first, so the Research change can't leak into it.
    ids.u1 = await newChatVia(page, async () => { await page.locator("button.icon-btn.new").click(); }, "Claude Code chat");
    await pickModelId(page, "sonnet");
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

  const step7Title = "Cursor board chat adds a cache; context meter; then sqlite3 off the PATH";
  if (SKIP_CURSOR_MCP) {
    await skipStep(7, step7Title, `real Cursor over the policy-approved MCP URL needs exclusive port ${MCP_PORT} (AIWB_E2E_SKIP_CURSOR_MCP is set)`);
  } else {
  await step(7, step7Title, async () => {
    const debugOffset = fs.existsSync(CURSOR_DEBUG_LOG) ? fs.statSync(CURSOR_DEBUG_LOG).size : 0;
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
    check(labels.some((l) => /^Edited arch\b/.test(l)), 'a tool card reads "Edited arch"', labels);
    log(`    tool cards: ${labels.join(" | ")}`);
    check(!items.some((i) => i.kind === "perm") && (await page.locator(".perm").count()) === 0, "no approval card appears", items.filter((i) => i.kind === "perm"));
    const filesAfter = listFiles(view.cwd);
    check(show(filesAfter) === show(filesBefore), "the chat's folder has no new files", { before: filesBefore, after: filesAfter });

    // Transport checks that would have caught the removed command path. The board MCP tool must be
    // presented as mcp__board__*, the server must have seen Cursor initialize and call it, the
    // first ACP prompt Cursor received must be the whiteboard body (no MCP how-to, no curl, no
    // <board-api>), and Cursor's own debug log must show neither a load failure nor a policy block.
    const chatShort = shortId(ids.cursorBoard);
    const serverLog = readIfExists(LOG);
    const mcpLines = serverLog.split("\n").filter((l) => /mcp (initialize|tools\/call)/.test(l)).slice(-10);
    check(new RegExp(`mcp initialize chat=${chatShort} client="Cursor"`).test(serverLog), "the server log shows a Cursor MCP initialize for the chat", mcpLines.join("\n"));
    check(new RegExp(`mcp tools/call chat=${chatShort} tool=`).test(serverLog), "the server log shows an MCP tools/call for the chat", mcpLines.join("\n"));
    check(items.some((i) => i.kind === "tool" && /^mcp__board__/.test(i.name ?? "")), "the tool card is an mcp__board__* tool", items.filter((i) => i.kind === "tool").map((i) => i.name));

    const acpTrace = readIfExists(ACP_LOG);
    check(acpTrace.length > 0, "the adapter's ACP trace exists and is not empty", `${ACP_LOG} (${acpTrace.length} bytes)`);
    const acpPrompt = firstCursorPrompt(acpTrace);
    check(acpPrompt.length > 0, "the ACP trace has an outgoing session/prompt", acpTrace.slice(0, 400));
    check(acpPrompt.includes("with the `board` MCP tools") && !acpPrompt.includes("How to call the board tools"), "the first ACP prompt is the whiteboard body, with no MCP how-to", acpPrompt.slice(0, 400));
    check(!acpPrompt.includes("curl") && !acpPrompt.includes("<board-api>"), "the first ACP prompt has no curl or <board-api> block", acpPrompt.slice(0, 400));

    const debugNew = readIfExists(CURSOR_DEBUG_LOG).slice(debugOffset);
    check(fs.existsSync(CURSOR_DEBUG_LOG), "Cursor's debug log exists", CURSOR_DEBUG_LOG);
    if (debugNew.length === 0) log(`    note: Cursor's debug log did not grow during the turn; the two negative MCP checks below are inconclusive`);
    check(!debugNew.includes("Failed to load ACP session MCP server"), "Cursor's debug log has no 'Failed to load ACP session MCP server'", debugNew.split("\n").filter((l) => /MCP server|team policy/.test(l)).slice(-5).join("\n"));
    check(!debugNew.includes("Blocked by team policy"), "Cursor's debug log has no 'Blocked by team policy'", debugNew);

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
  }

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
    const boardChats = [ids.claudeBoard, ids.cursorBoard].filter(Boolean); // no Cursor board chat when the MCP step is skipped
    const archChats = sc.chats.filter((c) => c.board === ids.arch);
    check(archChats.length === boardChats.length && archChats.every((c) => c.archived), "its chats are archived", archChats);
    await waitFor("the board and its chats disappear from the sidebar", async () => (await boardRow(page, "arch").count()) === 0 || saw(await page.locator(".side-tree").innerText()));
    await page.locator(".side-foot input").check();
    const row = boardRow(page, "arch");
    await row.waitFor();
    const archivedChats = groupBox(page, "Research").locator(".side-board.archived .side-row.is-chat.archived");
    check(await archivedChats.count() === boardChats.length, "Show archived shows the board's chats greyed in place under it", await groupBox(page, "Research").innerHTML());
    await row.click();
    await page.locator(".archived-note", { hasText: "read-only" }).waitFor();
    check(await page.locator('[data-testid="toolbar-rectangle"]').count() === 0, "the archived board opens read-only (no drawing tools)", "the rectangle tool is shown");
    const claudeRow = await chatRow(page, ids.claudeBoard);
    await hoverClick(page, claudeRow, 'button[title="More"]');
    await menuItem(page, "Unarchive").click();
    await waitFor("the board comes back", async () => !(await state()).boards.find((b) => b.id === ids.arch)?.archived);
    const s2 = await state();
    check(!s2.chats.find((c) => c.id === ids.claudeBoard).archived, "the unarchived chat is back", s2.chats.find((c) => c.id === ids.claudeBoard));
    if (ids.cursorBoard) {
      check(s2.chats.find((c) => c.id === ids.cursorBoard).archived === true, "the other chat stays archived", s2.chats.find((c) => c.id === ids.cursorBoard));
    }
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

    const expectedBoardChats = [ids.claudeBoard, ids.cursorBoard].filter(Boolean).length;
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
    check(archChats.length === expectedBoardChats && left.length === 0, "its chats' folders are gone", { chats: archChats, left });
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

  await step(18, "Claude subagents: two rows run then complete and their results reach the agent; the drawer; Esc closes it only; a reload keeps them; Stop while waiting", async () => {
    ids.claudeSubs = await newChatVia(page, async () => { await page.locator("button.icon-btn.new").click(); }, "Claude Code chat");
    await pickModelId(page, CLAUDE_MODEL_ID);
    await pickFolder(page, ids.claudeSubs, folders.B); // it has a README.md
    const v0 = await chatView(ids.claudeSubs);
    check(v0.agent === "claude" && v0.model === "haiku" && !v0.board, "a plain Claude chat on Haiku", v0);
    const cj0 = readJSON(path.join(HOME, "chats", ids.claudeSubs, "chat.json"));
    check(!!cj0.token, "plain chat.json has a token", cj0);
    const watch = watchChat(ids.claudeSubs);
    const before = await send(page, ids.claudeSubs, "Spawn two subagents in parallel via spawn_subagent. Give them distinct descriptions. One runs `ls`; the other reads README.md. When their results arrive, summarise them.");

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
    // The parent's turn ends before the results come, so the checks below wait for the result rows first.
    // What the reports hold and the prompt does not: the other file `ls` lists, and README.md's text.
    await checkDelivery(page, ids.claudeSubs, before, 2, watch, (text) => text.includes(TOKEN.ls) || /e2e run/i.test(text));
    const subs = (await get(`/api/chats/${ids.claudeSubs}/items`)).subagents;
    check(subs.length === 2 && subs.every((s) => s.status === "completed"), "the server has two completed subagents", subs);
    check(subs.every((s) => s.kind === "claude"), "server subagents have kind claude", subs.map((s) => ({ id: s.id, kind: s.kind })));
    const spawnCalls = (await chatItems(ids.claudeSubs)).filter((i) => i.kind === "tool" && i.name === "mcp__board__spawn_subagent");
    check(spawnCalls.length >= 2, "spawn rows are mcp__board__spawn_subagent", (await chatItems(ids.claudeSubs)).filter((i) => i.kind === "tool").map((i) => i.name));
    const chrome = await rows.evaluateAll((els) => els.map((e) => ({
      agent: (e.querySelector(".sub-agent")?.textContent ?? "").trim(),
      cls: e.querySelector(".sub-agent")?.className ?? "",
    })));
    check(chrome.length === 2 && chrome.every((r) => r.agent === "Claude" && /\bagent-claude\b/.test(r.cls)), "linked cards show Claude identity chrome", chrome);

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
    const sj = readJSON(path.join(folder, "subagent.json"));
    check(sj.status === "completed" && sj.kind === "claude", "its subagent.json says completed and includes kind", sj);
    check((body.items ?? []).some((i) => i?.kind === "tool"), "the fetched thread has its tool calls", body.items);
    await waitFor("the drawer shows the fetched thread", async () => (await drawer.locator(".tool").count()) > 0 || saw(await drawer.innerText().catch(() => "(no drawer)")), { timeout: 10_000 });
    await page.keyboard.press("Escape");
    await waitFor("the drawer closes", async () => (await drawer.count()) === 0, { timeout: 5000 });

    // Stop while waiting. The two subagents above finished at once, so one more is spawned that
    // runs long; the thread has no "Stopped." note so far (checked above). It loops in a shell
    // until a gate file exists: Claude Code refuses a `sleep N`, alone and followed by another
    // command (the subagent would end at once), and asks before a `ping`. Stop comes only once the
    // loop's process is seen, so the process checks after Stop cover a command that really runs.
    const b3 = await send(page, ids.claudeSubs, `Spawn one more subagent via spawn_subagent. It should run this exact shell command in the foreground with timeout 300000, wait for it to finish, and then reply done: until [ -f ${STOP_GATE} ]; do sleep 2; done; echo done`);
    const rowStates = async () => rows.evaluateAll((els) => els.map((e) => ({
      mark: e.querySelector(".sub-mark")?.textContent ?? "", cls: e.className, line: e.querySelector(".sub-line")?.textContent ?? "",
    })));
    await waitFor("a third subagent row shows running", async () => {
      const now = await rowStates();
      return now.length === 3 && /st-running/.test(now[2].cls) ? now : saw(now);
    }, { timeout: TURN_TIMEOUT, every: 200 });
    const loop = await waitFor("the third subagent's shell loop is running", async () => {
      const now = pgrep(STOP_GATE), r = await rowStates();
      if (!now.length && !/st-running/.test(r[2]?.cls ?? "")) throw new Fail("the third row is still running while its loop is awaited", r);
      return now.length > 0 ? now : saw(r);
    }, { timeout: TURN_TIMEOUT });
    log(`    the loop: ${loop.map((pid) => `${pid} ${argsOf(pid)}`).join(" | ")}`);
    await stopWhileWaiting(page, ids.claudeSubs, b3, 1, async (when) => {
      const ok = (now) => now.length === 3 && now.slice(0, 2).every((r) => r.mark === "✓") && now[2].mark === "■" && /st-stopped/.test(now[2].cls) && now[2].line === "Stopped";
      const now = await waitFor(`the third row shows ■ and "Stopped" ${when}, the first two stay ✓`, async () => { const r = await rowStates(); return ok(r) ? r : saw(r); }, { timeout: 30_000 });
      check(ok(now), `the running row is stopped ${when}`, now);
    });
    check(pgrep(STOP_GATE).length === 0, "no process of the loop is left", pgrep(STOP_GATE).map((pid) => `${pid} ${argsOf(pid)}`));
    openStopGate();
  });

  const step19Title = "Cursor subagents: meters while running; Stop while waiting stops both and starts no turn; still stopped after a reload";
  if (SKIP_CURSOR_MCP) {
    await skipStep(19, step19Title, `real Cursor over MCP spawn_subagent needs exclusive port ${MCP_PORT} (AIWB_E2E_SKIP_CURSOR_MCP is set)`);
  } else {
  await step(19, step19Title, async () => {
    ids.cursorSubs = await newChatVia(page, async () => { await page.locator("button.icon-btn.new").click(); }, "Cursor chat");
    await waitFor("Cursor's model list is loaded", async () => (await page.locator('.composer button.tchip[title^="Model"]').count()) > 0, { timeout: 60_000 });
    await pickModel(page, CURSOR_MODEL_LABEL);
    const v0 = await chatView(ids.cursorSubs);
    check(v0.agent === "cursor" && v0.model === "gpt-5.4-nano" && !v0.board, `a plain Cursor chat on ${CURSOR_MODEL_LABEL}`, v0);
    const before = await send(page, ids.cursorSubs, "Spawn two subagents in parallel via spawn_subagent. Give them distinct descriptions. Each should run `sleep 20` then `ls`.");

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
    const runningSubs = await waitFor("the server has both subagents running", async () => {
      const s = (await get(`/api/chats/${ids.cursorSubs}/items`)).subagents;
      return s.length === 2 && s.every((x) => x.status === "running") ? s : saw(s);
    }, { timeout: 15_000 });
    check(runningSubs.every((s) => s.kind === "cursor"), "server subagents have kind cursor", runningSubs.map((s) => ({ id: s.id, kind: s.kind })));
    const spawnCalls = (await chatItems(ids.cursorSubs)).filter((i) => i.kind === "tool" && i.name === "mcp__board__spawn_subagent");
    const taskCalls = (await chatItems(ids.cursorSubs)).filter((i) => i.kind === "tool" && i.name === "Task");
    check(spawnCalls.length >= 2, "spawn rows are mcp__board__spawn_subagent", (await chatItems(ids.cursorSubs)).filter((i) => i.kind === "tool").map((i) => i.name));
    check(!taskCalls.some((i) => !i.isError && !i.denied), "no native Task succeeded", taskCalls.map((i) => ({ name: i.name, isError: i.isError, denied: i.denied })));
    const chrome = await rows.evaluateAll((els) => els.map((e) => ({
      agent: (e.querySelector(".sub-agent")?.textContent ?? "").trim(),
      cls: e.querySelector(".sub-agent")?.className ?? "",
    })));
    check(chrome.length === 2 && chrome.every((r) => r.agent === "Cursor" && /\bagent-cursor\b/.test(r.cls)), "linked cards show Cursor identity chrome", chrome);
    const t0 = Date.now();
    const meters = await waitFor("each running row's meter shows a token count", async () => {
      const now = await running();
      if (!now.every((r) => r.running)) throw new Fail("the rows are still running while the meters are read", now);
      return now.length === 2 && now.every((r) => /\d/.test(r.meter)) ? now : saw(now);
    }, { timeout: 12_000, every: 200 });
    log(`    meters after ${((Date.now() - t0) / 1000).toFixed(1)} s: ${meters.map((m) => m.meter).join(" | ")}`);

    // Stop while waiting: the agent has ended its turn, so Stop meets an idle chat. No result can
    // come after it (a stopped subagent sends none); the delivery itself is step 19b.
    const stopped = async () => rows.evaluateAll((els) => els.map((e) => ({
      mark: e.querySelector(".sub-mark")?.textContent ?? "", cls: e.className, line: e.querySelector(".sub-line")?.textContent ?? "",
    })));
    const allStopped = (now) => now.length === 2 && now.every((r) => r.mark === "■" && /st-stopped/.test(r.cls) && r.line === "Stopped");
    await stopWhileWaiting(page, ids.cursorSubs, before, 2, async (when) => {
      const now = await waitFor(`both rows show ■ and "Stopped" ${when}`, async () => { const r = await stopped(); return allStopped(r) ? r : saw(r); }, { timeout: 30_000 });
      check(allStopped(now), `both rows are stopped ${when}`, now);
    });
    const subs = (await get(`/api/chats/${ids.cursorSubs}/items`)).subagents;
    check(subs.length === 2 && subs.every((s) => s.status === "stopped"), "the server has both subagents stopped", subs);
    const subDir = path.join(HOME, "chats", ids.cursorSubs, "subagents");
    await waitFor("no leftover subagent processes", async () => {
      const left = pgrep(subDir);
      return left.length === 0 || saw(left);
    }, { timeout: 15_000 });
    for (const s of subs) {
      const f = path.join(HOME, "chats", ids.cursorSubs, "subagents", s.id, "subagent.json");
      const disk = fs.existsSync(f) ? readJSON(f) : null;
      check(disk && disk.status === "stopped" && disk.kind === "cursor", `subagent ${s.id} is saved as stopped with kind cursor`, disk ?? "(no subagent.json)");
    }
  });
  }

  const step19bTitle = "Cursor subagents: the agent ends its turn; the results come as rows, reach the agent and start its next turn";
  if (SKIP_CURSOR_MCP) {
    await skipStep("19b", step19bTitle, `real Cursor over MCP spawn_subagent needs exclusive port ${MCP_PORT} (AIWB_E2E_SKIP_CURSOR_MCP is set)`);
  } else {
  await step("19b", step19bTitle, async () => {
    ids.cursorDelivery = await newChatVia(page, async () => { await page.locator("button.icon-btn.new").click(); }, "Cursor chat");
    await waitFor("Cursor's model list is loaded", async () => (await page.locator('.composer button.tchip[title^="Model"]').count()) > 0, { timeout: 60_000 });
    await pickModel(page, CURSOR_MODEL_LABEL);
    await pickFolder(page, ids.cursorDelivery, folders.C); // it has a.txt and b.txt
    const v0 = await chatView(ids.cursorDelivery);
    check(v0.agent === "cursor" && v0.model === "gpt-5.4-nano" && !v0.board, `a plain Cursor chat on ${CURSOR_MODEL_LABEL}`, v0);
    const watch = watchChat(ids.cursorDelivery);
    // The sleep keeps each subagent running past the end of the agent's own turn.
    const before = await send(page, ids.cursorDelivery, "Spawn two subagents in parallel via spawn_subagent. Give them distinct descriptions. One runs `sleep 15` and then `cat a.txt`; the other runs `sleep 15` and then `cat b.txt`. Each replies with just the file's content. When their results arrive, reply with both contents.");
    const rows = page.locator(".thread .subagent");
    const marks = await waitFor("two subagent rows show ✓", async () => {
      const now = await rows.evaluateAll((els) => els.map((e) => ({ mark: e.querySelector(".sub-mark")?.textContent ?? "", cls: e.className, line: e.querySelector(".sub-line")?.textContent ?? "" })));
      return now.length === 2 && now.every((r) => r.mark === "✓" && /st-completed/.test(r.cls)) ? now : saw(now);
    }, { timeout: TURN_TIMEOUT, every: 200 });
    log(`    rows: ${marks.map((m) => m.line).join(" | ")}`);
    // What only the reports hold: the files' contents.
    await checkDelivery(page, ids.cursorDelivery, before, 2, watch, (text) => text.includes(TOKEN.a) || text.includes(TOKEN.b));
    const subs = await chatSubs(ids.cursorDelivery);
    check(subs.every((x) => x.kind === "cursor" && x.status === "completed"), "the server has two completed subagents of kind cursor", subs.map((x) => ({ id: x.id, kind: x.kind, status: x.status })));
    const items = await chatItems(ids.cursorDelivery);
    const taskCalls = items.filter((i) => i.kind === "tool" && i.name === "Task");
    check(!taskCalls.some((i) => !i.isError && !i.denied), "no native Task succeeded", taskCalls.map((i) => ({ name: i.name, isError: i.isError, denied: i.denied })));
    check(!items.some((i) => i.kind === "note"), "the thread has no note (no error, no Stopped.)", items.filter((i) => i.kind === "note"));
  });
  }

  await step(20, "A typed message is kept as the chat's draft: across chat switches and a restart; sending clears it", async () => {
    ids.drafty = await newChatVia(page, async () => { await page.locator("button.icon-btn.new").click(); }, "Claude Code chat");
    await pickModelId(page, CLAUDE_MODEL_ID);
    const text = "Reply with just the word DRAFTED.";
    const ta = page.locator(".composer .composer-input");
    await ta.pressSequentially(text);
    const chatJSON = path.join(HOME, "chats", ids.drafty, "chat.json");
    await waitFor("chat.json has the draft", async () => readJSON(chatJSON).draft?.text === text || saw(readJSON(chatJSON).draft), { timeout: 5000 });

    await openChat(page, ids.claudeSubs);
    await waitFor("another chat's composer is empty", async () => (await ta.innerText()).trim() === "" || saw(await ta.innerText()), { timeout: 5000 });
    // Back to the draft's chat through the saved selection (it has no name to find its row by yet).
    await page.evaluate((id) => localStorage.setItem("aiwb.sel", JSON.stringify({ board: null, chat: id })), ids.drafty);
    await stopServer();
    await startServer();
    await page.reload();
    await page.locator(".side").waitFor();
    await waitFor("the chat is selected after the restart", async () => (await sel(page)).chat === ids.drafty || saw(await sel(page)));
    await waitFor("the composer shows the draft after the restart", async () => (await ta.innerText()).trim() === text || saw(await ta.innerText()), { timeout: 10_000 });

    await ta.press("Enter");
    await waitFor("the message is sent", async () => (await chatItems(ids.drafty)).some((i) => i.kind === "user" && i.text === text), { timeout: 30_000 });
    await waitFor("the draft is gone from chat.json", async () => readJSON(chatJSON).draft === undefined || saw(readJSON(chatJSON).draft), { timeout: 5000 });
    check((await ta.innerText()).trim() === "", "the composer is empty", await ta.innerText());
  });
}

// ---------------------------------------------------------------- main

let code = 0;
try {
  await run();
  log(ONLY ? `\nTHE SELECTED STEPS PASSED (AIWB_E2E_STEPS=${[...ONLY].join(",")}; the others were not run)` : "\nALL STEPS PASSED (step 15 is checked by hand)");
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
  openStopGate();
  fs.rmSync(CURSOR_CFG, { recursive: true, force: true });
  fs.rmSync(ACP_LOG, { force: true }); // never leave the adapter trace behind
}
process.exit(code);
