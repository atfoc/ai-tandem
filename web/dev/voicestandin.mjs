// The stand-in voice service (plans/voice-chats/architecture.md, VC-31): a local fake of the parts of ElevenLabs that voice
// uses (arch section 2), for the browser checks, the end-to-end scripts and the device flow. Plain Node, no dependency: the
// WebSocket handshake and frames are written here by hand. It calls nothing outside this computer.
//
//   node web/dev/voicestandin.mjs --port N [--prefix /voice]       prints `Voice: http://127.0.0.1:<port>/voice`
//
// It is mounted under a prefix (default /voice) by the mock (dev/mock.mjs), by the test host (dev/hostface.mjs) or alone:
//   POST <prefix>/v1/single-use-token/realtime_scribe          {token: "sutkn_…"}, used once, good for 15 minutes
//   GET  <prefix>/v2/voices                                    six voices; page_size, next_page_token, search, include_total_count
//   GET  <prefix>/_preview/<voice id>.wav                      a 0.5 s tone (a public clip: no key)
//   POST <prefix>/v1/text-to-speech/<voice>/stream             chunked raw PCM, 24 kHz, 16 bit, mono; the sentence is {text, model_id, …}
//   GET  <prefix>/v1/speech-to-text/realtime   (upgrade)       the realtime transcription socket (Scribe)
//   <prefix>/_control/{script,fail,pace,log,reset}             only standalone (routes()): the control of `control` over HTTP
//
// A key is `xi-api-key` (a key `keys(key)` accepts: sk_test_* by default, the others get the 401 of a rejected key) or, on the socket,
// `token=` from the token route. The key is never logged: an entry of the log has `keyHeader: true`, and a query loses any
// parameter named like a key or a token.
//
// The control (createVoiceStandin().control; the mock gives it to /mock/eval as `voice`, the control over HTTP is the same calls):
//   script(steps)   the next STT session: [{ after: <audio chunks received>, partial?: string, committed?: string }], each step
//                   fires once, in order, when that many chunks of audio have come (after: 0: at the start); partial then
//                   committed. A frame with `commit: true` commits the last partial that was not committed yet
//   fail(what)      { http: { status, code, legacyStatus? } }: every API request answers it, and a socket is refused with that status;
//                   { socket: messageType, after?: n }: the socket sends that error message (and closes) in place of `session_started`
//                   or, with after, once n chunks have come; { offline: true }: every request is destroyed, every socket refused;
//                   once: true on any of them: the next request alone; or a name for http and socket together: "key_rejected" (401),
//                   "no_credits" (402 insufficient_credits, socket quota_exceeded), "no_credits_legacy" (401 quota_exceeded in the old
//                   form), "rate_limited" (429, socket rate_limited), "offline"; null: none
//   pace({ chunkMs, chunks })   TTS: how many chunks a sentence's answer is cut into (6) and the time between them (100 ms). Cuts fall
//                   on odd bytes at every second boundary, as a network's may: the player keeps the odd byte
//   log()           every request, a copy: { at, kind: "token"|"voices"|"preview"|"tts"|"stt", path, query, keyHeader, token, status,
//                   problems: [what the client did against the protocol], … }; tts: text, voice, model, speed, chunks, bytes,
//                   sampleRates [24000], chunkMsMin/Max (the time between two writes), startedAt, finishedAt, cancelled (the request was
//                   closed before its end; cancelledAt); stt: chunks (of audio), commits, bytes, sampleRates, chunkMsMin/Max (the length
//                   of a chunk's audio), sent (message types), startedAt, finishedAt, closeCode
//   reset()         clears the log, the script, the failure, the pace and the tokens, and cuts what is open
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const STT_MODELS = ["scribe_v2_realtime"];
const TTS_MODELS = ["eleven_flash_v2_5", "eleven_v4_turbo", "eleven_multilingual_v2"];
const STT_PARAMS = new Set(["model_id", "audio_format", "language_code", "commit_strategy", "vad_silence_threshold_secs", "include_timestamps", "token"]);
const COMMIT_STRATEGIES = new Set(["manual", "vad", "turn_prediction"]);
const TOKEN_MS = 15 * 60 * 1000;
const BODY_MAX = 1 << 20;
const FRAME_MAX = 16 << 20;
const SECRET_NAME = /key|token|secret|auth/i;

