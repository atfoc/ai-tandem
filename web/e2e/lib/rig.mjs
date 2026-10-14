// What the end-to-end scripts of web/e2e share: scratch servers (real processes of the server program, each with a data
// folder, a port and a stand-in agent of its own), the test host that stands for the app's main process (web/dev/host.mjs,
// which holds the server list and the secrets and connects to every server through desktop/conn), and the page opened in a
// headless Chromium (Playwright, installed with --no-save by whoever runs a script).
//
// Nothing here touches the user's own AI Whiteboard: every server runs on a data folder under the system's temporary folder,
// on a free port, with `AIWB_MCP_PORT=0` (the MCP listener picks a free port, not 6006), and is stopped at the end.
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startHost, parseAppWaits } from "../../dev/host.mjs";

export { startHost, parseAppWaits };
export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Calls fn until it answers something true; throws after `timeout` ms. The bounds are generous: what must happen does not
 *  wait them out, and on a loaded machine it takes several times as long. */
export async function waitFor(what, fn, { timeout = 20000, every = 100 } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try { last = await fn(); if (last) return last; } catch (e) { last = "threw: " + e.message; }
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what} (last: ${JSON.stringify(last)?.slice(0, 300)})`);
    await sleep(every);
  }
}
/** true when fn turned true in time, else the sentence of what was last seen. */
export const holds = (what, fn, o) => waitFor(what, fn, o).then(() => true, (e) => e.message);
/** all(...): true when every part is true, else the first that is not (its sentence). */
export const all = (...parts) => parts.find((x) => x !== true) ?? true;

export function freePort() {
  return new Promise((resolve, reject) => {
    const l = net.createServer();
    l.once("error", reject);
    l.listen(0, "127.0.0.1", () => { const { port } = l.address(); l.close(() => resolve(port)); });
  });
}
export function portFree(port) {
  return new Promise((resolve) => {
    const c = net.connect({ port, host: "127.0.0.1" });
    c.once("connect", () => { c.destroy(); resolve(false); });
    c.once("error", () => resolve(true));
  });
}

/** The folder everything of a run is made in. realpath: on macOS the temp folder is a symlink, and the server reports folders resolved. */
export const makeOut = (name) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `aiwb-e2e-${name}-`)));

/** The built page: AIWB_E2E_CLIENT, else web/dist. */
export function pageDist() {
  const dist = path.resolve(process.env.AIWB_E2E_CLIENT || path.join(repo, "web/dist"));
  if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error(`${dist} holds no built page: cd web && npm run build`);
  return dist;
}

/** The server program: AIWB_E2E_BIN, else built into `out`. version: stamped into the build (the build the program says it is), for
 *  a script that needs two builds; AIWB_E2E_BIN is one build, and a script that needs two builds builds them itself. */
export function serverBinary(out, { version = "", name = "aiwb" } = {}) {
  if (process.env.AIWB_E2E_BIN && !version) return path.resolve(process.env.AIWB_E2E_BIN);
  const bin = path.resolve(path.join(out, name));
  execFileSync("go", ["build", ...(version ? ["-ldflags", `-X ai-whiteboard/internal/version.Version=${version}`] : []), "-o", bin, "./cmd/ai-whiteboard"], { cwd: repo, stdio: ["ignore", "inherit", "inherit"] });
  return bin;
}

/** The stand-in agent (internal/agenttest/fake-claude), copied into `out`: no script of web/e2e calls a paid model. */
export function standInAgent(out) {
  const fake = path.join(out, "bin", "fake-claude");
  fs.mkdirSync(path.dirname(fake), { recursive: true });
  fs.copyFileSync(path.join(repo, "internal/agenttest/fake-claude"), fake);
  fs.chmodSync(fake, 0o755);
  return fake;
}

export async function loadChromium() {
  try { return (await import("playwright")).chromium; }
  catch { throw new Error("playwright is not installed: cd web && npm install --no-save playwright && npx playwright install chromium"); }
}

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const run = (bin, args, env, timeout = 60000) => new Promise((resolve) => {
  execFile(bin, args, { env, timeout, encoding: "utf8" }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout, stderr }));
});

/** A scratch server: a data folder, a work folder, a client port and the flags that give it the stand-in agent and no other.
 *  It is started and stopped with the server program's own commands (`launch -json`, `stop`), as the app does it, so it runs
 *  detached and outlives the script unless stopped (finish() stops every one). */
export class Scratch {
  constructor({ out, bin, agent, tag, name, realAgents = false, envFn = null }) {
    Object.assign(this, { out, bin, agent, tag, name, realAgents, envFn });
    this.home = path.join(out, tag, "home");
    this.work = path.join(out, tag, "work");
    this.cursorCfg = path.join(out, tag, "cursor-config");
    this.log = path.join(this.home, "server.log");
    this.port = 0; // the client listener's
    this.fingerprint = "";
    this.secret = "";
    this.info = null; // what the last launch printed
    this.pids = [];
    for (const d of [this.home, this.work, this.cursorCfg]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(this.work, "README.md"), `scratch ${tag}\n`);
  }

  /** The environment of the server program: a free MCP port, the client listener on the loopback address, an empty Cursor config. */
  get env() {
    if (this.envFn) return this.envFn();
    return { ...process.env, AIWB_MCP_PORT: "0", AIWB_REMOTE_BIND: "127.0.0.1", CURSOR_CONFIG_DIR: this.cursorCfg };
  }
  /** The flags of `launch`: the work folder, the stand-in agent (when this server has one) and no Cursor and no pi; with realAgents
   *  the work folder alone (the real agents the machine has, which cost money). */
  get flags() {
    if (this.realAgents) return ["-cwd", this.work];
    return ["-cwd", this.work, "-claude", this.agent ?? "/nonexistent/claude", "-cursor", "/nonexistent/agent", "-pi", "/nonexistent/pi", "-cursor-cost", "/nonexistent/cursor-cost"];
  }

  /** Sets remote access up (the command the user runs by hand, once): the certificate, the secret and the port. */
  async setUp(port = 0) {
    this.port = port || await freePort();
    const out = execFileSync(this.bin, ["remote", "setup", "-home", this.home, "-port", String(this.port), "-name", "127.0.0.1"], { env: this.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    this.fingerprint = /^Fingerprint:\s*(\S+)/m.exec(out)?.[1] ?? "";
    this.secret = fs.readFileSync(path.join(this.home, "remote-secret"), "utf8").trim();
    if (!this.fingerprint || !this.secret) throw new Error(`remote setup gave no fingerprint or no secret: ${out}`);
    return this;
  }

  /** `launch -json`: finds the server or starts it detached. Answers what it printed, or throws with its message. */
  async launch() {
    const r = await run(this.bin, ["launch", "-json", "-home", this.home, ...this.flags], this.env, 90000);
    if (r.code !== 0) throw new Error(`launch of server ${this.tag} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    this.info = JSON.parse(r.stdout.trim().split("\n").pop());
    if (this.info.pid && !this.pids.includes(this.info.pid)) this.pids.push(this.info.pid);
    return this.info;
  }

  /** The program's `status -json`. */
  async status() {
    const r = await run(this.bin, ["status", "-json", "-home", this.home], this.env);
    try { return JSON.parse(r.stdout); } catch { throw new Error(`status of server ${this.tag}: ${r.stderr || r.stdout}`); }
  }

  /** `stop`: the server ends and the command waits for it. */
  async stop() {
    await run(this.bin, ["stop", "-home", this.home], this.env, 30000);
    for (const pid of this.pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  }

  /** Ends the running server without the program's help, as a crash does. */
  kill(signal = "SIGKILL") { process.kill(this.info.pid, signal); }

  alive() { return this.pids.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }); }

  /** A program for the host's `--local-bin`: the server program with this server's flags added to `launch` and `relaunch` (the host
   *  runs them with `-home` and `-json` alone). Answers { file, set(config), clear() }; the program reads its config file at every
   *  run, so a script stages what the app meets without restarting the host:
   *    bin      the server program to run instead (another build)
   *    launch   { stdout, stderr, code }: what `launch` and `relaunch` print and exit with, and nothing else is done
   *    secret   the line `secret` prints, and nothing else is done */
  wrapper() {
    const file = path.join(this.out, "bin", `aiwb-${this.tag}.js`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const config = file + ".json";
    fs.writeFileSync(file, `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const config = ${JSON.stringify(config)};
const cfg = fs.existsSync(config) ? JSON.parse(fs.readFileSync(config, "utf8")) : {};
const args = process.argv.slice(2);
const cmd = args[0];
const starts = cmd === "launch" || cmd === "relaunch";
if (starts && cfg.launch) { process.stdout.write(cfg.launch.stdout || ""); process.stderr.write(cfg.launch.stderr || ""); process.exit(cfg.launch.code || 0); }
if (cmd === "secret" && cfg.secret !== undefined) { console.log(cfg.secret); process.exit(0); }
const r = spawnSync(cfg.bin || ${JSON.stringify(this.bin)}, [cmd, ...(starts ? ${JSON.stringify(this.flags)} : []), ...args.slice(1)], { stdio: "inherit" });
process.exit(r.status === null ? 1 : r.status);
`, { mode: 0o755 });
    const w = {
      file,
      set: (c) => fs.writeFileSync(config, JSON.stringify(c)),
      clear: () => fs.rmSync(config, { force: true }),
    };
    return w;
  }
}

