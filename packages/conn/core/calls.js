'use strict';

// A call of the page to a server (port of internal/remotes/calls.go): the route check, the body
// limits, the time limits, and an answer defined for every state of the server. A call never
// rejects for anything a server or this module answers: those are statuses. It rejects only with
// an AbortError when the signal aborted.

const ROUTES = require('./routes.json');
const { isNetError } = require('./outcomes');
const { abortError, isAbort } = require('./abort');
const { decode, encode } = require('./utf8');

const MiB = 1 << 20;
const MAX_BODY = 2 * MiB; // a JSON body
const MAX_SCENE = 128 * MiB; // PUT /api/boards/{id}/scene
const MAX_IMAGE = 5 * MiB; // POST /api/chats/{id}/images
const MAX_ANSWER = 160 * MiB;

// The routes a call may name: every row of routes.json but the stream.
const CALLABLE = ROUTES.filter((r) => r !== 'GET /api/events').map((raw) => {
  const [method, pattern] = raw.split(' ');
  return { raw, method, parts: pattern.split('/').slice(1) };
});

const START = new Set([
  'POST /api/chats/{id}/messages', 'POST /api/chats/{id}/fork', 'POST /api/chats/{id}/open',
  'GET /api/chats/{id}/context', 'POST /api/groups/{id}/archive',
]);
const SCENE = new Set(['GET /api/boards/{id}/scene', 'PUT /api/boards/{id}/scene']);
// The calls that stop a reading: they have their own limit, and a server that is not connected has nothing to stop.
const UNFOLLOW = new Set(['POST /api/chats/{id}/unfollow', 'POST /api/boards/{id}/unfollow']);

// matchRoute returns the row of routes.json a call names, or null. A {name} matches one non-empty
// segment that is not "." or ".."; the path begins with /api/ and has no fragment.
function matchRoute(method, pathAndQuery) {
  if (typeof method !== 'string' || typeof pathAndQuery !== 'string') return null;
  if (!/^[\x21-\x7e]+$/.test(pathAndQuery) || pathAndQuery.includes('#') || !pathAndQuery.startsWith('/api/')) return null;
  const q = pathAndQuery.indexOf('?');
  const path = q < 0 ? pathAndQuery : pathAndQuery.slice(0, q);
  const segs = path.split('/').slice(1);
  for (const s of segs) {
    if (s === '') return null;
    let d;
    try { d = decodeURIComponent(s); } catch { return null; }
    if (d === '.' || d === '..') return null;
  }
  for (const r of CALLABLE) {
    if (r.method !== method || r.parts.length !== segs.length) continue;
    if (r.parts.every((p, i) => (p.startsWith('{') ? true : p === segs[i]))) return r.raw;
  }
  return null;
}

// synth is an answer this module makes itself: always {"error", "code"}.
function synth(status, error, code) {
  return { status, text: JSON.stringify({ error, code }), sceneRev: null };
}

const noServer = () => synth(404, 'This server is not in the list.', 'no_server');
const notConnected = (conn) => synth(503,
  conn.shown.state === 'too_old' ? `${conn.name} is too old: update the server on that machine.` : `${conn.name} is not connected.`,
  'server_unreachable');
const badAnswer = (conn) => synth(502, `${conn.name} gave an answer that cannot be read.`, 'bad_answer');
const noAnswer = (conn) => synth(504, `${conn.name} did not answer.`, 'no_answer');

// queryValue is the first value of name in a query (as URLSearchParams.get, for a name and a value
// to compare with that hold no '%' or '+'), or null. A part that does not decode matches nothing.
function queryValue(query, name) {
  for (const part of query.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    try {
      const k = decodeURIComponent((eq < 0 ? part : part.slice(0, eq)).replace(/\+/g, ' '));
      if (k === name) return eq < 0 ? '' : decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' '));
    } catch { /* not this one */ }
  }
  return null;
}