const VOICES = [
  ["vsAlice", "Alice", "Warm and clear, for narration.", { accent: "american", gender: "female", age: "young", use_case: "narration" }],
  ["vsBob", "Bob", "A calm, low voice.", { accent: "british", gender: "male", age: "middle_aged", use_case: "conversational" }],
  ["vsCarol", "Carol", "Bright and quick.", { accent: "australian", gender: "female", age: "young", use_case: "social_media" }],
  ["vsDave", "Dave", "Steady and friendly.", { accent: "american", gender: "male", age: "middle_aged", use_case: "conversational" }],
  ["vsErin", "Erin", "Soft and slow.", { accent: "irish", gender: "female", age: "old", use_case: "audiobook" }],
  ["vsFrank", "Frank", "Deep and formal.", { accent: "british", gender: "male", age: "old", use_case: "news" }],
].map(([voice_id, name, description, labels], i) => ({ voice_id, name, description, labels, category: "premade", index: i }));

const NAMED = {
  key_rejected: { http: { status: 401, code: "invalid_api_key" }, socket: "auth_error" },
  no_credits: { http: { status: 402, code: "insufficient_credits" }, socket: "quota_exceeded" },
  no_credits_legacy: { http: { status: 401, legacyStatus: "quota_exceeded" }, socket: "quota_exceeded" },
  rate_limited: { http: { status: 429, code: "rate_limit_exceeded" }, socket: "rate_limited" },
  offline: { offline: true },
};

const now = () => Date.now();
const rand = (n = 12) => crypto.randomBytes(n).toString("hex").slice(0, n);

/** The body of an error of the service, in the form of its docs (arch 2.6): the current one with a code, or the legacy one with a status alone. */
function errorBody(status, code, message, legacyStatus) {
  if (legacyStatus) return { detail: { status: legacyStatus, message } };
  return { detail: { type: status === 429 || status === 402 ? "rate_limit" : "authentication", code, message, status: code, request_id: "req_" + rand(16) } };
}

const MESSAGES = {
  invalid_api_key: "Invalid API key.", missing_api_key: "An API key is needed.", insufficient_credits: "Not enough credits.",
  quota_exceeded: "The quota is used up.", rate_limit_exceeded: "Too many requests.", not_found: "There is nothing here.",
  voice_not_found: "There is no such voice.", invalid_request: "The request is not valid.", method_not_allowed: "That method is not allowed here.",
};

// ---- WebSocket framing, by hand (RFC 6455)

/** A server frame (never masked): the length in 7, 16 or 64 bits. */
export function wsFrame(opcode, payload = Buffer.alloc(0)) {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]) : (() => {
    const h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); return h;
  })();
  return Buffer.concat([head, payload]);
}

/** Reads client frames out of what arrives: feed(chunk) calls onFrame({opcode, payload}) for each whole message (fragments are joined);
 *  onError(code, why) for a frame against the protocol (unmasked, too large, an unknown opcode). */
