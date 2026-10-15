#!/usr/bin/env node
// The runner of the iOS network spike (plans/rn-rewrite/spikes/ios-net.md). One command, repeatable:
//
//   node spikes/ios-net/run.mjs [--minutes N] [--skip-build] [--udid <simulator>] [--out <dir>] [--rate-ms 500]
//
// It builds the Go server, starts a SCRATCH server (its own home and a free port; never the user's on 4748/6006), starts the stand-ins
// the checks need (two TLS "tripwire" servers that count what is written to them, a plain HTTP server, a closed port), builds the Expo
// app with its Swift module and installs it on the simulator (unless --skip-build), launches it with its configuration in the
// environment, and reads what the app logs from the simulator's data container (and from `log stream`, which is kept as a file too).
// Without --minutes the app runs its checks (about a minute). With --minutes N it holds the event stream for N minutes while this
// script changes a board twice a second, and samples the app's memory (ps rss, and `footprint` at the start, the middle and the end).
//
// Exit code 0 when every check passed (and, with --minutes, the stream was held to the end).
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const appDir = path.join(here, "app");
const DOTTED = "localtest.me";
const BUNDLE = "app.aiwb.netspike";
const { Scratch, freePort } = await import(path.join(repo, "web/e2e/lib/rig.mjs"));

