// The test host (dev/host.mjs) checked once for what it must not do (goal 7.2): listen on an address other than the
// loopback one, hand a secret to the page, answer a server outside its list, or pass on a path outside the client API.
// It runs against the stand-in server of desktop/test/conn, which speaks the client API over HTTP/2 with a fixture
// certificate; no Go build and no browser. Run with: node --test web/dev/host.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { after, before, describe, test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { startHost } from "./host.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { standin } = require("../../desktop/test/conn/standin");

const SECRET = "s3cret-for-the-host-test-0123456789";
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const tmp = (prefix) => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
// (generous: the waits of the module are lowered, the bounds of the test are not)
const FAST = { dial: 2000, handshake: 2000, headers: 2000, hello: 3000, firstEvent: 3000, testStep: 2000, silence: 8000, backoff: [20, 40, 80], jitter: 0, stable: 150,
  call: 3000, start: 3000, scene: 3000, imageCall: 3000, launch: 3000, relaunch: 3000, secret: 3000, status: 3000 };

async function until(pred, what, ms = 15000) {
  for (const end = Date.now() + ms; ; await sleep(10)) { const v = await pred(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); }
}

/** The host's stream, held open: the module connects while a stream is subscribed, as it does while the app's window is open. */
function hold(url) {
  const ctl = new AbortController(), dec = new TextDecoder();
  let text = "", failed = null;
  const ready = fetch(url + "host/events", { signal: ctl.signal }).then(async (res) => {
    for (const reader = res.body.getReader(); ;) { const { value, done } = await reader.read(); if (done) break; text += dec.decode(value, { stream: true }); }
  }).catch((e) => { if (!ctl.signal.aborted) failed = e; });
  return {
    text: () => text,
    until: (pred, what) => until(() => { if (failed) throw failed; return pred(text); }, what),
    close: () => { ctl.abort(); return ready; },
  };
}

/** What the stand-in was asked besides the connection's own hello and stream (which come again whenever the entry is edited). */
const callsSeen = (s) => s.requests.filter((r) => !/^\/api\/(hello|events)/.test(r.path)).length;

