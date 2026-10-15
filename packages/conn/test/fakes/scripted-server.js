'use strict';

// A scripted AI Whiteboard server in memory, for the tests of the shared code on fake ports and
// for the JS fake of the native module (N0): no socket, no Node module, so it runs wherever core/
// does. It is the whole of a server as a Connector sees it:
//
//   the network   what dialing it does (down, no route, a name that is not found, a local network
//                 that is denied, a handshake that never ends), what it speaks (HTTP/2, HTTP/1.1
//                 only, no TLS at all) and the certificate it presents (a fingerprint, and what the
//                 platform's roots say of it);
//   the app       hello, the state, the event stream (hello, snapshot, scripted events, pings,
//                 silence), routes the test scripts, and the ways to refuse the secret, to be too
//                 old, to hang, to cut, to end a stream, to change the certificate.
//
// `connect()` is the Connector's `open` for this one server and answers a Session (FakeSession) or
// throws what the Connector throws, by the same rules as node/connector.js: nothing is written to a
// certificate the pin refused, a selfSigned trust with no pin dials nothing. A test of a native
// module's fake wraps `connect()`, `readCertificate()` and the Session it answers.

const { Problem, NetError } = require('../../core/outcomes');
const { abortError } = require('../../core/abort');
const { encode, decodeLenient } = require('../../core/utf8');
const { normalFingerprint } = require('../../core/list');

const HELLO_PATH = '/api/hello';
const SNAPSHOT_BODY = { agents: ['claude'], catalogs: {}, home: '/home/test', defaultCwd: '/home/test', chats: [] };

// fingerprintFor is a fingerprint (upper-case hex pairs joined by ':') made from a name: the same
// name, the same fingerprint, and no two of the usual names alike.
function fingerprintFor(name) {
  let x = 2166136261;
  for (const ch of String(name)) x = Math.imul(x ^ ch.codePointAt(0), 16777619) >>> 0;
  const out = [];
  for (let i = 0; i < 32; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out.push((x >>> 24).toString(16).padStart(2, '0'));
  }
  return out.join(':').toUpperCase();
}

// instanceIdFor is a lower-case UUID v4 made from a name.
function instanceIdFor(name) {
  const h = fingerprintFor(`instance:${name}`).replace(/:/g, '').toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// delay waits ms, or rejects with an AbortError when the signal aborts first.
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError());
    let timer = null;
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    timer = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

const lower = (headers) => {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) out[k.toLowerCase()] = String(v);
  return out;
};

// Pipe is the body of a streamed answer: the server writes text, the client reads it as a
// TextStream (ports.d.ts). Chunks come in order, delivered in a later turn as a network's are; end
// comes once after the last chunk; what is written before the reader is there waits for it.
class Pipe {
  constructor(server) {
    this.server = server;
    this.queue = [];
    this.chunk = null;
    this.endCb = null;
    this.finished = false; // the server ended it
    this.cancelled = false;
    this.scheduled = false;
    this.done = null; // called once, when the end was delivered or the reader cancelled
    server.streams.add(this);
  }

  // The server's side.
  write(text) {
    if (this.finished || this.cancelled) return;
    const size = this.server.chunkSize;
    if (size > 0) for (let i = 0; i < text.length; i += size) this.queue.push({ text: text.slice(i, i + size) });
    else this.queue.push({ text });
    this.pump();
  }

  end(err) {
    if (this.finished || this.cancelled) return;
    this.finished = true;
    this.server.streams.delete(this);
    this.queue.push({ end: true, err });
    this.pump();
  }

  // The reader's side: a TextStream.
  onChunk(f) { this.chunk = f; this.pump(); }

