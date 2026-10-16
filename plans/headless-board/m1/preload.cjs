// Preloaded into the headless writer's Node process (NODE_OPTIONS=--require), only to timestamp its phases for M1. It changes
// nothing the process does: it wraps tls.connect and the socket's write to note when a connection opens and which request line
// goes out, and appends one JSON line per event to the file M1_LOG (epoch milliseconds).
const fs = require("node:fs");
const { performance } = require("node:perf_hooks");
const file = process.env.M1_LOG;
const mine = /headless\.mjs$/.test(process.argv[1] || "");
if (file && mine) {
  const log = (ev, extra) => fs.appendFileSync(file, JSON.stringify({ pid: process.pid, ev, t: Date.now(), ...extra }) + "\n");
  log("start", { t: Math.round(performance.timeOrigin) });
  log("preload");
  const tls = require("node:tls");
  const connect = tls.connect;
  let n = 0;
  tls.connect = function (...a) {
    const id = ++n;
    log("tls.connect", { id });
    const s = connect.apply(this, a);
    s.once("secureConnect", () => log("secureConnect", { id }));
    return s;
  };
  const http2 = require("node:http2");
  const h2connect = http2.connect;
  let streams = 0;
  http2.connect = function (...a) {
    const session = h2connect.apply(this, a);
    log("http2.connect");
    const request = session.request;
    session.request = function (headers, ...rest) {
      const id = ++streams;
      const line = `${headers[":method"] || "GET"} ${String(headers[":path"] || "").replace(/\?.*/, "")}`;
      log("request", { id, line });
      const req = request.call(this, headers, ...rest);
      req.once("response", (h) => log("response", { id, line, status: h[":status"] }));
      req.once("close", () => log("closed", { id, line }));
      return req;
    };
    return session;
  };
  process.on("exit", () => log("exit"));
}
