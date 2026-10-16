// The collector of the board bench on a device (a dev tool: never in a shipped build, DEVICE.md here). A small HTTP server on the
// Mac that the bench page in the phone's web view POSTs to (fetch, no-cors, content-type text/plain, the body is JSON):
//   {"kind":"aiwb-board-bench-progress","text":"..."}    one line of progress   → `progress` emits "line" with the text
//   {"kind":"aiwb-board-bench", ...}                      the result (stats.mjs) → `result` resolves with the first, `latest()` is the last
// Anything else is logged and ignored. Every answer is 204 with `Access-Control-Allow-Origin: *`; OPTIONS (a preflight) is answered too.
import http from "node:http";
import { EventEmitter } from "node:events";

export const PROGRESS_KIND = "aiwb-board-bench-progress";
export const RESULT_KIND = "aiwb-board-bench";
const MAX_BODY = 20 * 1024 * 1024;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "600",
};

/**
 * Starts the collector. → { url(hostForPhone), port, progress (EventEmitter, "line"), lines, result (Promise), latest(), close() }.
 * `log` gets what was ignored (default: console.error).
 */
export function startCollector({ host = "0.0.0.0", port = 0, log = (m) => console.error(`[collector] ${m}`) } = {}) {
  const progress = new EventEmitter();
  const lines = [];
  let latest = null;
  let resolveResult;
  const result = new Promise((resolve) => { resolveResult = resolve; });

  const accept = (text) => {
    let msg;
    try { msg = JSON.parse(text); } catch { log(`ignored a body that is not JSON (${text.length} chars): ${text.slice(0, 80)}`); return; }
    if (msg?.kind === PROGRESS_KIND && typeof msg.text === "string") { lines.push(msg.text); progress.emit("line", msg.text); }
    else if (msg?.kind === RESULT_KIND) { latest = msg; resolveResult(msg); }
    else log(`ignored a message of kind ${JSON.stringify(msg?.kind)}`);
  };

  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "OPTIONS") { res.writeHead(204, CORS).end(); return; }
    if (req.method === "GET" && path === "/") { res.writeHead(200, { ...CORS, "content-type": "text/plain" }).end("aiwb bench collector\n"); return; }
    if (req.method !== "POST" || path !== "/report") { res.writeHead(404, CORS).end(); return; }
    const chunks = [];
    let size = 0, tooBig = false;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { tooBig = true; chunks.length = 0; } else if (!tooBig) chunks.push(c);
    });
    req.on("end", () => {
      if (tooBig) { log(`ignored a body over ${MAX_BODY} bytes`); res.writeHead(413, CORS).end(); return; }
      accept(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(204, CORS).end();
    });
    req.on("error", () => res.destroy());
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const bound = server.address();
      const boundPort = typeof bound === "object" && bound ? bound.port : port;
      resolve({
        port: boundPort,
        url: (hostForPhone = "127.0.0.1") => `http://${hostForPhone}:${boundPort}/report`,
        progress,
        lines,
        result,
        latest: () => latest,
        close: () => new Promise((done) => { server.close(() => done()); server.closeAllConnections?.(); }),
      });
    });
  });
}