  onEnd(f) { this.endCb = f; this.pump(); }

  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    this.queue = [];
    this.server.streams.delete(this);
    this.finish();
  }

  // abandon drops a pipe whose request was given up before its headers were read.
  abandon() {
    this.cancelled = true;
    this.queue = [];
    this.server.streams.delete(this);
  }

  finish() {
    const f = this.done;
    this.done = null;
    if (f) f();
  }

  pump() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.drain(); });
  }

  drain() {
    while (this.queue.length && !this.cancelled) {
      const item = this.queue[0];
      if (item.end) {
        if (!this.endCb) return;
        this.queue.shift();
        this.finish();
        this.endCb(item.err);
        return;
      }
      if (!this.chunk) return;
      this.queue.shift();
      this.chunk(item.text);
    }
  }
}

// Guard holds what ends one request on a session before its answer is whole: the caller's signal,
// the session going, a time limit. wait(p) is p, or the reason as soon as the guard is stopped.
class Guard {
  constructor(session, signal) {
    this.session = session;
    this.signal = signal;
    this.reason = null;
    this.fns = new Set();
    this.timers = new Set();
    this.onAbort = () => this.stop(abortError());
    session.guards.add(this);
    if (signal) signal.addEventListener('abort', this.onAbort, { once: true });
  }

  stop(err) {
    if (this.reason) return;
    this.reason = err;
    for (const f of [...this.fns]) f(err);
  }

  timer(ms, err) {
    const t = setTimeout(() => this.stop(err), ms);
    this.timers.add(t);
    return () => { clearTimeout(t); this.timers.delete(t); };
  }

  wait(p) {
    return new Promise((resolve, reject) => {
      if (this.reason) return reject(this.reason);
      const f = (err) => reject(err);
      this.fns.add(f);
      p.then((v) => { this.fns.delete(f); resolve(v); }, (e) => { this.fns.delete(f); reject(e); });
    });
  }

  dispose() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.fns.clear();
    if (this.signal) this.signal.removeEventListener('abort', this.onAbort);
    this.session.guards.delete(this);
  }
}

// FakeSession is the Session port (ports.d.ts) over a ScriptedServer, by the rules of
// node/session.js: abort is an AbortError, the headers' limit a NetError 'timeout', the whole
// request's limit the same, a body above maxBytes 'too_long', a session that ended under a request
// 'reset', a request on a session that has ended 'closed'.
class FakeSession {
  constructor(server, fingerprint) {
    this.server = server;
    this.fingerprint = fingerprint;
    this.closed = false;
    this.listeners = [];
    this.guards = new Set();
    server.sessions.add(this);
  }

  isClosed() { return this.closed; }

  onClose(f) {
    if (this.closed) f(); else this.listeners.push(f);
  }

  // end is what ends a session, from either side: the listeners are told once, and every request
  // still on it ends with 'reset'.
  end() {
    if (!this.closed) {
      this.closed = true;
      this.server.sessions.delete(this);
      for (const f of this.listeners.splice(0)) f();
    }
    for (const g of [...this.guards]) g.stop(new NetError('reset'));
  }

  close() { this.end(); }

  // head sends the request and answers the server's response, whose body may still be coming.
  async head(g, r) {
    const stopHeaders = r.headersMs ? g.timer(r.headersMs, new NetError('timeout', 'headers')) : null;
    try {
      const served = this.server.serve({ method: r.method, path: r.path, headers: lower(r.headers), body: r.body || null });
      served.then((res) => { if (g.reason && res.pipe) res.pipe.abandon(); }, () => {});
      return await g.wait(served);
    } finally {
      if (stopHeaders) stopHeaders();
    }
  }

  async fetch(r) {
    const { limitMs, maxBytes = Infinity, signal } = r;
    if (signal && signal.aborted) throw abortError();
    if (this.closed) throw new NetError('closed');
    const g = new Guard(this, signal);
    try {
      if (limitMs) g.timer(limitMs, new NetError('timeout'));
      const res = await this.head(g, r);
      if (res.pipe) { res.pipe.abandon(); throw new NetError('reset'); } // a stream is read with stream()
      if (res.hold) await g.wait(res.hold);
      if (res.bytes.length > maxBytes) throw new NetError('too_long');
      return { status: res.status, headers: res.headers, body: res.bytes };
    } finally {
      g.dispose();
    }
  }

