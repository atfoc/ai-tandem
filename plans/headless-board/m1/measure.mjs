// M1 — measure the quiet time (plans/headless-board/m1-quiet-time.md). A throwaway measurement, kept so that the numbers can be made again.
//
// A scratch server (web/e2e/lib/rig.mjs: its own data folder, free ports) with the stand-in agent and the real headless writer, as
// web/e2e/away.e2e.mjs starts it. No window is connected. The agent's calls are made as the agent makes them, on the chat's MCP endpoint
// (tools/call), and timed from this script. Inside the headless process, preload.cjs (NODE_OPTIONS=--require, the product is untouched)
// writes a timestamped line for the start of the process and for each connection and request it makes, to M1_LOG. Nothing is paid for.
//
//   node plans/headless-board/m1/measure.mjs [--runs 7] [--out results.json]      the table (cold, reload, warm, memory)
//   node plans/headless-board/m1/measure.mjs --drift 25 --out drift.json             only: does the memory level off over many reloads
//   node plans/headless-board/m1/measure.mjs --summarize results.json                prints the tables of a saved run
//
// Two servers, one after the other (the quiet time and the linger are lowered with AIWB_TEST_WAITS so that a run does not sit out 60 s):
//   cold   quiet=1s linger=1s: after each run the writer lets the board go and the process ends; the next call starts it again
//   reload quiet=2s linger=120s: the process stays after the board is let go; the next call takes the board again
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Scratch, finish, makeOut, onSignal, repo, serverBinary, sleep, standInAgent, waitFor } from "../../../web/e2e/lib/rig.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; };
const RUNS = Number(arg("runs", "7"));
const RESULT = arg("out", "");
const OUT = makeOut("m1");
const LOG = path.join(OUT, "m1.log");
fs.writeFileSync(LOG, "");

class Server extends Scratch {
  constructor(o, waits) { super(o); this.waits = waits; }
  get env() { return { ...super.env, AIWB_TEST_WAITS: this.waits, NODE_OPTIONS: `--require ${path.join(here, "preload.cjs")}`, M1_LOG: LOG }; }
  get flags() { return [...super.flags, "-headless-node", process.execPath, "-headless-dir", this.headlessDir]; }
}

// ---- the client API (a client with no event stream: there is no window), as in away.e2e.mjs
const CLIENT = crypto.randomUUID();
function api(A, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = https.request({
      host: "127.0.0.1", port: A.port, path: p, method, rejectUnauthorized: false, timeout: 60000,
      headers: { "X-AIWB-Secret": A.secret, "X-AIWB-Client": CLIENT, "X-AIWB-Level": "7", ...(data === null ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }) },
      checkServerIdentity: (_, cert) => (cert.fingerprint256 === A.fingerprint ? undefined : new Error("certificate is not the pinned one")),
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { const text = Buffer.concat(chunks).toString("utf8"); let json = null; try { json = text ? JSON.parse(text) : null; } catch {} resolve({ status: res.statusCode, json, text }); });
    });
    req.on("error", reject);
    if (data !== null) req.write(data);
    req.end();
  });
}
async function must(A, method, p, body) {
  const r = await api(A, method, p, body);
  if (r.status !== 200) throw new Error(`${method} ${p}: ${r.status} ${r.text.slice(0, 300)}`);
  return r.json;
}