/** A host for a page of this computer's server `local` (a Scratch, or none): the state folder is new for each host, so each is
 *  another app with its own list and its own client id (the same name is the same app: it finds its list again). wrapper: the
 *  program for --local-bin (Scratch.wrapper()), default one that adds the server's flags. extra: more options of startHost
 *  (timing, dial, port, dist, env). */
export async function hostFor({ out, name, local = null, wrapper, extra = {} }) {
  const stateDir = path.join(out, `state-${name}`);
  const host = await startHost({
    stateDir, dist: pageDist(), log: (line) => console.log(`# host ${name}: ${line}`),
    ...(local ? { localBin: (wrapper ?? local.wrapper()).file ?? wrapper, localHome: local.home, env: local.env } : {}),
    ...extra,
  });
  return Object.assign(host, { name, stateDir });
}

/** A call of the client API through a host, as the page makes it: { status, json, text, rev }. */
export async function hostCall(host, server, method, p, body) {
  const r = await fetch(`${host.url}host/call?server=${encodeURIComponent(server)}&method=${method}&path=${encodeURIComponent(p)}`, {
    method: "POST", signal: AbortSignal.timeout(20000),
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  const rev = r.headers.get("x-aiwb-scene-rev");
  return { status: r.status, json, text, rev: rev === null ? null : Number(rev) };
}
/** An operation of the app through a host: { status, json }. */
export async function hostApp(host, op, args) {
  const r = await fetch(`${host.url}host/app/${op}`, {
    method: "POST", signal: AbortSignal.timeout(20000),
    ...(args === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(args) }),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

/** The call a request of the page carries: { server, method, path } for a POST /host/call, an operation for /host/app, else null. */
export function callOf(url) {
  const u = new URL(url);
  if (u.pathname === "/host/call") return { server: u.searchParams.get("server"), method: u.searchParams.get("method"), path: u.searchParams.get("path") };
  if (u.pathname.startsWith("/host/app/")) return { server: "", method: "APP", path: decodeURIComponent(u.pathname.slice("/host/app/".length)) };
  return null;
}

/** Opens the page of a host in a context of its own (another localStorage) and keeps what it does. errors: console errors and
 *  uncaught exceptions; failedRequests: requests that failed or were answered with 400 or more; calls: every call and every
 *  operation of the page with its body and, once answered, its status and code, in the order they were made. */
export async function openPage(browser, host, { viewport = { width: 1400, height: 900 }, timeout = 10000, wait = "#root .side-tree" } = {}) {
  const ctx = await browser.newContext({ viewport });
  const p = await ctx.newPage();
  p.setDefaultTimeout(timeout);
  p.ctx = ctx;
  p.host = host;
  p.errors = [];
  p.failedRequests = [];
  p.calls = [];
  p.on("console", (m) => { if (m.type() === "error") p.errors.push(m.text()); });
  p.on("pageerror", (e) => p.errors.push(`uncaught: ${e.message}`));
  p.on("requestfailed", (r) => p.failedRequests.push(`${r.method()} ${new URL(r.url()).pathname} ${r.failure()?.errorText}`));
  p.pending = new Set(); // the requests that are not over: what a page that does not load is waiting for
  p.on("request", (r) => p.pending.add(r));
  p.on("requestfinished", (r) => p.pending.delete(r));
  p.on("requestfailed", (r) => p.pending.delete(r));
  p.on("request", (r) => {
    const c = callOf(r.url());
    if (!c) return;
    const call = { ...c, body: r.postData() ?? "", status: 0, code: "" };
    r.call = call;
    p.calls.push(call);
  });
  p.on("response", (r) => {
    if (r.status() >= 400) p.failedRequests.push(`${r.request().method()} ${callOf(r.url())?.path ?? new URL(r.url()).pathname} -> ${r.status()}`);
    const call = r.request().call;
    if (!call) return;
    call.status = r.status();
    if (r.status() >= 400) r.json().then((j) => { call.code = j?.code ?? j?.error ?? ""; }, () => {});
  });
  await p.goto(host.url);
  if (wait) await p.waitForSelector(wait, { timeout: 20000 });
  return p;
}
/** The calls of the client API a page made from now on that change something (no GET, no operation of the app), as "METHOD path". */
export const writesFrom = (p) => { const at = p.calls.length; return () => p.calls.slice(at).filter((c) => c.method !== "GET" && c.method !== "APP").map((c) => `${c.method} ${c.path}`); };
export const callsFrom = (p) => { const at = p.calls.length; return () => p.calls.slice(at); };

/** Ends a run: stops every server of `scratches`, and answers whether none of their ports or processes is left. */
export async function finish(scratches) {
  for (const s of scratches) await s.stop().catch(() => {});
  const alive = scratches.flatMap((s) => s.alive());
  const free = (await Promise.all(scratches.map((s) => s.port).filter(Boolean).map(portFree))).every(Boolean);
  return { alive, free };
}

/** Stops what a script started when it is ended early (SIGTERM, SIGINT, SIGHUP): fn runs once, then the process ends. */
export function onSignal(fn) {
  let done = false;
  for (const [signal, n] of [["SIGTERM", 15], ["SIGINT", 2], ["SIGHUP", 1]]) process.once(signal, async () => {
    if (!done) { done = true; await Promise.resolve().then(fn).catch(() => {}); }
    process.exit(128 + n);
  });
}

/** A link a script owns between a host and a server: a TCP relay to the server's client port. The host dials it in the place
 *  of the server's address (`link.dial`, the host's test seam for net.connect), so TLS, the pin and the Host header stay the
 *  entry's, and the script can pull the network while the server goes on, hold the server's answers back, or put another
 *  server behind the entry's address (`target`).
 *  pass: as a wire. cut: every connection ends and none is taken (the network is pulled; the server goes on). hold: a
 *  connection is taken and nothing is passed on (a server that does not answer the dial). mute: what the host sends arrives,
 *  what the server answers is held back until pass (answers that are late or lost). stall: nothing passes either way on the
 *  connections that are open, until pass. slow: what the server answers arrives `delay` later (a slow line). */
export class Link {
  constructor(target, { delay = 1500 } = {}) {
    this.target = target;
    this.delay = delay;
    this.mode = "pass";
    this.pairs = new Set();
    this.port = 0;
    this.server = null;
    this.dial = () => net.connect({ host: "127.0.0.1", port: this.port });
  }

  async open() {
    this.port = await freePort();
    this.server = net.createServer((c) => {
      c.on("error", () => {});
      if (this.mode === "cut") { c.destroy(); return; }
      const pair = { c, u: null, muted: false };
      this.pairs.add(pair);
      c.on("close", () => { pair.u?.destroy(); this.pairs.delete(pair); });
      if (this.mode === "hold") return;
      const u = net.connect({ host: "127.0.0.1", port: this.target });
      pair.u = u;
      u.on("error", () => {});
      u.on("close", () => c.destroy());
      this.answersTo(pair);
      if (this.mode === "stall") { pair.stalled = true; pair.muted = true; c.pause(); u.pause(); return; }
      c.pipe(u);
      if (this.mode === "mute") { pair.muted = true; u.pause(); }
    });
    await new Promise((resolve, reject) => { this.server.once("error", reject); this.server.listen(this.port, "127.0.0.1", resolve); });
    return this;
  }

  /** Passes what the server answers on to the host: at once, or `delay` later while the link is slow, in the order it came. */
  answersTo(pair) {
    pair.u.on("data", (d) => {
      const due = Math.max(Date.now() + (this.mode === "slow" ? this.delay : 0), pair.due ?? 0);
      pair.due = due;
      if (due <= Date.now()) { if (!pair.c.destroyed) pair.c.write(d); return; }
      setTimeout(() => { if (!pair.c.destroyed) pair.c.write(d); }, due - Date.now());
    });
  }

  set(mode) {
    this.mode = mode;
    for (const p of [...this.pairs]) {
      if (mode === "cut" || mode === "hold") { p.c.destroy(); p.u?.destroy(); this.pairs.delete(p); }
      else if (mode === "mute" && p.u && !p.muted) { p.u.pause(); p.muted = true; }
      else if (mode === "stall" && p.u && !p.stalled) { p.c.unpipe(p.u); p.c.pause(); p.u.pause(); p.stalled = p.muted = true; }
      else if (mode === "pass" && p.u && (p.muted || p.stalled)) {
        if (p.stalled) { p.stalled = false; p.c.pipe(p.u); p.c.resume(); }
        p.muted = false; p.u.resume();
      }
      else if (mode === "pass" && !p.u) { p.c.destroy(); this.pairs.delete(p); } // one that was held: the host dials anew
    }
  }

  async close() {
    for (const p of this.pairs) { p.c.destroy(); p.u?.destroy(); }
    if (this.server) await new Promise((r) => this.server.close(r));
  }
}