  async stream(r) {
    const { signal } = r;
    if (signal && signal.aborted) throw abortError();
    if (this.closed) throw new NetError('closed');
    const g = new Guard(this, signal);
    let res;
    try {
      res = await this.head(g, r);
    } catch (err) {
      g.dispose();
      throw err;
    }
    const pipe = res.pipe || this.server.textPipe(decodeLenient(res.bytes));
    // From here on the guard ends the body: an abort cancels it (no end after), a session that
    // went ends it with 'reset'.
    const stop = (err) => { if (err.name === 'AbortError') pipe.cancel(); else pipe.end(err); };
    g.fns.add(stop);
    pipe.done = () => g.dispose();
    if (g.reason) stop(g.reason);
    return { status: res.status, headers: res.headers, body: pipe };
  }
}

// The fields of a server a test may script when it makes it (and at any time after).
const SCRIPT = [
  'transport', 'dialError', 'handshakeHang', 'verdict', 'hang', 'badHost', 'helloAnswer', 'eventsAnswer', 'stateAnswer',
  'helloGate', 'noSnapshot', 'beforeSnapshot', 'chunkSize', 'onStream',
];

class ScriptedServer {
  // opts: host, port, cert (a name; the fingerprint is made from it) or fingerprint, secret,
  // instanceId, version, level, snapshot, withHello, and any field of the script below.
  constructor(opts = {}) {
    this.host = opts.host || 'fake.test';
    this.port = opts.port || ScriptedServer.nextPort++;
    this.cert = opts.cert || 'a';
    this.fingerprint = opts.fingerprint || fingerprintFor(this.cert);
    this.secret = opts.secret || 'secret-one';
    this.instanceId = opts.instanceId || instanceIdFor(`${this.host}:${this.port}`);
    this.version = opts.version || '1.2.3';
    this.level = opts.level === undefined ? 6 : opts.level;
    this.snapshotBody = opts.snapshot || SNAPSHOT_BODY;
    this.withHello = opts.withHello !== false;

    // the network
    this.transport = 'h2'; // 'h2' | 'http1' (TLS, no h2: not_aiwb) | 'plain' (no TLS: not_https)
    this.dialError = null; // null | 'refused' | 'no_route' | 'name_not_found' | 'local_network_denied' | 'hang'
    this.handshakeHang = false; // the TLS handshake never ends (tls_timeout)
    this.verdict = 'self_signed'; // what the platform's roots say of the certificate: 'trusted' | 'self_signed' | 'cert_name' | 'cert_expired' | 'cert_untrusted'

    // the app
    this.requests = []; // {method, path, headers, body: Uint8Array}, in the order they arrived
    this.routes = new Map(); // "METHOD /path" (or ending in *) → (req) => answer | Promise<answer> | undefined
    this.streams = new Set(); // open event streams (Pipe)
    this.sessions = new Set(); // open sessions (FakeSession)
    this.hang = false; // accept everything and answer nothing
    this.hangPaths = new Set(); // paths that are never answered
    this.badHost = false; // 403 "bad host" on every route
    this.helloAnswer = null; // () => {status, text, type?}: replaces hello
    this.eventsAnswer = null; // () => {status, text, type?}: replaces the stream
    this.stateAnswer = null; // () => {status, text}: replaces GET /api/state
    this.helloGate = null; // a promise hello waits for
    this.noSnapshot = false; // a stream sends no snapshot
    this.beforeSnapshot = []; // events a stream sends between the hello and the snapshot
    this.chunkSize = 0; // above 0: every text written is cut into pieces of this many UTF-16 units
    this.onStream = null; // (pipe) => void, when an event stream was opened
    this.dials = 0; // dials made (a dial that was refused counts)
    this.handshakes = 0; // handshakes that reached the TLS stage
    this.streamsOpened = 0;

    // every field of the script may be given at construction
    for (const k of SCRIPT) if (opts[k] !== undefined) this[k] = opts[k];
  }

  get address() { return `https://${this.host}:${this.port}`; }