/** A GET with the Host or Origin of the caller's choosing (fetch takes neither). */
function rawGet(url, headers) {
  return new Promise((ok, no) => {
    const u = new URL(url);
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: "POST", headers, setHost: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => ok({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", no);
    r.end();
  });
}

// A one-pixel PNG, and an SVG: what the picture check lets through and what it never does.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

describe("the test host", () => {
  let dist, stateDir, server, host, base, seen = [], logs = [], entry, stream;

  /** Everything the host said, kept for the scan for secrets: bodies, headers, the stream. */
  async function ask(p, init = {}) {
    const r = await fetch(base + p, init);
    const buf = Buffer.from(await r.arrayBuffer());
    seen.push(buf.toString("latin1"), JSON.stringify([...r.headers]));
    return { status: r.status, headers: r.headers, buf, text: buf.toString("utf8"), json: () => JSON.parse(buf.toString("utf8")) };
  }
  const call = (serverId, method, p, body, type = "application/json") =>
    ask(`host/call?server=${encodeURIComponent(serverId)}&method=${method}&path=${encodeURIComponent(p)}`,
      { method: "POST", ...(body === undefined ? {} : { headers: { "content-type": type }, body }) });
  const app = (op, args) => ask(`host/app/${op}`, { method: "POST", ...(args === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(args) }) });

  before(async () => {
    dist = tmp("aiwb-host-dist-");
    fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>page</title>");
    fs.writeFileSync(path.join(dist, "main.js"), "// the page");
    stateDir = tmp("aiwb-host-state-");
    server = await standin({ secret: SECRET });
    server.routes.set("POST /api/groups", () => ({ status: 200, json: { id: "g_1" } }));
    server.routes.set("GET /api/chats/c1/images/*", (req) => ({ status: 200, type: "image/png", bytes: req.url.endsWith("e".repeat(64)) ? PNG : SVG }));
    server.routes.set("POST /api/chats/c1/images", (req, res, body) => ({ status: 200, json: { id: "e".repeat(64), size: body.length } }));
    host = await startHost({ stateDir, dist, timing: FAST, log: (line) => logs.push(line) });
    base = host.url;
  });
  after(async () => {
    await stream?.close();
    await host?.close();
    await server?.close();
    fs.rmSync(dist, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  test("it listens on 127.0.0.1 alone: its address, and no other address of the machine reaches it", async () => {
    const hostPort = host.port;
    assert.equal(host.url, `http://127.0.0.1:${hostPort}/`);
    // (what is listening, whichever way it is asked: a wildcard bind would answer on every address below)
    const tcp = (hostName) => new Promise((ok) => {
      const c = net.connect({ port: hostPort, host: hostName, timeout: 3000 });
      c.once("connect", () => { c.destroy(); ok(true); });
      c.once("error", () => ok(false));
      c.once("timeout", () => { c.destroy(); ok(false); });
    });
    assert.equal(await tcp("127.0.0.1"), true);
    const others = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address);
    for (const a of others) assert.equal(await tcp(a), false, `the host answers on ${a}`);
    assert.equal(await tcp("::1"), false, "the host answers on ::1");
    const fromProc = await new Promise((ok) => { // (the same, read from the process that holds the port)
      const p = spawn("lsof", ["-nP", "-iTCP:" + hostPort, "-sTCP:LISTEN", "-a", "-p", String(process.pid)], { stdio: ["ignore", "pipe", "ignore"] });
      let out = ""; p.stdout.on("data", (d) => (out += d)); p.on("error", () => ok(null)); p.on("close", () => ok(out));
    });
    if (fromProc) assert.match(fromProc, new RegExp(`127\\.0\\.0\\.1:${hostPort} \\(LISTEN\\)`)), assert.doesNotMatch(fromProc, /\*:\d+|0\.0\.0\.0:\d+/);
  });

  test("it serves the page's files and answers its own page alone", async () => {
    assert.equal((await ask("")).text, "<!doctype html><title>page</title>");
    assert.equal((await ask("main.js")).status, 200);
    assert.equal((await ask("nothing.js")).status, 404);
    assert.equal((await ask("../../etc/passwd")).status, 404);
    assert.equal((await ask("host/other")).status, 404);
    // a name that is not the loopback's, or a page of another origin: no secret may be used by any other site in the browser
    const at = new URL(base).host;
    assert.equal((await rawGet(base + "host/app/servers.list", { host: "evil.example:80" })).status, 403);
    const foreign = await rawGet(base + "host/app/servers.list", { host: at, origin: "http://evil.example" });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.headers["access-control-allow-origin"], undefined);
    assert.equal((await rawGet(base + "host/app/servers.list", { host: at, origin: new URL(base).origin })).status, 200);
  });

  test("a server added to the list connects, and nothing the host says holds its secret", async () => {
    const added = await app("servers.add", { force: true, form: { name: "Away", address: server.address, secret: SECRET, selfSigned: true, pin: server.fingerprint } });
    assert.equal(added.status, 200, added.text);
    entry = added.json().server;
    assert.match(entry.id, /^s_[0-9a-f]{12}$/);
    assert.equal(fs.readFileSync(path.join(stateDir, "servers.json"), "utf8").includes(SECRET), true, "the secret is in the app's file, which is what the scan is for");

    // the stream: one for all servers, each event with its entry's id; held to the end of the suite
    stream = hold(base);
    await stream.until((t) => t.includes('"state":"connected"') && t.includes(`"server":"${entry.id}"`) && t.includes('"type":"snapshot"'), "the entry's snapshot on the stream");
    const text = stream.text();
    seen.push(text);
    assert.ok(text.includes(`"server":"${entry.id}"`));
  });

  test("calls, tests, a picture and every list operation, and no body or header holds the secret", async () => {
    const made = await call(entry.id, "POST", "/api/groups", JSON.stringify({ name: "g" }));
    assert.equal(made.status, 200);
    assert.deepEqual(made.json(), { id: "g_1" });
    const up = await call(entry.id, "POST", "/api/chats/c1/images", PNG, "image/png");
    assert.equal(up.status, 200);
    assert.equal(up.json().size, PNG.length);
    const pic = await ask(`host/picture/${entry.id}/c1/${"e".repeat(64)}`);
    assert.equal(pic.status, 200);
    assert.equal(pic.headers.get("content-type"), "image/png");
    assert.deepEqual(pic.buf, PNG);
    const bad = await ask(`host/picture/${entry.id}/c1/${"f".repeat(64)}`); // (the stand-in answers SVG there)
    assert.equal(bad.status, 502);
    assert.ok(!bad.text.includes("<script"), "the bytes of an SVG never reach the page");

    assert.equal((await app("servers.list")).status, 200);
    assert.equal((await app("servers.test", { form: { name: "Away", address: server.address, secret: SECRET, selfSigned: true, pin: server.fingerprint } })).status, 200);
    assert.equal((await app("servers.testSaved", { id: entry.id })).status, 200);
    assert.equal((await app("servers.edit", { id: entry.id, patch: { name: "Away 2" }, force: true })).status, 200);
    const wrong = await app("servers.test", { form: { name: "Wrong", address: server.address, secret: SECRET + "-wrong", selfSigned: true, pin: server.fingerprint } });
    assert.equal(wrong.status, 200);
    assert.ok(!wrong.text.includes(SECRET));
    assert.equal((await app("servers.accept", { id: entry.id, fingerprint: server.fingerprint })).status < 500, true);
    assert.equal((await app("owner.status")).status, 404, "no local entry: no owner's things");
    assert.equal((await app("no.such.op")).status, 404);
    // the stand-in saw the secret (it is what the host holds); the page-side never did
    assert.ok(server.requests.some((r) => r.headers["x-aiwb-secret"] === SECRET));
    const all = seen.join("\n") + logs.join("\n");
    assert.ok(!all.includes(SECRET), "a secret appeared in what the host said");
    assert.ok(!all.includes(SECRET.slice(0, 16)), "part of a secret appeared in what the host said");
    for (const r of seen) assert.ok(!/x-aiwb-secret/i.test(r), "the secret's header was passed to the page");
  });

  test("a call or a picture for an id that is no entry is 404 no_server, and nothing is sent anywhere", async () => {
    const before = callsSeen(server);
    for (const id of ["s_000000000000", "local", "../x", entry.id + "x", "0"]) {
      const c = await call(id, "GET", "/api/state");
      assert.equal(c.status, 404, `call for ${id}`);
      assert.equal(c.json().code, "no_server");
      const p = await ask(`host/picture/${encodeURIComponent(id)}/c1/${"e".repeat(64)}`);
      assert.equal(p.status, 404, `picture for ${id}`);
    }
    assert.equal(callsSeen(server), before);
  });

  test("a path outside the client API is 400 not_client_api, and is not sent", async () => {
    const before = callsSeen(server);
    const paths = [["GET", "/"], ["GET", "/index.html"], ["GET", "/api/servers"], ["GET", `/api/on/${entry.id}/api/state`], ["POST", "/api/restart"], ["GET", "/api/mcp/status"],
      ["GET", "/api/remote/status"], ["PUT", "/api/groups/order"], ["POST", "/api/boards/b_12345678/reveal"], ["GET", "/api/chats/../state"], ["GET", "/api/state#x"],
      ["GET", "/api/events"], ["GET", "http://evil.example/api/state"], ["GET", "api/state"], ["DELETE", "/api/state"]];
    for (const [m, p] of paths) {
      const c = await call(entry.id, m, p);
      assert.equal(c.status, 400, `${m} ${p}`);
      assert.equal(c.json().code, "not_client_api", `${m} ${p}`);
    }
    assert.equal((await ask(`host/call?server=${entry.id}&method=TRACE&path=%2Fapi%2Fstate`, { method: "POST" })).status, 400);
    assert.equal((await ask(`host/call?server=${entry.id}`, { method: "POST" })).status, 400);
    assert.equal(callsSeen(server), before);
  });

  test("started as a program it prints its address first, binds the loopback, and ends on SIGTERM", async () => {
    const state = tmp("aiwb-host-cli-state-");
    const p = spawn(process.execPath, [path.join(HERE, "host.mjs"), "--state-dir", state, "--dist", dist], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    const exited = new Promise((ok) => p.once("exit", (code, signal) => ok({ code, signal })));
    try {
      await until(() => out.includes("\n"), "the host's first line", 20000);
      const m = /^Host: (http:\/\/127\.0\.0\.1:(\d+)\/)\n/.exec(out);
      assert.ok(m, out);
      assert.equal((await fetch(m[1])).status, 200);
      p.kill("SIGTERM");
      assert.equal((await exited).code, 0);
    } finally { p.kill("SIGKILL"); fs.rmSync(state, { recursive: true, force: true }); }
    // (and a state folder is required, an unknown option is a usage error)
    const bad = spawn(process.execPath, [path.join(HERE, "host.mjs"), "--dist", dist], { stdio: "ignore" });
    assert.equal((await new Promise((ok) => bad.once("exit", ok))), 2);
  });

  test("with --local-bin, this computer's server is found by the program's launch and secret, and connects", async () => {
    const local = await standin({ secret: "local-secret-0123456789" });
    const state = tmp("aiwb-host-local-state-"), home = tmp("aiwb-host-local-home-");
    const bin = path.join(state, "..", `aiwb-fake-${path.basename(state)}.js`);
    // (what the server program prints for the app: `launch -json` one line, `secret` the secret)
    fs.writeFileSync(bin, `#!${process.execPath}
const a = process.argv.slice(2);
if (a.includes("launch")) console.log(JSON.stringify({ state: "running", address: ${JSON.stringify(local.address)}, fingerprint: ${JSON.stringify(local.fingerprint)}, version: "1.2.3", featureLevel: 6, instanceId: ${JSON.stringify(local.instanceId)}, pid: 1, home: ${JSON.stringify(home)} }));
else if (a.includes("secret")) console.log("local-secret-0123456789");
else process.exit(2);
`, { mode: 0o755 });
    let streamLocal;
    const h = await startHost({ stateDir: state, localBin: bin, localHome: home, dist, timing: FAST, log: () => {} });
    try {
      const st0 = hold(h.url);
      streamLocal = st0;
      await st0.until((t) => t.includes('"id":"local"') && t.includes('"state":"connected"') && t.includes('"type":"snapshot"'), "this computer's snapshot");
      const text = st0.text();
      assert.ok(!text.includes("local-secret-0123456789"));
      const st = await (await fetch(`${h.url}host/call?server=local&method=GET&path=${encodeURIComponent("/api/state")}`, { method: "POST" })).json();
      assert.deepEqual(st.agents, ["claude"]);
      const own = await (await fetch(`${h.url}host/app/owner.openLog`, { method: "POST" })).json();
      assert.equal(own.code, "not_here", "the host has no shell to open the log with");
    } finally { await streamLocal?.close(); await h.close(); await local.close(); fs.rmSync(state, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(bin, { force: true }); }
  });
});
