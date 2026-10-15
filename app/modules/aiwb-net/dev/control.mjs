// The control server of the device self-test of `aiwb-net` (src/dev/netSelfTest.ts in the app), started by the runner
// (app/e2e/lib/scratch.mjs `startStandIns`) on the computer the simulator or the emulator reaches (127.0.0.1; the Android
// emulator through `adb reverse`).
//
// The connector contract (packages/conn/test/contract) needs a server a real Go server cannot be: one that lists the requests
// it got, cuts its connections, hangs a path, holds an event stream open and writes to it. The stand-in of @aiwb/conn's tests
// (packages/conn/test/standin.js, the server `node.test.js` runs the same contract against) does all that, but it lives in this
// process and the contract calls it synchronously. So the self-test reaches it through this small control server: the device
// calls `POST /<op>` with a JSON body and gets JSON back (the dev screen may use fetch for that: it is not the app, AD-36 does
// not scan `dev/`).
//
//   const c = await startControl();   // {control: "http://127.0.0.1:<port>", close()}
//
// Controls (all POST, JSON in, JSON out): start {preamble?, cut?, probe?} → {id, port, fingerprint, secret}; state {id} →
// {requests, connections}; body, echo, hang, drop, write, endStreams, cut, waitStream, close. A request is {method, path, headers,
// body: number[]}. With `probe` the requests it lists leave out the probe `GET /api/hello` that opens a session (the first request
// of an HTTP/2 connection, with no x-aiwb-* header; the native module sends one: README.md, "What the module writes"). `preamble` is written when an event stream opens
// (a platform that hands a response over with its first byte, iOS, needs one); `cut: "rst"` makes `cut` reset the TCP connections
// instead of closing them politely (a polite GOAWAY is a clean end on iOS).

import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const standin = require(path.join(here, "../../../../packages/conn/test/standin.js"));

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

/** `expose(port)` / `unexpose(port)`: told of every stand-in server that starts and ends, for a device that reaches the computer
 *  through `adb reverse` (Android): a port it has not been given is not there for it. */
export async function startControl({ expose = async () => {}, unexpose = () => {} } = {}) {
  const servers = new Map(); // id → {s, log, connections}
  let seq = 0;

  async function startAiwb({ preamble, cut, probe } = {}) {
    const s = await standin.standin({ withHello: false });
    s.noSnapshot = true;
    if (preamble) {
      // A platform that hands a response over with its first byte (iOS) is given one when a stream opens.
      const events = s.events.bind(s);
      s.events = (req, res) => { events(req, res); if (!res.writableEnded) res.write(preamble); };
    }
    await expose(s.port);
    const entry = { s, log: [], connections: 0, sockets: null };
    const sockets = entry.sockets = new Set();
    s.server.on("connection", (sock) => { entry.connections++; sockets.add(sock); sock.on("close", () => sockets.delete(sock)); });
    if (cut === "rst") {
      // The connection is reset, as a network that breaks does, not closed politely after a GOAWAY.
      s.cut = () => { for (const sock of sockets) sock.resetAndDestroy(); s.streams.clear(); };
    }
    s.server.prependListener("request", (req) => {
      const session = req.stream.session;
      const first = !session.__seen;
      session.__seen = true;
      const isProbe = probe && first && req.method === "GET" && req.url === "/api/hello" && !Object.keys(req.headers).some((k) => k.startsWith("x-aiwb-"));
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        if (!isProbe) entry.log.push({ method: req.method, path: req.url, headers: { ...req.headers }, body: [...Buffer.concat(chunks)] });
      });
    });
    const id = String(++seq);
    servers.set(id, entry);
    return { id, port: s.port, fingerprint: s.fingerprint, secret: s.secret };
  }

  const ops = {
    start: async (o) => startAiwb(o),
    state: ({ id }) => { const e = servers.get(id); return { requests: e.log, connections: e.connections }; },
    body: ({ id, path: p, bytes }) => { servers.get(id).s.routes.set(`GET ${p}`, () => ({ bytes: Buffer.from(bytes), type: "application/octet-stream" })); return {}; },
    echo: ({ id, path: p }) => { servers.get(id).s.routes.set(`POST ${p}`, (req, res, body) => ({ bytes: body, type: "application/octet-stream" })); return {}; },
    // Every request to the path is answered by resetting the connection (the tripwire of the retries URLSession makes by itself).
    drop: ({ id, path: p }) => {
      const e = servers.get(id);
      for (const method of ["GET", "POST"]) e.s.routes.set(`${method} ${p}`, () => { for (const sock of e.sockets) sock.resetAndDestroy(); });
      return {};
    },
    hang: ({ id, path: p }) => { servers.get(id).s.hangPaths.add(p); return {}; },
    write: ({ id, text }) => { for (const res of servers.get(id).s.streams) res.write(text); return {}; },
    endStreams: ({ id }) => { servers.get(id).s.endStreams(); return {}; },
    cut: ({ id }) => { servers.get(id).s.cut(); return {}; },
    waitStream: async ({ id }) => { await servers.get(id).s.waitStreams(1); return {}; },
    close: async ({ id }) => { const e = servers.get(id); servers.delete(id); if (e) { unexpose(e.s.port); await e.s.close(); } return {}; },
  };

  const control = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const op = ops[req.url.slice(1)];
      try {
        if (!op) throw new Error(`no such control ${req.url}`);
        const out = await op(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out ?? {}));
      } catch (err) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(String(err?.message ?? err));
      }
    });
  });
  await listen(control);

  return {
    control: `http://127.0.0.1:${control.address().port}`,
    async close() {
      for (const e of servers.values()) await e.s.close();
      control.closeAllConnections?.(); control.close();
    },
  };
}