  // setCert makes the server present another certificate from now on (new connections only).
  setCert(name, verdict) {
    this.cert = name;
    this.fingerprint = fingerprintFor(name);
    if (verdict) this.verdict = verdict;
  }

  // down / up: the server stops answering the network (existing connections go too) and comes back.
  down(how = 'refused') { this.dialError = how; this.cut(); }

  up() { this.dialError = null; }

  // ---- the Connector's side ----

  // reach is the dial and the TLS handshake: it ends when they did, or throws what a Connector throws.
  async reach({ dialMs, handshakeMs, signal } = {}) {
    if (signal && signal.aborted) throw abortError();
    this.dials++;
    const at = `${this.host}:${this.port}`;
    await delay(0, signal);
    switch (this.dialError) {
      case 'refused': throw new Problem('refused', `connect ECONNREFUSED ${at}`);
      case 'no_route': throw new Problem('no_route', `connect EHOSTUNREACH ${at}`);
      case 'name_not_found': throw new Problem('name_not_found', `getaddrinfo ENOTFOUND ${this.host}`);
      case 'local_network_denied': throw new Problem('local_network_denied', 'the local network is not allowed');
      case 'hang':
        await delay(dialMs, signal);
        throw new Problem('no_route', 'the connection timed out');
      default:
    }
    this.handshakes++;
    if (this.transport === 'plain') throw new Problem('not_https', 'wrong version number');
    if (this.handshakeHang) {
      await delay(handshakeMs, signal);
      throw new Problem('tls_timeout');
    }
  }

  // connect is Connector.open for this server.
  async connect({ selfSigned, pin, dialMs, handshakeMs, signal }) {
    if (selfSigned && !pin) throw new Problem('fingerprint'); // nothing is dialed
    await this.reach({ dialMs, handshakeMs, signal });
    const presented = this.fingerprint;
    if (selfSigned) {
      const pinned = normalFingerprint(pin);
      if (pinned === null || pinned !== presented) throw new Problem('cert_changed', '', { fingerprint: presented, pinned: pinned || String(pin) });
    } else if (this.verdict !== 'trusted') {
      throw new Problem(this.verdict, this.verdict);
    }
    if (this.transport !== 'h2') throw new Problem('not_aiwb', 'the server does not speak HTTP/2');
    return new FakeSession(this, presented);
  }

  // readCertificate is Connector.readCertificate for this server: any certificate, no request.
  async readCertificate({ dialMs, handshakeMs, signal } = {}) {
    await this.reach({ dialMs, handshakeMs, signal });
    return this.fingerprint;
  }

  // ---- the app's side ----

  json(status, v, headers = {}) {
    return { status, headers: { 'content-type': 'application/json', ...headers }, bytes: encode(JSON.stringify(v)) };
  }

  helloBody() {
    return { app: 'ai-whiteboard', version: this.version, featureLevel: this.level, instanceId: this.instanceId };
  }

  snapshotEvent() { return { type: 'snapshot', ...this.snapshotBody }; }

  // answer makes a response of what a route returned: {status, json|text|bytes, type, headers, hold}.
  answer(a) {
    const headers = { 'content-type': a.type || 'application/json', ...lower(a.headers) };
    let bytes;
    if (a.bytes) bytes = a.bytes;
    else bytes = encode(a.text !== undefined ? a.text : JSON.stringify(a.json === undefined ? { ok: true } : a.json));
    return { status: a.status === undefined ? 200 : a.status, headers, bytes, hold: a.hold };
  }

