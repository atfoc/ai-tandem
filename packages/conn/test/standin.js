'use strict';

// A stand-in AI Whiteboard server for the tests of @aiwb/conn: node:http2 with a fixture
// certificate (no HTTP/1.1), the hello, the state, the event stream with scripted events and pings,
// scripted routes, and ways to cut, to go silent, to answer 401/403/not-JSON/slowly, to change the
// secret, to present another certificate and to hang.

const http2 = require('node:http2');
const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TLS_DIR = path.join(__dirname, 'fixtures', 'tls');
const pem = (name, ext) => fs.readFileSync(path.join(TLS_DIR, `${name}.${ext}`));

function fingerprintOf(name) {
  const der = new crypto.X509Certificate(pem(name, 'crt')).raw;
  return crypto.createHash('sha256').update(der).digest('hex').toUpperCase().match(/../g).join(':');
}

// uuid4 is a stable instance id for a test's server.
function uuid4() { return crypto.randomUUID(); }

const SNAPSHOT_BODY = { agents: ['claude'], catalogs: {}, home: '/home/test', defaultCwd: '/home/test', chats: [] };

class StandIn {
  constructor(opts = {}) {
    this.cert = opts.cert || 'a';
    this.secret = opts.secret || 'secret-one';
    this.instanceId = opts.instanceId || uuid4();
    this.version = opts.version || '1.2.3';
    this.level = opts.level === undefined ? 6 : opts.level;
    this.snapshotBody = opts.snapshot || SNAPSHOT_BODY;
    this.requests = []; // {method, path, headers, body: Buffer}
    this.routes = new Map(); // "METHOD /path" → (req, res, body) => void | {status, json|text|body, headers}
    this.streams = new Set(); // open event streams (http2 stream objects)
    this.sessions = new Set();
    this.hang = false; // accept everything and answer nothing
    this.badHost = false; // 403 "bad host" on every route
    this.helloAnswer = null; // () => {status, text, type?}: replaces hello
    this.eventsAnswer = null; // () => {status, text, type?}: replaces the stream
    this.stateAnswer = null; // () => {status, text}: replaces GET /api/state
    this.helloGate = null; // a promise hello waits for
    this.streamsOpened = 0;
    this.silent = false; // a stream sends nothing after its snapshot
    this.withHello = opts.withHello !== false;
    this.noSnapshot = false; // a stream sends no snapshot
    this.hangPaths = new Set(); // paths that are never answered
  }

  async listen() {
    this.server = http2.createSecureServer({ key: pem(this.cert, 'key'), cert: pem(this.cert, 'crt'), allowHTTP1: false, ALPNProtocols: ['h2'] });
    this.server.on('session', (s) => {
      this.sessions.add(s);
      s.on('close', () => this.sessions.delete(s));
      s.on('error', () => {});
    });
    this.server.on('secureConnection', (sock) => sock.on('error', () => {}));
    this.server.on('tlsClientError', () => {});
    this.server.on('request', (req, res) => this.handle(req, res));
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = this.server.address().port;
    this.address = `https://127.0.0.1:${this.port}`;
    return this;
  }

  get fingerprint() { return fingerprintOf(this.cert); }

  // setCert makes the server present another fixture certificate from now on.
  setCert(name) {
    this.cert = name;
    this.server.setSecureContext({ key: pem(name, 'key'), cert: pem(name, 'crt') });
  }