export function wsReader(onFrame, onError) {
  let buf = Buffer.alloc(0), parts = [], first = 0;
  return function feed(chunk) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0, opcode = buf[0] & 15, masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 127, at = 2;
      if (buf[0] & 0x70) return onError(1002, "reserved bits are set");
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; }
      else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(FRAME_MAX)) return onError(1009, "a frame is too large");
        len = Number(big); at = 10;
      }
      if (!masked) return onError(1002, "a client frame is not masked");
      if (len > FRAME_MAX) return onError(1009, "a frame is too large");
      if (buf.length < at + 4 + len) return;
      const key = buf.subarray(at, at + 4), payload = Buffer.alloc(len);
      for (let i = 0; i < len; i++) payload[i] = buf[at + 4 + i] ^ key[i & 3];
      buf = buf.subarray(at + 4 + len);
      if (opcode >= 8) { if (!fin || len > 125) return onError(1002, "a control frame is fragmented or long"); onFrame({ opcode, payload }); continue; }
      if (opcode === 0) { if (!parts.length) return onError(1002, "a continuation with nothing to continue"); }
      else if (opcode === 1 || opcode === 2) { if (parts.length) return onError(1002, "a new message inside a fragmented one"); first = opcode; }
      else return onError(1002, "an unknown opcode");
      parts.push(payload);
      if (fin) { const all = Buffer.concat(parts); parts = []; onFrame({ opcode: first, payload: all }); }
    }
  };
}

// ---- audio

/** A sine of `seconds` at `hz`, signed 16-bit little-endian mono at `rate`. */
function sine(seconds, hz, rate) {
  const n = Math.max(1, Math.round(seconds * rate)), out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const fade = Math.min(1, i / 240, (n - i) / 240); // (no click at either end)
    out.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 0.2 * 32767 * fade), i * 2);
  }
  return out;
}