// ---------------------------------------------------------------- arguments
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const flag = (name) => args.includes(name);
const minutes = Number(opt("--minutes", "0"));
const udid = opt("--udid", "E248FFFE-27D2-4569-9DEE-198432BC5428");
const extraEnv = Object.fromEntries(args.flatMap((a, i) => (a === "--env" ? [args[i + 1].split(/=(.*)/s).slice(0, 2)] : [])));
const rateMs = Number(opt("--rate-ms", "500"));
const out = path.resolve(opt("--out", fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-spike-ios-run-"))));
fs.mkdirSync(out, { recursive: true });
const t00 = Date.now();
const say = (m) => console.log(`[${((Date.now() - t00) / 1000).toFixed(0).padStart(4)}s] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanups = [];
async function cleanup() { for (const f of cleanups.reverse()) { try { await f(); } catch (e) { console.error("cleanup:", e.message); } } cleanups.length = 0; }
process.on("SIGINT", async () => { await cleanup(); process.exit(130); });

try {
  await main();
} catch (e) {
  console.error("RUN FAILED:", e.stack || e);
  await cleanup();
  process.exit(1);
}

async function main() {
  say(`output folder ${out}`);
  // --------------------------------------------------------------- server
  const bin = process.env.AIWB_E2E_BIN || path.join(out, "ai-whiteboard");
  if (!process.env.AIWB_E2E_BIN) execFileSync("go", ["build", "-o", bin, "./cmd/ai-whiteboard"], { cwd: repo, stdio: "inherit" });
  const server = new Scratch({ out, bin, agent: null, tag: "server", name: "spike" });
  await server.setUp();
  // The certificate also lists a dotted name that resolves to 127.0.0.1 (public DNS), as a user's set-up lists the names clients reach it by.
  const again = execFileSync(bin, ["remote", "setup", "-home", server.home, "-port", String(server.port), "-name", "127.0.0.1", "-name", DOTTED, "-new-cert"], { env: server.env, encoding: "utf8" });
  server.fingerprint = /^Fingerprint:\s*(\S+)/m.exec(again)?.[1] ?? server.fingerprint;
  cleanups.push(() => server.stop());
  await server.launch();
  say(`scratch server on 127.0.0.1:${server.port}, fingerprint ${server.fingerprint}`);

  // ------------------------------------------------------------ stand-ins
  const cert = makeCert(out);
  const wrong = await tripwire(cert, { destroyAfterMs: 0 });
  const control = await tripwire(cert, { destroyAfterMs: 300 });
  cleanups.push(() => wrong.close(), () => control.close());
  const plain = http.createServer((q, r) => r.end("plain http, not tls")).listen(0, "127.0.0.1");
  await new Promise((r) => plain.once("listening", r));
  cleanups.push(() => new Promise((r) => plain.close(r)));
  // Servers that answer {"app":"cert-test"} over h2 with a certificate of a given validity, to find what the system's network stack
  // demands of a certificate that the app accepts by its pin (the server's own certificate is valid for 10 years).
  const certTests = [];
  for (const [name, days] of [["valid-365-days", 365], ["valid-3650-days", 3650]]) {
    const c = makeCert(out, { name: name + "-dns", days, dns: DOTTED });
    const srv = http2.createSecureServer({ key: c.key, cert: c.cert });
    srv.on("request", (q, r) => { r.setHeader("content-type", "application/json"); r.end('{"app":"cert-test"}'); });
    srv.on("tlsClientError", () => {});
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    cleanups.push(() => { srv.closeAllConnections?.(); srv.close(); });
    certTests.push({ name, port: srv.address().port, pin: c.fingerprint });
  }
  // A server whose event stream sends two events and then nothing, not even a ping, and keeps the connection open: a stream gone silent.
  const stallCert = makeCert(out, { name: "stall", days: 365 });
  const stallSrv = http2.createSecureServer({ key: stallCert.key, cert: stallCert.cert });
  stallSrv.on("request", (q, r) => {
    if (q.url.startsWith("/api/events")) {
      r.writeHead(200, { "content-type": "text/event-stream" });
      r.write('data: {"type":"hello"}\n\n');
      r.write('data: {"type":"snapshot"}\n\n');
      return; // and then silence
    }
    r.setHeader("content-type", "application/json");
    r.end('{"app":"stall-test"}');
  });
  stallSrv.on("tlsClientError", () => {});
  await new Promise((r) => stallSrv.listen(0, "127.0.0.1", r));
  cleanups.push(() => { stallSrv.closeAllConnections?.(); stallSrv.close(); });
  const stall = { port: stallSrv.address().port, pin: stallCert.fingerprint };
  const closedPort = await freePort();
  say(`tripwires on ${wrong.port} (wrong pin) and ${control.port} (control), plain http on ${plain.address().port}, closed port ${closedPort}`);

  // ------------------------------------------------------------ the app
  if (!flag("--skip-build")) await buildApp();
  const config = {
    mode: minutes > 0 ? "long" : "checks",
    host: "127.0.0.1", port: server.port, pin: server.fingerprint, secret: server.secret,
    clientId: crypto.randomUUID(),
    wrongPin: "00:" + server.fingerprint.split(":").slice(1).join(":"),
    tripwireWrongPort: wrong.port, tripwireControlPort: control.port, tripwirePin: cert.fingerprint,
    dottedName: DOTTED, certTests, stall, closedPort, plainPort: plain.address().port,
    longMs: minutes * 60000 + 90000, heartbeatMs: 30000, // the app holds the stream a little beyond the last sample
  };
  sh("xcrun", ["simctl", "bootstatus", udid, "-b"], { quiet: true });
  spawnSync("xcrun", ["simctl", "terminate", udid, BUNDLE]);
  const installed = sh("xcrun", ["simctl", "get_app_container", udid, BUNDLE, "app"]).trim();
  say(`installed app's NSAppTransportSecurity: ${sh("plutil", ["-extract", "NSAppTransportSecurity", "json", "-o", "-", path.join(installed, "Info.plist")], { allowFail: true, quiet: true }).trim() || "(none)"}`);
  const container = sh("xcrun", ["simctl", "get_app_container", udid, BUNDLE, "data"]).trim();
  const logFile = path.join(container, "Documents", "aiwb-spike.log");
  fs.rmSync(logFile, { force: true });

  const streamLog = fs.createWriteStream(path.join(out, "oslog.txt"));
  const ls = spawn("xcrun", ["simctl", "spawn", udid, "log", "stream", "--style", "compact", "--predicate", 'eventMessage CONTAINS "AIWB_SPIKE"'], { stdio: ["ignore", "pipe", "ignore"] });
  ls.stdout.pipe(streamLog);
  cleanups.push(() => ls.kill());

  const launch = spawnSync("xcrun", ["simctl", "launch", udid, BUNDLE], { encoding: "utf8", env: { ...process.env, SIMCTL_CHILD_AIWB_CONFIG: JSON.stringify(config), ...Object.fromEntries(Object.entries(extraEnv).map(([k, v]) => [`SIMCTL_CHILD_${k}`, v])) } });
  if (launch.status !== 0) throw new Error(`launch failed: ${launch.stderr || launch.stdout}`);
  const pid = Number(/:\s*(\d+)/.exec(launch.stdout)[1]);
  say(`app launched, pid ${pid}`);
  cleanups.push(() => spawnSync("xcrun", ["simctl", "terminate", udid, BUNDLE]));

  // -------------------------------------------------------- watch the app
  const lines = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean) : []);
  let driver = null;
  const samples = [];
  const sample = (label) => {
    const rss = Number(sh("ps", ["-o", "rss=", "-p", String(pid)], { quiet: true, allowFail: true }).trim() || 0);
    samples.push({ t: Math.round((Date.now() - tStart) / 1000), label, rssKB: rss });
    return rss;
  };
  let tStart = Date.now();
  const footprints = {};
  const takeFootprint = (label) => {
    const r = spawnSync("footprint", ["-p", String(pid)], { encoding: "utf8" });
    footprints[label] = (r.stdout || r.stderr || "").trim();
    fs.writeFileSync(path.join(out, `footprint-${label}.txt`), footprints[label] + "\n");
    const m = /Footprint:\s*([\d.]+\s*\w+)/.exec(footprints[label]);
    say(`footprint ${label}: ${m ? m[1] : "(see footprint-" + label + ".txt)"}`);
  };

  const deadline = Date.now() + (minutes > 0 ? minutes * 60000 + 240000 : 240000);
  let done = null;
  if (minutes > 0) {
    // wait for the stream to be up, then start changing a board and sampling
    while (!lines().some((l) => /^(STREAM-OPEN|CRASH)/.test(l)) && Date.now() < deadline) await sleep(500);
    await sleep(10000);
    tStart = Date.now();
    driver = startDriver(server, rateMs);
    cleanups.push(() => driver.stop());
    sample("start"); takeFootprint("start");
    let mid = false;
    let lastSample = 0;
    while (Date.now() < deadline) {
      done = lines().find((l) => l.startsWith("DONE "));
      if (done || lines().some((l) => l.startsWith("CRASH"))) break;
      const el = Date.now() - tStart;
      if (el - lastSample >= 30000) { lastSample = el; const r = sample("t"); say(`t=${Math.round(el / 1000)}s rss ${(r / 1024).toFixed(1)} MB; ${lines().filter((l) => l.startsWith("BEAT")).pop() || ""}`); }
      if (!mid && el >= minutes * 30000) { mid = true; sample("middle"); takeFootprint("middle"); }
      if (!footprints.end && el >= minutes * 60000) { sample("end"); takeFootprint("end"); }
      await sleep(1000);
    }
    driver.stop();
    say(`the driver made ${JSON.stringify(driver.stats)} changes`);
    if (!footprints.end) { sample("end"); takeFootprint("end"); }
  } else {
    let stopped = false;
    while (Date.now() < deadline) {
      done = lines().find((l) => l.startsWith("DONE ")) || (lines().some((l) => l.startsWith("CRASH")) ? "crash" : null);
      if (done) break;
      if (!stopped && lines().includes("AWAIT-SERVER-STOP")) { stopped = true; say("the app waits for the server to stop: stopping the scratch server"); await server.stop(); }
      await sleep(500);
    }
    sample("end");
  }
  await sleep(1500); // the last lines of `log stream`
  const all = lines();
  fs.writeFileSync(path.join(out, "app.log"), all.join("\n") + "\n");
  for (const l of all) console.log("  app| " + l.slice(0, 400));

  // --------------------------------------------------------------- verdict
  const problems = [];
  const checkLines = all.filter((l) => l.startsWith("CHECK "));
  if (minutes === 0) {
    for (const l of checkLines) if (/ FAIL /.test(l.split(" ", 3).join(" ") + " ")) problems.push(l);
    if (!done || done === "crash") problems.push("the app did not finish its checks: " + (all.find((l) => l.startsWith("CRASH")) || "no DONE line"));
    // the tripwires
    const w = wrong.stats(), c = control.stats();
    say(`tripwire (wrong pin): ${JSON.stringify(w)}`);
    say(`tripwire (control):   ${JSON.stringify(c)}`);
    if (w.appBytes !== 0) problems.push(`the tripwire of the wrong pin received ${w.appBytes} application bytes`);
    if (w.prefaces !== 0) problems.push("the tripwire of the wrong pin saw an HTTP/2 preface");
    if (c.appBytes === 0 || c.prefaces === 0) problems.push("the control tripwire saw no application bytes: the tripwire proves nothing");
    if (w.secretSeen || c.secretSeen === undefined) { /* the secret is HPACK-coded: only the byte counts are the evidence */ }
  } else {
    if (!done) problems.push("the stream run did not finish");
  }
  const report = { config: { ...config, secret: "(hidden)" }, samples, tripwire: { wrong: wrong.stats(), control: control.stats() }, problems, checks: checkLines, done };
  fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
  if (minutes > 0) {
    say("memory (rss of the app process, KB):");
    for (const s of samples.filter((x) => x.label !== "t")) say(`  ${s.label.padEnd(7)} t=${String(s.t).padStart(5)}s  ${s.rssKB} KB  (${(s.rssKB / 1024).toFixed(1)} MB)`);
    fs.writeFileSync(path.join(out, "rss.csv"), "t_seconds,label,rss_kb\n" + samples.map((s) => `${s.t},${s.label},${s.rssKB}`).join("\n") + "\n");
  }
  await cleanup();
  const failed = checkLines.filter((l) => l.split(" ")[2] === "FAIL").length;
  say(problems.length ? `PROBLEMS:\n  - ${problems.join("\n  - ")}` : `ALL GOOD (${checkLines.length} check lines, ${failed} failed)`);
  say(`evidence in ${out}`);
  process.exit(problems.length ? 1 : 0);
}