  json(res, status, v, headers = {}) {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(v));
  }

  helloBody() {
    const b = { app: 'ai-whiteboard', version: this.version, featureLevel: this.level, instanceId: this.instanceId };
    return b;
  }

  snapshotEvent() { return { type: 'snapshot', ...this.snapshotBody }; }

  async handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    const body = await new Promise((resolve) => { req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', () => resolve(Buffer.alloc(0))); });
    this.requests.push({ method: req.method, path: req.url, headers: { ...req.headers }, body });
    res.on('error', () => {});
    if (this.hang || this.hangPaths.has(url.pathname)) return;
    const key = `${req.method} ${url.pathname}`;
    if (key === 'GET /api/hello') {
      if (this.badHost) return this.json(res, 403, { error: 'bad host' });
      if (this.helloGate) await this.helloGate;
      if (this.helloAnswer) {
        const a = this.helloAnswer();
        res.writeHead(a.status, { 'content-type': a.type || 'application/json' });
        return res.end(a.text);
      }
      return this.json(res, 200, this.helloBody());
    }
    if (this.badHost) return this.json(res, 403, { error: 'bad host' });
    if (req.headers['x-aiwb-secret'] !== this.secret) return this.json(res, 401, { error: 'unauthorized' });
    const level = Number(req.headers['x-aiwb-level']);
    if (!Number.isInteger(level) || level < 6) return this.json(res, 400, { error: 'client too old', code: 'client_too_old' });
    if (key === 'GET /api/state') {
      if (this.stateAnswer) {
        const a = this.stateAnswer();
        res.writeHead(a.status, { 'content-type': 'application/json' });
        return res.end(a.text);
      }
      return this.json(res, 200, this.snapshotBody);
    }
    if (key === 'GET /api/events') return this.events(req, res);
    const route = this.routes.get(key) || [...this.routes].find(([k]) => k.endsWith('*') && key.startsWith(k.slice(0, -1)))?.[1];
    if (route) {
      const a = await route(req, res, body, url);
      if (a === undefined || res.writableEnded || res.headersSent) return;
      const headers = { 'content-type': a.type || 'application/json', ...(a.headers || {}) };
      res.writeHead(a.status === undefined ? 200 : a.status, headers);
      if (a.bytes) return res.end(a.bytes);
      return res.end(a.text !== undefined ? a.text : JSON.stringify(a.json === undefined ? { ok: true } : a.json));
    }
    return this.json(res, 404, { error: 'not found' });
  }

  events(req, res) {
    this.streamsOpened++;
    if (this.eventsAnswer) {
      const a = this.eventsAnswer();
      res.writeHead(a.status, { 'content-type': a.type || 'application/json' });
      return res.end(a.text);
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.on('close', () => this.streams.delete(res));
    this.streams.add(res);
    if (this.withHello) res.write(`data: ${JSON.stringify({ type: 'hello', instanceId: this.instanceId })}\n\n`);
    if (!this.noSnapshot) res.write(`data: ${JSON.stringify(this.snapshotEvent())}\n\n`);
  }

  // emit sends an event on every open stream. raw is the text of a data line to send as it is.
  emit(ev, raw) {
    for (const s of this.streams) s.write(`data: ${raw !== undefined ? raw : JSON.stringify(ev)}\n\n`);
  }

  ping() { for (const s of this.streams) s.write(': ping\n\n'); }

  // cut drops every connection at once, as a server that died or a network that broke.
  cut() {
    for (const s of this.sessions) s.destroy();
    this.streams.clear();
  }

  // endStreams ends the open streams the polite way and leaves the connections.
  endStreams() {
    for (const s of [...this.streams]) s.end();
  }

  async waitStreams(n = 1, ms = 10000) {
    const end = Date.now() + ms;
    while (this.streams.size < n) {
      if (Date.now() > end) throw new Error(`${n} stream(s) did not open`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  async close() {
    this.cut();
    await new Promise((resolve) => { this.server.close(resolve); this.server.closeAllConnections?.(); setTimeout(resolve, 200).unref(); });
  }
}

async function standin(opts) { return new StandIn(opts).listen(); }

// blackhole is a TCP server that accepts and never answers: a handshake that never comes.
async function blackhole() {
  const sockets = new Set();
  const server = net.createServer((s) => { sockets.add(s); s.on('error', () => {}); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => { for (const s of sockets) s.destroy(); server.close(); } };
}

// plainHttp is an HTTP/1.1 server without TLS: what a TLS client finds at the server's local port.
async function plainHttp() {
  const server = http.createServer((req, res) => { res.writeHead(200); res.end('hello'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => { server.closeAllConnections?.(); server.close(); } };
}

// closedPort is a port nothing listens on.
async function closedPort() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

module.exports = { standin, StandIn, blackhole, plainHttp, closedPort, fingerprintOf, pem, TLS_DIR, uuid4, SNAPSHOT_BODY };