// ---- boards
const mcpCall = async (cfg, name, args) => {
  const t0 = Date.now();
  const res = await fetch(cfg.url, { method: "POST", headers: { "Content-Type": "application/json", ...cfg.headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const j = await res.json();
  const t1 = Date.now();
  const text = (j.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return { t0, t1, ms: t1 - t0, text, isError: !!j.result?.isError || !!j.error, bytes: JSON.stringify(j).length };
};
/** The small board: 10 elements as the file stores them (4 labelled shapes are 8, and 2 arrows). */
const smallCreate = () => [
  ...Array.from({ length: 4 }, (_, i) => ({ type: i % 2 ? "ellipse" : "rectangle", key: `s${i}`, x: i * 220, y: 0, width: 160, height: 70, label: `Service ${i}` })),
  { type: "arrow", key: "a0", start: { key: "s0" }, end: { key: "s1" } },
  { type: "arrow", key: "a1", start: { key: "s2" }, end: { key: "s3" } },
];
/** The large board of packages/board-engine/dev/cases.mjs ("large"): 30x20 labelled shapes and 600 arrows (1,819 elements with the labels). */
function largeCreate(cols = 30, rows = 20) {
  const create = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) create.push({ type: c % 3 === 1 ? "ellipse" : "rectangle", key: `n${r}_${c}`, x: c * 220, y: r * 140, width: 160, height: 70, label: `Service ${r}.${c} gateway` });
  for (let r = 0; r < rows; r++) for (let c = 0; c + 1 < cols; c++) create.push({ type: "arrow", key: `a${r}_${c}`, start: { key: `n${r}_${c}` }, end: { key: `n${r}_${c + 1}` } });
  for (let r = 0; r + 1 < rows; r++) create.push({ type: "arrow", key: `v${r}`, start: { key: `n${r}_0` }, end: { key: `n${r + 1}_0` }, label: "next" });
  return create;
}

// ---- the log of the headless process
const events = () => fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
/** The phases of a cold call, in ms, from the events of the new process (t is epoch ms; t0 and t1 are the script's, around the call). */
function phases(evs, t0, t1) {
  const ev = (name) => evs.find((e) => e.ev === name);
  const byLine = (name, re) => evs.find((e) => e.ev === name && re.test(e.line));
  const start = ev("start"), pre = ev("preload"), conn = ev("tls.connect");
  const stream = byLine("response", /GET \/api\/events$/);
  const scene = byLine("request", /GET \/api\/boards\/[^/]+\/scene$/);
  const replyReq = byLine("request", /POST \/api\/rpc-reply$/);
  if (![start, pre, conn, stream, scene, replyReq].every(Boolean)) return null;
  return {
    spawn: start.t - t0,              // the call reaches the server, the server starts the process
    boot: pre.t - start.t,            // Node boots up to the bundle's first line
    engine: conn.t - pre.t,           // the bundle loads, the configuration is read, the engine says ready, the first connection starts
    stream: stream.t - conn.t,        // TLS, hello, the event stream is open
    grant: scene.t - stream.t,        // the call's rpc arrives over the stream with the board granted, and the scene is asked for
    load: replyReq.t - scene.t,       // the scene is read from the server, restored in the engine, the tool runs, the reply is sent
    answer: t1 - replyReq.t,          // the reply goes back to the agent
    total: t1 - t0,
  };
}
/** The phases of a call on a board the process takes again (no start, no stream): from the request of the scene. */
function reloadPhases(evs, t0, t1) {
  const scene = evs.find((e) => e.ev === "request" && /GET \/api\/boards\/[^/]+\/scene$/.test(e.line));
  const replyReq = evs.find((e) => e.ev === "request" && /POST \/api\/rpc-reply$/.test(e.line));
  if (!scene || !replyReq) return null;
  return { grant: scene.t - t0, load: replyReq.t - scene.t, answer: t1 - replyReq.t, total: t1 - t0 };
}

// ---- memory
const rssOf = (pid) => new Promise((resolve) => execFile("ps", ["-o", "rss=", "-p", String(pid)], (e, out) => resolve(e ? 0 : Math.round(Number(out.trim()) / 1024))));
function sampler(pid) {
  let max = 0, stop = false;
  const loop = (async () => { while (!stop) { max = Math.max(max, await rssOf(pid)); await sleep(20); } })();
  return async () => { stop = true; await loop; return max; };
}

// ---- main
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const results = { runs: RUNS, node: process.version, machine: `${process.platform} ${process.arch}`, cold: { small: [], large: [] }, reload: { small: [], large: [] }, warm: { small: [], large: [] }, rss: {}, setup: {} };
let servers = [];
onSignal(async () => { for (const s of servers) await s.stop(); });

async function boot(tag, waits, bin, dist) {
  const A = new Server({ out: OUT, bin, agent: standInAgent(OUT), tag, name: "This computer" }, waits);
  A.headlessDir = dist;
  await A.setUp();
  await A.launch();
  servers.push(A);
  return A;
}
const headless = async (A) => (await A.status()).running?.headless;

async function world(A) {
  const mk = async (name) => (await must(A, "POST", "/api/boards", { name, group: "__ungrouped__" })).id;
  const small = await mk("small"), large = await mk("large");
  const chat = (await must(A, "POST", "/api/chats", { agent: "claude", board: small })).id;
  await must(A, "PATCH", `/api/chats/${chat}`, { cwd: A.work });
  const before = (await must(A, "GET", `/api/chats/${chat}/items`)).items?.filter((i) => i.kind === "end").length ?? 0;
  await must(A, "POST", `/api/chats/${chat}/messages`, { text: "hello" });
  await waitFor("the first turn ends", async () => ((await must(A, "GET", `/api/chats/${chat}/items`)).items ?? []).filter((i) => i.kind === "end").length > before, { timeout: 60000, every: 200 });
  const cfg = JSON.parse(fs.readFileSync(path.join(A.home, "chats", chat, "mcp.json"), "utf8")).mcpServers.board;
  // seed: the first apply on each board is a cold start too (not measured)
  const s = await mcpCall(cfg, "apply", { board: small, create: smallCreate() });
  const l = await mcpCall(cfg, "apply", { board: large, create: largeCreate() });
  const fileOf = (id) => path.join(A.home, "boards", id, "drawing.excalidraw");
  const scene = (id) => JSON.parse(fs.readFileSync(fileOf(id), "utf8"));
  const live = (id) => scene(id).elements.filter((e) => !e.isDeleted);
  results.setup = { smallApplyMs: s.ms, largeApplyMs: l.ms, smallElements: live(small).length, largeElements: live(large).length, largeFileBytes: fs.statSync(fileOf(large)).size, smallFileBytes: fs.statSync(fileOf(small)).size, smallErr: s.isError ? s.text : "", largeErr: l.isError ? l.text : "" };
  console.log("# setup", JSON.stringify(results.setup));
  return { cfg, boards: { small, large }, ids: { small: live(small)[0].id, large: live(large)[0].id } };
}

/** Waits until the headless process is gone (cold) or holds no board while it runs (reload). */
const idleCold = (A) => waitFor("the headless process has ended", async () => { const h = await headless(A); return !h.running ? h : null; }, { timeout: 60000, every: 150 });
const idleLoose = (A) => waitFor("the writer let the board go but the process runs", async () => { const h = await headless(A); return h.running && h.boards === 0 ? h : null; }, { timeout: 60000, every: 100 });

function record(into, size, call, evs, reload = false, extra = {}) {
  const p = (reload ? reloadPhases : phases)(evs, call.t0, call.t1);
  into[size].push({ ms: call.ms, err: call.isError ? call.text.slice(0, 200) : "", bytes: call.bytes, phases: p, ...extra, evs: evs.map((e) => ({ ...e, t: e.t - call.t0 })) });
  return p;
}

async function measureCold(A, w, bin) {
  for (let i = 0; i < RUNS; i++) for (const size of ["small", "large"]) {
    await idleCold(A);
    await sleep(300);
    const mark = events().length;
    const call = await mcpCall(w.cfg, "read_board", { board: w.boards[size] });
    const evs = events().slice(mark);
    const pid = evs.find((e) => e.ev === "start")?.pid;
    const rss = pid ? await rssOf(pid) : 0;
    const p = record(results.cold, size, call, evs, false, { rss });
    console.log(`cold ${size} #${i + 1}: ${call.ms} ms${call.isError ? " ERROR " + call.text.slice(0, 100) : ""}; ${p ? JSON.stringify(p) : "NO PHASES"}; rss ${rss} MB`);
  }
}

async function measureReload(A, w) {
  // the writer has the process running with no board
  for (const size of ["small", "large"]) {
    // memory of the process with no board, with the board, after a picture
    const rss = (results.rss[size] = { empty: [], held: [], afterRead: [], peakImage: [] });
    for (let i = 0; i < RUNS; i++) {
      await idleLoose(A);
      const h = await headless(A);
      rss.empty.push(await rssOf(h.pid));
      await sleep(200);
      const mark = events().length;
      const call = await mcpCall(w.cfg, "read_board", { board: w.boards[size] });
      const evs = events().slice(mark);
      const p = record(results.reload, size, call, evs, true);
      rss.held.push(await rssOf(h.pid));
      console.log(`reload ${size} #${i + 1}: ${call.ms} ms${call.isError ? " ERROR " + call.text.slice(0, 100) : ""}; ${p ? JSON.stringify(p) : "NO PHASES"}`);
      // warm calls on the board it holds now: read_board, then an update (a change + save)
      const mark2 = events().length;
      const warm = await mcpCall(w.cfg, "read_board", { board: w.boards[size] });
      const upd = await mcpCall(w.cfg, "apply", { board: w.boards[size], update: [{ ref: { id: w.ids[size] }, moveBy: [1, 1] }] });
      const evs2 = events().slice(mark2);
      results.warm[size].push({ readMs: warm.ms, applyMs: upd.ms, applyErr: upd.isError ? upd.text.slice(0, 200) : "", requests: evs2.filter((e) => e.ev === "request").map((e) => e.line) });
      console.log(`warm ${size} #${i + 1}: read_board ${warm.ms} ms, apply ${upd.ms} ms${upd.isError ? " ERROR " + upd.text.slice(0, 100) : ""}`);
      rss.afterRead.push(await rssOf(h.pid));
      // a picture of the whole board (the largest memory the board costs)
      const stop = sampler(h.pid);
      const img = await mcpCall(w.cfg, "get_image", { board: w.boards[size], scope: "all", scale: 0.5 });
      rss.peakImage.push(await stop());
      (results.warm[size].at(-1)).imageMs = img.ms;
      (results.warm[size].at(-1)).imageErr = img.isError ? img.text.slice(0, 200) : "";
    }
  }
}

/** min / median / max of a column. */
const stat = (rows, f) => { const v = rows.map(f).filter((x) => typeof x === "number"); return v.length ? `${Math.min(...v)} / ${med(v)} / ${Math.max(...v)}` : "-"; };
function summary() {
  const out = [];
  const line = (...c) => out.push(`| ${c.join(" | ")} |`);
  out.push("min / median / max in ms (n = runs); times in the cold rows are from the call sent to the answer", "");
  line("cold start", "n", "spawn", "node boot", "engine ready", "stream open", "grant", "load + call", "answer back", "total", "RSS MB right after"); line(...Array(11).fill("---"));
  for (const size of ["small", "large"]) { const r = results.cold[size]; line(size, r.length, ...["spawn", "boot", "engine", "stream", "grant", "load", "answer", "total"].map((k) => stat(r, (x) => x.phases?.[k])), stat(r, (x) => x.rss)); }
  out.push(""); line("reload (process runs)", "n", "grant", "load + call", "answer back", "total"); line(...Array(6).fill("---"));
  for (const size of ["small", "large"]) { const r = results.reload[size]; line(size, r.length, ...["grant", "load", "answer", "total"].map((k) => stat(r, (x) => x.phases?.[k]))); }
  out.push(""); line("warm (board held)", "n", "read_board", "apply (move one element)", "get_image all, scale 0.5"); line(...Array(5).fill("---"));
  for (const size of ["small", "large"]) { const r = results.warm[size]; line(size, r.length, stat(r, (x) => x.readMs), stat(r, (x) => x.applyMs), stat(r, (x) => x.imageMs)); }
  out.push(""); line("RSS of the process, MB", "n", "holds no board", "holds the board", "after read + apply", "peak during get_image"); line(...Array(6).fill("---"));
  for (const size of ["small", "large"]) { const r = results.rss[size]; if (r) line(size, r.empty.length, stat(r.empty.map((v) => ({ v })), (x) => x.v), stat(r.held.map((v) => ({ v })), (x) => x.v), stat(r.afterRead.map((v) => ({ v })), (x) => x.v), stat(r.peakImage.map((v) => ({ v })), (x) => x.v)); }
  return out.join("\n");
}

/** Does the memory of a process that takes the large board again and again (with or without a picture each time) level off? */
async function measureDrift(A, w, cycles) {
  const series = { read: [], readImage: [] };
  for (const [name, image] of [["read", false], ["readImage", true]]) {
    for (let i = 0; i < cycles; i++) {
      const h = await idleLoose(A);
      series[name].push(await rssOf(h.pid));
      await mcpCall(w.cfg, "read_board", { board: w.boards.large });
      if (image) await mcpCall(w.cfg, "get_image", { board: w.boards.large, scope: "all", scale: 0.5 });
    }
    console.log(`drift ${name}: ${series[name].join(" ")}`);
  }
  results.drift = series;
}

if (arg("summarize", "")) {
  Object.assign(results, JSON.parse(fs.readFileSync(arg("summarize", ""), "utf8")));
  console.log(summary());
  fs.rmSync(OUT, { recursive: true, force: true });
  process.exit(0);
}

try {
  const bin = serverBinary(OUT);
  const dist = path.join(OUT, "headless");
  execFileSync(process.execPath, [path.join(repo, "packages/headless/build.mjs"), "--out", dist], { stdio: ["ignore", "inherit", "inherit"] });
  console.log(`# files in ${OUT}`);

  const drift = Number(arg("drift", "0")); // --drift N: only the memory drift test, N cycles of each kind
  if (!drift) {
    const C = await boot("cold", "quiet=1s,linger=1s", bin, dist);
    const wc = await world(C);
    await measureCold(C, wc, bin);
    await C.stop();
  }

  const R = await boot("reload", "quiet=2s,linger=120s", bin, dist);
  const wr = await world(R);
  if (drift) await measureDrift(R, wr, drift); else await measureReload(R, wr);
  await R.stop();
  const end = await finish(servers);
  console.log(`# stopped: port free ${end.free}, processes left ${end.alive.join(",") || "none"}`);
  if (!drift) console.log(summary());
} finally {
  for (const s of servers) await s.stop().catch(() => {});
  if (RESULT) fs.writeFileSync(RESULT, JSON.stringify(results, null, 1));
  console.log(`# results ${RESULT || "(not saved)"}; files in ${OUT}`);
}