  // serve is the server's answer to one request: the response's head and its body (bytes), or its
  // head and a Pipe. A promise that never settles is a server that never answers.
  async serve(req) {
    const q = req.path.indexOf('?');
    const pathname = q < 0 ? req.path : req.path.slice(0, q);
    this.requests.push({ method: req.method, path: req.path, headers: { ...req.headers, ':authority': `${this.host}:${this.port}` }, body: req.body || new Uint8Array(0) });
    await Promise.resolve();
    if (this.hang || this.hangPaths.has(pathname)) return new Promise(() => {});
    const key = `${req.method} ${pathname}`;
    if (key === `GET ${HELLO_PATH}`) {
      if (this.badHost) return this.json(403, { error: 'bad host' });
      if (this.helloGate) await this.helloGate;
      if (this.helloAnswer) {
        const a = this.helloAnswer();
        return this.answer({ status: a.status, text: a.text, type: a.type });
      }
      return this.json(200, this.helloBody());
    }
    if (this.badHost) return this.json(403, { error: 'bad host' });
    if (req.headers['x-aiwb-secret'] !== this.secret) return this.json(401, { error: 'unauthorized' });
    const level = Number(req.headers['x-aiwb-level']);
    if (!Number.isInteger(level) || level < 6) return this.json(400, { error: 'client too old', code: 'client_too_old' });
    if (key === 'GET /api/state') {
      if (this.stateAnswer) {
        const a = this.stateAnswer();
        return this.answer({ status: a.status, text: a.text });
      }
      return this.json(200, this.snapshotBody);
    }
    if (key === 'GET /api/events') return this.events();
    const route = this.routes.get(key) || [...this.routes].find(([k]) => k.endsWith('*') && key.startsWith(k.slice(0, -1)))?.[1];
    if (route) {
      const a = await route({ ...req, pathname, query: q < 0 ? '' : req.path.slice(q + 1) });
      if (a && a.pipe) return { status: a.status === undefined ? 200 : a.status, headers: { 'content-type': 'text/event-stream', ...lower(a.headers) }, pipe: a.pipe };
      return this.answer(a || {});
    }
    return this.json(404, { error: 'not found' });
  }

  events() {
    this.streamsOpened++;
    if (this.eventsAnswer) {
      const a = this.eventsAnswer();
      return this.answer({ status: a.status, text: a.text, type: a.type });
    }
    const pipe = new Pipe(this);
    if (this.withHello) pipe.write(`data: ${JSON.stringify({ type: 'hello', instanceId: this.instanceId })}\n\n`);
    for (const ev of this.beforeSnapshot) pipe.write(`data: ${JSON.stringify(ev)}\n\n`);
    if (!this.noSnapshot) pipe.write(`data: ${JSON.stringify(this.snapshotEvent())}\n\n`);
    if (this.onStream) this.onStream(pipe);
    return { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }, pipe };
  }

  // pipe makes an open body of its own, for a route to answer with: `() => ({ pipe: server.pipe() })`.
  pipe() { return new Pipe(this); }

  // textPipe is a body that holds text and ends.
  textPipe(text) {
    const p = new Pipe(this);
    p.write(text);
    p.end();
    return p;
  }

  // emit sends an event on every open stream. raw is the text of a data line to send as it is.
  emit(ev, raw) {
    this.write(`data: ${raw !== undefined ? raw : JSON.stringify(ev)}\n\n`);
  }

  // write sends text, as it is, on every open stream.
  write(text) { for (const p of [...this.streams]) p.write(text); }

  ping() { this.write(': ping\n\n'); }

  // cut drops every connection at once, as a server that died or a network that broke.
  cut() {
    for (const s of [...this.sessions]) s.end();
    for (const p of [...this.streams]) p.end(new NetError('reset'));
    this.streams.clear();
  }

  // endStreams ends the open streams the polite way and leaves the connections.
  endStreams() {
    for (const p of [...this.streams]) p.end();
  }

  async waitStreams(n = 1, ms = 10000) {
    const end = Date.now() + ms;
    while (this.streams.size < n) {
      if (Date.now() > end) throw new Error(`${n} stream(s) did not open`);
      await delay(5);
    }
  }

  async close() { this.down(); }
}

ScriptedServer.nextPort = 41000;

function scriptedServer(opts) { return new ScriptedServer(opts); }

module.exports = { ScriptedServer, scriptedServer, FakeSession, Pipe, fingerprintFor, instanceIdFor, SNAPSHOT_BODY };
