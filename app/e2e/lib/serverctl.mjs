// What a flow does to the scratch server while the app is on the screen (architecture AD-83, flow `net-pinned-stream`): a Maestro
// flow cannot touch a process on this computer, so the runner serves a small control API on 127.0.0.1 (the flow's script calls it
// with `http.post`, Maestro runs on this computer too) and the control API acts on the server:
//
//   POST /stop            the server ends (its port stays free of anything else: the next /start takes it again)
//   POST /start           the server starts again on its own home, with the same certificate, secret and port
//   POST /new-cert        the server is stopped, its key and certificate are made again (`remote setup -new-cert`), it starts again
//   POST /board?name=N    a board is made through the client API (as an app's "new board" does); answers its id. With &scene=chips the board
//                         holds a filled rectangle labelled "API" (id chips-rect, lib/scenes.mjs) and is let go (the app takes it when it opens it)
//   POST /chat            a chat is made (answers its id), named ?name=N when that is given, on the board ?board=ID when that is given, and with
//                         ?text=T a message is sent to it
//   POST /say?chat=ID&text=T   a message is sent to that chat: the stand-in agent answers "FAKE(<model>): T" (the server of the flow runs
//                         it, no paid model), streamed to every client that follows the chat
//   POST /reset           the server is stopped, its first certificate is put back and its boards and chats are removed, it starts again: the
//                         state the run began with (a second attempt of the flow, after /new-cert, starts from it; the runner calls it)
//   GET  /state           { boards: [names], chats: [names] } of the server, read through the client API
//   GET  /sent?chat=ID    the texts of the messages the user sent in that chat, in order (the thread's "user" items)
//   GET  /box             the latest state of the app's chip input (what it reported, see the flow's `report=1` header), null before the first
//   POST /check?name=C[&timeout=ms]   waits (default 20 s) until the check C of the flow's `verify=` module holds for the box's latest state; answers
//                         500 with what it saw when it does not, which fails the flow at that step
//   GET  /chat-images?chat=ID   the images the server holds for the chat's messages, as it received them (package V4): each with its name, the
//                         type and size the server found, the type of its first bytes and, for a PNG or a JPEG, its width and height
//
// The runner adds the routes of the device the flow runs on (`add`, lib/devicectl.mjs: the library, the privacy answers, the app's storage).
//
// Every answer is JSON, `{ ok: true, ... }` or a status 500 with `{ ok: false, error }`. The client API is the one of the apps: HTTP/2 over
// the server's own certificate, the secret and a client id in headers (internal/server/clients.go ClientHandler); this client takes the
// certificate as it is, the server being the run's own.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import http2 from "node:http2";

import { sceneOf } from "./scenes.mjs";

const LEVEL = 7; // internal/server/clients.go MinClientLevel: the feature level this caller says it has

/** A client of the server's client API: `call(method, path, body)` answers { status, json, text, rev }. Its client id is its own (a v4 UUID).
 *  `known(fn)` runs `fn(call)` with the client known to the server: an event stream is open for the time of it, as an app's is (a client
 *  that takes or holds a board must have one: `unknown_client` otherwise); the calls of `fn` share its connection. */