// ---------------------------------------------------------------- helpers
function sh(cmd, a, { quiet = false, allowFail = false, cwd } = {}) {
  const r = spawnSync(cmd, a, { encoding: "utf8", cwd, maxBuffer: 1 << 28 });
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${a.join(" ")} failed (${r.status}): ${r.stderr || r.stdout}`);
  if (!quiet && r.stderr) process.stderr.write(r.stderr);
  return r.stdout || "";
}

async function buildApp() {
  if (!fs.existsSync(path.join(appDir, "node_modules"))) { say("npm install"); execFileSync("npm", ["install"], { cwd: appDir, stdio: "inherit" }); }
  say("building the app (expo run:ios, Release: the bundle is inside the app, no Metro) ...");
  const r = spawnSync("npx", ["expo", "run:ios", "--device", udid, "--configuration", "Release", "--no-bundler"], {
    cwd: appDir, stdio: ["ignore", fs.openSync(path.join(out, "build.log"), "w"), "inherit"], env: { ...process.env, CI: "1", LANG: "en_US.UTF-8" },
  });
  if (r.status !== 0) throw new Error(`the build failed: see ${path.join(out, "build.log")}`);
  say("built and installed");
}

/** A self-signed certificate that is not the server's, for the tripwires. */
function makeCert(dir, { name = "tripwire", days = 30, dns = "" } = {}) {
  const key = path.join(dir, `${name}.key`), crt = path.join(dir, `${name}.crt`), cnf = path.join(dir, `${name}.cnf`);
  fs.writeFileSync(cnf, `[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=${name}\n[v3]\nsubjectAltName=${dns ? `DNS:${dns},` : ""}IP:127.0.0.1\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature\n`);
  execFileSync("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", key], { stdio: "ignore" });
  execFileSync("openssl", ["req", "-x509", "-new", "-key", key, "-days", String(days), "-config", cnf, "-out", crt], { stdio: "ignore" });
  const x = new crypto.X509Certificate(fs.readFileSync(crt));
  return { key: fs.readFileSync(key), cert: fs.readFileSync(crt), fingerprint: x.fingerprint256.toUpperCase() };
}

/** A TLS server (ALPN h2) with its own certificate that counts what is written to it after the handshake. */
async function tripwire(cert, { destroyAfterMs }) {
  const st = { connections: 0, tlsClientErrors: 0, appBytes: 0, prefaces: 0, alpn: [] };
  const server = tls.createServer({ key: cert.key, cert: cert.cert, ALPNProtocols: ["h2"] }, (sock) => {
    st.connections++;
    st.alpn.push(sock.alpnProtocol);
    sock.on("data", (d) => {
      st.appBytes += d.length;
      if (d.toString("latin1").startsWith("PRI * HTTP/2.0")) st.prefaces++;
    });
    sock.on("error", () => {});
    if (destroyAfterMs) sock.once("data", () => setTimeout(() => sock.destroy(), destroyAfterMs));
  });
  server.on("tlsClientError", () => st.tlsClientErrors++);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, stats: () => ({ ...st }), close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); setTimeout(r, 500); }) };
}

/** Changes a board of the scratch server every rateMs: a rename (an event of the stream) and, every fifth time, a drawing. */
function startDriver(server, every) {
  const cid = crypto.randomUUID();
  const c = http2.connect(`https://127.0.0.1:${server.port}`, { rejectUnauthorized: false });
  c.on("error", () => {});
  const hd = { "x-aiwb-secret": server.secret, "x-aiwb-client": cid, "x-aiwb-level": "6" };
  const call = (method, p, body) => new Promise((res) => {
    const r = c.request({ ":method": method, ":path": p, ...hd, ...(body ? { "content-type": "application/json" } : {}) });
    let s = ""; r.on("data", (d) => (s += d)); r.on("end", () => res(s)); r.on("error", () => res(""));
    r.end(body ? JSON.stringify(body) : undefined);
  });
  let stopped = false, n = 0, rev = 0, id = "";
  const stats = { renames: 0, scenes: 0 };
  (async () => {
    id = JSON.parse(await call("POST", "/api/boards", { name: "driver", group: "__ungrouped__" })).id;
    await call("POST", `/api/boards/${id}/take`, { ifFree: true });
    while (!stopped) {
      n++;
      await call("POST", `/api/boards/${id}/rename`, { name: `driver ${n} ${"é日😀".repeat(n % 8)}` });
      stats.renames++;
      if (n % 5 === 0) {
        const scene = JSON.stringify({ type: "excalidraw", version: 2, elements: Array.from({ length: 20 }, (_, i) => ({ id: "e" + i, type: "rectangle", x: i * 10, y: n, width: 40, height: 40 })) });
        const r = await call("PUT", `/api/boards/${id}/scene?rev=${rev}`, scene);
        try { const j = JSON.parse(r); if (j.ok) { rev = j.rev; stats.scenes++; } } catch { /* not ok */ }
      }
      await sleep(every);
    }
  })();
  return { stats, stop: () => { stopped = true; try { c.close(); } catch { /* gone */ } } };
}
