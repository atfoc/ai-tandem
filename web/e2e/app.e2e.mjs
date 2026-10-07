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
//                    Step 1 always runs: it starts the server. Steps 18, 19, 19b and 21 to 28
//                    need nothing an earlier step made (each makes its own chat); most other
//                    steps do.
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
// Steps 21 to 26 are the scenario of concurrent branches (docs/concurrent-branches-plan.md, phase
// 1): two branches of one chat in a turn at once, each stopped by itself; a subagent's result that
// reaches its own branch while another is shown; a fork to a new chat from a running source; a
// draft per branch; the cap on running turns (step 25 restarts the server with AIWB_CHAT_CAP=1 and
// puts the default back at its end); a restart. They run on plain Claude chats on Haiku. A turn
// that must keep running waits on a gate file, as step 18's subagent does.
//
// Step 27 is phase 2 of that plan: the tree popup, open during a run, is kept current by the
// server's `tree` events with no fetch of the tree. Its rows show which branches work, a branch
// started and a fork made elsewhere appear in it, a row's Stop stops that branch alone, a branch is
// viewed by a double click on its end row while another runs, and its foot counts the agents
// working in the folder. One plain Claude chat on Haiku, with the same gates.
//
// Step 27b closes two clauses of those phases: a branch is started from a row of the tree popup
// while main runs (a double click on a finished turn's reply; no reply of the running turn offers
// it), and two branches of one chat wait for approval at once and are answered each by itself, with
// the header's alert and the popup's "needs approval" marks. Claude runs with --permission-mode
// auto and asks for nothing by itself, so the step gives its chat a folder of its own whose project
// settings (<folder>/.claude/settings.json) hold an "ask" rule for one harmless command, `ping`: a
// rule comes before the mode, and the CLI then asks through the app. Nothing of the user's Claude
// config is read for it or changed.
//
// Step 28 is phase 3 of that plan: a model and an effort per branch and per fork. A branch started
// from a chat on Haiku is given Sonnet in the pending branch's toolbar (the picker is there although
// the chat has started, the notice says the history is read again, Back drops the choice); it
// answers on Sonnet while main keeps Haiku, and its choice is fixed from then on. A fork to a new
// chat that has had no message of its own is given Sonnet by a PATCH, which starts its agent
// again; after its first message that is fixed too. Neither choice becomes a default of new chats,
// and a subagent of the Sonnet branch takes the branch's model. That an answer came from Sonnet is
// read from the agent itself, not only from the app's record: the model the branch's Claude
// process reports (GET …/context) and the one on the assistant lines of its Claude session file.
// It is the one step that runs turns on Sonnet (three short ones and a subagent's), at effort low.
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
// The gates of steps 21 to 27b: a turn (or a subagent) told to loop until its gate file exists runs
// until the step makes the file. Each step opens its own at its end, and the run all of them again.
const GATES = [];
const newGate = (name) => { const f = path.join(WORK, `gate-${name}-${randomUUID().slice(0, 8)}`); GATES.push(f); return f; };
const openGates = (...files) => { for (const f of files) try { fs.writeFileSync(f, ""); } catch { /* the folder is gone */ } };

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

// ---------------------------------------------------------------- concurrent branches

/** A chat's branch records from the snapshot: one per branch; the main branch's id is "main". */
async function branchStates(id) { return (await state()).states.filter((r) => r.chat === id); }
const branchRec = async (id, branch) => (await branchStates(id)).find((r) => r.branch === branch);
const recBrief = (recs) => recs.map((r) => ({ branch: r.branch, status: r.status, turns: r.usage?.turns ?? 0, subsRunning: r.subsRunning ?? 0, subsOwed: r.subsOwed ?? 0 }));
/** The items of one branch of a chat. */
async function itemsOf(id, branch) { return (await get(`/api/chats/${id}/items?branch=${encodeURIComponent(branch)}`)).items; }
const subsOf = async (id, branch) => (await get(`/api/chats/${id}/items?branch=${encodeURIComponent(branch)}`)).subagents;
const hasUser = (items, text) => items.some((i) => i.kind === "user" && i.text === text);

/** A message whose turn runs until `gate` exists. `word` starts it (a branch is named by its first message) and is the reply. */
const gatedTask = (word, gate) => `${word} task. Run this exact shell command in the foreground with timeout 300000, wait for it to finish, and then reply with just the word ${word}: until [ -f ${gate} ]; do sleep 2; done; echo done`;
/** A message whose turn waits on two gates, one after the other: with the first open the turn goes on (a tool result, the next tool call) without ending. */
const gatedTask2 = (word, gate1, gate2) => `${word} task. Run these two exact shell commands one after the other, as two separate tool calls, each in the foreground with timeout 300000. Start the second only after the first has finished, and say nothing in between. First: until [ -f ${gate1} ]; do sleep 2; done; echo done` +
  ` Second: until [ -f ${gate2} ]; do sleep 2; done; echo done When the second has finished, reply with just the word ${word}.`;
/** A message that makes the agent spawn one subagent that runs until `gate` exists and then reports `word`; the agent's own turn ends at once. */
const gatedSpawn = (word, gate) => `ALPHA task. Spawn one subagent via spawn_subagent, then end your turn right away without waiting for it. The subagent should run this exact shell command in the foreground with timeout 300000, wait for it to finish, and then reply with just ${word}: until [ -f ${gate} ]; do sleep 2; done; echo done`;

/** Waits until a branch's gated turn (the one after `before` turns) is inside its shell loop. */
async function waitGated(id, branch, gate, before) {
  const what = `branch ${branch} is in a turn that waits on its gate (its shell loop runs)`;
  await waitFor(what, async () => {
    const r = await branchRec(id, branch);
    if (r?.status === "error") throw new Fail(what, `the branch is in error: ${r.error}`);
    if (r && (r.usage?.turns ?? 0) > before && !BUSY.has(r.status)) throw new Fail(what, { ended: recBrief([r]), reply: lastReply(await itemsOf(id, branch)) });
    return (r && BUSY.has(r.status) && pgrep(gate).length > 0) || saw({ record: r ? recBrief([r]) : "(none)", loop: pgrep(gate) });
  }, { timeout: TURN_TIMEOUT, every: 500 });
}

/** Waits for a branch's turn after `before` turns to end, and returns the branch's record. */
async function waitBranchTurn(id, branch, before, what = `the turn on branch ${branch} ends`) {
  return waitFor(what, async () => {
    const r = await branchRec(id, branch);
    if (r?.status === "error") throw new Fail(what, `the branch is in error: ${r.error}`);
    return r && (r.usage?.turns ?? 0) > before && !BUSY.has(r.status) ? r : saw(r ? recBrief([r]) : "(no record)");
  }, { timeout: TURN_TIMEOUT, every: 1000 });
}

/** Waits until a branch's own turn has ended while the one subagent it spawned still runs in its loop. */
async function waitSpawned(id, branch, gate, before) {
  const what = `the turn on branch ${branch} has ended while its subagent runs`;
  await waitFor(what, async () => {
    const r = await branchRec(id, branch);
    if (r?.status === "error") throw new Fail(what, `the branch is in error: ${r.error}`);
    return (r && (r.usage?.turns ?? 0) > before && r.status === "ready" && r.subsRunning === 1 && pgrep(gate).length > 0) || saw({ record: r ? recBrief([r]) : "(none)", loop: pgrep(gate) });
  }, { timeout: TURN_TIMEOUT, every: 500 });
}

/**
 * The models that wrote the answers of a Claude session, in order, from Claude's own session file
 * (<Claude's config folder>/projects/<folder>/<session id>.jsonl; read, never written). A branch's
 * or a fork's file starts with the copied history, so its first answers are the source's.
 */
function sessionModels(sessionId) {
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { /* no such folder */ }
  for (const d of dirs) {
    const text = readIfExists(path.join(root, d, `${sessionId}.jsonl`));
    if (!text) continue;
    const out = [];
    for (const line of text.split("\n")) {
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.type === "assistant" && m.message?.model && m.message.model !== "<synthetic>") out.push(m.message.model);
    }
    return out;
  }
  return [];
}