// limitFor is the time a call may take, by its route.
function limitFor(tm, raw, pathAndQuery) {
  if (START.has(raw)) return tm.start;
  if (SCENE.has(raw)) return tm.scene;
  if (raw === 'POST /api/chats/{id}/images') return tm.imageCall;
  if (raw === 'DELETE /api/groups/{id}') {
    const q = pathAndQuery.indexOf('?');
    if (q >= 0 && queryValue(pathAndQuery.slice(q + 1), 'contents') === 'delete') return tm.delete;
  }
  if (raw === 'GET /api/dirs') return tm.dirs;
  if (raw === 'GET /api/usage/{agent}') return tm.usage;
  if (UNFOLLOW.has(raw)) return tm.unfollow;
  return tm.call;
}

function bodyOf(body) {
  if (body === undefined || body === null) return null;
  if (typeof body.json === 'string') return { data: encode(body.json), type: 'application/json' };
  if (body.bytes instanceof Uint8Array) {
    const type = typeof body.type === 'string' && /^[\x20-\x7e]{1,200}$/.test(body.type) ? body.type : 'application/octet-stream';
    return { data: new Uint8Array(body.bytes.buffer, body.bytes.byteOffset, body.bytes.length), type };
  }
  return undefined;
}

// call answers {status, text, sceneRev}: a server's answer as it came, or one of this module's.
async function call(mgr, req) {
  const r = req || {};
  const { server, method, path, signal } = r;
  if (signal && signal.aborted) throw abortError();

  // 1: the server.
  const conn = typeof server === 'string' ? mgr.connFor(server) : null;
  if (!conn) return noServer();

  // 2: the route.
  const raw = matchRoute(method, path);
  if (raw === null) return synth(400, 'not a call of the client API', 'not_client_api');

  // 3: the body.
  const body = bodyOf(r.body);
  if (body === undefined) return synth(400, 'not a call of the client API', 'not_client_api');
  if (body) {
    if (raw === 'POST /api/chats/{id}/images') {
      if (body.data.length > MAX_IMAGE) return synth(413, 'the image is too large', 'image_too_large');
    } else if (body.data.length > (raw === 'PUT /api/boards/{id}/scene' ? MAX_SCENE : MAX_BODY)) {
      return synth(413, 'the body is too large', 'too_large');
    }
  }

  // 4: the entry is not connected.
  const link = conn.link;
  if (conn.shown.state !== 'connected' || !link) {
    if (UNFOLLOW.has(raw)) return { status: 200, text: '{"ok":true}', sceneRev: null };
    if (raw === 'POST /api/boards/{id}/release') return { status: 200, text: '{"state":"none"}', sceneRev: null };
    conn.retryIfBackingOff();
    return notConnected(conn);
  }

  // 5: send it with the limit of its route.
  const headers = conn.identify();
  if (body) headers['content-type'] = body.type;
  let res;
  try {
    res = await link.session.fetch({
      method, path, headers, body: body ? body.data : null, limitMs: limitFor(mgr.timing, raw, path),
      maxBytes: MAX_ANSWER, signal,
    });
  } catch (err) {
    if (isAbort(err)) throw err;
    if (isNetError(err)) {
      if (err.code === 'closed') { conn.retryIfBackingOff(); return notConnected(conn); }
      if (err.code === 'too_long') return badAnswer(conn);
    }
    if (raw === 'POST /api/chats/{id}/messages') {
      return synth(504, `${conn.name} did not answer: it is not known whether the message arrived.`, 'send_unknown');
    }
    return noAnswer(conn);
  }

  // 6: the answer.
  if (res.status === 401) {
    link.refused = true;
    link.stop();
    return notConnected(conn);
  }
  let text = '';
  if (res.body.length) {
    try {
      text = decode(res.body);
      JSON.parse(text);
    } catch {
      return badAnswer(conn);
    }
  }
  const rev = res.headers['x-aiwb-scene-rev'];
  return { status: res.status, text, sceneRev: typeof rev === 'string' && /^\d+$/.test(rev) ? Number(rev) : null };
}

module.exports = { call, matchRoute, queryValue, synth, noServer, notConnected, badAnswer, noAnswer };