function wav(seconds, hz, rate) {
  const data = sine(seconds, hz, rate), h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Where a sentence's PCM is cut into `count` parts: every second boundary falls on an odd byte. */
function cuts(length, count) {
  count = Math.max(1, Math.min(count, Math.floor(length / 4)));
  const at = [0];
  for (let k = 1; k < count; k++) { const b = Math.floor((k * length) / count); at.push(k % 2 && b % 2 === 0 ? b + 1 : b); }
  at.push(length);
  return at;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

// ---- the stand-in

/** Makes a stand-in. prefix: where it is mounted; keys(key): whether a key works; log(line): a line for what it did (never a key);
 *  tokenMs: how long a token lives (a test lowers it). */
export function createVoiceStandin({ prefix = "/voice", keys = (k) => /^sk_test_/.test(k), log: say = () => {}, tokenMs = TOKEN_MS } = {}) {
  prefix = prefix.replace(/\/+$/, "");
  let pending = null, failure = null, pace = { chunkMs: 100, chunks: 6 };
  let entries = [];
  const tokens = new Map(); // token → { used, expires }
  const open = new Set(); // sockets and responses in flight

  // The path of a request under the prefix, "" for the prefix alone; null when it is not under it.
  const under = (req) => {
    const p = new URL(req.url, "http://x").pathname;
    return p === prefix ? "" : p.startsWith(prefix + "/") ? p.slice(prefix.length) : null;
  };
  const queryOf = (req) => {
    const q = {};
    for (const [k, v] of new URL(req.url, "http://x").searchParams) if (!SECRET_NAME.test(k)) q[k] = v;
    return q;
  };
  const hasToken = (req) => new URL(req.url, "http://x").searchParams.has("token");
  const keyOf = (req) => { const k = req.headers["xi-api-key"]; return typeof k === "string" ? k : null; };

  function entry(kind, req, more = {}) {
    const e = { at: now(), kind, method: req.method, path: new URL(req.url, "http://x").pathname, query: queryOf(req), keyHeader: keyOf(req) !== null, token: hasToken(req), status: 0, problems: [], ...more };
    entries.push(e);
    return e;
  }

  /** The failure to apply to this request, or null; one marked `once` is spent. */
  function failing() {
    const f = failure;
    if (f?.once) failure = null;
    return f;
  }

  function json(res, status, body, e) {
    if (e) e.status = status;
    const text = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(text) });
    res.end(text);
  }
  const refuse = (res, status, code, e, legacyStatus) => json(res, status, errorBody(status, code, MESSAGES[code] ?? code, legacyStatus), e);

  /** Whether the key header opens the door; answers the 401 itself when it does not. */
  function keyed(req, res, e) {
    const key = keyOf(req);
    if (key === null) { refuse(res, 401, "missing_api_key", e); return false; }
    if (!keys(key)) { refuse(res, 401, "invalid_api_key", e); return false; }
    return true;
  }

  async function bodyOf(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) { size += c.length; if (size > BODY_MAX) return null; chunks.push(c); }
    return Buffer.concat(chunks).toString("utf8");
  }

  // ---- HTTP

  function voicesRoute(req, res, e) {
    const q = new URL(req.url, "http://x").searchParams;
    const size = q.has("page_size") ? Number(q.get("page_size")) : 10;
    if (!Number.isInteger(size) || size < 1 || size > 100) { e.problems.push("page_size is not 1 to 100"); return refuse(res, 400, "invalid_request", e); }
    const start = q.has("next_page_token") ? Number(String(q.get("next_page_token")).replace(/^vsp_/, "")) : 0;
    if (!Number.isInteger(start) || start < 0) { e.problems.push("next_page_token is not one this service gave"); return refuse(res, 400, "invalid_request", e); }
    const find = (q.get("search") ?? "").toLowerCase();
    const all = VOICES.filter((v) => !find || v.name.toLowerCase().includes(find) || v.description.toLowerCase().includes(find));
    const origin = `http://${req.headers.host}`;
    const page = all.slice(start, start + size).map(({ index, ...v }) => ({ ...v, preview_url: `${origin}${prefix}/_preview/${v.voice_id}.wav` }));
    const more = start + size < all.length;
    json(res, 200, { voices: page, has_more: more, total_count: all.length, next_page_token: more ? `vsp_${start + size}` : null }, e);
  }

  async function tokenRoute(req, res, e) {
    if (req.method !== "POST") return refuse(res, 405, "method_not_allowed", e);
    const token = "sutkn_" + rand(32);
    tokens.set(token, { used: false, expires: now() + tokenMs });
    json(res, 200, { token }, e);
  }

  function previewRoute(req, res, name) {
    const e = entry("preview", req);
    const voice = VOICES.find((v) => name === v.voice_id + ".wav");
    if (!voice) return refuse(res, 404, "not_found", e);
    const body = wav(0.5, 330 + voice.index * 55, 24000);
    e.status = 200;
    res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": body.length, "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : body);
  }

  async function ttsRoute(req, res, voiceId, e) {
    if (req.method !== "POST") return refuse(res, 405, "method_not_allowed", e);
    const q = new URL(req.url, "http://x").searchParams;
    Object.assign(e, { text: undefined, voice: voiceId, chunks: 0, bytes: 0, sampleRates: [24000], chunkMsMin: null, chunkMsMax: null, startedAt: null, finishedAt: null, cancelled: false });
    const voice = VOICES.find((v) => v.voice_id === voiceId);
    if (!voice) return refuse(res, 404, "voice_not_found", e);
    if (q.get("output_format") !== "pcm_24000") { e.problems.push(`output_format is ${q.get("output_format") ?? "missing"}, not pcm_24000`); return refuse(res, 400, "invalid_request", e); }
    const raw = await bodyOf(req);
    let b;
    try { b = JSON.parse(raw ?? ""); } catch { b = null; }
    if (!b || typeof b !== "object" || Array.isArray(b)) { e.problems.push("the body is not a JSON object"); return refuse(res, 400, "invalid_request", e); }
    e.text = typeof b.text === "string" ? b.text : undefined;
    e.model = b.model_id;
    if (typeof b.text !== "string" || !b.text.trim()) e.problems.push("text is missing or empty");
    if (!TTS_MODELS.includes(b.model_id)) e.problems.push(`model_id ${JSON.stringify(b.model_id)} is not one of ${TTS_MODELS.join(", ")}`);
    if ("language_code" in b && typeof b.language_code !== "string") e.problems.push("language_code is not a string");
    let speed = 1;
    if ("voice_settings" in b) {
      const s = b.voice_settings?.speed;
      if (typeof s !== "number" || !(s >= 0.7 && s <= 1.2)) e.problems.push("voice_settings.speed is not a number from 0.7 to 1.2");
      else speed = s;
    }
    e.speed = speed;
    if (e.problems.length) return refuse(res, 400, "invalid_request", e);
    // (what the service takes but voice must not send: noted, not refused)
    if (speed === 1 && "voice_settings" in b) e.problems.push("voice_settings is sent with a speed of 1.0: it is sent only when the speed is not 1.0");
    for (const k of Object.keys(b)) if (!["text", "model_id", "language_code", "voice_settings"].includes(k)) e.problems.push(`the body has ${k}, which voice does not send`);

    const seconds = Math.min(30, Math.max(0.3, b.text.length * 0.05)) / speed;
    const pcm = sine(seconds, 220 + voice.index * 30, 24000), at = cuts(pcm.length, pace.chunks), ms = pace.chunkMs;
    e.status = 200;
    res.writeHead(200, { "Content-Type": "audio/pcm", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.flushHeaders();
    e.startedAt = now();
    let i = 0, last = e.startedAt, timer = null, done = false;
    const cut = { destroy() { res.destroy(); } };
    open.add(cut);
    res.on("close", () => {
      open.delete(cut);
      clearTimeout(timer);
      if (!done) { e.cancelled = true; e.cancelledAt = now(); }
    });
    const next = () => {
      const part = pcm.subarray(at[i], at[i + 1]);
      res.write(part);
      const t = now();
      if (i > 0) { const gap = t - last; e.chunkMsMin = e.chunkMsMin === null ? gap : Math.min(e.chunkMsMin, gap); e.chunkMsMax = e.chunkMsMax === null ? gap : Math.max(e.chunkMsMax, gap); }
      last = t;
      e.chunks++; e.bytes += part.length;
      if (++i < at.length - 1) timer = setTimeout(next, ms);
      else { done = true; e.finishedAt = now(); res.end(); }
    };
    next();
  }

  /** HTTP under the prefix. Answers whether the request was its own. */
  function handle(req, res) {
    const rest = under(req);
    if (rest === null) return false;
    serve(req, res, rest).catch((err) => {
      say(`${req.method} ${req.url}: ${err?.message ?? err}`);
      if (!res.headersSent) json(res, 500, errorBody(500, "internal", "The stand-in failed."), null); else res.destroy();
    });
    return true;
  }

  async function serve(req, res, rest) {
    if (failure?.offline) { entry("offline", req).status = 0; req.socket.destroy(); return; }
    if (rest.startsWith("/_preview/")) return previewRoute(req, res, rest.slice("/_preview/".length));
    let m;
    const kind = rest === "/v1/single-use-token/realtime_scribe" ? "token" : rest === "/v2/voices" ? "voices"
      : (m = /^\/v1\/text-to-speech\/([^/]+)\/stream$/.exec(rest)) ? "tts" : null;
    const e = entry(kind ?? "other", req);
    if (!kind) return refuse(res, 404, "not_found", e);
    const f = failing();
    if (f?.http) return json(res, f.http.status, errorBody(f.http.status, f.http.code, MESSAGES[f.http.code ?? f.http.legacyStatus] ?? f.http.code, f.http.legacyStatus), e);
    if (!keyed(req, res, e)) return;
    if (kind === "token") return tokenRoute(req, res, e);
    if (kind === "voices") return req.method === "GET" ? voicesRoute(req, res, e) : refuse(res, 405, "method_not_allowed", e);
    let voiceId;
    try { voiceId = decodeURIComponent(m[1]); } catch { voiceId = m[1]; }
    return ttsRoute(req, res, voiceId, e);
  }

  // ---- the STT socket

  /** The upgrade under the prefix. Answers whether it was its own (a refusal of it is an answer too). */
  function upgrade(req, socket, head) {
    const rest = under(req);
    if (rest === null) return false;
    socket.on("error", () => {});
    if (failure?.offline) { entry("offline", req).status = 0; socket.destroy(); return true; }
    if (rest !== "/v1/speech-to-text/realtime") { entry("other", req).status = 404; socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return true; }
    const e = entry("stt", req, { chunks: 0, commits: 0, bytes: 0, sampleRates: [], chunkMsMin: null, chunkMsMax: null, sent: [], startedAt: null, finishedAt: null, closeCode: null, cancelled: false });
    const refuseWith = (status, text) => { e.status = status; socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    const wsKey = req.headers["sec-websocket-key"];
    if (req.method !== "GET" || !/websocket/i.test(String(req.headers.upgrade ?? "")) || typeof wsKey !== "string" || req.headers["sec-websocket-version"] !== "13") {
      e.problems.push("the handshake is not a WebSocket one of version 13");
      refuseWith(400, "Bad Request"); return true;
    }
    const f = failing();
    if (f?.http && !f.socket) { refuseWith(f.http.status, "Refused"); return true; }
    // (a socket that fails with a message accepts the handshake first, as the service does: a browser sees no status of a refusal)

    const q = new URL(req.url, "http://x").searchParams, key = keyOf(req);
    let authorised = false;
    if (key !== null) authorised = keys(key);
    else if (q.has("token")) {
      const t = tokens.get(q.get("token"));
      if (t && !t.used && t.expires > now()) { t.used = true; authorised = true; }
    }
    const problem = [];
    if (authorised) {
      for (const k of q.keys()) if (!STT_PARAMS.has(k)) problem.push(`the query has ${k}, which voice does not send`);
      if (q.has("model_id") && !STT_MODELS.includes(q.get("model_id"))) problem.push(`model_id ${q.get("model_id")} is not one of ${STT_MODELS.join(", ")}`);
      if (q.has("audio_format") && q.get("audio_format") !== "pcm_16000") problem.push(`audio_format is ${q.get("audio_format")}, not pcm_16000`);
      if (q.has("commit_strategy") && !COMMIT_STRATEGIES.has(q.get("commit_strategy"))) problem.push(`commit_strategy ${q.get("commit_strategy")} is not known`);
      if (q.has("vad_silence_threshold_secs") && !(Number(q.get("vad_silence_threshold_secs")) > 0)) problem.push("vad_silence_threshold_secs is not a positive number");
      if (q.has("include_timestamps") && !["true", "false"].includes(q.get("include_timestamps"))) problem.push("include_timestamps is not true or false");
    }
    e.problems.push(...problem);

    socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${crypto.createHash("sha1").update(wsKey + GUID).digest("base64")}`, "", ""].join("\r\n"));
    e.status = 101;
    e.startedAt = now();
    const cut = { destroy() { socket.destroy(); } };
    open.add(cut);

    let closed = false, current = "", script = null, at = 0;
    const send = (msg) => {
      if (closed || socket.destroyed) return;
      e.sent.push(msg.message_type);
      socket.write(wsFrame(1, Buffer.from(JSON.stringify(msg))));
    };
    const close = (code, why = "") => {
      if (closed) return;
      closed = true;
      e.closeCode ??= code;
      const p = Buffer.alloc(2 + Buffer.byteLength(why)); p.writeUInt16BE(code, 0); p.write(why, 2);
      socket.end(wsFrame(8, p));
    };
    socket.on("close", () => { closed = true; open.delete(cut); e.finishedAt = now(); if (!e.cancelled && e.closeCode === null) e.closeCode = 1006; });
    const fail = (type) => { send({ message_type: type, error: MESSAGES[type] ?? type }); close(1008, type); };

    if (!authorised) { fail("auth_error"); return true; }
    if (f?.socket && !(f.after > 0)) { fail(f.socket); return true; }
    if (f?.socket) script = { socketFail: f.socket, after: f.after };
    const steps = pending ?? [];
    pending = null;
    send({ message_type: "session_started", session_id: "sess_" + rand(16), config: { sample_rate: 16000, audio_format: "pcm_16000", model_id: q.get("model_id") ?? STT_MODELS[0],
      language_code: q.get("language_code") ?? null, commit_strategy: q.get("commit_strategy") ?? "vad", include_timestamps: false } });

    const speak = () => {
      while (at < steps.length && steps[at].after <= e.chunks) {
        const s = steps[at++];
        if (s.partial !== undefined) { current = s.partial; send({ message_type: "partial_transcript", text: s.partial }); }
        if (s.committed !== undefined) { current = ""; send({ message_type: "committed_transcript", text: s.committed }); }
      }
      if (script && e.chunks >= script.after) { const t = script.socketFail; script = null; fail(t); }
    };
    speak();

    const message = (text) => {
      let m;
      try { m = JSON.parse(text); } catch { e.problems.push("a text frame is not JSON"); return send({ message_type: "input_error", error: "The frame is not JSON." }); }
      if (!m || m.message_type !== "input_audio_chunk") { e.problems.push(`a frame has message_type ${JSON.stringify(m?.message_type)}, not input_audio_chunk`); return send({ message_type: "input_error", error: "Unknown message_type." }); }
      const bad = [];
      if (typeof m.audio_base_64 !== "string") bad.push("audio_base_64 is missing");
      if (typeof m.commit !== "boolean") bad.push("commit is missing or not a boolean");
      if (m.sample_rate !== 16000) bad.push(`sample_rate is ${JSON.stringify(m.sample_rate)}, not 16000`);
      let pcm = Buffer.alloc(0);
      if (typeof m.audio_base_64 === "string") {
        pcm = Buffer.from(m.audio_base_64, "base64");
        if (!BASE64.test(m.audio_base_64) || m.audio_base_64.length % 4 !== 0 || pcm.toString("base64") !== m.audio_base_64) bad.push("audio_base_64 is not base64");
        else if (pcm.length % 2) bad.push("audio_base_64 holds an odd number of bytes: samples are 16 bit");
      }
      for (const k of Object.keys(m)) if (!["message_type", "audio_base_64", "commit", "sample_rate", "previous_text"].includes(k)) bad.push(`the frame has ${k}`);
      if (bad.length) { e.problems.push(...bad); return send({ message_type: "input_error", error: bad[0] }); }
      if (pcm.length) {
        const chunkMs = (pcm.length / 2 / m.sample_rate) * 1000;
        e.chunks++; e.bytes += pcm.length;
        e.chunkMsMin = e.chunkMsMin === null ? chunkMs : Math.min(e.chunkMsMin, chunkMs);
        e.chunkMsMax = e.chunkMsMax === null ? chunkMs : Math.max(e.chunkMsMax, chunkMs);
        if (!e.sampleRates.includes(m.sample_rate)) e.sampleRates.push(m.sample_rate);
      }
      if (m.commit) { e.commits++; if (current) { const t = current; current = ""; send({ message_type: "committed_transcript", text: t }); } }
      speak();
    };

    const feed = wsReader(({ opcode, payload }) => {
      if (closed) return;
      if (opcode === 1) message(payload.toString("utf8"));
      else if (opcode === 2) { e.problems.push("a binary frame"); send({ message_type: "input_error", error: "Binary frames are not taken." }); }
      else if (opcode === 9) socket.write(wsFrame(10, payload));
      else if (opcode === 8) { e.closeCode ??= payload.length >= 2 ? payload.readUInt16BE(0) : 1005; close(payload.length >= 2 ? payload.readUInt16BE(0) : 1000); }
    }, (code, why) => { e.problems.push(why); close(code, why); });
    socket.on("data", feed);
    if (head?.length) feed(head); // (what came with the handshake)
    return true;
  }

  const control = {
    script(steps) {
      if (steps === null) { pending = null; return; }
      if (!Array.isArray(steps)) throw new TypeError("script: steps are an array");
      pending = steps.map((s) => {
        if (!s || !Number.isInteger(s.after) || s.after < 0) throw new TypeError("script: a step needs after, a count of chunks");
        for (const k of ["partial", "committed"]) if (s[k] !== undefined && typeof s[k] !== "string") throw new TypeError(`script: ${k} is a string`);
        return { after: s.after, partial: s.partial, committed: s.committed };
      });
    },
    fail(what) {
      if (what === null || what === undefined) { failure = null; return; }
      if (typeof what === "string") {
        if (!NAMED[what]) throw new TypeError(`fail: ${what} is no failure (${Object.keys(NAMED).join(", ")})`);
        what = NAMED[what];
      }
      if (!(what.offline || what.http || what.socket)) throw new TypeError("fail: { http }, { socket }, { offline } or a name");
      if (what.http && !Number.isInteger(what.http.status)) throw new TypeError("fail: http needs a status");
      failure = { ...what };
    },
    pace(p = {}) {
      const next = { ...pace, ...p };
      if (!Number.isInteger(next.chunks) || next.chunks < 1 || next.chunks > 500) throw new TypeError("pace: chunks is a whole number from 1 to 500");
      if (!(next.chunkMs >= 0 && next.chunkMs <= 10000)) throw new TypeError("pace: chunkMs is 0 to 10000");
      pace = next;
    },
    log: () => JSON.parse(JSON.stringify(entries)),
    reset() {
      pending = null; failure = null; pace = { chunkMs: 100, chunks: 6 }; entries = []; tokens.clear();
      for (const o of [...open]) o.destroy();
      open.clear();
    },
  };

  /** Standalone: answers the requests and upgrades of `server` (an http.Server), with the control over HTTP at <prefix>/_control/*. */
  function routes(server) {
    server.on("request", (req, res) => {
      const rest = under(req);
      if (rest?.startsWith("/_control/")) return void controlRoute(req, res, rest.slice("/_control/".length));
      if (!handle(req, res)) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end(`This is the stand-in voice service: ${prefix}/…\n`); }
    });
    server.on("upgrade", (req, socket, head) => { if (!upgrade(req, socket, head)) socket.destroy(); });
  }

  async function controlRoute(req, res, name) {
    const ok = (v = { ok: true }) => json(res, 200, v);
    try {
      if (name === "log") return ok(control.log());
      if (req.method !== "POST") return json(res, 405, { error: "the control is POST" });
      const raw = await bodyOf(req);
      const body = raw ? JSON.parse(raw) : null;
      if (name === "script") control.script(body);
      else if (name === "fail") control.fail(body);
      else if (name === "pace") control.pace(body ?? {});
      else if (name === "reset") control.reset();
      else return json(res, 404, { error: "no such control" });
      ok();
    } catch (err) { json(res, 400, { error: String(err?.message ?? err) }); }
  }

  return { handle, upgrade, control, routes, prefix };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const a = process.argv.slice(2), o = { port: 0, prefix: "/voice" };
  for (let i = 0; i < a.length; i += 2) {
    const k = { "--port": "port", "--prefix": "prefix" }[a[i]];
    if (!k || a[i + 1] === undefined) { console.error(`voicestandin: ${a[i]} is not an option\nusage: node voicestandin.mjs --port N [--prefix /voice]`); process.exit(2); }
    o[k] = k === "port" ? Number(a[i + 1]) : a[i + 1];
  }
  const standin = createVoiceStandin({ prefix: o.prefix });
  const server = http.createServer();
  standin.routes(server);
  await new Promise((ok, no) => { server.once("error", no); server.listen(o.port, "127.0.0.1", ok); }).catch((e) => { console.error(`voicestandin: ${e.message}`); process.exit(1); });
  console.log(`Voice: http://127.0.0.1:${server.address().port}${standin.prefix}`);
  const end = () => { server.closeAllConnections?.(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500).unref(); };
  for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, end);
}
