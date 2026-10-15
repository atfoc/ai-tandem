// Tests of the HTTP face (dev/hostface.mjs) against a fake client, and of the mock's fake client (dev/mock.mjs) with and
// without the face. Run: node --test web/dev/hostface.test.mjs
// Nothing here waits out a production wait: the stream's ping is lowered, and what must happen is waited for with a
// generous bound (a machine four times slower passes).
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createHostFace } from "./hostface.mjs";
import { CLIENT_ROUTES, createMockClient, startMock } from "./mock.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
/** Waits for fn() to answer something true; ends the test with the last answer when `ms` passes. */
async function until(fn, ms = 15000) {
  for (const end = Date.now() + ms; ; await sleep(10)) { const v = await fn(); if (v || Date.now() > end) return v; }
}
const listen = (handler) => new Promise((ok) => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => ok(s)); });
const urlOf = (s) => `http://127.0.0.1:${s.address().port}`;
const closeAll = (s) => new Promise((ok) => { s.closeAllConnections?.(); s.close(() => ok()); });

/** One request with headers of its own (Host and Origin included); answers { status, headers, body (Buffer) }. */
function raw(base, method, p, { headers = {}, body } = {}) {
  const u = new URL(base);
  return new Promise((ok, no) => {
    const req = http.request({ host: u.hostname, port: u.port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", no);
    req.end(body);
  });
}
const json = (r) => JSON.parse(r.body.toString("utf8"));

/** The stream of a face, read: the envelopes, the pings and the open mark, with a way to close it. */
function readStream(base) {
  const out = { events: [], pings: 0, opened: false, ended: false, status: 0, type: "", req: null, close() { out.req.destroy(); } };
  out.req = http.get(`${base}/host/events`, (res) => {
    out.status = res.statusCode; out.type = res.headers["content-type"];
    let buf = "";
    res.setEncoding("utf8");
    res.on("data", (d) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n\n")) >= 0; buf = buf.slice(i + 2)) {
        const block = buf.slice(0, i);
        if (block.startsWith("data: ")) out.events.push(JSON.parse(block.slice(6)));
        else if (block === ": ping") out.pings++;
        else if (block === ": open") out.opened = true;
      }
    });
    res.on("end", () => { out.ended = true; });
    res.on("close", () => { out.ended = true; });
  });
  out.req.on("error", () => { out.ended = true; });
  return out;
}

