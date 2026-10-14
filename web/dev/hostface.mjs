// The HTTP face of a client of servers, for the page in a headless browser (plans/app-as-client-plan.md, C5.1). It is
// what the main process's IPC face is to the app: the page sends its calls, takes its stream and shows its pictures
// through it, and behind it stands a client with the API of desktop/conn (createClient), or the mock's fake one
// (dev/mock.mjs). The face never listens: the caller gives `handle` to an http.Server.
//
//   GET  /host/events                        the stream of every server: one SSE stream, each envelope a `data:` line
//   POST /host/call?server=&method=&path=    one call; the body is the call's body (JSON, or bytes with their type)
//   GET  /host/picture/<entry>/<chat>/<image>
//   POST /host/app/<op>                      an app operation (the server list, the owner's things); the body is its arguments
//   GET  anything else                       a file of distDir (/ is index.html)
//
// The face holds no secret and checks no route: the client answers a server that is not in its list, a path that is
// no call of the client API and the state of a server, each with a status, and so does the picture's check of bytes.
// What it does check is that it is asked from the page it serves: the Host of a request must be a loopback name and an
// Origin, when there is one, the host's own, so that no other site in the same browser can use the secrets it stands for.
import fs from "node:fs";
import path from "node:path";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".ico": "image/x-icon", ".map": "application/json", ".txt": "text/plain; charset=utf-8", ".wasm": "application/wasm" };
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const PING = 20000;
const BODY_MAX = 160 << 20; // above the largest drawing a server takes (128 MiB), which the client checks itself
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/** Whether a request comes from the page a loopback host serves: a loopback Host, and an Origin, if any, that is its own. */
export function ownRequest(req) {
  if (!LOOPBACK.test(String(req.headers.host ?? ""))) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

/** Creates the face of `client`, serving the page files of `distDir`. log(line) gets one line for a call the face
 *  could not hand to the client; it is never given a body. pingMs: the time between the pings of the stream, bodyMax the
 *  most a body may hold (a test lowers each). Answers { handle(req, res), close() }: close ends the
 *  stream and its timer, and ends the client's subscription. It does not close the client. */
export function createHostFace({ client, distDir, log = () => {}, pingMs = PING, bodyMax = BODY_MAX }) {
  let stream = null; // the one open stream: { res, sub, timer }

  const endStream = (s) => {
    if (!s || s.done) return;
    s.done = true;
    clearInterval(s.timer);
    try { s.sub?.close(); } catch {}
    if (stream === s) stream = null;
    if (!s.res.writableEnded) s.res.end();
  };

  const json = (res, code, v, headers = {}) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
    res.end(typeof v === "string" ? v : JSON.stringify(v));
  };
  const refuse = (res, code, error, word) => json(res, code, { error, code: word });

  /** The body of a request as the client takes it: JSON when the type says so, else bytes with the type; undefined for none.
   *  Answers null when it is over the limit (already answered). */
  async function bodyOf(req, res) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > bodyMax) { res.setHeader("Connection", "close"); refuse(res, 413, "The body is too large.", "too_large"); return null; }
      chunks.push(c);
    }
    if (!size) return undefined;
    const type = String(req.headers["content-type"] ?? "").trim();
    if (/^application\/json\b/i.test(type)) return { json: Buffer.concat(chunks).toString("utf8") };
    return { bytes: new Uint8Array(Buffer.concat(chunks)), type: type || "application/octet-stream" };
  }

  /** An AbortSignal that aborts when the request goes away before its answer is written. */
  function signalOf(req, res) {
    const ctl = new AbortController();
    res.on("close", () => { if (!res.writableEnded) ctl.abort(); });
    return ctl.signal;
  }

  function events(req, res) {
    endStream(stream); // a new stream ends the previous one of this face
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
    res.flushHeaders();
    res.write(": open\n\n");
    const s = { res, sub: null, timer: setInterval(() => res.write(": ping\n\n"), pingMs) };
    s.timer.unref?.();
    stream = s;
    res.on("close", () => endStream(s));
    s.sub = client.subscribe((env) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(env)}\n\n`); });
    if (stream !== s) s.sub?.close(); // (ended while subscribing)
  }

  async function call(req, res, u) {
    const server = u.searchParams.get("server"), method = u.searchParams.get("method"), p = u.searchParams.get("path");
    if (!server || !method || !p) return refuse(res, 400, "A call names a server, a method and a path.", "bad_request");
    if (!METHODS.has(method)) return refuse(res, 400, `${method} is no method of a call.`, "bad_request");
    const body = await bodyOf(req, res);
    if (body === null) return;
    const signal = signalOf(req, res);
    let a;
    try { a = await client.call({ server, method, path: p, ...(body ? { body } : {}), signal }); }
    catch (e) {
      if (signal.aborted || e?.name === "AbortError") return;
      log(`call ${method} ${server}: ${e?.message ?? e}`);
      return refuse(res, 500, "The host could not make the call.", "host_error");
    }
    json(res, a.status, a.text, a.sceneRev === null || a.sceneRev === undefined ? {} : { "X-AIWB-Scene-Rev": String(a.sceneRev) });
  }

  async function picture(req, res, rest) {
    if (req.method !== "GET") return refuse(res, 405, "A picture is read with GET.", "method_not_allowed");
    const parts = rest.split("/");
    let ids;
    try { ids = parts.map(decodeURIComponent); } catch { return refuse(res, 404, "not found", "not_found"); }
    if (ids.length !== 3 || ids.some((x) => !x)) return refuse(res, 404, "not found", "not_found");
    const signal = signalOf(req, res);
    let a;
    try { a = await client.picture({ server: ids[0], chat: ids[1], image: ids[2], signal }); }
    catch (e) {
      if (signal.aborted || e?.name === "AbortError") return;
      log(`picture ${ids[0]}: ${e?.message ?? e}`);
      return refuse(res, 500, "The host could not fetch the picture.", "host_error");
    }
    if (!a.ok) return json(res, a.status, a.text);
    res.writeHead(200, { "Content-Type": a.type, "Content-Length": a.data.length, "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=31536000, immutable", "Content-Security-Policy": "default-src 'none'; sandbox" });
    res.end(Buffer.from(a.data.buffer, a.data.byteOffset, a.data.length));
  }

  async function app(req, res, op) {
    if (req.method !== "POST") return refuse(res, 405, "An operation is asked with POST.", "method_not_allowed");
    const body = await bodyOf(req, res);
    if (body === null) return;
    let args;
    if (body) {
      if (!("json" in body)) return refuse(res, 400, "The arguments of an operation are JSON.", "bad_request");
      try { args = JSON.parse(body.json); } catch { return refuse(res, 400, "The arguments of an operation are JSON.", "bad_request"); }
    }
    let a;
    try { a = await client.app(op, args); }
    catch (e) { log(`app ${op}: ${e?.message ?? e}`); return refuse(res, 500, "The host could not do the operation.", "host_error"); }
    json(res, a.status, a.body ?? null);
  }

  function file(req, res, pathname) {
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(404); return res.end(); }
    let name;
    try { name = decodeURIComponent(pathname); } catch { res.writeHead(404); return res.end(); }
    const root = path.resolve(distDir), f = path.join(root, name === "/" ? "index.html" : name);
    if ((f !== root && !f.startsWith(root + path.sep)) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(f).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "no-store" });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(f).pipe(res);
  }

  async function handle(req, res) {
    try {
      if (!ownRequest(req)) return refuse(res, 403, "This host answers its own page alone.", "bad_host");
      const u = new URL(req.url, "http://host"), p = u.pathname;
      if (p === "/host/events") return req.method === "GET" ? events(req, res) : refuse(res, 405, "The stream is read with GET.", "method_not_allowed");
      if (p === "/host/call") return req.method === "POST" ? await call(req, res, u) : refuse(res, 405, "A call is sent with POST.", "method_not_allowed");
      if (p.startsWith("/host/picture/")) return await picture(req, res, p.slice("/host/picture/".length));
      if (p.startsWith("/host/app/")) { let op; try { op = decodeURIComponent(p.slice("/host/app/".length)); } catch { return refuse(res, 404, "not found", "not_found"); } return await app(req, res, op); }
      if (p.startsWith("/host/") || p === "/host") return refuse(res, 404, "not found", "not_found");
      return file(req, res, p);
    } catch (e) {
      log(`${req.method} ${req.url}: ${e?.message ?? e}`);
      if (!res.headersSent) refuse(res, 500, "The host failed.", "host_error"); else res.end();
    }
  }

  return {
    handle,
    close() { endStream(stream); },
    /** Cuts the connection of the stream that is open, as a network does (the page's stream tries again by itself). Not part of the contract: for the mock's dropStreams(). */
    drop() { stream?.res.destroy(); },
  };
}