export function apiClient({ host, port, secret }) {
  const client = crypto.randomUUID();
  const connect = () => http2.connect(`https://${host}:${port}`, { rejectUnauthorized: false });
  const headersOf = (method, path, body) => {
    const headers = { ":method": method, ":path": path, "x-aiwb-secret": secret, "x-aiwb-client": client, "x-aiwb-level": String(LEVEL) };
    if (body !== undefined) headers["content-type"] = "application/json";
    return headers;
  };
  const request = (session, method, path, body) => new Promise((resolve, reject) => {
    session.once("error", reject);
    const req = session.request(headersOf(method, path, body));
    let text = "";
    let status = 0;
    let rev = null;
    req.setEncoding("utf8");
    req.on("response", (h) => { status = Number(h[":status"]); rev = h["x-aiwb-scene-rev"] ?? null; });
    req.on("data", (d) => { text += d; });
    req.on("end", () => { let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ } resolve({ status, json, text, rev }); });
    req.on("error", reject);
    req.setTimeout(20000, () => req.close());
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
  return {
    client,
    async call(method, path, body) {
      const session = connect();
      try { return await request(session, method, path, body); } finally { session.close(); }
    },
    async known(fn) {
      const session = connect();
      session.on("error", () => {});
      const events = session.request(headersOf("GET", "/api/events"));
      try {
        await new Promise((resolve, reject) => { // (the snapshot is the first thing the stream says: the client is then known)
          events.once("data", resolve);
          events.once("error", reject);
          events.once("end", () => reject(new Error("the event stream ended")));
          setTimeout(() => reject(new Error("the event stream said nothing in 20 s")), 20000);
        });
        events.on("data", () => {});
        return await fn((method, path, body) => request(session, method, path, body));
      } finally { events.close(); session.close(); }
    },
  };
}

/** The size of a PNG or a JPEG, from its first bytes; null for any other bytes. */
export function pictureSize(b) {
  if (b.length > 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

/** The type of an image from its first bytes ("" for anything else). */
export function typeOfBytes(b) {
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return "";
}

/** Starts the control API for `server` (startServer of lib/scratch.mjs). Answers { url, close() }. */
export async function startServerControl(server, { say = () => {}, hooks = {} } = {}) {
  const api = apiClient(server);
  const s = server.scratch;
  const need = async (method, path, body) => {
    const r = await api.call(method, path, body);
    if (r.status !== 200) throw new Error(`${method} ${path}: ${r.status} ${r.text.slice(0, 200)}`);
    return r.json;
  };
  // The certificate the run began with: /reset puts it back.
  const first = ["remote-cert.pem", "remote-key.pem"].map((f) => [f, fs.readFileSync(path.join(s.home, f))]);
  const reset = async () => {
    await s.stop();
    for (const [f, data] of first) fs.writeFileSync(path.join(s.home, f), data, { mode: 0o600 });
    for (const d of ["boards", "chats"]) fs.rmSync(path.join(s.home, d), { recursive: true, force: true });
    await s.launch();
  };
  const rawGet = (path) => new Promise((resolve, reject) => {
    const session = http2.connect(`https://${server.host}:${server.port}`, { rejectUnauthorized: false });
    const req = session.request({ ":method": "GET", ":path": path, "x-aiwb-secret": server.secret, "x-aiwb-client": api.client, "x-aiwb-level": String(LEVEL) });
    const parts = [];
    let status = 0;
    req.on("response", (h) => { status = Number(h[":status"]); });
    req.on("data", (d) => parts.push(d));
    req.on("end", () => { session.close(); status === 200 ? resolve({ body: Buffer.concat(parts) }) : reject(new Error(`GET ${path}: ${status}`)); });
    req.on("error", (e) => { session.close(); reject(e); });
    req.end();
  });
  const routes = {
    "POST /reset": async () => { await reset(); return {}; },
    "POST /stop": async () => { await s.stop(); return {}; },
    "POST /start": async () => { await s.launch(); return {}; },
    "POST /new-cert": async () => {
      await s.stop();
      const printed = execFileSync(server.bin, ["remote", "setup", "-home", s.home, "-new-cert"], { env: s.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      const fingerprint = /^Fingerprint:\s*(\S+)/m.exec(printed)?.[1] ?? "";
      if (!fingerprint) throw new Error(`remote setup -new-cert printed no fingerprint: ${printed}`);
      await s.launch();
      return { fingerprint };
    },
    "POST /board": async (q) => {
      const id = (await need("POST", "/api/boards", { name: q.get("name") || "V1 board", group: "__ungrouped__", new: true })).id;
      if (q.get("scene")) { // (the client takes the board, writes the drawing as the holder, and lets the board go; the app takes it when it opens it)
        await api.known(async (call) => {
          const ask = async (method, path, body) => {
            const r = await call(method, path, body);
            if (r.status !== 200) throw new Error(`${method} ${path}: ${r.status} ${r.text.slice(0, 200)}`);
            return r.json;
          };
          const held = await ask("POST", `/api/boards/${id}/take`, { ifFree: true });
          if (held.state !== "held") throw new Error(`take ${id}: ${JSON.stringify(held)}`);
          await ask("PUT", `/api/boards/${id}/scene?rev=${held.rev ?? 0}`, sceneOf(q.get("scene")));
          await ask("POST", `/api/boards/${id}/release`, {});
        });
      }
      return { id };
    },
    "POST /chat": async (q) => {
      const chat = await need("POST", "/api/chats", q.get("board") ? { agent: "claude", board: q.get("board") } : { agent: "claude", group: "__ungrouped__" });
      if (q.get("name")) await need("PATCH", `/api/chats/${chat.id}`, { name: q.get("name") });
      if (q.get("text")) await need("POST", `/api/chats/${chat.id}/messages`, { text: q.get("text"), context: "" });
      return { id: chat.id };
    },
    "POST /say": async (q) => { await need("POST", `/api/chats/${q.get("chat")}/messages`, { text: q.get("text"), context: "" }); return {}; },
    "GET /chat-images": async (q) => {
      const id = q.get("chat");
      const thread = await need("GET", `/api/chats/${id}/items`);
      const found = [];
      const walk = (x) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === "object") { if (Array.isArray(x.images)) found.push(...x.images); Object.values(x).forEach(walk); } };
      walk(thread.items);
      const images = [];
      for (const im of found) {
        const r = await rawGet(`/api/chats/${id}/images/${im.id}`);
        images.push({ id: im.id, name: im.name, type: im.type, size: im.size, got: r.body.length, bytesType: typeOfBytes(r.body), ...(pictureSize(r.body) ?? {}) });
      }
      say(`the server holds for chat ${id}: ${images.map((i) => `${i.name} ${i.bytesType} ${i.width ?? "?"}x${i.height ?? "?"} ${i.size} B`).join("; ") || "no image"}`);
      return { images };
    },
    "GET /sent": async (q) => {
      const t = await need("GET", `/api/chats/${q.get("chat")}/items`);
      return { sent: (t.items ?? []).filter((i) => i.kind === "user").map((i) => i.text) };
    },
    "GET /box": async () => ({ box: hooks.box?.() ?? null }),
    "POST /check": async (q) => {
      const name = q.get("name"), end = Date.now() + Number(q.get("timeout") || 20000);
      if (!hooks.check) throw new Error("this flow has no `verify=` module");
      let seen;
      for (;;) {
        seen = await hooks.check(name);
        if (seen === true) return {};
        if (Date.now() > end) throw new Error(`check ${name} did not hold: ${seen}`);
        await new Promise((r) => setTimeout(r, 250));
      }
    },
    "GET /state": async () => {
      const st = await need("GET", "/api/state");
      return { boards: (st.boards ?? []).map((b) => b.name), chats: (st.chats ?? []).map((c) => c.name) };
    },
  };
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    const handler = routes[`${req.method} ${u.pathname}`];
    const send = (status, o) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (!handler) return send(404, { ok: false, error: "no such route" });
    try {
      const out = await handler(u.searchParams);
      say(`control ${req.method} ${u.pathname}${u.search} -> ok`);
      send(200, { ok: true, ...out });
    } catch (e) {
      say(`control ${req.method} ${u.pathname}${u.search} -> ${e.message}`);
      send(500, { ok: false, error: e.message });
    }
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return {
    reset,
    /** More routes (`"GET /device/storage": async (query) => ({...})`), added by the runner once it knows the device. */
    add: (more) => Object.assign(routes, more),
    url: `http://127.0.0.1:${srv.address().port}`,
    close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }),
  };
}