describe("the face against a fake client", () => {
  let dist, server, base, face, calls, subs, closed, picture, answer, app;
  const fake = {
    subscribe(cb) { const s = { cb, closed: false }; subs.push(s); return { close() { s.closed = true; closed.push(s); } }; },
    async call(req) { calls.push(req); return answer(req); },
    async picture(req) { calls.push({ picture: req }); return picture(req); },
    async app(op, args) { calls.push({ app: op, args }); return app(op, args); },
  };
  before(async () => {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-face-"));
    fs.writeFileSync(path.join(dist, "index.html"), "<html>page</html>");
    fs.mkdirSync(path.join(dist, "fonts"));
    fs.writeFileSync(path.join(dist, "fonts", "a.woff2"), "font");
    fs.writeFileSync(path.join(dist, "main.js"), "export {}");
    fs.writeFileSync(path.join(path.dirname(dist), "outside-" + path.basename(dist)), "secret file");
    face = createHostFace({ client: fake, distDir: dist, pingMs: 40, log: () => {} });
    server = await listen(face.handle);
    base = urlOf(server);
  });
  after(async () => { face.close(); await closeAll(server); fs.rmSync(dist, { recursive: true, force: true }); fs.rmSync(path.join(path.dirname(dist), "outside-" + path.basename(dist)), { force: true }); });
  const reset = () => {
    calls = []; subs = []; closed = [];
    answer = () => ({ status: 200, text: '{"ok":true}', sceneRev: null });
    picture = () => ({ ok: false, status: 404, text: '{"error":"no such image"}' });
    app = () => ({ status: 200, body: { ok: true } });
  };

  test("a JSON call reaches the client with its server, method, path with query and body; its answer is the status and the text", async () => {
    reset();
    answer = () => ({ status: 409, text: '{"error":"stale","code":"stale"}', sceneRev: null });
    const r = await raw(base, "POST", `/host/call?server=s_abc&method=PUT&path=${encodeURIComponent("/api/chats/c1/draft?rev=3&branch=main")}`, { headers: { "content-type": "application/json" }, body: '{"text":"hi"}' });
    assert.equal(r.status, 409);
    assert.match(r.headers["content-type"], /^application\/json; charset=utf-8$/);
    assert.deepEqual(json(r), { error: "stale", code: "stale" });
    assert.equal(r.headers["x-aiwb-scene-rev"], undefined);
    assert.equal(calls.length, 1);
    const { signal, ...req } = calls[0];
    assert.deepEqual(req, { server: "s_abc", method: "PUT", path: "/api/chats/c1/draft?rev=3&branch=main", body: { json: '{"text":"hi"}' } });
    assert.ok(signal instanceof AbortSignal);
  });

  test("a call with no body sends none, and a scene revision is told in X-AIWB-Scene-Rev", async () => {
    reset();
    answer = () => ({ status: 200, text: '{"elements":[]}', sceneRev: 7 });
    const r = await raw(base, "POST", `/host/call?server=local&method=GET&path=${encodeURIComponent("/api/boards/b_x/scene")}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers["x-aiwb-scene-rev"], "7");
    assert.equal("body" in calls[0], false);
  });

  test("a body that is not JSON goes as bytes with their type", async () => {
    reset();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 128]);
    const r = await raw(base, "POST", `/host/call?server=local&method=POST&path=${encodeURIComponent("/api/chats/c1/images?name=a.png")}`, { headers: { "content-type": "image/png" }, body: bytes });
    assert.equal(r.status, 200);
    assert.equal(calls[0].body.type, "image/png");
    assert.ok(calls[0].body.bytes instanceof Uint8Array);
    assert.deepEqual(Buffer.from(calls[0].body.bytes), bytes);
  });

  test("a call that is missing its server, method or path, or has another method, is 400 and reaches no client", async () => {
    reset();
    for (const q of ["method=GET&path=%2Fapi%2Fstate", "server=local&path=%2Fapi%2Fstate", "server=local&method=GET", "server=local&method=TRACE&path=%2Fapi%2Fstate"]) {
      const r = await raw(base, "POST", `/host/call?${q}`);
      assert.equal(r.status, 400, q);
      assert.equal(json(r).code, "bad_request");
    }
    assert.equal((await raw(base, "GET", "/host/call?server=local&method=GET&path=%2Fapi%2Fstate")).status, 405);
    assert.equal(calls.length, 0);
  });

  test("a body over the face's limit is 413 and is not sent", async () => {
    reset();
    const small = createHostFace({ client: fake, distDir: dist, bodyMax: 1024 });
    const s2 = await listen(small.handle);
    const path = `/host/call?server=local&method=PUT&path=${encodeURIComponent("/api/boards/b_x/scene")}`;
    // (the face answers before it has read it all, and may end the connection: the answer or a reset are both a refusal)
    const r = await raw(urlOf(s2), "POST", path, { headers: { "content-type": "application/json" }, body: Buffer.alloc(100 * 1024, 97) }).catch((e) => ({ status: 0, err: e }));
    if (r.status) { assert.equal(r.status, 413); assert.equal(json(r).code, "too_large"); }
    assert.equal(calls.length, 0);
    const fits = await raw(urlOf(s2), "POST", path, { headers: { "content-type": "application/json" }, body: '{"a":1}' });
    assert.equal(fits.status, 200);
    await closeAll(s2);
  });

  test("the client's call is aborted when the request goes away before the answer", async () => {
    reset();
    let signal, release;
    answer = (req) => { signal = req.signal; return new Promise((ok) => { release = ok; }); };
    const req = http.request({ host: "127.0.0.1", port: new URL(base).port, method: "POST", path: `/host/call?server=local&method=GET&path=${encodeURIComponent("/api/chats/c1/items")}` });
    req.on("error", () => {});
    req.end();
    assert.ok(await until(() => signal), "the call did not reach the client");
    assert.equal(signal.aborted, false);
    req.destroy();
    assert.ok(await until(() => signal.aborted), "the call was not aborted");
    release({ status: 200, text: "{}", sceneRev: null });
  });

  test("a call the client fails is 500 host_error with no detail of the failure", async () => {
    reset();
    answer = () => { throw new Error("boom with s3cr3t"); };
    const r = await raw(base, "POST", `/host/call?server=local&method=GET&path=${encodeURIComponent("/api/state")}`);
    assert.equal(r.status, 500);
    assert.equal(json(r).code, "host_error");
    assert.ok(!r.body.toString().includes("s3cr3t"));
  });

  test("the stream: an open mark, each envelope as a data line in order, and pings", async () => {
    reset();
    const s = readStream(base);
    assert.ok(await until(() => subs.length === 1 && s.opened), "the stream did not open");
    assert.equal(s.status, 200);
    assert.match(s.type, /^text\/event-stream/);
    const envs = [{ app: { type: "servers", servers: [], notice: "" } }, { server: "local", event: { type: "hello" } }, { server: "s_1", event: { type: "chat", chat: { id: "c1", name: "é\nnewline" } } }];
    for (const e of envs) subs[0].cb(e);
    assert.ok(await until(() => s.events.length === 3));
    assert.deepEqual(s.events, envs);
    assert.ok(await until(() => s.pings >= 2), "no pings");
    s.close();
    assert.ok(await until(() => closed.length === 1), "the subscription did not end with the request");
  });

  test("a second stream ends the first one and its subscription", async () => {
    reset();
    const a = readStream(base);
    assert.ok(await until(() => subs.length === 1 && a.opened));
    const b = readStream(base);
    assert.ok(await until(() => subs.length === 2 && b.opened));
    assert.ok(await until(() => a.ended), "the first stream was not ended");
    assert.equal(subs[0].closed, true);
    assert.equal(subs[1].closed, false);
    subs[1].cb({ app: { type: "servers", servers: [], notice: "" } });
    assert.ok(await until(() => b.events.length === 1));
    assert.equal(a.events.length, 0);
    b.close();
    assert.ok(await until(() => subs[1].closed));
  });

  test("close() of the face ends the stream and its subscription", async () => {
    reset();
    const f2 = createHostFace({ client: fake, distDir: dist, pingMs: 40 });
    const s2 = await listen(f2.handle);
    const s = readStream(urlOf(s2));
    assert.ok(await until(() => subs.length === 1 && s.opened));
    f2.close();
    assert.ok(await until(() => s.ended && closed.length === 1));
    await closeAll(s2);
  });

  test("drop() cuts the stream as a network does", async () => {
    reset();
    const f2 = createHostFace({ client: fake, distDir: dist, pingMs: 40 });
    const s2 = await listen(f2.handle);
    const s = readStream(urlOf(s2));
    assert.ok(await until(() => subs.length === 1 && s.opened));
    f2.drop();
    assert.ok(await until(() => s.ended && closed.length === 1));
    await closeAll(s2);
  });

  test("a picture: the bytes with the headers the app's scheme gives, the ids decoded", async () => {
    reset();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    picture = () => ({ ok: true, type: "image/png", data: png });
    const id = "a".repeat(64);
    const r = await raw(base, "GET", `/host/picture/s_abc/c%5F1/${id}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-type"], "image/png");
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.equal(r.headers["cache-control"], "private, max-age=31536000, immutable");
    assert.equal(r.headers["content-security-policy"], "default-src 'none'; sandbox");
    assert.deepEqual(new Uint8Array(r.body), png);
    assert.deepEqual({ ...calls[0].picture, signal: undefined }, { server: "s_abc", chat: "c_1", image: id, signal: undefined });
  });

  test("a picture the client refuses is its status with its text as JSON; a wrong shape is 404; POST is 405", async () => {
    reset();
    picture = () => ({ ok: false, status: 502, text: '{"error":"x gave an answer that cannot be read.","code":"bad_answer"}' });
    let r = await raw(base, "GET", `/host/picture/local/c1/${"b".repeat(64)}`);
    assert.equal(r.status, 502);
    assert.match(r.headers["content-type"], /json/);
    assert.equal(json(r).code, "bad_answer");
    for (const p of ["/host/picture/local/c1", "/host/picture/local/c1/x/y", "/host/picture/local//x", "/host/picture/", "/host/picture/%E0%A4%A/x/y"]) {
      r = await raw(base, "GET", p);
      assert.equal(r.status, 404, p);
    }
    assert.equal((await raw(base, "POST", `/host/picture/local/c1/${"b".repeat(64)}`)).status, 405);
    assert.equal(calls.length, 1);
  });

  test("an app operation: the arguments are the JSON body, or none; the answer is the status and the body", async () => {
    reset();
    app = (op) => (op === "servers.list" ? { status: 200, body: { servers: [], notice: "" } } : { status: 409, body: { error: "no", code: "local_entry" } });
    let r = await raw(base, "POST", "/host/app/servers.list");
    assert.equal(r.status, 200);
    assert.deepEqual(json(r), { servers: [], notice: "" });
    assert.deepEqual(calls[0], { app: "servers.list", args: undefined });
    r = await raw(base, "POST", "/host/app/servers.edit", { headers: { "content-type": "application/json" }, body: '{"id":"local","patch":{"name":"x"}}' });
    assert.equal(r.status, 409);
    assert.equal(json(r).code, "local_entry");
    assert.deepEqual(calls[1], { app: "servers.edit", args: { id: "local", patch: { name: "x" } } });
    r = await raw(base, "POST", "/host/app/owner.reveal", { headers: { "content-type": "application/json" }, body: "{not json" });
    assert.equal(r.status, 400);
    r = await raw(base, "POST", "/host/app/owner.reveal", { headers: { "content-type": "text/plain" }, body: "x" });
    assert.equal(r.status, 400);
    assert.equal((await raw(base, "GET", "/host/app/servers.list")).status, 405);
    assert.equal(calls.length, 2);
  });

  test("the files of the page: / is index.html, a nested file, its type; nothing outside; no other /host path", async () => {
    reset();
    let r = await raw(base, "GET", "/");
    assert.equal(r.status, 200);
    assert.match(r.headers["content-type"], /^text\/html/);
    assert.equal(r.body.toString(), "<html>page</html>");
    r = await raw(base, "GET", "/main.js");
    assert.match(r.headers["content-type"], /^text\/javascript/);
    r = await raw(base, "GET", "/fonts/a.woff2");
    assert.equal(r.headers["content-type"], "font/woff2");
    assert.equal((await raw(base, "HEAD", "/main.js")).status, 200);
    const outside = "outside-" + path.basename(dist);
    for (const p of ["/nope.js", "/fonts", `/../${outside}`, `/%2e%2e/${outside}`, `/fonts/../../${outside}`, "/api/hello", "/api/state", "/host/nope", "/host", "/%E0%A4%A"]) {
      r = await raw(base, "GET", p);
      assert.equal(r.status, 404, p);
      assert.ok(!r.body.toString().includes("secret file"), p);
    }
    assert.equal((await raw(base, "POST", "/main.js")).status, 404);
    assert.equal(calls.length, 0);
  });

  test("it answers its own page alone: a Host that is not a loopback name, or an Origin that is not its own, is 403", async () => {
    reset();
    const port = new URL(base).port;
    const ok = await raw(base, "GET", "/", { headers: { host: `localhost:${port}`, origin: `http://localhost:${port}` } });
    assert.equal(ok.status, 200);
    for (const headers of [{ host: "evil.example" }, { host: `evil.example:${port}` }, { host: `127.0.0.1:${port}`, origin: "http://evil.example" }, { host: `127.0.0.1:${port}`, origin: "null" }]) {
      for (const [m, p] of [["GET", "/"], ["POST", `/host/call?server=local&method=GET&path=%2Fapi%2Fstate`], ["GET", "/host/events"], ["POST", "/host/app/servers.list"]]) {
        const r = await raw(base, m, p, { headers });
        assert.equal(r.status, 403, `${m} ${p} ${JSON.stringify(headers)}`);
        assert.equal(json(r).code, "bad_host");
      }
    }
    assert.equal(calls.length, 0);
    assert.equal(subs.length, 0);
  });

  test("the face never listens: it is a handler", () => {
    assert.deepEqual(Object.keys(face).sort(), ["close", "drop", "handle"]);
  });
});

describe("the mock's fake client", () => {
  const client = createMockClient();
  const seen = [];
  let sub;
  before(() => { sub = client.subscribe((e) => seen.push(e)); });
  after(async () => { sub.close(); await client.close(); });
  const words = (list) => list.map((e) => (e.app ? `app:${e.app.type}${e.app.server ? ":" + e.app.server.id + "=" + e.app.server.state : ""}` : `${e.server}:${e.event.type}`));
  const call = (server, method, p, body, signal) => client.call({ server, method, path: p, ...(body === undefined ? {} : { body: { json: JSON.stringify(body) } }), signal });
  const parse = (a) => JSON.parse(a.text);
  const mock = async (code) => { const r = await fetch(mockUrl + "/mock/eval", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) }); const j = await r.json(); if (!j.ok) throw new Error(j.error); return j.r; };
  let mockServer, mockUrl, dist;
  before(async () => {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-mockdist-"));
    fs.writeFileSync(path.join(dist, "index.html"), "<html>mock</html>");
    mockServer = await startMock({ port: 0, dist });
    mockUrl = urlOf(mockServer);
  });
  after(async () => { await closeAll(mockServer); fs.rmSync(dist, { recursive: true, force: true }); });

  test("subscribe: the list, each entry's state with the connected one still connecting, then its stream: hello, the snapshot, connected", () => {
    assert.deepEqual(words(seen), ["app:servers", "app:server_state:local=connecting", "local:hello", "local:snapshot", "app:server_state:local=connected"]);
    const servers = seen[0].app.servers;
    assert.deepEqual(servers.map((s) => [s.id, s.local, s.name, s.state]), [["local", true, "This computer", "connecting"]]);
    const snap = seen[3].event;
    for (const k of ["agents", "catalogs", "home", "defaultCwd", "groups", "boards", "chats", "defaults", "states", "library"]) assert.ok(k in snap, k);
    assert.equal("sections" in snap || "servers" in snap || "libraries" in snap || "dataDir" in snap, false);
    assert.ok(snap.groups.every((g) => !("collapsed" in g)));
  });

  test("a call is answered by that machine, and its events come as that server's, in order", async () => {
    seen.length = 0;
    const g = await call("local", "POST", "/api/groups", { name: "Made" });
    assert.equal(g.status, 200);
    const made = parse(g);
    assert.equal(made.name, "Made");
    assert.deepEqual(words(seen), ["local:groups"]);
    assert.ok(seen[0].event.groups.some((x) => x.id === made.id));
    const c = await call("local", "POST", "/api/chats", { group: made.id });
    assert.equal(c.status, 200);
    assert.deepEqual(words(seen), ["local:groups", "local:chat"]);
    assert.equal((await call("local", "GET", `/api/chats/${parse(c).id}`)).status, 200);
  });

  test("what the fake client checks before a machine does: no_server, not_client_api, the body limits", async () => {
    let a = await call("s_nope", "GET", "/api/state");
    assert.equal(a.status, 404);
    assert.equal(parse(a).code, "no_server");
    for (const [m, p] of [["GET", "/api/events"], ["GET", "/api/servers"], ["GET", "/api/on/s_x/chats"], ["POST", "/api/restart"], ["GET", "/api/chats/c1/../items"], ["GET", "/api/chats/%2e%2e/items"], ["GET", "/api/chats#x"], ["GET", "api/state"], ["PUT", "/api/groups/g1"], ["GET", "/"]]) {
      a = await call("local", m, p);
      assert.equal(a.status, 400, `${m} ${p}`);
      assert.equal(parse(a).code, "not_client_api", `${m} ${p}`);
    }
    a = await call("local", "POST", "/api/chats/c_plain/messages", { text: "x".repeat(2 * 1024 * 1024 + 1) });
    assert.equal(a.status, 413);
    assert.equal(parse(a).code, "too_large");
    a = await client.call({ server: "local", method: "POST", path: "/api/chats/c_plain/images?name=a.png", body: { bytes: new Uint8Array(5 * 1024 * 1024 + 1), type: "image/png" } });
    assert.equal(a.status, 413);
    assert.equal(parse(a).code, "image_too_large");
    const ctl = new AbortController(); ctl.abort();
    await assert.rejects(call("local", "GET", "/api/state", undefined, ctl.signal), { name: "AbortError" });
  });

  test("a server added to the list, connected, dropped, connected again and removed: the envelopes in the module's order", async () => {
    await mock(`addServer({ id: "s_t1", name: "Test box", address: "https://t1.example:4790", state: "unreachable", detail: "connection refused" }, { lists: { agents: ["claude"], catalogs: { claude }, home: "/home/t", defaultCwd: "/home/t/w" } }); resync();`);
    // (the page of the mock's server is another subscription: this one is the fake client's own, so it is told through resync alike)
    const listed = seen.filter((e) => e.app?.type === "servers").at(-1);
    assert.deepEqual(listed.app.servers.map((s) => [s.id, s.state]), [["local", "connected"], ["s_t1", "unreachable"]]);
    assert.equal((await call("s_t1", "GET", "/api/chats/c_x")).status, 503);
    seen.length = 0;
    await mock(`setServerState("s_t1", "connected", { version: "dev" });`);
    assert.deepEqual(words(seen), ["s_t1:hello", "s_t1:snapshot", "app:server_state:s_t1=connected"]);
    assert.equal(seen[1].event.home, "/home/t");
    assert.equal(seen[1].event.library, null);
    seen.length = 0;
    const made = parse(await call("s_t1", "POST", "/api/groups", { name: "There" }));
    assert.deepEqual(words(seen), ["s_t1:groups"]);
    assert.deepEqual(seen[0].event.groups.map((g) => g.id), [made.id]);
    seen.length = 0;
    await mock(`setServerState("s_t1", "unreachable", { detail: "gone" });`);
    assert.deepEqual(words(seen), ["app:server_state:s_t1=unreachable"]);
    seen.length = 0;
    await mock(`await elsewhere("s_t1", "POST", "/groups", { name: "While away" });`);
    assert.deepEqual(seen, [], "what changes on a server that is not connected is told to nobody");
    const away = await call("s_t1", "POST", "/api/groups", { name: "x" });
    assert.equal(away.status, 503);
    assert.deepEqual(parse(away), { error: "Test box is not connected.", code: "server_unreachable" });
    // ...but two calls are answered as the module answers them
    assert.deepEqual(parse(await call("s_t1", "POST", "/api/chats/c_x/unfollow")), { ok: true });
    assert.deepEqual(parse(await call("s_t1", "POST", "/api/boards/b_x/release")), { state: "none" });
    await mock(`setServerState("s_t1", "too_old", { version: "0.9" });`);
    assert.equal(parse(await call("s_t1", "GET", "/api/state")).error, "Test box is too old: update the server on that machine.");
    seen.length = 0;
    assert.equal(await mock(`return viewOf(entryById("s_t1")).version;`), "0.9", "a server that is too old shows the version it reports");
    await mock(`setServerState("s_t1", "connected");`);
    assert.equal(await mock(`return viewOf(entryById("s_t1")).version;`), "dev", "back from too old, the entry shows the version it had");
    assert.deepEqual(words(seen), ["s_t1:hello", "s_t1:snapshot", "app:server_state:s_t1=connected"]);
    assert.deepEqual(seen[1].event.groups.map((g) => g.name), ["There", "While away"]);
    seen.length = 0;
    await mock(`removeServer("s_t1");`);
    assert.deepEqual(words(seen), ["app:servers"]);
    assert.deepEqual(seen[0].app.servers.map((s) => s.id), ["local"]);
    assert.equal((await call("s_t1", "GET", "/api/state")).status, 404);
  });

  test("this computer's entry can leave connected and come back, like any other", async () => {
    seen.length = 0;
    await mock(`setServerState("local", "not_started", { detail: "AI Whiteboard is not set up on this machine." });`);
    assert.deepEqual(words(seen), ["app:server_state:local=not_started"]);
    assert.equal(seen[0].app.server.detail, "AI Whiteboard is not set up on this machine.");
    assert.equal((await call("local", "GET", "/api/state")).status, 503);
    seen.length = 0;
    const r = await client.app("owner.retry");
    assert.equal(r.status, 200);
    assert.deepEqual(words(seen), ["app:server_state:local=connecting", "local:hello", "local:snapshot", "app:server_state:local=connected"]);
    assert.equal((await call("local", "GET", "/api/state")).status, 200);
  });

  test("a held board is forgotten when its server's stream ends", async () => {
    await mock(`return seedUI("A1");`);
    const taken = parse(await call("local", "POST", "/api/boards/b_ui/take"));
    assert.equal(taken.state, "held");
    assert.equal(await mock(`return heldBoards.size;`), 1);
    await mock(`setServerState("local", "unreachable"); setServerState("local", "connected");`);
    assert.equal(await mock(`return heldBoards.size;`), 0);
  });

  test("the prompt library: a change is an own_library event of that server before the answer; a library is its server's own", async () => {
    seen.length = 0;
    const a = await call("local", "POST", "/api/library/local/groups", { name: "git", parent: "" });
    assert.equal(a.status, 200);
    assert.deepEqual(words(seen), ["local:own_library"]);
    assert.ok(seen[0].event.groups.some((g) => g.name === "git"));
    assert.equal((await call("local", "POST", "/api/library/s_other/groups", { name: "x" })).status, 404);
    assert.equal(parse(await call("local", "GET", "/api/library")).libraries[0].server, "local");
  });

  test("pictures: an uploaded PNG is shown; bytes that are no image of the taken types are never given, whatever the type claimed", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kg==", "base64");
    const up = await client.call({ server: "local", method: "POST", path: "/api/chats/c_plain/images?name=a.png", body: { bytes: new Uint8Array(png), type: "image/png" } });
    assert.equal(up.status, 200);
    const id = parse(up).id;
    const ok = await client.picture({ server: "local", chat: "c_plain", image: id });
    assert.equal(ok.ok, true);
    assert.equal(ok.type, "image/png");
    assert.deepEqual(Buffer.from(ok.data), png);
    await mock(`const bad = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'); (images.c_plain ??= {})["${"c".repeat(64)}"] = { id: "${"c".repeat(64)}", name: "x", type: "image/png", size: bad.length, bytes: bad };`);
    const bad = await client.picture({ server: "local", chat: "c_plain", image: "c".repeat(64) });
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 502);
    assert.equal(JSON.parse(bad.text).code, "bad_answer");
    assert.equal((await client.picture({ server: "local", chat: "c_plain", image: "d".repeat(64) })).status, 404);
    assert.equal((await client.picture({ server: "local", chat: "c_plain", image: "../x" })).status, 400);
    assert.equal((await client.picture({ server: "local", chat: "bad chat", image: id })).status, 400);
    assert.equal((await client.picture({ server: "s_nope", chat: "c_plain", image: id })).status, 404);
  });

  test("app operations: the list is kept, a secret is never told, owner operations answer", async () => {
    seen.length = 0;
    const secret = "S3CR3T-never-shown";
    const form = { name: "Added", address: "https://added.example:4790", secret, selfSigned: true, pin: "AA:".repeat(31) + "AA" };
    let r = await client.app("servers.add", { form, force: false });
    assert.equal(r.status, 200);
    assert.equal(r.body.saved, true);
    const id = r.body.server.id;
    assert.match(id, /^s_[0-9a-f]{12}$/);
    assert.ok(await until(() => seen.some((e) => e.app?.type === "server_state" && e.app.server.id === id && e.app.server.state === "connected")), "the added server did not connect");
    r = await client.app("servers.add", { form: { ...form, name: "Twice" } });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "duplicate");
    for (const [bad, code] of [[{ name: "" }, "bad_name"], [{ address: "http://x" }, "bad_address"], [{ secret: "" }, "bad_secret"], [{ pin: "xyz" }, "bad_pin"]]) {
      r = await client.app("servers.add", { form: { ...form, address: "https://other.example:1", ...bad } });
      assert.equal(r.status, 400, code);
      assert.equal(r.body.code, code);
    }
    r = await client.app("servers.edit", { id, patch: { name: "Renamed" } });
    assert.equal(r.body.server.name, "Renamed");
    assert.equal((await client.app("servers.edit", { id: "local", patch: { name: "x" } })).body.code, "local_entry");
    assert.equal((await client.app("servers.remove", { id: "local" })).status, 409);
    assert.equal((await client.app("servers.testSaved", { id })).body.ok, true);
    assert.equal((await client.app("servers.test", { form })).body.outcome, "connected");
    r = await client.app("servers.list");
    assert.equal(r.body.servers[0].id, "local");
    assert.equal(r.body.servers.at(-1).id, id);
    assert.equal((await client.app("servers.remove", { id })).status, 200);
    assert.equal((await client.app("servers.remove", { id })).status, 404);
    // the owner's things
    const st = await client.app("owner.status");
    assert.equal(st.body.running.mcp.listener.port, 6006);
    assert.equal((await client.app("owner.openLog")).status, 501);
    assert.equal((await client.app("owner.reveal", { board: "b_aaaaaaaa" })).body.code, "not_here");
    assert.equal((await client.app("owner.nothing")).body.code, "no_op");
    const restart = await client.app("owner.restart");
    assert.equal(restart.status, 200);
    // the secret is in nothing the client said
    const everything = JSON.stringify([seen, r, st]);
    assert.ok(!everything.includes(secret), "the secret came back");
  });

  test("the table of calls is the client API's: it equals packages/conn/core/routes.json when that is there", () => {
    assert.equal(new Set(CLIENT_ROUTES).size, CLIENT_ROUTES.length);
    const file = path.resolve(HERE, "../../packages/conn/core/routes.json");
    if (!fs.existsSync(file)) return;
    assert.deepEqual(CLIENT_ROUTES, JSON.parse(fs.readFileSync(file, "utf8")));
  });

  test("behind the face: the page's files, a call, the stream, a picture and the controls, over HTTP", async () => {
    let r = await fetch(mockUrl + "/");
    assert.equal(await r.text(), "<html>mock</html>");
    r = await fetch(mockUrl + "/api/hello");
    assert.equal(r.status, 404, "the mock serves no /api/ path of its own");
    r = await fetch(mockUrl + "/api/state");
    assert.equal(r.status, 404);
    const st = await (await fetch(mockUrl + "/mock/state")).json();
    assert.equal(st.pid, process.pid);
    // the stream: the page's subscription takes the mock's from the fake client of the test
    const s = readStream(mockUrl);
    assert.ok(await until(() => s.events.some((e) => e.app?.server?.state === "connected")), "the stream did not give this computer connected");
    const order = s.events.map((e) => (e.app ? `${e.app.type}:${e.app.server?.id ?? ""}=${e.app.server?.state ?? ""}` : `${e.server}:${e.event.type}`));
    assert.equal(order[0], "servers:=");
    assert.ok(order.indexOf("local:hello") < order.indexOf("local:snapshot") && order.indexOf("local:snapshot") < order.indexOf("server_state:local=connected"), order.join());
    assert.equal((await (await fetch(mockUrl + "/mock/state")).json()).subscribed, true);
    const made = await fetch(`${mockUrl}/host/call?server=local&method=POST&path=${encodeURIComponent("/api/groups")}`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"name":"Over HTTP"}' });
    assert.equal(made.status, 200);
    assert.ok(await until(() => s.events.some((e) => e.event?.type === "groups")), "the event of the call did not come on the stream");
    // flags.streamDown: a new stream is refused, as a closed stream is for the page's transport
    await mock(`flags.streamDown = true; dropStreams();`);
    assert.ok(await until(() => s.ended), "dropStreams did not cut the stream");
    const down = await fetch(mockUrl + "/host/events");
    assert.equal(down.status, 503);
    await mock(`delete flags.streamDown;`);
    const again = readStream(mockUrl);
    assert.ok(await until(() => again.events.some((e) => e.event?.type === "snapshot")), "the stream did not start over from its beginning");
    again.close();
    // the controls answer their own page alone
    const foreign = await raw(mockUrl, "POST", "/mock/eval", { headers: { host: "evil.example", "content-type": "application/json" }, body: '{"code":"return 1"}' });
    assert.equal(foreign.status, 403);
    const crossSite = await raw(mockUrl, "POST", "/mock/eval", { headers: { origin: "http://evil.example", "content-type": "application/json" }, body: '{"code":"return 1"}' });
    assert.equal(crossSite.status, 403);
  });

  test("a make that waited on flags.make while its server dropped is 504 no_answer", async () => {
    await mock(`addServer({ id: "s_t2", name: "Slow box", address: "https://t2.example:4790", state: "connected", version: "dev" }); resync(); flags.make = { server: "s_t2", hold: true };`);
    let done = false;
    const held = call("s_t2", "POST", "/api/groups", { name: "x" }).then((a) => { done = true; return a; });
    assert.ok(await until(async () => (await mock(`return flags.make.held?.length ?? 0;`)) === 1), "the make did not reach the mock");
    await mock(`setServerState("s_t2", "unreachable"); release("make");`);
    const a = await held;
    assert.equal(done, true);
    assert.equal(a.status, 504);
    assert.equal(parse(a).code, "no_answer");
    await mock(`delete flags.make; removeServer("s_t2");`);
  });
});