/** Reads the page in the background and keeps every change of what `read` answers. */
function watchPage(read, every = 100) {
  const seen = [];
  let on = true, last = "";
  const done = (async () => {
    while (on) {
      try { const v = await read(); const k = JSON.stringify(v); if (k !== last) { last = k; seen.push(v); } } catch { /* the page is loading */ }
      await sleep(every);
    }
  })();
  return { seen, stop: async () => { on = false; await done; } };
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

/** The agent picker's label for each agent. */
const AGENT_LABEL = { claude: "Claude Code", cursor: "Cursor", pi: "Pi" };

/** Creates a chat through the sidebar or board bar, gives it the agent and returns its id. */
async function newChatVia(page, opener, agent) {
  const before = new Set((await state()).chats.map((c) => c.id));
  const made = async () => { const s = (await sel(page)).chat; return s && !before.has(s) ? s : null; };
  await opener();
  // A "+" with a menu has one chat item; the other places make the chat on the click.
  const item = menuItem(page, /^\s*(New chat|Chat)\s*$/);
  if (await waitFor("a new chat or the menu's chat item", async () => (await made()) ? "made" : (await item.count()) > 0 && "menu") === "menu") await item.click();
  const id = await waitFor("a new chat is created and selected", made);
  await page.locator(".composer .composer-input").waitFor();
  if ((await chatView(id)).agent !== agent) {
    await page.locator('.composer button.tchip[title^="Agent"]').click();
    await page.locator(".menu .menu-item.pick .menu-label", { hasText: new RegExp(`^${AGENT_LABEL[agent]}$`) }).click();
    await waitFor(`chat ${id} has the agent ${agent}`, async () => { const c = await chatView(id); return c.agent === agent || saw(c.agent); });
  }
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

/** A plain Claude chat on Haiku with one short finished turn: the point steps 21 to 27b branch and fork from. `folder`: its working folder, when the step needs its own. */
async function branchChat(page, folder) {
  const id = await newChatVia(page, async () => { await page.locator("button.icon-btn.new").click(); }, "claude");
  await pickModelId(page, CLAUDE_MODEL_ID);
  if (folder) await pickFolder(page, id, folder);
  const v = await chatView(id);
  check(v.agent === "claude" && v.model === "haiku" && !v.board, "a plain Claude chat on Haiku", v);
  const b = await send(page, id, "Reply with just the word ONE.");
  await waitTurn(id, b);
  return id;
}

/** Types into the composer and presses Enter; answers the status and body of the POST …/messages it makes (the body names the branch the message was put on). */
async function typeSend(page, id, text, { typed = false } = {}) {
  const posted = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/chats/${id}/messages`, { timeout: 15_000 });
  const ta = page.locator(".composer .composer-input");
  if (!typed) await ta.fill(text);
  await ta.press("Enter");
  const res = await posted;
  return { status: res.status(), body: await res.json().catch(() => ({})) };
}

/** Clicks a fork action of the chat's first reply. The actions show on hover and their texts are drawn by CSS, so they are found by class. */
async function firstReplyAction(page, cls) {
  const msg = page.locator(".thread > .msg.assistant").first();
  await msg.hover();
  await msg.locator(`.fk-act.${cls}`).click();
}

/** Starts a new branch at the chat's first reply with `text` as its first message: the hover action, the banner, Send. Answers the new branch's id. */
async function branchFromFirstReply(page, id, text) {
  await firstReplyAction(page, "k-branch");
  const banner = page.locator(".fk-banner .fk-banner-text");
  await banner.waitFor({ timeout: 10_000 });
  const said = (await banner.innerText()).trim();
  check(/^New branch after “.+”: your message starts it\. “.+” stays in the tree\.$/.test(said), `the banner tells of the new branch: ${said}`, said);
  const res = await typeSend(page, id, text);
  check(res.status === 200 && res.body.ok === true && !!res.body.branch && res.body.branch !== "main", "the Send is accepted and its answer names the new branch", res);
  await waitFor("the banner goes and the view is on the new branch", async () => (await page.locator(".fk-banner").count()) === 0 && (await crumbText(page)) !== "" || saw({ banner: await page.locator(".fk-banner").count(), crumb: await crumbText(page) }), { timeout: 15_000 });
  return res.body.branch;
}

/** The name of the branch the chat is viewed on, from the header ("" before the chat has split). */
const crumbText = async (page) => ((await page.locator(".fk-crumb").count()) ? (await page.locator(".fk-crumb").innerText()).trim() : "");
const waitCrumb = (page, re, what) => waitFor(what, async () => re.test(await crumbText(page)) || saw(`crumb: "${await crumbText(page)}"`), { timeout: 15_000 });

/** The tree popup's rows, as drawn. endOf: the branch that ends at the row; link: the title of a fork's link row (such a row has no text). */
const treeRows = (page) => page.locator(".fk-nav .fk-row").evaluateAll((els) => els.map((e) => ({
  text: e.querySelector(".fk-text")?.textContent ?? "", cls: e.className, mark: e.querySelector(".fk-mark")?.textContent ?? "",
  here: !!e.querySelector(".fk-here"), end: !!e.querySelector(".fk-end"), endOf: e.getAttribute("data-end") ?? "",
  link: e.querySelector(".fk-fork-link")?.textContent ?? "", stop: !!e.querySelector("button.fk-stop"),
})));
/** The popup's row a branch ends at: a double click on it views the branch. */
const endRow = (page, branch) => page.locator(`.fk-nav .fk-row[data-end="${branch}"]`);
const rowBrief = (rows) => rows.map((r) => `${r.link ? `⑂ ${r.link}` : r.text.slice(0, 24)}${r.mark ? ` [${r.mark}]` : ""}${r.here ? " ●here" : r.end ? " end" : ""}`).join(" | ");

/** Waits until the open popup's rows are as `ok` wants them and have stopped changing; answers them. */
async function settledRows(page, what, ok = () => true) {
  let last = "";
  return waitFor(what, async () => {
    const now = await treeRows(page), was = last;
    last = JSON.stringify(now);
    return last === was && (await ok(now)) ? now : saw(now);
  }, { timeout: 15_000, every: 200 });
}

/**
 * Views a branch of a chat through the tree popup: a double click on the row the branch ends at,
 * which names the branch in `data-end`. ("● here" is on the end of the branch this page shows,
 * whichever the server's current one is, so it does not tell the branches apart.) `open` opens the
 * popup (the header's Tree button). The popup draws the tree the page keeps, fetched when the chat
 * was selected and kept current by the server's `tree` events, so no request is waited for: the
 * rows are read once they have settled.
 */
async function viewBranchVia(page, branch, open = () => page.locator(".fk-tree-btn").click()) {
  await open();
  const nav = page.locator(".fk-nav");
  await nav.waitFor({ timeout: 10_000 });
  const row = endRow(page, branch);
  const rows = await settledRows(page, `the tree shows the row branch ${branch} ends at`, async () => (await row.count()) === 1);
  await row.dblclick();
  await waitFor("the double click closes the tree", async () => (await nav.count()) === 0, { timeout: 10_000 });
  return rows;
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

    ids.chat1 = await newChatVia(page, () => hoverClick(page, groupHead(page, "Research"), 'button[title="New in Research"]'), "claude");
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
    ids.u1 = await newChatVia(page, async () => { await page.locator("button.icon-btn.new").click(); }, "claude");
    await pickModelId(page, "sonnet");
    await pickEffort(page, "Medium");
    await pickFolder(page, ids.u1, folders.A);

    ids.chat2 = await newChatVia(page, () => hoverClick(page, groupHead(page, "Research"), 'button[title="New in Research"]'), "claude");
    await pickFolder(page, ids.chat2, folders.B);
    const c2 = await chatView(ids.chat2);

    ids.chat3 = await newChatVia(page, () => hoverClick(page, groupHead(page, "Research"), 'button[title="New in Research"]'), "claude");
    const c3 = await chatView(ids.chat3);
    check(c3.cwd === folders.B, "the third chat starts in the folder picked in the second", { third: c3.cwd, picked: folders.B });
    check(c3.model === c2.model && (c3.effort ?? "") === (c2.effort ?? ""), "the third chat has the second's model and effort", { second: [c2.model, c2.effort], third: [c3.model, c3.effort] });
    // name it, so later steps can find it in the sidebar
    await page.locator(".chat-head-name").click();
    await page.locator(".chat-head .name-input").fill("codeword chat");
    await page.locator(".chat-head .name-input").press("Enter");
    await waitFor("the third chat is renamed", async () => (await chatView(ids.chat3)).name === "codeword chat");

    ids.u2 = await newChatVia(page, async () => { await page.locator("button.icon-btn.new").click(); }, "claude");
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
    ids.claudeBoard = await newChatVia(page, () => page.locator(".board-bar button", { hasText: "+ Chat on this board" }).click(), "claude");
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
    ids.cursorBoard = await newChatVia(page, () => page.locator(".board-bar button", { hasText: "+ Chat on this board" }).click(), "cursor");
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

  // ---- Steps 9a to 9f: two pages on one server (plans/multiple-remote-servers.md, phase 7). Each
  // board is held by one page at a time and only its holder writes it; a stored drawing and a
  // draft have a revision, which a write names; every page uses every chat. The second page has a
  // browser context of its own: another localStorage, so another client id, and a network that is
  // cut by itself. No agent runs before step 9f, which has one short turn.
  let context2 = null, page2 = null;
  const second = async () => {
    if (page2 && !page2.isClosed()) return page2;
    context2 ??= await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const p = await context2.newPage();
    p.on("request", (r) => { const id = r.headers()["x-aiwb-client"]; if (id) clientIds.set(p, id); });
    p.on("pageerror", (e) => log(`    [page 2 error] ${e.message}`));
    p.on("console", (m) => { if (m.type() === "error") log(`    [page 2 console error] ${m.text()}`); });
    await p.goto(BASE + "/");
    await p.locator(".side").waitFor();
    return (page2 = p);
  };
  // The shapes toolbar is drawn only for the page that holds the board: any other page has the canvas in view mode, or the panel in its place.
  const TOOLBAR = '[data-testid="toolbar-rectangle"]';
  const DROPPED = "A change made here was not saved in time and was dropped.";
  const panel = (p) => p.locator(".board-canvas .takeover-panel");
  const panelHead = (p) => panel(p).locator("h2", { hasText: "Open in another window" });
  const useHere = (p) => panel(p).locator("button", { hasText: "Use here" });
  const canvasText = (p) => p.locator(".board-canvas").innerText().catch(() => "(no board on screen)");
  const showsPanel = async (p, what) => {
    await panelHead(p).waitFor({ timeout: 15_000 }).catch(() => {});
    check(await panelHead(p).isVisible(), what, await canvasText(p));
  };
  /** Waits until the board is on screen in the page and the page's to draw on. */
  const drawable = (p, id, what) => waitFor(what, async () => ((await sel(p)).board === id && await p.locator(TOOLBAR).isVisible()) || saw(await canvasText(p)), { timeout: 20_000 });
  /** Makes the page the holder of a board, with the board on screen: a click on its row asks for it, and "Use here" where the panel shows. */
  const holdOn = async (p, name, id) => {
    if ((await sel(p)).board !== id) await boardRow(p, name).click();
    await waitFor(`${name} is on screen and the page's to draw on`, async () => {
      if ((await sel(p)).board === id && await p.locator(TOOLBAR).isVisible()) return true;
      if (await useHere(p).isVisible()) await useHere(p).click();
      return saw(await canvasText(p));
    }, { timeout: 20_000 });
  };
  /** The start of a hand-off of arch: `holder` draws on it, and `other` has it on screen behind the panel. */
  const stage = async (holder, other) => {
    const staged = async () => (await sel(other)).board === ids.arch && await panelHead(other).isVisible() && (await sel(holder)).board === ids.arch && await holder.locator(TOOLBAR).isVisible();
    if (await staged()) return;
    await holdOn(other, "arch", ids.arch);
    await holdOn(holder, "arch", ids.arch);
    await panelHead(other).waitFor({ timeout: 15_000 });
  };
  /** Draws a rectangle and returns it once it is in the board's file. */
  const drawOn = async (p, board, fx, fy, what) => {
    const before = idSet(board);
    await p.keyboard.press("Escape");
    await drawRect(p, fx, fy);
    return newElement(board, before, "rectangle", what);
  };
  const has = (board, id) => liveElements(board).some((e) => e.id === id);
  /** What a stored drawing holds: its live elements, each with its version. */
  const drawn = (board) => liveElements(board).map((e) => [e.id, e.version]);
  /** Whether a stored drawing is still what `was` (from drawn) held: no element is gone or back at an older version, and none
   *  was added. A page that wrote an older drawing over a newer one, or an edit that was to be dropped, shows as one of these. */
  const unchanged = (board, was) => { const now = new Map(drawn(board)); return now.size === was.length && was.every(([id, v]) => (now.get(id) ?? -1) >= v); };
  /** The revision the server stores a board's drawing at. */
  const sceneRev = async (board) => Number((await fetch(`${BASE}/api/boards/${board}/scene`)).headers.get("x-aiwb-scene-rev"));
  /** Holds back the page's requests that `match` picks (they wait in `held`) until off(), which lets them go and ends the hold. */
  const holdRequests = async (p, url, match) => {
    const held = [];
    let open = false;
    const handler = async (route) => {
      if (!open && match(route.request())) await new Promise((go) => held.push(go));
      await route.continue().catch(() => {});
    };
    await p.route(url, handler);
    return { held, off: async () => { open = true; for (const go of held.splice(0)) go(); await p.unroute(url, handler).catch(() => {}); } };
  };
  /** Cuts the second page off, as when its connection dies: its context goes offline, and its event stream is ended at the
   *  server (a stream opened with a connected id ends the older one; a browser may keep a stream that was open before it
   *  went offline). The page then shows "Reconnecting…" and tries again until the context is back online. */
  const cutOff = async (p) => {
    await context2.setOffline(true);
    await new Promise((done) => {
      const req = http.get(`${BASE}/api/events?client=${clientIds.get(p)}`, (res) => res.once("data", () => { req.destroy(); done(); }));
      req.on("error", done);
      setTimeout(() => { req.destroy(); done(); }, 5000);
    });
    await p.locator(".side .offline").waitFor({ timeout: 30_000 }).catch(() => {});
    check(await p.locator(".side .offline").isVisible(), 'the page that is cut off says "Reconnecting…"', await p.locator(".side").innerText());
  };
  const SAVE_WAIT = 1200; // longer than the page's save delay: a page that had something to write has sent it by then

  await step("9a", "Two pages work on two boards at once: each saves its own, and neither shows the take-over panel", async () => {
    const p2 = await second();
    const idsOf = await waitFor("each page has a client id of its own", () => { const a = clientIds.get(page), b = clientIds.get(p2); return a && b && a !== b ? [a, b] : saw({ first: a, second: b }); }, { timeout: 10_000 });
    log(`    clients ${idsOf.join(" and ")}`);
    await holdOn(page, "arch", ids.arch);
    await holdOn(p2, "scratch", ids.scratch); // taken from the first page, which made scratch and does not show it
    check((await panel(page).count()) === 0, "the first page shows no panel: the board it lost is not the one on its screen", await canvasText(page));
    const rev0 = { arch: await sceneRev(ids.arch), scratch: await sceneRev(ids.scratch) };
    const beforeA = idSet(ids.arch), beforeS = idSet(ids.scratch);
    await page.keyboard.press("Escape");
    await p2.keyboard.press("Escape");
    await Promise.all([drawRect(page, 0.4, 0.75), drawRect(p2, 0.4, 0.4)]);
    const ra = await newElement(ids.arch, beforeA, "rectangle", "the first page's rectangle is saved on arch");
    const rs = await newElement(ids.scratch, beforeS, "rectangle", "the second page's rectangle is saved on scratch");
    check(!has(ids.scratch, ra.id) && !has(ids.arch, rs.id), "each rectangle is in its own board's file only", { arch: liveElements(ids.arch).map(brief), scratch: liveElements(ids.scratch).map(brief) });
    const rev1 = { arch: await sceneRev(ids.arch), scratch: await sceneRev(ids.scratch) };
    check(rev1.arch > rev0.arch && rev1.scratch > rev0.scratch, "the stored revision of each board rose", { before: rev0, after: rev1 });
    await sleep(500);
    check((await panel(page).count()) === 0 && (await panel(p2).count()) === 0, "neither page shows the take-over panel", { first: await canvasText(page), second: await canvasText(p2) });
    check(await page.locator(TOOLBAR).isVisible() && await p2.locator(TOOLBAR).isVisible(), "both pages can go on drawing", { first: await canvasText(page), second: await canvasText(p2) });
  });

  await step("9b", "A page takes a board another page holds: the pending edit is written first; the panel replaces that board's canvas only; Use here shows the stored drawing", async () => {
    const p2 = await second();
    await holdOn(page, "arch", ids.arch);
    await holdOn(p2, "scratch", ids.scratch);
    // What the first page sends about arch, in order: the board is let go only after the edit is written.
    const sent = [];
    const onResponse = (r) => { if (r.request().method() === "PUT" && new URL(r.url()).pathname === `/api/boards/${ids.arch}/scene`) sent.push(`saved ${r.status()}`); };
    const onRequest = (q) => { if (q.method() === "POST" && new URL(q.url()).pathname === `/api/boards/${ids.arch}/release`) sent.push("release"); };
    page.on("response", onResponse);
    page.on("request", onRequest);
    try {
      const before = idSet(ids.arch);
      await page.keyboard.press("Escape");
      await drawRect(page, 0.5, 0.75);
      const savedAlready = liveElements(ids.arch).some((e) => !before.has(e.id));
      await boardRow(p2, "arch").click(); // a click on a board asks for it
      await showsPanel(page, 'the page that held arch shows "Open in another window" in place of its canvas');
      const r1 = liveElements(ids.arch).find((e) => e.type === "rectangle" && !before.has(e.id));
      check(!!r1, `its pending edit is in the file${savedAlready ? " (it was already saved before the take)" : ""}`, liveElements(ids.arch).map(brief));
      const saves = sent.filter((x) => x.startsWith("saved"));
      check(saves.length > 0 && saves.every((x) => x === "saved 200") && sent.includes("release") && sent.lastIndexOf("saved 200") < sent.indexOf("release"),
        "the edit was written and accepted before the board was let go", sent);
      check((await panel(page).locator(".takeover-dropped").count()) === 0, "the panel tells of no dropped change", await canvasText(page));

      // The page that got the board draws on the stored drawing: what it saves next holds the other page's edit too.
      await drawable(p2, ids.arch, "the second page has arch and can draw on it");
      const r2 = await drawOn(p2, ids.arch, 0.6, 0.4, "the second page's rectangle is saved on arch");
      check(has(ids.arch, r1.id) && has(ids.arch, r2.id), "the file has the rectangles of both pages", liveElements(ids.arch).map(brief));

      // Beside the panel the rest of the first page is in use. A chat of the board that shows the panel is opened without taking the board.
      await openChat(page, ids.claudeBoard);
      await sleep(500);
      check(await panelHead(page).isVisible() && await page.locator(".side").isVisible() && await page.locator(".composer .composer-input").isVisible(),
        "beside the panel the sidebar and the board's chat are in use", await page.locator("body").innerText());
      check(await p2.locator(TOOLBAR).isVisible() && (await panel(p2).count()) === 0, "opening the board's chat took nothing from the second page", await canvasText(p2));

      // "Use here" takes the board back: the canvas shows the stored drawing, not the one this page kept.
      const stored = drawn(ids.arch);
      await useHere(page).click();
      await drawable(page, ids.arch, 'after "Use here" the first page draws on arch');
      await showsPanel(p2, "the second page shows the panel in its turn");
      await sleep(SAVE_WAIT);
      check(unchanged(ids.arch, stored), "taking the board back wrote no older drawing over the stored one", { before: stored, after: drawn(ids.arch) });
      const r3 = await drawOn(page, ids.arch, 0.45, 0.5, "the first page's next rectangle is saved on arch");
      check([r1, r2, r3].every((r) => has(ids.arch, r.id)), '"Use here" showed the stored drawing: the file has every rectangle of both pages', liveElements(ids.arch).map(brief));

      // The page that lost arch uses another board and a chat.
      await boardRow(p2, "scratch").click();
      await drawable(p2, ids.scratch, "the second page draws on scratch, which it still holds");
      check((await panel(p2).count()) === 0, "the panel was for arch only: scratch shows none", await canvasText(p2));
      await drawOn(p2, ids.scratch, 0.6, 0.6, "the second page's rectangle is saved on scratch");
      await openChat(p2, ids.chat1);
      await p2.locator(".thread").waitFor({ timeout: 10_000 });
      check(await p2.locator(".composer .composer-input").isVisible(), "the second page has a chat open with its thread and its composer", await p2.locator("body").innerText());
      check(await page.locator(TOOLBAR).isVisible() && (await panel(page).count()) === 0, "the first page still draws on arch", await canvasText(page));
    } finally { page.off("response", onResponse); page.off("request", onRequest); }
  });

  await step("9c", "No older drawing is written over a newer one: a page that takes a board back, a write held up past the hand-over delay, a page cut off and back", async () => {
    const p2 = await second();
    const sceneURL = new RegExp(`/api/boards/${ids.arch}/scene`);
    const isScenePut = (r) => r.request().method() === "PUT" && new URL(r.url()).pathname === `/api/boards/${ids.arch}/scene`;

    // T11 X1. The second page had arch and lost it; the first page changes it; the second page comes back.
    log("    -- a page that lost a board takes it back");
    await stage(p2, page);
    await holdOn(page, "arch", ids.arch); // the second page keeps the drawing as it was, behind the panel
    await showsPanel(p2, "the second page lost arch and shows the panel");
    const x = await drawOn(page, ids.arch, 0.55, 0.35, "the first page's change is saved: the stored drawing is newer than the one the second page keeps");
    let stored = drawn(ids.arch), rev = await sceneRev(ids.arch);
    await useHere(p2).click();
    await drawable(p2, ids.arch, "the second page has arch back");
    await sleep(SAVE_WAIT);
    check(unchanged(ids.arch, stored) && has(ids.arch, x.id), "the drawing it kept was not written: the file is the newer one", { before: stored, after: drawn(ids.arch) });
    check((await p2.locator(".canvas-note").count()) === 0, "nothing was dropped: the canvas shows no note", await canvasText(p2));
    const y = await drawOn(p2, ids.arch, 0.65, 0.55, "the second page's next rectangle is saved");
    check(has(ids.arch, x.id) && has(ids.arch, y.id) && (await sceneRev(ids.arch)) > rev, "it was drawn on the newer drawing: the file has both changes", liveElements(ids.arch).map(brief));

    // T11 X3 (b). The holder's write is held up for longer than the hand-over delay (3 s).
    log("    -- a holder that cannot write its pending edit in time");
    await stage(p2, page);
    stored = drawn(ids.arch);
    const hold = await holdRequests(p2, sceneURL, (q) => q.method() === "PUT");
    try {
      await p2.keyboard.press("Escape");
      await drawRect(p2, 0.4, 0.6); // pending: its write will wait in the hold
      const t0 = Date.now();
      await useHere(page).click();
      await panel(page).locator("p", { hasText: "Taking over from the other window…" }).waitFor({ timeout: 2500 }).catch(() => {});
      check(await panel(page).locator("p", { hasText: "Taking over from the other window…" }).isVisible(), "while the holder is asked, the taking page says it is taking over", await canvasText(page));
      await drawable(page, ids.arch, "the first page gets arch without the holder's answer");
      const took = Date.now() - t0;
      check(took >= 2500 && hold.held.length > 0, "it got the board at the end of the hand-over delay, with the holder's write still on its way", { ms: took, held: hold.held.length });
      await showsPanel(p2, "the page that lost arch shows the panel");
      const line = panel(p2).locator(".takeover-dropped");
      check((await line.count()) === 1 && (await line.innerText()).trim() === DROPPED, "its panel says the change was dropped", await canvasText(p2));
      check(unchanged(ids.arch, stored), "the file is as before: the edit was not written", { before: stored, after: drawn(ids.arch) });
      const q = await drawOn(page, ids.arch, 0.7, 0.4, "the new holder's rectangle is saved");
      stored = drawn(ids.arch);
      rev = await sceneRev(ids.arch);
      // The write arrives late.
      const late = p2.waitForResponse(isScenePut, { timeout: 15_000 });
      await hold.off();
      const res = await late;
      const body = await res.json().catch(() => ({}));
      check(res.status() === 409 && body.code === "not_holder", "the write that arrives late is refused: another window holds the board", { status: res.status(), body });
      await sleep(300);
      check(unchanged(ids.arch, stored) && (await sceneRev(ids.arch)) === rev && has(ids.arch, q.id), "the file is still the new holder's", { before: stored, after: drawn(ids.arch) });
      // The page takes the board back, and nothing else is done.
      await useHere(p2).click();
      await drawable(p2, ids.arch, 'after "Use here" the page that lost its edit draws on arch again');
      await sleep(SAVE_WAIT);
      check(unchanged(ids.arch, stored), "taking the board back put nothing of the dropped edit into the file", { before: stored, after: drawn(ids.arch) });
    } finally { await hold.off(); }

    // T11 X5. The holder's connection is cut, another page works on the board, the connection returns.
    log("    -- a page whose connection is cut, with another page at work when it returns");
    await stage(p2, page);
    try {
      await cutOff(p2);
      await p2.keyboard.press("Escape");
      await drawRect(p2, 0.5, 0.45); // an edit made while cut off: its write fails
      await sleep(SAVE_WAIT);
      await useHere(page).click();
      await drawable(page, ids.arch, "the first page takes arch, which the server freed when the stream ended");
      const w = await drawOn(page, ids.arch, 0.75, 0.65, "the first page's rectangle is saved");
      stored = drawn(ids.arch);
      rev = await sceneRev(ids.arch);
      await context2.setOffline(false);
      await waitFor("back on the server, the page shows the panel for arch and says its change was dropped", async () =>
        (await panelHead(p2).isVisible() && (await panel(p2).locator(".takeover-dropped").count()) === 1 && (await p2.locator(".side .offline").count()) === 0) || saw(await canvasText(p2)), { timeout: 45_000 });
      await sleep(SAVE_WAIT);
      check(await page.locator(TOOLBAR).isVisible() && (await panel(page).count()) === 0, "it took nothing back: the first page still draws on arch", await canvasText(page));
      check(unchanged(ids.arch, stored) && (await sceneRev(ids.arch)) === rev && has(ids.arch, w.id), "its older drawing was not written: the file is the first page's", { before: stored, after: drawn(ids.arch) });

      // The same cut with nobody else on the board: the edit is saved once the page is back.
      log("    -- a page whose connection is cut, with nobody else on the board");
      await useHere(p2).click();
      await drawable(p2, ids.arch, 'after "Use here" the second page draws on arch');
      await showsPanel(page, "the first page shows the panel");
      rev = await sceneRev(ids.arch);
      const before = idSet(ids.arch);
      await cutOff(p2);
      await p2.keyboard.press("Escape");
      await drawRect(p2, 0.35, 0.35);
      await sleep(SAVE_WAIT);
      check(!liveElements(ids.arch).some((e) => !before.has(e.id)) && await panelHead(page).isVisible(), "the edit is not in the file, and the first page asked for nothing", liveElements(ids.arch).map(brief));
      await context2.setOffline(false);
      const f = await waitFor("back on the server, the page saves the edit it made while cut off", () => liveElements(ids.arch).find((e) => e.type === "rectangle" && !before.has(e.id)) ?? null, { timeout: 45_000, every: 200 });
      check((await sceneRev(ids.arch)) > rev && has(ids.arch, f.id), "it was written on the revision the page had, which nobody had changed", { before: rev, after: await sceneRev(ids.arch) });
      check(await p2.locator(TOOLBAR).isVisible() && (await panel(p2).count()) === 0 && (await p2.locator(".canvas-note").count()) === 0, "the page draws on arch again, with no panel and no note", await canvasText(p2));
    } finally { await context2.setOffline(false).catch(() => {}); }
  });

  await step("9d", "A draft changed in another page is not overwritten: it is shown where nothing was typed, and a save on an older draft is refused", async () => {
    const p2 = await second();
    const chatJSON = path.join(HOME, "chats", ids.chat1, "chat.json");
    const stored = () => { const m = readJSON(chatJSON); return { text: m.drafts?.main?.text ?? "", rev: m.draftRevs?.main ?? 0 }; };
    const saved = (text, what) => waitFor(what, () => { const s = stored(); return s.text === text ? s : saw(s); }, { timeout: 10_000 });
    const ta = page.locator(".composer .composer-input"), tb = p2.locator(".composer .composer-input");
    const shows = (t, text, what) => waitFor(what, async () => (await t.innerText()).trim() === text || saw(await t.innerText()), { timeout: 10_000 });
    const draftURL = new RegExp(`/api/chats/${ids.chat1}/draft`);
    const isDraftPut = (r) => r.request().method() === "PUT" && new URL(r.url()).pathname === `/api/chats/${ids.chat1}/draft`;
    await openChat(page, ids.chat1);
    await openChat(p2, ids.chat1);
    await ta.waitFor();
    await tb.waitFor();

    // T11 X4, steps 1 to 4: the other page replaces a draft this page has on screen.
    await ta.fill("draft typed in the first page");
    const d1 = await saved("draft typed in the first page", "the first page's draft is saved");
    await shows(tb, d1.text, "the second page, where nothing was typed, shows the first page's draft");
    await tb.fill("draft typed in the second page");
    const d2 = await saved("draft typed in the second page", "the second page's draft replaces it");
    check(d2.rev > d1.rev, "the draft's counter rose", { before: d1, after: d2 });
    await shows(ta, d2.text, "the first page, where nothing was typed since its save, shows the second page's draft");
    await ta.pressSequentially("!");
    const d3 = await waitFor("a character typed in the first page is saved onto the second page's draft, not onto its own older one", () => {
      const s = stored();
      return s.text.includes("typed in the second page") && s.text.includes("!") && !s.text.includes("first page") ? s : saw(s);
    }, { timeout: 10_000 });
    await shows(tb, d3.text, "the second page shows that draft");

    // Steps 6 to 8: a save that reaches the server after the other page's.
    let hold = await holdRequests(page, draftURL, (q) => q.method() === "PUT");
    const puts = []; // the first page's saves, as answered: the counter each named and the status
    const onResponse = (r) => { if (isDraftPut(r)) puts.push({ base: Number(new URL(r.url()).searchParams.get("rev")), status: r.status() }); };
    try {
      await ta.fill("late text of the first page");
      await waitFor("the first page's save is on its way", () => hold.held.length === 1 || saw(`${hold.held.length} held`), { timeout: 5000, every: 50 });
      await tb.fill("newer text of the second page");
      const d4 = await saved("newer text of the second page", "the second page's draft is saved meanwhile");
      check((await ta.innerText()).trim() === "late text of the first page", "the first page keeps its text while its save is on its way", await ta.innerText());
      const late = page.waitForResponse(isDraftPut, { timeout: 15_000 });
      await hold.off();
      const res = await late;
      const body = await res.json().catch(() => ({}));
      check(res.status() === 409 && body.code === "stale" && body.rev === d4.rev && body.draft?.text === d4.text, "the late save is refused as stale and answered with the stored draft and its counter", { status: res.status(), body });
      check(stored().text === d4.text && stored().rev === d4.rev, "the stored draft is still the second page's", stored());
      await shows(ta, d4.text, "the first page, where nothing was typed since, shows the stored draft");

      // The same, with the user typing on while the save is on its way: what was typed stays, and is saved on the new counter.
      hold = await holdRequests(page, draftURL, (q) => q.method() === "PUT");
      page.on("response", onResponse);
      await ta.fill("the first page types on");
      await waitFor("the first page's save is on its way", () => hold.held.length === 1 || saw(`${hold.held.length} held`), { timeout: 5000, every: 50 });
      await tb.fill("the second page again");
      const d5 = await saved("the second page again", "the second page's draft is saved meanwhile");
      await ta.fill("the first page types on and on");
      await sleep(600); // longer than the composer's save delay: the next save waits for the one on its way
      await hold.off();
      const d6 = await saved("the first page types on and on", "what was typed since is saved");
      check((await ta.innerText()).trim() === "the first page types on and on", "the first page kept what was typed", await ta.innerText());
      await waitFor("both saves of the first page are answered", () => puts.length >= 2 || saw(puts), { timeout: 5000 });
      check(puts.length === 2 && puts[0].status === 409 && puts[1].status === 200 && puts[1].base === d5.rev && d6.rev === d5.rev + 1,
        "the save on the older draft was refused, and the next one named the stored draft's counter", { puts, stored: [d5, d6] });
      await shows(tb, d6.text, "the second page, where nothing was typed since, shows it");
    } finally { page.off("response", onResponse); await hold.off(); }

    await ta.fill("");
    await saved("", "the draft is cleared");
    await shows(tb, "", "and the second page's composer is empty");
  });

  await step("9e", "A page of another origin gets nothing: its calls carry no client header and are refused, and the holder keeps its board", async () => {
    await holdOn(page, "arch", ids.arch);
    const victim = clientIds.get(page);
    const rev = await sceneRev(ids.arch);
    const other = http.createServer((q, s) => { s.writeHead(200, { "Content-Type": "text/html" }); s.end("<!doctype html><title>another origin</title>"); });
    await new Promise((ok, no) => { other.once("error", no); other.listen(0, "127.0.0.1", ok); });
    const origin = `http://127.0.0.1:${other.address().port}`;
    const context3 = await browser.newContext();
    // A stream needs no header. This one stays open while the other page calls: a client that only opened a stream.
    const lurker = randomUUID();
    const stream = await new Promise((resolve, reject) => {
      const req = http.get(`${BASE}/api/events?client=${lurker}`, (res) => {
        let buf = "";
        res.on("data", (d) => { buf += d; const m = /data: (.*)\n\n/.exec(buf); if (m) resolve({ req, hello: JSON.parse(m[1]) }); });
      });
      req.on("error", reject);
      setTimeout(() => reject(new Error("no hello on the event stream")), 5000);
    });
    try {
      check(stream.hello.type === "hello" && stream.hello.client === lurker && !("active" in stream.hello) && !("waiting" in stream.hello), "a stream opened without a header gets its hello, which tells of no role", stream.hello);
      const foreign = await context3.newPage();
      const answers = [];
      foreign.on("response", (r) => { const u = new URL(r.url()); if (u.origin === BASE && u.pathname.startsWith("/api/")) answers.push(`${r.request().method()} ${u.pathname} ${r.status()}`); });
      await foreign.goto(origin + "/");
      const paths = ["/api/rpc-reply", `/api/boards/${ids.arch}/release`, `/api/boards/${ids.arch}/take`, "/api/client/flushed"];
      const did = await foreign.evaluate(async ({ base, victim, paths }) => {
        // An EventSource sends no header of the page's choosing: the server opens the stream, and the browser lets this page read nothing of it.
        const stream = await new Promise((done) => {
          const es = new EventSource(`${base}/api/events?client=${crypto.randomUUID()}`);
          es.onmessage = () => { es.close(); done("read an event"); };
          es.onerror = () => { es.close(); done("error"); };
          setTimeout(() => { es.close(); done("nothing"); }, 5000);
        });
        // Without the client header a POST needs no preflight. Its body names the holder as the client.
        const plain = [];
        for (const p of paths) {
          plain.push(await fetch(base + p, { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ client: victim, id: "rpc_1", result: "forged" }) })
            .then((r) => r.type, (e) => `failed: ${e.message}`));
        }
        // With the header the browser asks the server first, and the server allows no other origin.
        const withHeader = await fetch(base + paths[2], { method: "POST", headers: { "Content-Type": "application/json", "X-AIWB-Client": victim }, body: "{}" })
          .then((r) => `answered ${r.status}`, () => "blocked");
        return { stream, plain, withHeader };
      }, { base: BASE, victim, paths });
      log(`    the other origin's page: stream ${did.stream}; plain posts ${did.plain.join(", ")}; with the header ${did.withHeader}`);
      check(did.stream !== "read an event", "the other origin's page reads nothing of the event stream", did);
      await waitFor("every post without the header is answered 409", () => paths.every((p) => answers.includes(`POST ${p} 409`)) || saw(answers), { timeout: 5000 });
      check(did.withHeader === "blocked", "a call with the client header is blocked by the browser: the server allows no other origin", did);
      await sleep(500);
      check(await page.locator(TOOLBAR).isVisible() && (await panel(page).count()) === 0, "the holder shows no panel and still draws on its board", await canvasText(page));
      const r = await drawOn(page, ids.arch, 0.5, 0.65, "the holder's next rectangle is saved");
      check((await sceneRev(ids.arch)) > rev && has(ids.arch, r.id), "its write is accepted: nothing was taken, released or written meanwhile", { before: rev, after: await sceneRev(ids.arch) });
    } finally {
      stream.req.destroy();
      await context3.close().catch(() => {});
      other.close();
    }
  });

  await step("9f", "Two pages with one chat open show the same thread after a turn", async () => {
    const p2 = await second();
    await openChat(page, ids.chat1);
    await openChat(p2, ids.chat1);
    const thread = (p) => p.locator(".thread .msg.user, .thread .msg.assistant").evaluateAll((els) => els.map((e) => `${e.classList.contains("user") ? "user" : "assistant"}: ${e.innerText.trim()}`));
    const word = `PAIRED-${token()}`;
    const text = `Reply with just the word ${word}.`;
    const before = await send(page, ids.chat1, text);
    await waitFor("the page that sent nothing shows the message", async () => { const t = await thread(p2); return t.some((m) => m.startsWith("user:") && m.includes(text)) || saw(t.slice(-3)); }, { timeout: 15_000 });
    const { items } = await waitTurn(ids.chat1, before);
    check(lastReply(items).includes(word), "the agent answered", lastReply(items));
    const same = await waitFor("both pages show the same thread, with the answer", async () => {
      const a = await thread(page), b = await thread(p2);
      return a.length > 0 && JSON.stringify(a) === JSON.stringify(b) && a.some((m) => m.startsWith("assistant:") && m.includes(word)) ? a : saw({ first: a.slice(-3), second: b.slice(-3) });
    }, { timeout: 15_000 });
    log(`    ${same.length} messages in each thread`);
  });

  // The second page goes: step 10 needs every page closed.
  if (context2) await context2.close().catch(() => {});
  shotPage = page;

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
    check(sse.hello.type === "hello" && sse.hello.client === cid, "the fresh client is connected (no tab is open)", sse.hello);
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
    // The sidebar is drawn from the server's push, which may come after the state read above.
    await waitFor("the group is gone from the sidebar", async () => (await groupHead(page, "Research").count()) === 0 || saw(await page.locator(".side-tree").innerText()), { timeout: 10_000 });

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
    await waitFor("the board is gone from the sidebar", async () => (await boardRow(page, "arch").count()) === 0 || saw(await page.locator(".side-tree").innerText()), { timeout: 10_000 });
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
    ids.claudeSubs = await newChatVia(page, async () => { await page.locator("button.icon-btn.new").click(); }, "claude");
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
    ids.cursorSubs = await newChatVia(page, async () => { await page.locator("button.icon-btn.new").click(); }, "cursor");
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
    ids.cursorDelivery = await newChatVia(page, async () => { await page.locator("button.icon-btn.new").click(); }, "cursor");
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
    ids.drafty = await newChatVia(page, async () => { await page.locator("button.icon-btn.new").click(); }, "claude");
    await pickModelId(page, CLAUDE_MODEL_ID);
    const text = "Reply with just the word DRAFTED.";
    const ta = page.locator(".composer .composer-input");
    await ta.pressSequentially(text);
    const chatJSON = path.join(HOME, "chats", ids.drafty, "chat.json");
    await waitFor("chat.json has the draft", async () => readJSON(chatJSON).drafts?.main?.text === text || saw(readJSON(chatJSON).drafts?.main), { timeout: 5000 });

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
    await waitFor("the draft is gone from chat.json", async () => readJSON(chatJSON).drafts?.main === undefined || saw(readJSON(chatJSON).drafts?.main), { timeout: 5000 });
    check((await ta.innerText()).trim() === "", "the composer is empty", await ta.innerText());
  });

  // ---- Concurrent branches (docs/concurrent-branches-plan.md, phase 1). Each step makes its own
  // chat. "Approved separately" is step 27b's: it needs a folder whose project settings make Claude
  // ask, as with --permission-mode auto it asks for nothing by itself.
  const CAP_TEXT = "this chat already has 1 branch working; wait for it to finish or stop it";
  const composerText = async () => (await page.locator(".composer .composer-input").innerText()).trim();
  const headSub = async () => (await page.locator(".chat-head-sub").innerText()).replace(/\s+/g, " ").trim();
  const alertText = async () => ((await page.locator(".fk-alert").count()) ? (await page.locator(".fk-alert").first().innerText()).trim() : "");
  /** The selected chat's sidebar row: its state class and second line. */
  const sideRow = () => page.locator(".side-row.is-chat.on").evaluate((e) => ({ st: [...e.classList].find((c) => c.startsWith("st-")) ?? "", sub: e.querySelector(".side-sub")?.textContent ?? "" }));
  /** A request of the API that changes something, made as the page's client (not by the page). */
  const call = async (method, p, body) => {
    const r = await fetch(BASE + p, {
      method, headers: { "Content-Type": "application/json", "X-AIWB-Client": clientIds.get(page) ?? "" }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const postMessage = (id, branch, text) => call("POST", `/api/chats/${id}/messages?branch=${encodeURIComponent(branch)}`, { text, context: "" });

  await step(21, "Two branches of one chat work at once; viewing one sends nothing; Stop stops only the branch shown, the other ends by itself", async () => {
    const gateA = newGate("21a"), gateB = newGate("21b");
    try {
      const id = ids.two = await branchChat(page);
      const a0 = await send(page, id, gatedTask("ALPHA", gateA));
      await waitGated(id, "main", gateA, a0);

      // The running branch's finished turn keeps its actions; nothing in the running turn offers one.
      const acts = await page.locator(".thread > .msg.assistant").evaluateAll((els) => els.map((e) => [...e.querySelectorAll(".fk-act")].map((b) => b.className.replace("fk-act ", ""))));
      check(acts.length > 0 && acts[0].includes("k-branch") && acts[0].includes("k-fork") && acts.slice(1).every((a) => !a.includes("k-branch") && !a.includes("k-fork")),
        "the first reply offers a branch and a fork while main runs; no reply of the running turn does", acts);
      const sendBtn = page.locator(".composer button.send:not(.stop)"), stop = page.locator(".composer button.send.stop");
      check(await sendBtn.isDisabled() && await stop.isVisible(), "on the running branch Send is greyed out and Stop shows", { sendDisabled: await sendBtn.isDisabled(), stop: await stop.isVisible() });

      // A second branch from the finished point, while main runs.
      await firstReplyAction(page, "k-branch");
      const banner = page.locator(".fk-banner .fk-banner-text");
      await banner.waitFor({ timeout: 10_000 });
      const said = (await banner.innerText()).trim();
      check(/^New branch after “.+”: your message starts it\. “.+” stays in the tree\.$/.test(said), `the banner tells of the new branch: ${said}`, said);
      const ta = page.locator(".composer .composer-input");
      await ta.fill(gatedTask("BRAVO", gateB));
      check(await sendBtn.isEnabled() && await stop.isVisible(), "Send is enabled for the new branch although its source runs, and Stop still shows", { sendEnabled: await sendBtn.isEnabled(), stop: await stop.isVisible() });
      const res = await typeSend(page, id, "", { typed: true });
      const B = res.body.branch;
      check(res.status === 200 && !!B && B !== "main", "the Send is accepted and its answer names the new branch", res);
      await waitGated(id, B, gateB, 0);
      const v = await chatView(id), recs = await branchStates(id);
      check(v.branches === 2 && v.working === 2 && v.branch === B, "the chat has 2 branches, both working; the new one is the branch last sent to", { branches: v.branches, working: v.working, branch: v.branch });
      check(recs.length === 2 && recs.every((r) => BUSY.has(r.status)), "the snapshot has two busy records, main's and the new branch's", recBrief(recs));
      check(pgrep(gateA).length > 0 && pgrep(gateB).length > 0, "both shell loops run", { a: pgrep(gateA), b: pgrep(gateB) });
      await waitCrumb(page, /^BRAVO/, "the view moved to the new branch (the crumb names it)");
      const alert = page.locator("button.fk-alert.quiet");
      await waitFor('the header says "1 other branch working"', async () => (await alertText()) === "1 other branch working" || saw(await alertText()), { timeout: 10_000 });
      log(`    crumb "${await crumbText(page)}", header alert "${await alertText()}", sidebar row ${JSON.stringify(await sideRow())}`);

      // The tree marks both; a double click on main's end views main and sends nothing.
      const sent = [];
      const onRequest = (r) => { if (r.method() !== "GET") sent.push(`${r.method()} ${new URL(r.url()).pathname}${new URL(r.url()).search}`); };
      page.on("request", onRequest);
      const rows = await viewBranchVia(page, "main", async () => {
        await alert.click(); // the alert opens the tree
        await waitFor("the tree marks two rows as working", async () => { const r = await treeRows(page); return r.filter((x) => /\bfk-run\b/.test(x.cls) && x.mark === "working").length === 2 || saw(r); }, { timeout: 15_000 });
      });
      log(`    tree rows: ${rowBrief(rows)}`);
      check(rows.filter((r) => /\bfk-run\b/.test(r.cls)).map((r) => r.endOf).sort().join() === ["main", B].sort().join(), "the working marks are on the two branches' end rows", rows);
      check(rows.filter((r) => r.here).map((r) => r.endOf).join() === B, '"● here" is on the end of the branch the page shows, the new one', rows);
      await waitCrumb(page, /^ALPHA/, "the crumb names main after the double click on its end");
      await sleep(500);
      page.off("request", onRequest);
      check(!sent.some((x) => /\/messages/.test(x)), `viewing made no POST …/messages (it sent: ${sent.join(", ") || "nothing"})`, sent);
      const after = await chatView(id);
      check(after.branch === B && after.working === 2, "viewing left the server's current branch and both turns as they were", { branch: after.branch, working: after.working });
      await waitFor('on main the header says "1 other branch working" too', async () => (await alertText()) === "1 other branch working" || saw(await alertText()), { timeout: 10_000 });

      // Stop on main stops main only. A turn the user stops ends as "ready" with a "Stopped." note
      // (the status "stopped" is for a turn the agent's process died in: step 26).
      await stop.click();
      const ra1 = await waitFor("main's turn is stopped: its record is not busy any more", async () => { const r = await branchRec(id, "main"); return !BUSY.has(r.status) ? r : saw(recBrief([r])); }, { timeout: 30_000 });
      await waitFor('main\'s items get one "Stopped." note', async () => stoppedNotes(await itemsOf(id, "main")) === 1 || saw((await itemsOf(id, "main")).filter((i) => i.kind === "note")), { timeout: 15_000 });
      await sleep(2000);
      const mid = await branchStates(id);
      check(mid.find((r) => r.branch === "main").status === "ready" && BUSY.has(mid.find((r) => r.branch === B).status) && pgrep(gateB).length > 0 && stoppedNotes(await itemsOf(id, B)) === 0,
        "after Stop on main the new branch is still busy in its loop, with no note of the Stop", { records: recBrief(mid), loopB: pgrep(gateB) });
      await waitFor("main's loop has ended with its turn", async () => pgrep(gateA).length === 0 || saw(pgrep(gateA).map((pid) => `${pid} ${argsOf(pid).slice(0, 80)}`)), { timeout: 15_000 });
      const note = page.locator(".thread .note", { hasText: /^Stopped\.$/ });
      await waitFor('main\'s thread shows "Stopped." and its composer no Stop', async () => (await note.count()) === 1 && (await stop.count()) === 0 || saw({ notes: await note.count(), stop: await stop.count() }), { timeout: 10_000 });
      check((await alertText()) === "1 other branch working" && (await chatView(id)).working === 1, 'the header still says "1 other branch working"', { alert: await alertText(), working: (await chatView(id)).working });

      // The other branch ends by itself, on its own branch.
      openGates(gateB);
      const rb = await waitBranchTurn(id, B, 0);
      const itemsB = await itemsOf(id, B), itemsA = await itemsOf(id, "main");
      check(rb.status === "ready" && /bravo/i.test(lastReply(itemsB)), "the new branch's turn ended with its reply on its own branch", { record: recBrief([rb]), reply: lastReply(itemsB) });
      const ra = await branchRec(id, "main");
      check(ra.status === "ready" && (ra.usage?.turns ?? 0) === (ra1.usage?.turns ?? 0) && stoppedNotes(itemsA) === 1 && !itemsA.some((i) => i.kind === "text" && /bravo/i.test(i.text ?? "")),
        "main stays as the Stop left it and got nothing of it", { record: recBrief([ra]), was: recBrief([ra1]) });
      await waitFor("the header alert goes once no other branch works", async () => (await alertText()) === "" || saw(await alertText()), { timeout: 10_000 });
      check(!(await chatView(id)).working, "the chat has no working branch", (await chatView(id)).working);
    } finally { openGates(gateA, gateB); }
  });

  await step(22, "A subagent's result reaches the branch that spawned it while another branch is shown", async () => {
    const gateS = newGate("22s");
    try {
      const id = ids.subBranch = await branchChat(page);
      const word = `RESULT-${token()}`;
      const a0 = await send(page, id, `${gatedSpawn(word, gateS)} When its result arrives, reply with just that result.`);
      await waitSpawned(id, "main", gateS, a0);
      // Another branch, B, is made and shown before the subagent finishes.
      const B = await branchFromFirstReply(page, id, "BRAVO task. Reply with just the word TWO.");
      const rb0 = await waitBranchTurn(id, B, 0);
      await waitCrumb(page, /^BRAVO/, "branch B is the one shown");
      const ra0 = await branchRec(id, "main");
      check(ra0.status === "ready" && ra0.subsRunning === 1, "branch A (main) is idle and its subagent still runs", recBrief([ra0]));
      check(await page.locator(".thread .sub-result").count() === 0 && await page.locator(".thread .subagent").count() === 0, "B's thread shows no subagent of A's", await page.locator(".thread").innerText());

      const ui = watchPage(async () => ({ crumb: (await crumbText(page)).slice(0, 5), alert: await alertText(), ...(await sideRow()) }));
      openGates(gateS);
      const ra = await waitFor("A's result has reached A's agent and its delivery turn has ended", async () => {
        const r = await branchRec(id, "main"), subs = await subsOf(id, "main");
        const ok = (r.usage?.turns ?? 0) > (ra0.usage?.turns ?? 0) && !BUSY.has(r.status) && !r.subsRunning && !r.subsOwed && subs.length === 1 && subs[0].delivery === "sent";
        return ok ? r : saw({ record: recBrief([r]), subs: subs.map((x) => [x.id, x.status, x.delivery]) });
      }, { timeout: TURN_TIMEOUT, every: 300 });
      await sleep(300);
      await ui.stop();
      log(`    the page while A's result was delivered: ${ui.seen.map((e) => `${e.crumb}/${e.alert || "-"}/${e.st}/${e.sub}`).join(" → ")} (crumb/alert/row state/row line)`);
      check(ui.seen.every((e) => e.crumb === "BRAVO"), "B stayed the branch shown", ui.seen);
      check(ui.seen.some((e) => e.alert === "1 other branch working"), 'while A\'s delivery turn ran, the header on B said "1 other branch working"', ui.seen);
      check(ui.seen.some((e) => e.sub === "1 branch working" && e.st === "st-thinking"), "and the sidebar row showed the chat as working", ui.seen);
      const itemsA = await itemsOf(id, "main"), itemsB = await itemsOf(id, B);
      check(resultItems(itemsA).length === 1 && resultItems(itemsB).length === 0, "the result row is in A's items and not in B's", { a: itemsA.map((i) => i.kind), b: itemsB.map((i) => i.kind) });
      check(ra.usage.turns === ra0.usage.turns + 1, `A's own turn count grew by the delivery turn (${ra0.usage.turns} → ${ra.usage.turns})`, recBrief([ra]));
      const lastA = itemsA.slice(itemsA.map((i) => i.kind).lastIndexOf("subresult") + 1).filter((i) => i.kind === "text").map((i) => i.text ?? "").join("\n").trim();
      check(lastA.includes(word), "A's agent answered with the subagent's result", lastA);
      const rb = await branchRec(id, B);
      check((rb.usage?.turns ?? 0) === (rb0.usage?.turns ?? 0) && rb.status === "ready" && !rb.subsRunning && !rb.subsOwed, "B ran no turn and has no subagent counts", recBrief([rb]));
      check((await chatView(id)).branch === B, "B is still the branch last sent to", (await chatView(id)).branch);
      check(await page.locator(".thread .sub-result").count() === 0, "B's thread still shows no result row", await page.locator(".thread .sub-result").allInnerTexts());

      // A, viewed afterwards, shows the row.
      await viewBranchVia(page, "main");
      await waitCrumb(page, /^ALPHA/, "A is shown after a double click on its end in the tree");
      const rowsA = await waitFor('A\'s thread shows the result row "sent to the agent"', async () => {
        const now = (await page.locator(".thread .sub-result").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
        return now.length === 1 && /sent to the agent$/.test(now[0]) ? now : saw(now);
      }, { timeout: 15_000 });
      log(`    result row on A: ${rowsA[0]}`);
    } finally { openGates(gateS); }
  });

  await step(23, "A fork to a new chat from a branch whose turn runs: the copy answers, the source runs on", async () => {
    const gateA = newGate("23a");
    try {
      const id = ids.forkSource = await branchChat(page);
      const a0 = await send(page, id, gatedTask("ALPHA", gateA));
      await waitGated(id, "main", gateA, a0);
      const before = new Set((await state()).chats.map((c) => c.id));
      const watch = watchChat(id);
      await firstReplyAction(page, "k-fork");
      const fork = await waitFor("a new chat is made and selected", async () => { const s = (await sel(page)).chat; return s && !before.has(s) ? s : saw(await sel(page)); }, { timeout: 30_000 });
      const fv = await chatView(fork);
      check(fv.forkedFrom === id && fv.forkedBranch === "main" && fv.forkedAt > 0 && fv.agent === "claude" && fv.model === "haiku", "the new chat names its source, the branch and the point; it is a Claude chat on Haiku",
        { forkedFrom: fv.forkedFrom, forkedBranch: fv.forkedBranch, forkedAt: fv.forkedAt, agent: fv.agent, model: fv.model });
      await page.locator(".thread .fk-forked").waitFor({ timeout: 10_000 });
      await page.locator(".thread .prefix-end").waitFor({ timeout: 10_000 });
      const users = await page.locator(".thread .msg.user").allInnerTexts();
      check(users.length === 1 && /word ONE/.test(users[0]), "the fork shows the copied finished turn and nothing of the running one", users);
      log(`    fork note: ${(await page.locator(".thread .fk-forked").innerText()).replace(/\s+/g, " ").trim()}`);
      const f0 = await send(page, fork, "Reply with just the word FORKED.");
      check(BUSY.has((await branchRec(id, "main")).status), "the source is busy when the fork's message is sent", recBrief(await branchStates(id)));
      const { items } = await waitTurn(fork, f0);
      check(/forked/i.test(lastReply(items)), "the fork's agent answers", lastReply(items));
      await watch.stop();
      const src = await branchRec(id, "main");
      check(BUSY.has(src.status) && pgrep(gateA).length > 0 && watch.seen.every((e) => BUSY.has(e.status) && e.turns === a0),
        "the source was busy in the same turn the whole time", { record: recBrief([src]), loop: pgrep(gateA), seen: watch.seen });
      check(!hasUser(await itemsOf(id, "main"), "Reply with just the word FORKED."), "the fork's message is not in the source", "it is");
      openGates(gateA);
      const end = await waitBranchTurn(id, "main", a0);
      check(end.status === "ready" && /alpha/i.test(lastReply(await itemsOf(id, "main"))), "the source's turn ends by itself once its gate opens", recBrief([end]));
    } finally { openGates(gateA); }
  });

  await step(24, "A draft is kept per branch: A's survives a Send on B, which clears only B's", async () => {
    const id = ids.draftBranches = await branchChat(page);
    const B = await branchFromFirstReply(page, id, "BRAVO task. Reply with just the word TWO.");
    await waitBranchTurn(id, B, 0);
    const chatJSON = path.join(HOME, "chats", id, "chat.json");
    const drafts = () => readJSON(chatJSON).drafts ?? {};
    const ta = page.locator(".composer .composer-input");

    // A is main: nothing was sent on it after the point B starts at, so it is still named "main".
    await viewBranchVia(page, "main");
    await waitCrumb(page, /^main$/, "A (main) is shown");
    const textA = "ALPHA draft, typed on A and not sent.";
    await ta.pressSequentially(textA);
    await waitFor("chat.json has A's draft as drafts.main", async () => drafts().main?.text === textA || saw(drafts()), { timeout: 5000 });

    const seen = await viewBranchVia(page, B);
    check(seen.filter((r) => r.here).map((r) => r.endOf).join() === "main" && (await chatView(id)).branch === B, 'with A shown the tree has "● here" on A\'s end, although B is the branch last sent to', seen);
    await waitCrumb(page, /^BRAVO/, "B is shown");
    await waitFor("B's composer is empty", async () => (await composerText()) === "" || saw(await composerText()), { timeout: 5000 });
    const textB = "Reply with just the word THREE.";
    await ta.pressSequentially(textB);
    await waitFor(`chat.json has B's draft as drafts.${B}`, async () => drafts()[B]?.text === textB && drafts().main?.text === textA || saw(drafts()), { timeout: 5000 });
    const b0 = (await branchRec(id, B)).usage?.turns ?? 0;
    const res = await typeSend(page, id, textB, { typed: true });
    check(res.status === 200 && res.body.branch === B, "the Send goes to B", res);
    await waitFor("the Send clears B's draft in chat.json and leaves A's", async () => drafts()[B] === undefined && drafts().main?.text === textA || saw(drafts()), { timeout: 5000 });
    const rb = await waitBranchTurn(id, B, b0);
    check(/three/i.test(lastReply(await itemsOf(id, B))), "B answers", lastReply(await itemsOf(id, B)));
    check(await composerText() === "", "B's composer is empty after the Send", await composerText());

    await viewBranchVia(page, "main");
    await waitCrumb(page, /^main$/, "A is shown again");
    await waitFor("A's composer holds A's text", async () => (await composerText()) === textA || saw(await composerText()), { timeout: 5000 });
    const recs = await branchStates(id);
    check(drafts().main?.text === textA && drafts()[B] === undefined, "chat.json still has A's draft and none for B", drafts());
    check(recs.find((r) => r.branch === "main").draft?.text === textA && !recs.find((r) => r.branch === B).draft && (await chatView(id)).hasDraft === true,
      "the records say the same: A's has the draft, B's has none, the chat has a draft", recs.map((r) => ({ branch: r.branch, draft: r.draft })));
    check(!hasUser(await itemsOf(id, "main"), textB) && rb.status === "ready", "nothing was sent on A", recBrief(recs));
  });

  await step(25, "At the cap a Send is refused and keeps its text; a subagent result that comes then stays owed and goes with the next message", async () => {
    const gateS = newGate("25s"), gateB = newGate("25b");
    try {
      // One working branch a chat (the test-only override, read at the server's start).
      await stopServer();
      await startServer({ ...process.env, AIWB_CHAT_CAP: "1" });
      await page.reload();
      await page.locator(".side").waitFor();
      const id = ids.capped = await branchChat(page);
      const word = `RESULT-${token()}`;
      // A (main) spawns a subagent and ends its turn: A is idle, and a subagent that only runs holds no slot.
      const a0 = await send(page, id, gatedSpawn(word, gateS));
      await waitSpawned(id, "main", gateS, a0);
      // B takes the chat's one slot: its Send would be refused if A's running subagent held it.
      const B = await branchFromFirstReply(page, id, gatedTask("BRAVO", gateB));
      await waitGated(id, B, gateB, 0);
      const v = await chatView(id), ra = await branchRec(id, "main");
      check(v.working === 1 && v.branches === 2 && ra.status === "ready" && ra.subsRunning === 1, "one branch of the chat works, the cap; A is idle and its subagent runs", { working: v.working, branches: v.branches, records: recBrief(await branchStates(id)) });

      // A Send on A is refused: the server's text shows and the message stays.
      await viewBranchVia(page, "main");
      await waitCrumb(page, /^ALPHA/, "A is shown");
      const ta = page.locator(".composer .composer-input");
      const later = "Reply with just the result the subagent reported.";
      const refused = await typeSend(page, id, later);
      check(refused.status === 429 && refused.body.code === "cap", "the Send on A gets 429 with code cap", refused);
      const err = page.locator(".composer .composer-err");
      await waitFor("the composer shows the server's text", async () => (await err.count()) > 0 && (await err.innerText()).trim() === CAP_TEXT || saw(await page.locator(".composer").innerText()), { timeout: 10_000 });
      log(`    ${(await err.innerText()).trim()}`);
      await sleep(500);
      check(await composerText() === later, "the composer still holds the message", await composerText());
      check(!hasUser(await itemsOf(id, "main"), later), "the message was not put on A", "it is in A's items");
      const direct = await postMessage(id, "main", "hi");
      check(direct.status === 429 && direct.body.code === "cap" && direct.body.error === CAP_TEXT, "a POST …/messages?branch=main gets 429, code cap, with that text", direct);
      const own = await postMessage(id, B, "hi");
      check(own.status === 409 && own.body.code === "busy", "a POST to the working branch itself gets 409 busy, not the cap", own);
      // A new branch is refused the same way, and its banner stays.
      const kept = await composerText();
      await firstReplyAction(page, "k-branch");
      await page.locator(".fk-banner").waitFor({ timeout: 10_000 });
      const refused2 = await typeSend(page, id, "", { typed: true });
      check(refused2.status === 429 && refused2.body.code === "cap", "a Send that would start a third branch gets 429 with code cap", refused2);
      await waitFor("the text shows again", async () => (await err.count()) > 0 && (await err.innerText()).trim() === CAP_TEXT || saw(await page.locator(".composer").innerText()), { timeout: 10_000 });
      await sleep(500);
      check(await page.locator(".fk-banner").count() === 1 && await composerText() === kept, "the pending-branch banner and the message stay", { banner: await page.locator(".fk-banner").count(), text: await composerText() });
      check((await chatView(id)).branches === 2, "no branch was made", (await chatView(id)).branches);
      await page.locator(".fk-banner button", { hasText: "Back" }).click();
      await waitFor("Back drops the pending branch; A is shown with the message", async () => {
        const now = { banner: await page.locator(".fk-banner").count(), crumb: await crumbText(page), text: await composerText() };
        return now.banner === 0 && /^ALPHA/.test(now.crumb) && now.text === kept || saw(now);
      }, { timeout: 10_000 });

      // The subagent ends while the chat is at the cap: its result is owed on A and starts no turn.
      const ra0 = await branchRec(id, "main");
      openGates(gateS);
      await waitFor("the result is owed on A (subsOwed in A's record)", async () => { const r = await branchRec(id, "main"); return r.subsOwed === 1 && !r.subsRunning || saw(recBrief([r])); }, { timeout: TURN_TIMEOUT, every: 300 });
      const waiting = page.locator(".thread .typing.waiting");
      await waitFor("A's thread says the result is not sent yet", async () => (await waiting.count()) > 0 && /1 subagent result not sent yet/.test(await waiting.innerText()) || saw(await page.locator(".thread").innerText()), { timeout: 10_000 });
      log(`    ${(await waiting.innerText()).trim()}`);
      const owed = async (when) => {
        const r = await branchRec(id, "main");
        if (r.subsOwed !== 1 || r.status !== "ready" || (r.usage?.turns ?? 0) !== (ra0.usage?.turns ?? 0) || !(await waiting.count())) {
          throw new Fail(`${when}: the result stays owed on A and shown as owed, and no turn starts on A`, { record: recBrief([r]), was: recBrief([ra0]), shown: await waiting.count() });
        }
      };
      for (const until = Date.now() + 8000; Date.now() < until; await sleep(500)) await owed("for 8 s at the cap");
      log("    ok  for 8 s at the cap: the result stays owed on A and shown as owed, and no turn starts on A");
      const row = await sideRow();
      check(/^st-(thinking|writing|tool)$/.test(row.st), "the sidebar row shows the chat as working (B works)", row);

      // B ends: the slot is free, and the result still waits for the user's next message.
      openGates(gateB);
      await waitBranchTurn(id, B, 0);
      for (const until = Date.now() + 4000; Date.now() < until; await sleep(500)) await owed("for 4 s after B's turn ended");
      log("    ok  for 4 s after B's turn ended: still owed, no turn started by itself");
      const sent = await typeSend(page, id, "", { typed: true });
      check(sent.status === 200 && sent.body.branch === "main", "the same message is accepted on A now", sent);
      const ra1 = await waitBranchTurn(id, "main", ra0.usage?.turns ?? 0);
      const itemsA = await itemsOf(id, "main"), subs = await subsOf(id, "main");
      check(!ra1.subsOwed && subs.length === 1 && subs[0].delivery === "sent" && resultItems(itemsA).length === 1, "the result went with it: nothing owed, the subagent's result is sent, A has its row",
        { record: recBrief([ra1]), subs: subs.map((x) => [x.id, x.status, x.delivery]), kinds: itemsA.map((i) => i.kind) });
      check(lastReply(itemsA).includes(word), "A's agent answers with the subagent's result", lastReply(itemsA));
      await waitFor("the refusal text and the owed line are gone", async () => (await err.count()) === 0 && (await waiting.count()) === 0 || saw(await page.locator(".composer").innerText()), { timeout: 10_000 });
    } finally {
      openGates(gateS, gateB);
      // The default caps again.
      await stopServer();
      await startServer();
      await page.reload();
      await page.locator(".side").waitFor();
    }
  });

  await step(26, "After a restart both branches show as stopped, each by itself; a Send on one continues only that one", async () => {
    const gateA = newGate("26a"), gateB = newGate("26b");
    try {
      const id = ids.restarted = await branchChat(page);
      const a0 = await send(page, id, gatedTask("ALPHA", gateA));
      await waitGated(id, "main", gateA, a0);
      const B = await branchFromFirstReply(page, id, gatedTask("BRAVO", gateB));
      await waitGated(id, B, gateB, 0);
      check((await branchStates(id)).every((r) => BUSY.has(r.status)) && (await chatView(id)).working === 2, "both branches are in a turn when the server stops", recBrief(await branchStates(id)));
      await stopServer();
      openGates(gateA, gateB); // what the stopped server left of the two loops ends
      await startServer();
      await page.reload();
      await page.locator(".side").waitFor();
      await waitFor("the chat is selected after the restart", async () => (await sel(page)).chat === id || saw(await sel(page)));
      const recs = await branchStates(id), v = await chatView(id);
      check(recs.length === 2 && recs.every((r) => r.status === "stopped") && !v.working, "both records are stopped and no branch works", { records: recBrief(recs), working: v.working });

      // Each branch, viewed, shows its own stopped state.
      await waitCrumb(page, /^BRAVO/, "B, the branch last sent to, is shown after the reload");
      await waitFor('B\'s header says "Stopped"', async () => /Stopped/.test(await headSub()) || saw(await headSub()), { timeout: 10_000 });
      const row = await sideRow();
      check(row.sub === "Stopped" && row.st === "st-stopped", 'the sidebar row says "Stopped"', row);
      check((await alertText()) === "", "the header has no alert about another branch", await alertText());
      await viewBranchVia(page, "main");
      await waitCrumb(page, /^ALPHA/, "A is shown");
      await waitFor('A\'s header says "Stopped"', async () => /Stopped/.test(await headSub()) || saw(await headSub()), { timeout: 10_000 });
      check(await page.locator(".composer button.send.stop").count() === 0, "A's composer shows no Stop", "it shows Stop");

      // A Send on B continues B alone.
      const seen = await viewBranchVia(page, B);
      check(seen.filter((r) => r.here).map((r) => r.endOf).join() === "main" && seen.filter((r) => /\bfk-stopped\b/.test(r.cls)).map((r) => r.endOf).sort().join() === ["main", B].sort().join(),
        'with A shown the tree has "● here" on A\'s end and marks both ends as stopped', seen);
      await waitCrumb(page, /^BRAVO/, "B is shown again");
      const b0 = (await branchRec(id, B)).usage?.turns ?? 0, turnsA = (await branchRec(id, "main")).usage?.turns ?? 0;
      const text = "Reply with just the word BACK.";
      const res = await typeSend(page, id, text);
      check(res.status === 200 && res.body.branch === B, "the Send goes to B", res);
      const rb = await waitBranchTurn(id, B, b0);
      check(rb.status === "ready" && /back/i.test(lastReply(await itemsOf(id, B))), "B answers", { record: recBrief([rb]), reply: lastReply(await itemsOf(id, B)) });
      const ra = await branchRec(id, "main");
      check(ra.status === "stopped" && (ra.usage?.turns ?? 0) === turnsA && !hasUser(await itemsOf(id, "main"), text), "A's record stays stopped: nothing ran on A", recBrief([ra]));
      await waitFor('B\'s header no longer says "Stopped"', async () => !/Stopped/.test(await headSub()) || saw(await headSub()), { timeout: 10_000 });
      await viewBranchVia(page, "main");
      await waitCrumb(page, /^ALPHA/, "A is shown");
      await waitFor('A\'s header still says "Stopped"', async () => /Stopped/.test(await headSub()) || saw(await headSub()), { timeout: 10_000 });
    } finally { openGates(gateA, gateB); }
  });

  // ---- Concurrent branches, phase 2: the tree popup while branches work. Not here, as unit tests
  // cover them: the marks of an error, of a turn cut by a restart and of running subagents, and the
  // model note. The approval mark and a branch started from a row are step 27b's.
  await step(27, "The tree popup stays current during a run: marks, Stop from a row, a fork link, the folder hint, no tree fetch", async () => {
    const gateA1 = newGate("27a1"), gateA2 = newGate("27a2"), gateB = newGate("27b");
    const nav = page.locator(".fk-nav"), treeBtn = page.locator(".fk-tree-btn");
    const stop = page.locator(".composer button.send.stop");
    const isRun = (r) => /\bfk-run\b/.test(r.cls), isReply = (r) => /\bk-text\b/.test(r.cls);
    const hereOf = (rows) => rows.filter((r) => r.here).map((r) => r.endOf).join();
    // What the page itself asks of the server about this chat from the popup's first opening on.
    let id = "";
    const treeGets = [], posts = [];
    const onRequest = (r) => {
      const u = new URL(r.url());
      if (r.method() === "GET" && u.pathname === `/api/chats/${id}/tree`) treeGets.push(new Date().toISOString());
      if (r.method() === "POST" && u.pathname === `/api/chats/${id}/messages`) posts.push(u.pathname + u.search);
    };
    const noFetch = (when) => check(treeGets.length === 0, `${when}: the page has made no GET …/tree for the chat since the popup first opened`, treeGets);
    try {
      id = ids.live = await branchChat(page);
      const at = (await itemsOf(id, "main")).findIndex((i) => i.kind === "end") + 1;
      check(at > 0, `the first turn ends at item count ${at}: the point the branch and the fork start from`, (await itemsOf(id, "main")).map((i) => i.kind));
      // A, on main: a turn that waits on two gates, one after the other.
      const textA = gatedTask2("ALPHA", gateA1, gateA2);
      const a0 = await send(page, id, textA);
      await waitGated(id, "main", gateA1, a0);

      // The popup, opened while main works: the tree was fetched when the chat was selected.
      page.on("request", onRequest);
      await treeBtn.click();
      await nav.waitFor({ timeout: 10_000 });
      let rows = await settledRows(page, "the tree marks one row as working", (r) => r.filter(isRun).length === 1);
      log(`    tree rows: ${rowBrief(rows)}`);
      const runA = rows.find(isRun);
      check(runA.mark === "working" && runA.stop && runA.endOf === "main" && runA.here, 'main\'s end row is marked "working", has Stop, and is "● here"', rows);

      // B starts elsewhere (the API) with the popup open.
      const textB = gatedTask("BRAVO", gateB);
      const made = await call("POST", `/api/chats/${id}/messages`, { text: textB, context: "", target: { branch: "main", at, new: true } });
      const B = made.body.branch;
      check(made.status === 200 && !!B && B !== "main", "a message sent through the API starts a new branch at the first reply", made);
      await waitGated(id, B, gateB, 0);
      rows = await settledRows(page, "the open popup gets B's row: two rows are marked as working", (r) => r.filter(isRun).length === 2 && r.some((x) => x.endOf === B));
      log(`    tree rows: ${rowBrief(rows)}`);
      const rowB = rows.find((r) => r.endOf === B);
      check(isRun(rowB) && rowB.mark === "working" && rowB.stop && rowB.text.startsWith("BRAVO task."), "B's message is a row, marked \"working\" with Stop", rows);
      const v = await chatView(id);
      check(hereOf(rows) === "main" && v.branch === B && v.working === 2, '"● here" stays on main\'s end, the branch the page shows, although B is now the server\'s current branch', { here: hereOf(rows), current: v.branch, working: v.working });
      await waitCrumb(page, /^ALPHA/, "the chat under the popup still shows main (the crumb names it)");

      // The agents in the folder: both in the popup's foot, the other one beside the composer.
      const footHint = page.locator(".fk-nav-foot .fk-folder-agents"), chip = page.locator(".composer .folder-agents");
      await waitFor('the popup\'s foot says "2 agents working in <folder>"', async () => (await footHint.count()) === 1 && /^2 agents working in \S/.test((await footHint.innerText()).trim()) || saw(await page.locator(".fk-nav-foot").innerText()), { timeout: 10_000 });
      await waitFor('the composer says "1 other working here"', async () => (await chip.count()) === 1 && (await chip.innerText()).trim() === "1 other working here" || saw(await page.locator(".composer").innerText()), { timeout: 10_000 });
      log(`    foot: "${(await footHint.innerText()).trim()}" (${await footHint.getAttribute("title")}); composer: "${(await chip.innerText()).trim()}" (${await chip.getAttribute("title")})`);

      // A fork made elsewhere is a link under the reply it left from.
      const forked = await call("POST", `/api/chats/${id}/fork`, { branch: "main", at });
      const fork = ids.liveFork = forked.body.id;
      check(forked.status === 200 && !!fork && forked.body.forkedFrom === id && !!forked.body.name, "a fork of main at the first reply is made through the API while both branches work", forked);
      rows = await settledRows(page, "the open popup gets the fork's link row", (r) => r.some((x) => /\bfk-fork-row\b/.test(x.cls)));
      log(`    tree rows: ${rowBrief(rows)}`);
      const links = rows.filter((r) => /\bfk-fork-row\b/.test(r.cls));
      check(links.length === 1 && links[0].link === forked.body.name, `one link row, named as the new chat: ${forked.body.name}`, rows);
      const li = rows.indexOf(links[0]), before = rows[li - 1];
      check(!!before && isReply(before) && /one/i.test(before.text) && li < rows.findIndex((r) => r.text.startsWith("ALPHA task.")) && li < rows.indexOf(rows.find((r) => r.endOf === B)),
        "the link is the row right after the first turn's reply, before the two branches' messages", rows);
      const sub = (await page.locator(".fk-nav-sub").innerText()).trim();
      check(/ · 2 branches · 1 fork$/.test(sub), `the popup's header counts it: ${sub}`, sub);
      check((await sel(page)).chat === id && await nav.count() === 1, "the page stays on the chat, the popup open", await sel(page));

      // Stop on B's row stops B alone.
      await endRow(page, B).locator("button.fk-stop").click();
      await waitFor("B's turn is stopped: its record is not busy any more", async () => { const r = await branchRec(id, B); return !BUSY.has(r.status) ? r : saw(recBrief([r])); }, { timeout: 30_000 });
      await waitFor('B\'s items get one "Stopped." note', async () => stoppedNotes(await itemsOf(id, B)) === 1 || saw((await itemsOf(id, B)).filter((i) => i.kind === "note")), { timeout: 15_000 });
      rows = await settledRows(page, "one working row is left, and B's row has no mark", (r) => r.filter(isRun).length === 1 && r.find((x) => x.endOf === B)?.mark === "");
      log(`    tree rows: ${rowBrief(rows)}`);
      const ra = await branchRec(id, "main");
      check(BUSY.has(ra.status) && pgrep(gateA1).length > 0 && stoppedNotes(await itemsOf(id, "main")) === 0 && rows.find(isRun).endOf === "main" && !rows.find((r) => r.endOf === B).stop,
        "main is still busy in its loop with no note of the Stop, and its row is the working one; B's row has no Stop", { record: recBrief([ra]), loop: pgrep(gateA1), rows });
      await waitFor("both folder hints go: one agent is left in the folder", async () => (await footHint.count()) === 0 && (await chip.count()) === 0 || saw({ foot: await footHint.count(), chip: await chip.count() }), { timeout: 10_000 });
      check(await nav.count() === 1 && hereOf(rows) === "main", 'the popup stayed open, "● here" on main\'s end', rows);
      noFetch("so far");

      // B is viewed; main, not shown, grows past what the tree's rows were built from.
      await nav.locator('.fk-nav-head button[title="Close"]').click();
      await waitFor("the popup closes", async () => (await nav.count()) === 0, { timeout: 5000 });
      await viewBranchVia(page, B);
      await waitCrumb(page, /^BRAVO/, "B is shown after a double click on its end row");
      const note = page.locator(".thread .note", { hasText: /^Stopped\.$/ });
      await waitFor('B\'s thread shows "Stopped." and its composer no Stop', async () => (await note.count()) === 1 && (await stop.count()) === 0 || saw({ notes: await note.count(), stop: await stop.count() }), { timeout: 10_000 });
      const lenA = (await itemsOf(id, "main")).length;
      openGates(gateA1);
      await waitGated(id, "main", gateA2, a0);
      const grown = await itemsOf(id, "main");
      check(grown.length > lenA && BUSY.has((await branchRec(id, "main")).status), `with B shown, main's turn went on to its second command without ending: ${lenA} → ${grown.length} items`, grown.map((i) => i.kind));
      await treeBtn.click();
      await nav.waitFor({ timeout: 10_000 });
      rows = await settledRows(page, "the tree shows main's end row, marked as working", (r) => r.filter(isRun).length === 1 && r.find(isRun).endOf === "main");
      log(`    tree rows: ${rowBrief(rows)}`);
      check(hereOf(rows) === B, '"● here" is on B\'s end now', rows);
      await endRow(page, "main").dblclick();
      await waitFor("the double click on main's end row closes the popup", async () => (await nav.count()) === 0, { timeout: 10_000 });
      await waitCrumb(page, /^ALPHA/, "the crumb names main");
      await waitFor("the thread is main's running turn: its last message is A's, Stop shows, no \"Stopped.\"", async () => {
        const users = await page.locator(".thread .msg.user").allInnerTexts();
        const now = { lastUser: (users.at(-1) ?? "").trim().slice(0, 40), stop: await stop.count(), notes: await note.count() };
        return now.lastUser.startsWith("ALPHA task.") && now.stop === 1 && now.notes === 0 || saw(now);
      }, { timeout: 15_000 });
      await sleep(500);
      check(await page.locator(".fk-banner").count() === 0, "no pending-branch banner shows: the branch is viewed, no new one is started", await page.locator(".fk-banner").allInnerTexts());
      check(posts.length === 0, "viewing made no POST …/messages", posts);
      check(BUSY.has((await branchRec(id, "main")).status) && pgrep(gateA2).length > 0 && (await chatView(id)).branches === 2, "main is still in its turn, and the chat still has 2 branches", recBrief(await branchStates(id)));

      // main ends with the popup open: its mark goes and its reply is a new row.
      await treeBtn.click();
      await nav.waitFor({ timeout: 10_000 });
      rows = await settledRows(page, "the tree marks main's end row as working", (r) => r.filter(isRun).length === 1 && r.find(isRun).endOf === "main" && hereOf(r) === "main");
      const was = rows.length;
      openGates(gateA2);
      const endA = await waitBranchTurn(id, "main", a0);
      check(endA.status === "ready" && /alpha/i.test(lastReply(await itemsOf(id, "main"))), "main's turn ends by itself once its second gate opens", { record: recBrief([endA]), reply: lastReply(await itemsOf(id, "main")) });
      rows = await settledRows(page, "no row is marked as working, and main ends at a new reply row", (r) => r.filter(isRun).length === 0 && r.some((x) => x.endOf === "main" && isReply(x) && /alpha/i.test(x.text)));
      log(`    tree rows: ${rowBrief(rows)}`);
      check(rows.length > was && !rows.some((r) => r.mark || r.stop) && await nav.count() === 1, `the popup, still open, has the reply as a new row (${was} → ${rows.length} rows) and no mark or Stop`, rows);

      // Another branch is opened from the popup, and the popup opened again.
      await endRow(page, B).dblclick();
      await waitFor("the double click on B's end row closes the popup", async () => (await nav.count()) === 0, { timeout: 10_000 });
      await waitCrumb(page, /^BRAVO/, "the crumb names B");
      await sleep(500);
      check(posts.length === 0 && await page.locator(".fk-banner").count() === 0, "that made no POST …/messages and no pending branch", { posts, banner: await page.locator(".fk-banner").count() });
      await treeBtn.click();
      await nav.waitFor({ timeout: 10_000 });
      rows = await settledRows(page, 'the tree has "● here" on B\'s end row', (r) => hereOf(r) === B);
      log(`    tree rows: ${rowBrief(rows)}`);
      noFetch("to the end");

      // The fork's link opens the fork.
      await nav.locator(".fk-fork-link").click();
      await waitFor("a click on the fork's link closes the popup and selects the fork", async () => (await nav.count()) === 0 && (await sel(page)).chat === fork || saw({ popup: await nav.count(), sel: await sel(page) }), { timeout: 10_000 });
      await page.locator(".thread .fk-forked").waitFor({ timeout: 10_000 });
      log(`    fork note: ${(await page.locator(".thread .fk-forked").innerText()).replace(/\s+/g, " ").trim()}`);
      check(treeGets.length === 0 && posts.length === 0, "from the popup's first opening to here the page made no GET …/tree and no POST …/messages for the chat", { treeGets, posts });

      // The step's two chats go.
      for (const c of [fork, id]) {
        const gone = await call("DELETE", `/api/chats/${c}`);
        check(gone.status === 200, `chat ${shortId(c)} is deleted through the API`, gone);
      }
      await waitFor("neither chat is in the snapshot or the sidebar's selection", async () => {
        const left = (await state()).chats.filter((c) => c.id === id || c.id === fork).map((c) => c.id), chat = (await sel(page)).chat ?? null;
        return left.length === 0 && chat !== id && chat !== fork || saw({ left, sel: chat });
      }, { timeout: 10_000 });
    } finally {
      page.off("request", onRequest);
      openGates(gateA1, gateA2, gateB);
    }
  });

  // ---- Step 27b: two clauses of phases 1 and 2 that the steps above leave to unit tests. A branch
  // is started from a row of the tree popup while main runs, and two branches of one chat ask for
  // approval at once and are answered each by itself. Claude runs with --permission-mode auto, where
  // it asks for nothing by itself; an "ask" rule in the project settings of the chat's folder
  // (<folder>/.claude/settings.json) comes before the mode, so a command the rule names is asked for.
  await step("27b", "A branch starts from a row of the tree popup while main runs; two branches ask for approval and each is answered by itself", async () => {
    const gateA = newGate("27ba"), gateB = newGate("27bb");
    const nav = page.locator(".fk-nav"), treeBtn = page.locator(".fk-tree-btn"), banner = page.locator(".fk-banner .fk-banner-text");
    const sendBtn = page.locator(".composer button.send:not(.stop)"), stop = page.locator(".composer button.send.stop");
    const pending = page.locator(".thread .perm.pending"), asksAlert = page.locator("button.fk-alert.asks");
    const rowAt = (i) => page.locator(".fk-nav .fk-row").nth(i);
    const isRun = (r) => /\bfk-run\b/.test(r.cls), isAsk = (r) => /\bfk-ask\b/.test(r.cls), isReply = (r) => /\bk-text\b/.test(r.cls), isUser = (r) => /\bk-user\b/.test(r.cls);
    const hereOf = (rows) => rows.filter((r) => r.here).map((r) => r.endOf).join();
    const asking = (rows) => rows.filter(isAsk).map((r) => r.endOf).sort().join();
    const closePopup = async () => {
      await nav.locator('.fk-nav-head button[title="Close"]').click();
      await waitFor("the popup closes", async () => (await nav.count()) === 0, { timeout: 5000 });
    };
    /** A row's right-click menu as drawn ([] for a row that opens none); Esc closes it and leaves the popup open. */
    const menuOf = async (i) => {
      const ctx = page.locator(".fk-ctx");
      await rowAt(i).click({ button: "right" });
      try { await ctx.waitFor({ state: "attached", timeout: 2000 }); } catch { return []; } // the box itself has no size: the menu in it is drawn over the page
      const items = await ctx.locator(".menu-item, .fk-ctx-note").evaluateAll((els) => els.map((e) => ({ text: (e.textContent ?? "").trim(), note: e.classList.contains("fk-ctx-note"), disabled: !!e.disabled })));
      await page.keyboard.press("Escape");
      await waitFor("Esc closes the row's menu and leaves the popup open", async () => (await ctx.count()) === 0 && (await nav.count()) === 1 || saw({ menu: await ctx.count(), popup: await nav.count() }), { timeout: 5000 });
      return items;
    };
    // The folder's project settings make Claude ask before this one harmless command.
    const ASK_RULE = "Bash(ping:*)", ASK_CMD = "ping -c 1 127.0.0.1";
    const askTask = (word) => `${word} check. Run this exact shell command once and then reply with just the word ${word}: ${ASK_CMD} If you are not allowed to run it, try nothing else and reply with just the word REFUSED.`;
    // A turn with replies partway through it, which then waits on its gate.
    const textA = `ALPHA task. This is one turn with two shell commands: do not end your turn before both have finished. First write the single word STARTING and, in that same message, run this exact shell command: echo first ` +
      `When it has finished, write the single word MIDDLE and, in that same message, run this exact shell command in the foreground with timeout 300000, and wait for it to finish: until [ -f ${gateA} ]; do sleep 2; done; echo done When that has finished, reply with just the word ALPHA.`;
    let id = "";
    /** The requests about this chat's permissions and messages the page makes, with the branch each names. */
    const posts = [];
    const onRequest = (r) => {
      const u = new URL(r.url());
      if (r.method() === "POST" && /^\/api\/chats\/[^/]+\/(messages|permission)$/.test(u.pathname) && u.pathname.includes(id)) posts.push(`${u.pathname.split("/").pop()}${u.search}`);
    };
    /** Waits until a branch's turn (the one after `before` turns) has asked for approval and waits; answers the request's item. */
    const waitAsks = async (branch, before) => {
      const what = `branch ${branch} asks for approval and waits (its record says "approval")`;
      await waitFor(what, async () => {
        const r = await branchRec(id, branch);
        if (r?.status === "error") throw new Fail(what, `the branch is in error: ${r.error}`);
        if (r && (r.usage?.turns ?? 0) > before && !BUSY.has(r.status)) throw new Fail(what, { ended: recBrief([r]), reply: lastReply(await itemsOf(id, branch)) });
        return r?.status === "approval" || saw(r ? recBrief([r]) : "(no record)");
      }, { timeout: TURN_TIMEOUT, every: 500 });
      const open = (await itemsOf(id, branch)).filter((i) => i.kind === "perm" && !i.decided);
      check(open.length === 1 && String(open[0].input?.command ?? "").includes("ping"), `branch ${branch} has one open request, for the command of the rule: ${open[0]?.toolName} ${open[0]?.input?.command}`, open);
      return open[0];
    };
    const permsOf = async (branch) => (await itemsOf(id, branch)).filter((i) => i.kind === "perm").map((i) => i.decided || "open");
    /** The calls of the rule's command that ran: their result is ping's own output. */
    const pinged = (items) => items.filter((i) => i.kind === "tool" && String(i.input?.command ?? "").includes("ping") && /1 packets transmitted/.test(i.result ?? ""));
    try {
      const folder = dir("ask-27b");
      fs.mkdirSync(path.join(folder, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(folder, ".claude", "settings.json"), JSON.stringify({ permissions: { ask: [ASK_RULE] } }, null, 2));
      id = ids.rowBranch = await branchChat(page, folder);
      const at = (await itemsOf(id, "main")).findIndex((i) => i.kind === "end") + 1;
      check(at > 0, `the first turn ends at item count ${at}: the finished point the new branch starts from`, (await itemsOf(id, "main")).map((i) => i.kind));

      // ---- Part A: a branch from a row of the popup while main runs.
      const a0 = await send(page, id, textA);
      await waitGated(id, "main", gateA, a0);
      page.on("request", onRequest);
      await treeBtn.click();
      await nav.waitFor({ timeout: 10_000 });
      const iTask = (r) => r.findIndex((x) => isUser(x) && x.text.startsWith("ALPHA task."));
      let rows = await settledRows(page, "the tree marks main's end row as working, and the running turn has a reply row", (r) => r.filter(isRun).length === 1 && r.find(isRun).endOf === "main" && r.slice(iTask(r) + 1).some(isReply));
      log(`    tree rows: ${rowBrief(rows)}`);
      const task = iTask(rows), first = task - 1;
      check(task > 0 && isReply(rows[first]) && /one/i.test(rows[first].text) && !rows[first].endOf, "the row before main's running message is the first turn's reply, and no branch ends there", rows);

      // The rows inside the running turn: none of its replies starts a branch or a fork.
      const inTurn = rows.map((r, i) => ({ r, i })).filter((x) => x.i > task && isReply(x.r));
      for (const { r, i } of inTurn) {
        const menu = await menuOf(i);
        const offers = menu.filter((m) => !m.note && !m.disabled && !/label/i.test(m.text));
        if (r.endOf) {
          check(offers.length === 0 && menu.some((m) => m.text === "Fork to new chat" && m.disabled), `the running turn's last reply "${r.text.slice(0, 20)}" (main's end) has its fork greyed out and no branch action`, menu);
        } else {
          check(offers.length === 0 && menu.some((m) => m.note && /^Partway through a turn/.test(m.text)), `the running turn's reply "${r.text.slice(0, 20)}" offers no branch or fork: its menu says "${menu.find((m) => m.note)?.text}"`, menu);
          await rowAt(i).dblclick();
          await sleep(700);
          check(await nav.count() === 1 && await page.locator(".fk-banner").count() === 0 && posts.length === 0, "a double click on it does nothing: the popup stays, no banner, nothing sent", { popup: await nav.count(), banner: await page.locator(".fk-banner").count(), posts });
        }
      }

      // The finished boundary, the first turn's reply: the popup's actions are there although main works.
      const menu1 = await menuOf(first);
      check(menu1.some((m) => m.text === "Fork to new chat" && !m.disabled) && !menu1.some((m) => m.note), "the first reply's menu offers Fork to new chat, enabled, and has no \"partway through a turn\" note", menu1);
      const foot = (await page.locator(".fk-nav-foot").innerText()).replace(/\s+/g, " ").trim();
      check(/Double-click a message to open the chat there; what you send next branches off/.test(foot), `the popup says how a branch starts from a row: ${foot}`, foot);
      await rowAt(first).dblclick();
      await waitFor("the double click on the first reply's row closes the popup", async () => (await nav.count()) === 0, { timeout: 10_000 });
      await banner.waitFor({ timeout: 10_000 });
      const said = (await banner.innerText()).trim();
      check(/^New branch after “.+”: your message starts it\. “.+” stays in the tree\.$/.test(said), `the banner tells of the new branch: ${said}`, said);
      const recs0 = await branchStates(id);
      check(posts.length === 0 && recs0.length === 1 && recs0[0].branch === "main" && BUSY.has(recs0[0].status), "nothing is sent yet: the chat's one record is main's, still working", { posts, records: recBrief(recs0) });
      await page.locator(".composer .composer-input").fill(gatedTask("BRAVO", gateB));
      check(await sendBtn.isEnabled() && await stop.isVisible(), "Send is enabled for the new branch although its source runs, and Stop still shows", { sendEnabled: await sendBtn.isEnabled(), stop: await stop.isVisible() });
      const res = await typeSend(page, id, "", { typed: true });
      const B = res.body.branch;
      check(res.status === 200 && !!B && B !== "main", "the Send is accepted and its answer names the new branch", res);
      await waitGated(id, B, gateB, 0);
      const v = await chatView(id), recs = await branchStates(id);
      check(recs.length === 2 && recs.every((r) => BUSY.has(r.status)) && recs.map((r) => r.branch).sort().join() === ["main", B].sort().join(), "the snapshot has a second record for the chat; main's and the new branch's are both busy", recBrief(recs));
      check(v.branches === 2 && v.working === 2 && !v.approvals, "the chat has 2 branches and both work", { branches: v.branches, working: v.working, approvals: v.approvals });
      check(pgrep(gateA).length > 0 && pgrep(gateB).length > 0, "both shell loops run", { a: pgrep(gateA), b: pgrep(gateB) });
      const itemsB0 = await itemsOf(id, B);
      check(itemsB0.findIndex((i) => i.kind === "user" && i.text.startsWith("BRAVO task.")) === at && !hasUser(itemsB0, textA), `the new branch starts at the first reply (its message is item ${at}) and has nothing of main's running turn`, itemsB0.map((i) => i.kind));
      await waitFor("the banner goes and the view is on the new branch", async () => (await page.locator(".fk-banner").count()) === 0 && /^BRAVO/.test(await crumbText(page)) || saw({ banner: await page.locator(".fk-banner").count(), crumb: await crumbText(page) }), { timeout: 15_000 });
      await waitFor('the header says "1 other branch working"', async () => (await alertText()) === "1 other branch working" || saw(await alertText()), { timeout: 10_000 });

      // Both end by themselves.
      openGates(gateA, gateB);
      const endA = await waitBranchTurn(id, "main", a0), endB = await waitBranchTurn(id, B, 0);
      check(endA.status === "ready" && /alpha/i.test(lastReply(await itemsOf(id, "main"))) && endB.status === "ready" && /bravo/i.test(lastReply(await itemsOf(id, B))),
        "with the gates open each turn ends with its own reply on its own branch", { main: lastReply(await itemsOf(id, "main")), B: lastReply(await itemsOf(id, B)) });
      await waitFor("the header alert goes once no other branch works", async () => (await alertText()) === "" || saw(await alertText()), { timeout: 10_000 });

      // ---- Part B: approval per branch. A is main, B the branch made above.
      // A asks.
      await viewBranchVia(page, "main");
      await waitCrumb(page, /^ALPHA/, "main is shown (the crumb names it)");
      posts.length = 0;
      const a1 = (await branchRec(id, "main")).usage?.turns ?? 0, b1 = (await branchRec(id, B)).usage?.turns ?? 0;
      const sentA = await typeSend(page, id, askTask("CHARLIE"));
      check(sentA.status === 200 && hasUser(await itemsOf(id, "main"), askTask("CHARLIE")), "A's message is put on main", sentA);
      const askA = await waitAsks("main", a1);
      await waitFor("main's thread shows the request as a pending card with the command", async () => (await pending.count()) === 1 && (await pending.locator(".perm-what").innerText()).includes(ASK_CMD) || saw(await page.locator(".thread .perm").allInnerTexts()), { timeout: 10_000 });
      log(`    main's card: ${(await pending.innerText()).replace(/\s+/g, " ").trim()}`);

      // B asks too, while A waits.
      await viewBranchVia(page, B);
      await waitCrumb(page, /^BRAVO/, "B is shown (the crumb names it)");
      await waitFor("B's thread has no card of A's request, and the header tells of the approval on the other branch", async () => (await pending.count()) === 0 && (await asksAlert.count()) === 1 || saw({ cards: await pending.count(), alert: await alertText() }), { timeout: 10_000 });
      const sentB = await typeSend(page, id, askTask("DELTA"));
      check(sentB.status === 200 && hasUser(await itemsOf(id, B), askTask("DELTA")) && !hasUser(await itemsOf(id, "main"), askTask("DELTA")), "B's message is put on B while A waits for its approval", sentB);
      const askB = await waitAsks(B, b1);
      let cv = await chatView(id), rs = await branchStates(id);
      check(cv.approvals === 2 && cv.working === 2 && rs.length === 2 && rs.every((r) => r.status === "approval") && askA.requestId !== askB.requestId,
        "the chat counts 2 approvals, both records say \"approval\", and the two requests are different ones", { approvals: cv.approvals, working: cv.working, records: recBrief(rs), requests: [askA.requestId, askB.requestId] });
      await waitFor("B's thread shows one pending card, B's own", async () => (await pending.count()) === 1 || saw(await page.locator(".thread .perm").allInnerTexts()), { timeout: 10_000 });
      const alertSaid = (await asksAlert.innerText()).trim();
      check(await asksAlert.count() === 1 && /^Approval needed on “ALPHA/.test(alertSaid), `with B shown the header tells of A's request: ${alertSaid}`, alertSaid);
      await treeBtn.click();
      await nav.waitFor({ timeout: 10_000 });
      rows = await settledRows(page, "the tree marks both branches' end rows as needing approval", (r) => asking(r) === ["main", B].sort().join());
      log(`    tree rows: ${rowBrief(rows)}`);
      check(rows.filter(isAsk).every((r) => r.mark === "needs approval" && r.stop) && !rows.some(isRun) && hereOf(rows) === B, 'both rows say "needs approval" and have Stop; none says "working"; "● here" is on B\'s end', rows);
      await closePopup();

      // B's request is approved with its card: B goes on and ends, A still waits.
      const decidedB = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/chats/${id}/permission`, { timeout: 15_000 });
      await pending.locator(".perm-actions button", { hasText: /^Allow$/ }).click();
      const dB = await decidedB;
      check(dB.status() === 200 && new URL(dB.url()).searchParams.get("branch") === B && dB.request().postDataJSON().requestId === askB.requestId && dB.request().postDataJSON().allow === true,
        "Allow on the card sends B's request id for branch B", { status: dB.status(), url: dB.url(), body: dB.request().postDataJSON() });
      const doneB = await waitBranchTurn(id, B, b1);
      const itemsB = await itemsOf(id, B);
      check(doneB.status === "ready" && /delta/i.test(lastReply(itemsB)) && (await permsOf(B)).join() === "allow" && pinged(itemsB).length === 1,
        "B ran the command and ended with its reply; its request is marked as allowed", { record: recBrief([doneB]), reply: lastReply(itemsB), perms: await permsOf(B), tools: itemsB.filter((i) => i.kind === "tool").map((i) => [i.input?.command, i.result]) });
      cv = await chatView(id);
      const recA = await branchRec(id, "main");
      check(recA.status === "approval" && cv.approvals === 1 && cv.working === 1 && (await permsOf("main")).join() === "open", "A's record still says \"approval\" and its request is still open: the chat counts 1 approval", { record: recBrief([recA]), approvals: cv.approvals, working: cv.working, perms: await permsOf("main") });
      await waitFor('B\'s thread shows its card as "Approved", none pending; the header still tells of A\'s request', async () => (await pending.count()) === 0 && (await page.locator(".thread .perm.allow").count()) === 1 && (await asksAlert.count()) === 1 || saw({ cards: await page.locator(".thread .perm").allInnerTexts(), alert: await alertText() }), { timeout: 10_000 });

      // A is viewed: its card is still pending. It is denied, and A ends by itself.
      rows = await viewBranchVia(page, "main", async () => {
        await treeBtn.click();
        await waitFor("the tree marks only main's end row as needing approval", async () => { const r = await treeRows(page); return asking(r) === "main" && !r.find((x) => x.endOf === B)?.mark || saw(r); }, { timeout: 15_000 });
      });
      log(`    tree rows: ${rowBrief(rows)}`);
      await waitCrumb(page, /^ALPHA/, "main is shown again");
      await waitFor("main's thread still shows its card as pending, and no header alert: no other branch asks or works", async () => (await pending.count()) === 1 && (await page.locator(".fk-alert").count()) === 0 || saw({ cards: await page.locator(".thread .perm").allInnerTexts(), alert: await alertText() }), { timeout: 10_000 });
      const decidedA = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/chats/${id}/permission`, { timeout: 15_000 });
      await pending.locator(".perm-actions button", { hasText: /^Don't$/ }).click();
      const dA = await decidedA;
      check(dA.status() === 200 && new URL(dA.url()).searchParams.get("branch") === "main" && dA.request().postDataJSON().requestId === askA.requestId && dA.request().postDataJSON().allow === false,
        "Don't on the card sends A's request id for main", { status: dA.status(), url: dA.url(), body: dA.request().postDataJSON() });
      const doneA = await waitBranchTurn(id, "main", a1);
      const itemsA = await itemsOf(id, "main");
      log(`    A's reply after the denial: ${JSON.stringify(lastReply(itemsA))}`);
      check(doneA.status === "ready" && (await permsOf("main")).join() === "deny" && pinged(itemsA).length === 0 && !/charlie/i.test(lastReply(itemsA)),
        "A's turn ended by itself without the command having run; its request is marked as denied", { record: recBrief([doneA]), reply: lastReply(itemsA), perms: await permsOf("main"), tools: itemsA.filter((i) => i.kind === "tool").map((i) => [i.input?.command, i.result]) });
      cv = await chatView(id);
      check(!cv.approvals && !cv.working && (await permsOf(B)).join() === "allow", "the chat counts no approval and no working branch; B's request stays as it was answered", { approvals: cv.approvals, working: cv.working, permsB: await permsOf(B) });
      await waitFor('main\'s thread shows its card as "Denied", none pending, and no header alert', async () => (await pending.count()) === 0 && (await page.locator(".thread .perm.deny").count()) === 1 && (await page.locator(".fk-alert").count()) === 0 || saw({ cards: await page.locator(".thread .perm").allInnerTexts(), alert: await alertText() }), { timeout: 10_000 });
      await treeBtn.click();
      await nav.waitFor({ timeout: 10_000 });
      rows = await settledRows(page, "no row of the tree has a mark or Stop", (r) => !r.some((x) => x.mark || x.stop || isAsk(x) || isRun(x)));
      log(`    tree rows: ${rowBrief(rows)}`);
      await closePopup();
      check(posts.join() === [`messages?branch=main`, `messages?branch=${B}`, `permission?branch=${B}`, `permission?branch=main`].join(), "the page's requests of part B: a message and an answer per branch, each naming its own", posts);

      const gone = await call("DELETE", `/api/chats/${id}`);
      check(gone.status === 200, `chat ${shortId(id)} is deleted through the API`, gone);
      await waitFor("the chat is not in the snapshot or the sidebar's selection", async () => {
        const left = (await state()).chats.some((c) => c.id === id), chat = (await sel(page)).chat ?? null;
        return !left && chat !== id || saw({ left, sel: chat });
      }, { timeout: 10_000 });
    } finally {
      page.off("request", onRequest);
      openGates(gateA, gateB);
    }
  });

  await step(28, "A branch and a fork on another model: the picker on a pending branch, the notice, fixed after the first message, a fork without a message is given another model", async () => {
    const SONNET = "sonnet", ASK = "Which word? Answer with the word only.";
    const haikuLabel = await claudeLabel(CLAUDE_MODEL_ID), sonnetLabel = await claudeLabel(SONNET);
    const modelBtn = page.locator('.composer button.tchip[title^="Model"]'), effortBtn = page.locator('.composer button.tchip[title^="Effort"]');
    const fixedChip = page.locator('.composer .tchip.static[title^="Model and effort are fixed"]'), folderChip = page.locator('.composer .tchip.static[title^="Working directory"]');
    const restartChip = page.locator('.composer .tchip.static[title="Starting the agent on this model…"]');
    const notice = page.locator(".composer .model-notice"), banner = page.locator(".fk-banner .fk-banner-text");
    const noticeText = `Another model than the conversation so far (${haikuLabel}): the history is read again once, at full price.`;
    const one = async (loc) => ((await loc.count()) ? (await loc.first().innerText()).replace(/\s+/g, " ").trim() : "");
    /** The toolbar and the notice as drawn: "" for what is not there. */
    const bar = async () => ({ model: await one(modelBtn), effort: await one(effortBtn), fixed: await one(fixedChip), folder: await one(folderChip), notice: await one(notice), banner: await banner.count() });
    const stateOf = async (id, branch) => (await get(`/api/chats/${id}/items?branch=${encodeURIComponent(branch)}`)).state;
    const stateBrief = (s) => s && { model: s.model, effort: s.effort ?? "", locked: s.locked, fresh: !!s.fresh, status: s.status };
    /** A branch's folder in the data folder: the chat's own for main. */
    const branchDir = (id, branch) => (branch === "main" ? path.join(HOME, "chats", id) : path.join(HOME, "chats", id, "branches", branch));
    /** The model the branch's Claude process says it runs on (the "Model" fact of its context split, asked of the process). */
    const processModel = async (id, branch) => (await get(`/api/chats/${id}/context?branch=${encodeURIComponent(branch)}&fresh=1`)).facts?.find((f) => f.label === "Model")?.value ?? "";
    /** Claude's choice among the defaults a new chat starts with on the local server: each group's. */
    const claudeDefaults = (d) => ({ groups: Object.fromEntries(Object.entries(d.groups ?? {}).sort().map(([k, g]) => [k, g.servers?.local?.byAgent?.claude ?? null])) });
    // Everything the page sends that is not a GET, with the body of a message or a PATCH.
    const sent = [];
    const bodyOf = (r) => { try { return r.postDataJSON(); } catch { return null; } };
    const onRequest = (r) => { if (r.method() !== "GET") sent.push({ req: `${r.method()} ${new URL(r.url()).pathname}${new URL(r.url()).search}`, body: bodyOf(r) }); };
    page.on("request", onRequest);
    try {
      // 1. A plain Claude chat on Haiku with one finished turn.
      const id = ids.models = await newChatVia(page, async () => { await page.locator("button.icon-btn.new").click(); }, "claude");
      await pickModelId(page, CLAUDE_MODEL_ID);
      const v0 = await chatView(id);
      check(v0.agent === "claude" && v0.model === CLAUDE_MODEL_ID && !v0.board, "a plain Claude chat on Haiku", v0);
      const t0 = await send(page, id, "Remember the word KIWI. Answer OK.");
      await waitTurn(id, t0);
      await waitFor("the started chat's toolbar shows the fixed chip with Haiku's label and no Model picker", async () => { const b = await bar(); return b.fixed.includes(haikuLabel) && !b.model && !b.notice || saw(b); }, { timeout: 10_000 });

      // 2. The defaults of a new chat, before any choice for a branch or a fork.
      const defaults0 = (await state()).defaults;
      log(`    defaults for Claude: ${JSON.stringify(claudeDefaults(defaults0))}`);
      check(claudeDefaults(defaults0).groups.__ungrouped__?.model === CLAUDE_MODEL_ID, "the ungrouped group's choice for a new Claude chat is Haiku", claudeDefaults(defaults0));

      // 3. A pending branch has the Model picker although the chat has started; a choice shows the notice and sends nothing.
      sent.length = 0;
      await firstReplyAction(page, "k-branch");
      await banner.waitFor({ timeout: 10_000 });
      let b = await waitFor("the pending branch has the Model picker, on Haiku", async () => { const now = await bar(); return now.model.includes(haikuLabel) ? now : saw(now); }, { timeout: 10_000 });
      check(!b.fixed && !b.notice && !!b.folder, "with it: no fixed model chip, no notice, and the folder as a fixed chip", b);
      await pickModelId(page, SONNET);
      b = await waitFor("after picking Sonnet the picker shows it and the notice appears", async () => { const now = await bar(); return now.model.includes(sonnetLabel) && !!now.notice ? now : saw(now); }, { timeout: 10_000 });
      check(b.notice === noticeText && /history is read again/.test(b.notice), `the notice says the history is read again: ${b.notice}`, b);
      check(await notice.evaluate((e) => !e.classList.contains("warn")), "it is the plain notice, not the warning", await notice.getAttribute("class"));
      log(`    toolbar of the pending branch: model "${b.model}", effort "${b.effort}", folder "${b.folder}"`);
      const recs3 = await branchStates(id);
      check(sent.length === 0 && recs3.length === 1 && recs3[0].branch === "main" && recs3[0].model === CLAUDE_MODEL_ID && (await chatView(id)).model === CLAUDE_MODEL_ID,
        "the choice sent nothing: the chat has its one record, main's, still on Haiku", { sent, records: recs3.map((r) => [r.branch, r.model]), view: (await chatView(id)).model });

      // 4. Back drops the choice with the pending branch; a new pending branch starts on Haiku again.
      await page.locator(".fk-banner button", { hasText: "Back" }).click();
      b = await waitFor("after Back: no banner, no notice, no Model picker, the fixed chip with Haiku's label", async () => { const now = await bar(); return !now.banner && !now.notice && !now.model && now.fixed.includes(haikuLabel) ? now : saw(now); }, { timeout: 10_000 });
      await firstReplyAction(page, "k-branch");
      await banner.waitFor({ timeout: 10_000 });
      b = await waitFor("the next pending branch shows Haiku again and no notice: the choice was not kept", async () => { const now = await bar(); return now.model.includes(haikuLabel) && !now.notice ? now : saw(now); }, { timeout: 10_000 });
      await pickModelId(page, SONNET);
      await waitFor("Sonnet is picked again", async () => { const now = await bar(); return now.model.includes(sonnetLabel) && now.notice === noticeText ? now : saw(now); }, { timeout: 10_000 });
      // The cheapest effort Sonnet offers, when it offers "low": the branch's effort is its own too.
      const sonnet = (await state()).catalogs.claude.models.find((m) => m.id === SONNET);
      const low = sonnet.efforts?.includes("low") ? "low" : "";
      if (low) {
        await pickEffort(page, "Low");
        await waitFor("effort Low is picked for the pending branch, and the notice stays", async () => { const now = await bar(); return /Low/.test(now.effort) && now.notice === noticeText ? now : saw(now); }, { timeout: 10_000 });
      } else log(`    Sonnet offers no effort "low" (${JSON.stringify(sonnet.efforts ?? [])}): the effort is left as the picker set it`);
      check(sent.length === 0, "picking sent nothing so far", sent);
      const res = await typeSend(page, id, ASK);
      const B = res.body.branch, target = sent.find((x) => /\/messages$/.test(x.req))?.body?.target;
      check(res.status === 200 && res.body.ok === true && !!B && B !== "main", "the Send is accepted and its answer names the new branch", res);
      check(target?.branch === "main" && target.new === true && target.model === SONNET && (!low || target.effort === low), "the message's target names main, a new branch and the choice", target);

      // 5. The branch answers on Sonnet and knows the word; its choice is fixed; main keeps Haiku.
      const rb = await waitBranchTurn(id, B, 0);
      const itemsB = await itemsOf(id, B);
      check(/kiwi/i.test(lastReply(itemsB)), `the branch's reply has the word of the turn before it: ${JSON.stringify(lastReply(itemsB))}`, itemsB.map((i) => [i.kind, i.text ?? i.name]));
      const sb = await stateOf(id, B), sm = await stateOf(id, "main");
      check(sb.model === SONNET && sb.locked === true && !sb.fresh && (!low || sb.effort === low), "the branch's state: Sonnet, the effort picked, locked, not fresh", stateBrief(sb));
      check(sm.model === CLAUDE_MODEL_ID && sm.locked === true && !sm.effort, "main's state still says Haiku", stateBrief(sm));
      check(rb.model === SONNET && (await branchRec(id, "main")).model === CLAUDE_MODEL_ID, "and so do the snapshot's two records", (await branchStates(id)).map((r) => [r.branch, r.model, r.effort ?? ""]));
      b = await waitFor("the branch's toolbar: the fixed chip with Sonnet's label, no Model picker, no notice", async () => { const now = await bar(); return now.fixed.includes(sonnetLabel) && !now.model && !now.notice && !now.banner ? now : saw(now); }, { timeout: 15_000 });
      log(`    fixed chip on the branch: "${b.fixed}"`);
      // That the answer came from Sonnet, not only that the record says so: the branch's own Claude
      // process names its model, and the assistant lines of its Claude session file carry theirs.
      const pmB = await processModel(id, B), pmMain = await processModel(id, "main");
      check(/sonnet/i.test(pmB) && /haiku/i.test(pmMain), `the branch's Claude process says it runs ${pmB}, main's ${pmMain}`, { branch: pmB, main: pmMain });
      const sfB = sessionModels(readJSON(path.join(branchDir(id, B), "chat.json")).sessionId), sfMain = sessionModels(readJSON(path.join(branchDir(id, "main"), "chat.json")).sessionId);
      check(/sonnet/i.test(sfB.at(-1) ?? "") && sfMain.length > 0 && sfMain.every((m) => /haiku/i.test(m)),
        `Claude's session files: the branch's last answer was written by ${sfB.at(-1)}, main's answers by ${[...new Set(sfMain)].join(", ")}`, { branch: sfB, main: sfMain });
      log(`    the models of the branch's session file, in order: ${sfB.join(", ")}`);

      // 6. What the API refuses: a choice for a branch that goes on, an unknown model, a change once started.
      const before6 = recBrief(await branchStates(id));
      const carry = await call("POST", `/api/chats/${id}/messages`, { text: "Reply with just the word NO.", context: "", target: { branch: B, at: itemsB.length, model: CLAUDE_MODEL_ID } });
      check(carry.status === 409, `a target at the branch's end with a model is refused with 409: ${JSON.stringify(carry.body)}`, carry);
      const unknown = await call("POST", `/api/chats/${id}/messages`, { text: "Reply with just the word NO.", context: "", target: { branch: "main", at: target.at, new: true, model: "nope" } });
      check(unknown.status === 400, `a new branch on the model "nope" is refused with 400: ${JSON.stringify(unknown.body)}`, unknown);
      const patchB = await call("PATCH", `/api/chats/${id}?branch=${B}`, { model: CLAUDE_MODEL_ID });
      check(patchB.status === 409, `a PATCH of the started branch's model is refused with 409: ${JSON.stringify(patchB.body)}`, patchB);
      const patchMain = await call("PATCH", `/api/chats/${id}?branch=main`, { model: SONNET });
      check(patchMain.status === 409, `a PATCH of main's model is refused with 409: ${JSON.stringify(patchMain.body)}`, patchMain);
      await sleep(500);
      const after6 = await branchStates(id);
      check(JSON.stringify(recBrief(after6)) === JSON.stringify(before6) && after6.length === 2 && after6.find((r) => r.branch === B).model === SONNET && after6.find((r) => r.branch === "main").model === CLAUDE_MODEL_ID,
        "the refusals changed nothing: two branches, no turn, Sonnet and Haiku as before", { before: before6, after: after6.map((r) => [r.branch, r.model, r.status, r.usage?.turns]) });

      // 7. A fork of main to a new chat has had no message of its own: its model can still be changed.
      await viewBranchVia(page, "main");
      await waitFor("main is shown: its fixed chip has Haiku's label", async () => { const now = await bar(); return now.fixed.includes(haikuLabel) && !now.model ? now : saw(now); }, { timeout: 15_000 });
      const chatsBefore = new Set((await state()).chats.map((c) => c.id));
      await firstReplyAction(page, "k-fork");
      const fork = ids.modelsFork = await waitFor("a new chat is made and selected", async () => { const s = (await sel(page)).chat; return s && !chatsBefore.has(s) ? s : saw(await sel(page)); }, { timeout: 30_000 });
      await page.locator(".thread .fk-forked").waitFor({ timeout: 10_000 });
      const fv = await waitFor("the fork is ready", async () => { const v = await chatView(fork); return v.status === "ready" ? v : saw({ status: v.status, error: v.error }); }, { timeout: 60_000 });
      check(fv.forkedFrom === id && fv.forkedBranch === "main" && fv.agent === "claude" && fv.model === CLAUDE_MODEL_ID && fv.fresh === true && fv.locked === true,
        "the fork names main of the source, is on Haiku, and its view says fresh", { forkedFrom: fv.forkedFrom, forkedBranch: fv.forkedBranch, forkedAt: fv.forkedAt, model: fv.model, effort: fv.effort ?? "", fresh: fv.fresh, locked: fv.locked });
      b = await waitFor("the fork's toolbar has the Model picker on Haiku", async () => { const now = await bar(); return now.model.includes(haikuLabel) ? now : saw(now); }, { timeout: 15_000 });
      check(!!b.folder && !b.fixed && !b.notice, "with the folder as a fixed chip, no fixed model chip and no notice", b);
      const watch = watchChat(fork);
      const ui = watchPage(async () => ({ picker: await modelBtn.count() ? ((await modelBtn.getAttribute("aria-disabled")) === "true" ? "disabled" : "open") : "none", restart: await restartChip.count(),
        stop: await page.locator(".composer button.send.stop").count(), typing: await one(page.locator(".thread .typing")) }));
      const patched = page.waitForResponse((r) => r.request().method() === "PATCH" && new URL(r.url()).pathname === `/api/chats/${fork}`, { timeout: 120_000 });
      sent.length = 0;
      await pickModelId(page, SONNET);
      const pr = await patched;
      const prBody = await pr.json().catch(() => ({}));
      check(pr.status() === 200 && prBody.ok === true && pr.request().postDataJSON().model === SONNET, "the pick is a PATCH of the fork's model, answered {ok: true}", { status: pr.status(), body: prBody, sent: pr.request().postDataJSON() });
      const fv2 = await waitFor("the fork is on Sonnet, ready and still fresh", async () => { const v = await chatView(fork); return v.model === SONNET && v.status === "ready" && v.fresh === true ? v : saw({ model: v.model, status: v.status, fresh: v.fresh, error: v.error }); }, { timeout: 60_000 });
      await sleep(300);
      await watch.stop();
      await ui.stop();
      log(`    the fork while its agent started again: status ${watch.seen.map((e) => e.status).join(" → ")}; the page ${ui.seen.map((e) => `${e.picker}${e.restart ? "+restart chip" : ""}${e.typing ? ` "${e.typing}"` : ""}${e.stop ? "+Stop" : ""}`).join(" → ")}`);
      check(watch.seen.some((e) => e.status === "thinking") && watch.seen.at(-1).status === "ready" && watch.seen.every((e) => e.turns === watch.seen[0].turns),
        "its status was thinking during the restart and ready after; no turn ran", watch.seen);
      check(ui.seen.some((e) => e.picker === "disabled" || e.restart), "meanwhile the page's Model picker was disabled or replaced by the \"Starting the agent\" chip", ui.seen);
      check(ui.seen.every((e) => !e.stop && !/Thinking/.test(e.typing)) && ui.seen.every((e) => !e.typing || e.typing === "Starting the agent…"),
        "and the restart did not look like a turn: no Stop button, and the thread said nothing or \"Starting the agent…\", never \"Thinking…\"", ui.seen);
      b = await waitFor("the fork's toolbar: the Model picker on Sonnet, enabled, and the notice", async () => { const now = await bar(); return now.model.includes(sonnetLabel) && now.notice === noticeText && (await modelBtn.getAttribute("aria-disabled")) !== "true" ? now : saw(now); }, { timeout: 15_000 });
      check(!!b.folder && !b.fixed, "the folder is still a fixed chip and the model is not", b);
      log(`    toolbar of the fork after the change: model "${b.model}", effort "${b.effort}", record ${JSON.stringify({ model: fv2.model, effort: fv2.effort ?? "" })}`);
      if (low) {
        // Its effort too, by a second PATCH and a second restart.
        const patchedEffort = page.waitForResponse((r) => r.request().method() === "PATCH" && new URL(r.url()).pathname === `/api/chats/${fork}`, { timeout: 120_000 });
        await pickEffort(page, "Low");
        const pe = await patchedEffort;
        const peBody = await pe.json().catch(() => ({}));
        check(pe.status() === 200 && peBody.ok === true && pe.request().postDataJSON().effort === low, "picking effort Low is a PATCH of the fork's effort, answered {ok: true}", { status: pe.status(), body: peBody, sent: pe.request().postDataJSON() });
        await waitFor("the fork is on Sonnet at effort low, ready and still fresh", async () => { const v = await chatView(fork); return v.model === SONNET && v.effort === low && v.status === "ready" && v.fresh === true || saw({ model: v.model, effort: v.effort, status: v.status, fresh: v.fresh, error: v.error }); }, { timeout: 60_000 });
        await waitFor("the fork's toolbar shows effort Low, the pickers enabled, and the notice still", async () => { const now = await bar(); return /Low/.test(now.effort) && now.model.includes(sonnetLabel) && now.notice === noticeText && (await modelBtn.getAttribute("aria-disabled")) !== "true" ? now : saw(now); }, { timeout: 15_000 });
      }
      check((await branchRec(id, "main")).model === CLAUDE_MODEL_ID, "the source's main is still on Haiku", (await branchStates(id)).map((r) => [r.branch, r.model]));
      const f0 = await send(page, fork, ASK);
      const { items: itemsF } = await waitTurn(fork, f0);
      check(/kiwi/i.test(lastReply(itemsF)), `the fork's reply has the word of the copied turn: ${JSON.stringify(lastReply(itemsF))}`, itemsF.map((i) => [i.kind, i.text ?? i.name]));
      const fv3 = await chatView(fork), sf = await stateOf(fork, "main");
      check(fv3.model === SONNET && (!low || fv3.effort === low) && !fv3.fresh && fv3.locked === true && sf.model === SONNET && !sf.fresh, "after its first message the fork is on Sonnet, at the effort picked, and not fresh", { view: stateBrief(fv3), state: stateBrief(sf) });
      b = await waitFor("the fork's toolbar: the fixed chip with Sonnet's label, no Model picker, no notice", async () => { const now = await bar(); return now.fixed.includes(sonnetLabel) && !now.model && !now.notice ? now : saw(now); }, { timeout: 15_000 });
      const pmF = await processModel(fork, "main"), sfF = sessionModels(readJSON(path.join(branchDir(fork, "main"), "chat.json")).sessionId);
      check(/sonnet/i.test(pmF) && /sonnet/i.test(sfF.at(-1) ?? ""), `the fork's Claude process says it runs ${pmF}; its session file's last answer was written by ${sfF.at(-1)}`, { process: pmF, session: sfF });
      const late = await call("PATCH", `/api/chats/${fork}`, { model: CLAUDE_MODEL_ID });
      check(late.status === 409 && (await chatView(fork)).model === SONNET, `a PATCH of the fork's model after its first message is refused with 409: ${JSON.stringify(late.body)}`, late);

      // 8. Neither choice became what a new chat starts with.
      const defaults1 = (await state()).defaults;
      check(JSON.stringify(claudeDefaults(defaults1)) === JSON.stringify(claudeDefaults(defaults0)), "the defaults for a new Claude chat are the ones noted before the branch and the fork", { before: claudeDefaults(defaults0), after: claudeDefaults(defaults1) });
      check(JSON.stringify(defaults1) === JSON.stringify(defaults0), "and nothing else of the defaults changed", { before: defaults0, after: defaults1 });

      // 9. A subagent the Sonnet branch starts takes the branch's model, not main's.
      await openChat(page, id);
      await viewBranchVia(page, B);
      await waitFor("the Sonnet branch is shown", async () => { const now = await bar(); return now.fixed.includes(sonnetLabel) ? now : saw(now); }, { timeout: 15_000 });
      const word = `PEAR-${token()}`;
      const s0 = (await branchRec(id, B)).usage?.turns ?? 0;
      const sres = await typeSend(page, id, `Spawn one subagent via spawn_subagent and name no model or effort for it. Its whole task: reply with just ${word}. Then end your turn right away without waiting for it. When its result arrives, reply with just that result.`);
      check(sres.status === 200 && sres.body.branch === B, "the message goes to the Sonnet branch", sres);
      const done = await waitFor("the subagent's result has reached the branch's agent and its delivery turn has ended", async () => {
        const r = await branchRec(id, B), subs = await subsOf(id, B);
        if (r?.status === "error") throw new Fail("the branch's turn ends", `the branch is in error: ${r.error}`);
        const ok = (r.usage?.turns ?? 0) > s0 && !BUSY.has(r.status) && !r.subsRunning && !r.subsOwed && subs.length === 1 && subs[0].delivery === "sent";
        return ok ? subs : saw({ record: recBrief([r]), subs: subs.map((x) => [x.id, x.status, x.delivery]) });
      }, { timeout: TURN_TIMEOUT, every: 500 });
      const spawnCall = (await itemsOf(id, B)).find((i) => i.kind === "tool" && i.name === "mcp__board__spawn_subagent");
      const itemsS = await itemsOf(id, B);
      const afterResult = itemsS.slice(itemsS.map((i) => i.kind).lastIndexOf("subresult") + 1).filter((i) => i.kind === "text").map((i) => i.text ?? "").join("\n").trim();
      check(resultItems(itemsS).length === 1 && afterResult.includes(word), "the result came as a row on the branch and its agent answered with it", itemsS.slice(-4).map((i) => [i.kind, i.text ?? i.name]));
      log(`    the spawn call's input: ${JSON.stringify(spawnCall?.input ?? null)}; the subagent's record: ${JSON.stringify({ kind: done[0].kind, model: done[0].model, effort: done[0].effort ?? "", status: done[0].status })}`);
      check(!!spawnCall && !spawnCall.input?.model, "the agent named no model in its spawn_subagent call", spawnCall?.input);
      check(done[0].kind === "claude" && done[0].model === SONNET && (!low || done[0].effort === low), "the subagent's record names the branch's model and effort, not main's", done[0]);
      const onDisk = readJSON(path.join(branchDir(id, B), "subagents", done[0].id, "subagent.json"));
      check(onDisk.model === SONNET, "and so does its subagent.json", { model: onDisk.model, effort: onDisk.effort, kind: onDisk.kind });
      check((await subsOf(id, "main")).length === 0 && (await branchRec(id, "main")).model === CLAUDE_MODEL_ID, "main has no subagent and is still on Haiku", { subs: await subsOf(id, "main"), main: stateBrief(await stateOf(id, "main")) });
    } finally { page.off("request", onRequest); }
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
  openGates(...GATES);
  fs.rmSync(CURSOR_CFG, { recursive: true, force: true });
  fs.rmSync(ACP_LOG, { force: true }); // never leave the adapter trace behind
}
process.exit(code);
