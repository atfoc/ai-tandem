'use strict';

// The two faces of a client of servers, side by side (plan H1; goal 6 "every way means the same", 7.1): the IPC face of the
// app (desktop/ipcface.js, reached through the real preload.js) and the HTTP face of the test host and the mock
// (web/dev/hostface.mjs). One fake client stands behind both. The page's own transports (packages/core/src/transport/desktop.ts over
// the preload's window.aiwbTransport, and http.ts) drive them, so the page's side is run too: the same sequence must give the same statuses, texts, scene
// revisions, envelopes in the same order and the same notices of the stream's state, and the fake client must be asked
// the same things. No Electron, no browser, no server. The handler of the app's picture scheme is
// made by lib.js (makePictureResponse), which main.js hands to Electron's protocol.handle, and is run here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { createIpcFace } = require('../ipcface');
const { makePictureResponse } = require('../lib');

const WEB = path.resolve(__dirname, '../../web');
const CORE = path.resolve(__dirname, '../../packages/core');
const pageURL = 'file:///Applications/AI%20Whiteboard.app/Contents/Resources/web/index.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, what, ms = 15000) => {
  for (const end = Date.now() + ms; ; await sleep(5)) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
  }
};

// ---- the fake client behind both faces

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const ENTRY = 's_000000000001';
const err = (status, error, code) => ({ status, text: JSON.stringify({ error, code }), sceneRev: null });
const bodyOf = (b) => (!b ? null : 'json' in b ? { json: b.json } : { type: b.type, length: b.bytes.length, head: [...b.bytes.slice(0, 6)] });

class FakeClient {
  constructor() { this.reset(); }

  reset() {
    this.subs = [];
    this.calls = [];
    this.apps = [];
    this.pictures = [];
    this.aborted = [];
  }

  // subscribe ends the earlier subscription, as the module's does, and greets the new one: the servers, then this
  // computer's state, its hello and snapshot (C3.4).
  subscribe(cb) {
    for (const s of this.subs) s.closed = true;
    const sub = { cb, closed: false, close() { sub.closed = true; } };
    this.subs.push(sub);
    setImmediate(() => {
      this.emit({ app: { type: 'servers', servers: [{ id: 'local', local: true, name: 'This computer', state: 'connecting' }, { id: ENTRY, name: 'Away', state: 'connecting' }], notice: '' } });
      this.emit({ server: 'local', event: { type: 'hello', instanceId: 'i-1' } });
      this.emit({ server: 'local', event: { type: 'snapshot', agents: ['claude'], note: 'é日本 ' } });
      this.emit({ app: { type: 'server_state', server: { id: 'local', local: true, name: 'This computer', state: 'connected' } } });
    });
    return sub;
  }

  emit(envelope) { for (const s of this.subs) if (!s.closed) s.cb(envelope); }

  async call(req) {
    const rec = { server: req.server, method: req.method, path: req.path, body: bodyOf(req.body), signalled: !!req.signal };
    this.calls.push(rec);
    const key = `${req.method} ${req.path}`;
    switch (key) {
      case 'GET /api/state': return { status: 200, text: JSON.stringify({ agents: ['claude'], note: 'é日本  "quoted"\nline' }), sceneRev: null };
      case 'POST /api/groups': return { status: 201, text: JSON.stringify({ id: 'g_1', got: rec.body }), sceneRev: null };
      case 'PUT /api/boards/b1/scene': return { status: 200, text: JSON.stringify({ ok: true, got: rec.body }), sceneRev: 7 };
      case 'GET /api/boards/b1/scene': return { status: 200, text: JSON.stringify({ elements: Array.from({ length: 4000 }, (_, i) => ({ id: `e${i}`, x: i })) }), sceneRev: 9 };
      case 'POST /api/chats/c1/images': return { status: 200, text: JSON.stringify({ id: 'e'.repeat(64), got: rec.body }), sceneRev: null };
      case 'GET /api/empty': return { status: 200, text: '', sceneRev: null };
      case 'GET /api/gone': return err(404, 'This server is not in the list.', 'no_server');
      case 'GET /api/notapi': return err(400, 'not a call of the client API', 'not_client_api');
      case 'GET /api/unreachable': return err(503, 'Away is not connected.', 'server_unreachable');
      case 'GET /api/unreadable': return err(502, 'Away gave an answer that cannot be read.', 'bad_answer');
      case 'POST /api/chats/c1/messages': return err(504, 'Away did not answer: it is not known whether the message arrived.', 'send_unknown');
      case 'POST /api/toolarge': return err(413, 'The body is too large.', 'too_large');
      case 'GET /api/stale': return { status: 409, text: JSON.stringify({ error: 'stale', code: 'stale_draft', rev: 4 }), sceneRev: 3 };
      case 'GET /api/slow':
        return new Promise((_, reject) => {
          const abort = () => { this.aborted.push(key); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
          if (req.signal.aborted) abort(); else req.signal.addEventListener('abort', abort, { once: true });
        });
      default: return { status: 200, text: JSON.stringify({ path: req.path }), sceneRev: null };
    }
  }

  async app(op, args) {
    this.apps.push([op, args === undefined ? null : args]);
    switch (op) {
      case 'servers.list': return { status: 200, body: { servers: [{ id: 'local', name: 'This computer', state: 'connected' }], notice: '' } };
      case 'servers.add': return { status: 200, body: { saved: true, server: { id: ENTRY, name: args.form.name } } };
      case 'servers.remove': return { status: 200, body: { ok: true } };
      case 'servers.accept': return { status: 404, body: { error: 'That server is not in the list.', code: 'not_found' } };
      case 'owner.status': return { status: 200, body: { running: { build: 'this', mcp: { listener: { up: true } } } } };
      case 'owner.openLog': case 'owner.reveal': return { status: 501, body: { code: 'not_here' } };
      default: return { status: 404, body: { error: 'this app does not know that operation', code: 'no_op' } };
    }
  }

  // picture answers by the image id: a, a PNG; b, a JPEG; c, gone; d, bytes the check refused.
  async picture(req) {
    this.pictures.push({ server: req.server, chat: req.chat, image: req.image });
    if (!/^(local|s_[0-9a-f]{12})$/.test(req.server) || req.server === 's_0000000000ff') return { ok: false, status: 404, text: JSON.stringify({ error: 'This server is not in the list.', code: 'no_server' }) };
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(req.chat) || !/^[0-9a-f]{64}$/.test(req.image)) return { ok: false, status: 400, text: JSON.stringify({ error: 'not a picture', code: 'image_id' }) };
    switch (req.image[0]) {
      case 'a': return { ok: true, type: 'image/png', data: new Uint8Array(PNG) };
      case 'b': return { ok: true, type: 'image/jpeg', data: new Uint8Array(JPEG) };
      case 'c': return { ok: false, status: 404, text: JSON.stringify({ error: 'gone', code: 'not_found' }) };
      default: return { ok: false, status: 502, text: JSON.stringify({ error: 'Away gave an answer that cannot be read.', code: 'bad_answer' }) };
    }
  }

  localInfo() { return { home: '/nonexistent-home', address: 'https://127.0.0.1:4748', version: 'test', pid: 1 }; }
  async close() {}
}

// ---- the IPC way: the real preload.js and the real face, joined by a fake electron that copies what it carries

function makeIpc(client) {
  const handlers = new Map(), listeners = new Map(), renderer = new Map();
  const mainFrame = { url: pageURL };
  const webContents = new EventEmitter();
  Object.assign(webContents, { id: 3, mainFrame, destroyed: false });
  webContents.isDestroyed = () => false;
  webContents.send = (channel, payload) => {
    const copy = structuredClone(payload);
    for (const fn of renderer.get(channel) || []) fn({ sender: 'main' }, copy);
  };
  const win = new EventEmitter();
  Object.assign(win, { webContents, isDestroyed: () => false });
  const ipcMain = {
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => listeners.set(ch, fn),
    removeHandler: (ch) => handlers.delete(ch),
    removeAllListeners: (ch) => listeners.delete(ch),
  };
  const face = createIpcFace({
    ipcMain, client, getWindow: () => win, pageURL, home: '/nonexistent-home',
    shell: { openPath: async () => '', showItemInFolder() {} }, dialog: {},
  });
  const event = () => ({ sender: webContents, senderFrame: mainFrame });
  const exposed = {};
  const electron = {
    contextBridge: { exposeInMainWorld: (k, api) => { exposed[k] = api; } },
    ipcRenderer: {
      invoke: async (ch, payload) => structuredClone(await handlers.get(ch)(event(), structuredClone(payload))),
      send: (ch, payload) => listeners.get(ch)(event(), structuredClone(payload)),
      on: (ch, fn) => renderer.set(ch, [...(renderer.get(ch) || []), fn]),
      removeListener: (ch, fn) => renderer.set(ch, (renderer.get(ch) || []).filter((x) => x !== fn)),
    },
  };
  const file = require.resolve('../preload.js');
  const load = Module._load;
  Module._load = function (request, ...rest) { return request === 'electron' ? electron : load.call(this, request, ...rest); };
  try { delete require.cache[file]; require(file); } finally { Module._load = load; delete require.cache[file]; }
  return { aiwbTransport: exposed.aiwbTransport, face, dispose: () => face.dispose() };
}

// ---- the HTTP way: the real face on a loopback server, and an EventSource that behaves as a browser's

let EventSourceFake;
function makeEventSource(base) {
  return class EventSource {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;

    constructor(url) {
      this.url = new URL(url, base).href;
      this.readyState = 0;
      this.onopen = this.onmessage = this.onerror = null;
      this.ctl = new AbortController();
      void this.run();
    }

    async run() {
      for (;;) {
        try {
          const res = await fetch(this.url, { headers: { accept: 'text/event-stream' }, signal: this.ctl.signal });
          if (res.status !== 200 || !/^text\/event-stream/.test(res.headers.get('content-type') || '')) {
            this.readyState = 2; // closed for good, as a browser's is by an answer that is no stream
            this.onerror?.({});
            return;
          }
          this.readyState = 1;
          this.onopen?.({});
          const dec = new TextDecoder();
          let buf = '', data = [];
          for (const reader = res.body.getReader(); ;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.search(/\r\n|\n|\r/)) >= 0) {
              const line = buf.slice(0, i);
              buf = buf.slice(i + (buf.startsWith('\r\n', i) ? 2 : 1));
              if (line === '') { if (data.length) this.onmessage?.({ data: data.join('\n') }); data = []; }
              else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
            }
          }
        } catch { if (this.ctl.signal.aborted) return; }
        if (this.readyState === 2) return;
        this.readyState = 0; // (a break: the browser opens it again by itself)
        this.onerror?.({});
        await sleep(30);
      }
    }

    close() { this.readyState = 2; this.ctl.abort(); }
  };
}

async function makeHttp(client) {
  const { createHostFace } = await import(pathToFileURL(path.join(WEB, 'dev/hostface.mjs')).href);
  const dist = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'aiwb-faces-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html>');
  const face = createHostFace({ client, distDir: dist, pingMs: 200 });
  const gate = { refuseStream: false };
  const server = http.createServer((req, res) => {
    if (gate.refuseStream && req.url === '/host/events') { res.writeHead(503, { 'content-type': 'application/json' }); return res.end('{"code":"stream_down"}'); }
    return face.handle(req, res);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { httpTransport } = await import(pathToFileURL(path.join(CORE, 'src/transport/http.ts')).href);
  return {
    base, face, gate, httpTransport,
    async close() { face.close(); server.closeAllConnections(); await new Promise((ok) => server.close(ok)); fs.rmSync(dist, { recursive: true, force: true }); },
  };
}

// The page's transports run in Node: relative addresses are the host's.
const realFetch = globalThis.fetch;
let pageBase = null;
globalThis.fetch = (u, init) => realFetch(typeof u === 'string' && u.startsWith('/') && pageBase ? pageBase + u : u, init);

// rig makes one fake client, both faces and both of the page's transports.
async function rig() {
  const client = new FakeClient();
  const ipc = makeIpc(client);
  const h = await makeHttp(client);
  pageBase = h.base;
  EventSourceFake = makeEventSource(h.base);
  globalThis.EventSource = EventSourceFake;
  const { desktopTransport } = await import(pathToFileURL(path.join(CORE, 'src/transport/desktop.ts')).href);
  const ways = { ipc: desktopTransport(ipc.aiwbTransport), http: h.httpTransport() };
  return { client, ipc, http: h, ways, async close() { ipc.dispose(); await h.close(); } };
}

// both runs fn on each way, from the same state of the fake client, and answers { ipc, http } of what it returned and
// what the client was asked.
async function both(r, fn) {
  const out = {};
  for (const way of ['ipc', 'http']) {
    r.client.reset();
    const result = await fn(r.ways[way], way);
    out[way] = { result, calls: structuredClone(r.client.calls), apps: structuredClone(r.client.apps), pictures: structuredClone(r.client.pictures) };
  }
  return out;
}
const same = (o, what) => { assert.deepEqual(o.http.result, o.ipc.result, `${what}: the results differ`); assert.deepEqual(o.http.calls, o.ipc.calls, `${what}: the client was asked different calls`); };

async function attempt(p) {
  try { return await p; } catch (e) { return { rejected: e?.name ?? String(e) }; }
}

// ---- the tests

test('a call of every kind gives the same status, text and scene revision through both faces, and asks the client the same', async () => {
  const r = await rig();
  try {
    const scene = new Blob([new Uint8Array(70000).fill(7)]);
    const calls = [
      { server: 'local', method: 'GET', path: '/api/state' },
      { server: ENTRY, method: 'POST', path: '/api/groups', body: { json: '{"name":"é日本 \\u2028 \\n"}' } },
      { server: ENTRY, method: 'PUT', path: '/api/boards/b1/scene', body: { bytes: scene, type: 'application/octet-stream' } },
      { server: 'local', method: 'GET', path: '/api/boards/b1/scene' },
      { server: 'local', method: 'POST', path: '/api/chats/c1/images', body: { bytes: new Uint8Array(PNG), type: 'image/png' } },
      { server: 'local', method: 'GET', path: '/api/empty' },
      { server: 's_0000000000ff', method: 'GET', path: '/api/gone' },
      { server: 'local', method: 'GET', path: '/api/notapi' },
      { server: ENTRY, method: 'GET', path: '/api/unreachable' },
      { server: ENTRY, method: 'GET', path: '/api/unreadable' },
      { server: ENTRY, method: 'POST', path: '/api/chats/c1/messages', body: { json: '{"text":"hi"}' } },
      { server: 'local', method: 'POST', path: '/api/toolarge', body: { json: '{}' } },
      { server: 'local', method: 'GET', path: '/api/stale' },
      { server: 'local', method: 'DELETE', path: '/api/chats/c1?x=1&y=%2F%20z' },
    ];
    const o = await both(r, async (t) => { const out = []; for (const c of calls) out.push(await t.call(c)); return out; });
    same(o, 'calls');
    const a = o.ipc.result;
    assert.deepEqual(a.map((x) => x.status), [200, 201, 200, 200, 200, 200, 404, 400, 503, 502, 504, 413, 409, 200]);
    assert.deepEqual(a.map((x) => x.sceneRev), [null, null, 7, 9, null, null, null, null, null, null, null, null, 3, null]);
    assert.equal(JSON.parse(a[0].text).note, 'é日本  "quoted"\nline');
    assert.equal(a[5].text, '');
    assert.equal(JSON.parse(a[6].text).code, 'no_server');
    assert.equal(JSON.parse(a[10].text).code, 'send_unknown');
    assert.equal(JSON.parse(a[2].text).got.length, 70000, 'a Blob arrives as its bytes');
    assert.equal(JSON.parse(a[1].text).got.json, calls[1].body.json);
    assert.equal(o.ipc.calls[13].path, '/api/chats/c1?x=1&y=%2F%20z');
  } finally { await r.close(); }
});

test('a call that is cancelled rejects with an AbortError through both faces and stops the client\'s call', async () => {
  const r = await rig();
  try {
    const o = await both(r, async (t) => {
      const ctl = new AbortController();
      const p = attempt(t.call({ server: 'local', method: 'GET', path: '/api/slow', signal: ctl.signal }));
      await until(() => r.client.calls.length === 1, 'the call to reach the client');
      ctl.abort();
      const result = await p;
      await until(() => r.client.aborted.length === 1, 'the client\'s call to be aborted');
      const before = new AbortController();
      before.abort();
      const early = await attempt(t.call({ server: 'local', method: 'GET', path: '/api/state', signal: before.signal }));
      return { result, aborted: r.client.aborted.length, early, askedAfter: r.client.calls.length };
    });
    assert.deepEqual(o.ipc.result.result, { rejected: 'AbortError' });
    assert.deepEqual(o.ipc.result.early, { rejected: 'AbortError' });
    assert.deepEqual(o.http.result, o.ipc.result);
    assert.equal(o.ipc.result.aborted, 1);
    assert.equal(o.ipc.result.askedAfter, 1, 'a call aborted before it was sent is not asked of the client');
  } finally { await r.close(); }
});

test('the app operations answer the same status and body through both faces; the two the host has no shell for differ, and say so', async () => {
  const r = await rig();
  try {
    const ops = [['servers.list'], ['servers.add', { form: { name: 'Away', secret: 'x' }, force: true }], ['servers.remove', { id: ENTRY }], ['servers.accept', { id: ENTRY, fingerprint: 'AB' }],
      ['owner.status'], ['no.such.op'], ['servers.list', undefined]];
    const o = await both(r, async (t) => {
      const out = [];
      for (const [op, args] of ops) { const a = await t.app(op, args); out.push({ status: a.status, body: JSON.parse(a.text) }); }
      return out;
    });
    // (an operation the app does not know is answered by the app's face itself; the host passes it on and the client answers the same)
    const asked = (run) => run.apps.filter(([op]) => op !== 'no.such.op');
    same({ ipc: { result: o.ipc.result, calls: asked(o.ipc) }, http: { result: o.http.result, calls: asked(o.http) } }, 'operations');
    assert.deepEqual(o.ipc.result.map((x) => x.status), [200, 200, 200, 404, 200, 404, 200]);
    assert.equal(o.ipc.result[5].body.code, 'no_op');

    // the owner's things that need the app's shell: the app does them, the host answers 501
    r.client.reset();
    const log = await r.ways.ipc.app('owner.openLog');
    assert.ok([200, 500].includes(log.status), `the app tries to open the log: ${log.text}`);
    assert.deepEqual(r.client.apps, [], 'the app\'s face does not hand owner.openLog to the client');
    const host = await r.ways.http.app('owner.openLog');
    assert.equal(host.status, 501);
    assert.equal(JSON.parse(host.text).code, 'not_here');
  } finally { await r.close(); }
});

// stream collects what a way's stream delivers: the envelopes in order and the notices of its state.
function watch(t) {
  const got = { envelopes: [], states: [] };
  const s = t.stream((e) => got.envelopes.push(e), (st) => got.states.push(st));
  return { got, close: () => s.close() };
}

test('the stream gives the same envelopes in the same order and the same notices through both faces, across a cut and a return', async () => {
  const r = await rig();
  try {
    const scripted = [];
    for (let i = 0; i < 1300; i++) scripted.push({ server: i % 3 === 0 ? ENTRY : 'local', event: { type: 'chat_item', n: i, text: i % 50 === 0 ? 'é日本 \n"' : 'x' } });
    // a cut and a return of one server: not connected, nothing of it, then its greeting again (C3.4)
    scripted.splice(400, 0,
      { app: { type: 'server_state', server: { id: ENTRY, name: 'Away', state: 'unreachable', detail: 'The server went silent' } } },
      { app: { type: 'server_state', server: { id: ENTRY, name: 'Away', state: 'connecting' } } },
      { server: ENTRY, event: { type: 'hello', instanceId: 'i-2' } }, { server: ENTRY, event: { type: 'snapshot', agents: ['claude'] } },
      { app: { type: 'server_state', server: { id: ENTRY, name: 'Away', state: 'connected' } } });
    scripted.push({ server: 'local', event: { type: 'end', n: -1 } });
    const o = await both(r, async (t) => {
      const w = watch(t);
      await until(() => w.got.states.length === 1 && w.got.envelopes.length === 4, 'the stream to open and greet');
      for (const e of scripted) r.client.emit(e);
      await until(() => w.got.envelopes.at(-1)?.event?.type === 'end', 'every envelope');
      w.close();
      return w.got;
    });
    assert.deepEqual(o.http.result.states, ['open']);
    assert.deepEqual(o.ipc.result.states, ['open']);
    assert.equal(o.ipc.result.envelopes.length, 4 + scripted.length);
    assert.deepEqual(o.ipc.result.envelopes.slice(4), scripted, 'nothing dropped, nothing reordered');
    assert.deepEqual(o.http.result.envelopes, o.ipc.result.envelopes);
    assert.deepEqual(o.http.result.states, o.ipc.result.states);
  } finally { await r.close(); }
});

test('a stream that is closed for good gives the page one notice "closed" through both faces, and opening it again greets it again', async () => {
  const r = await rig();
  try {
    const shut = { ipc: () => r.ipc.face.close(), http: () => { r.http.gate.refuseStream = true; r.http.face.drop(); } };
    const open = { ipc: () => {}, http: () => { r.http.gate.refuseStream = false; } };
    const o = await both(r, async (t, way) => {
      const first = watch(t);
      await until(() => first.got.states.length === 1 && first.got.envelopes.length === 4, 'the stream to open and greet');
      shut[way]();
      await until(() => first.got.states.at(-1) === 'closed', 'the notice that the stream is closed');
      await sleep(150);
      const quiet = first.got.states.length;
      first.close();
      open[way]();
      const second = watch(t);
      await until(() => second.got.states.length === 1 && second.got.envelopes.length === 4, 'the stream to open again and greet');
      second.close();
      return { first: first.got, quiet, second: second.got };
    });
    assert.deepEqual(o.ipc.result.first.states, ['open', 'closed']);
    assert.equal(o.ipc.result.quiet, 2, 'one notice, not a flood');
    assert.deepEqual(o.http.result, o.ipc.result);
  } finally { await r.close(); }
});

test('through the HTTP face a cut connection is the browser\'s to open again: the greeting comes again and no "closed" is told', async () => {
  const r = await rig();
  try {
    r.client.reset();
    const w = watch(r.ways.http);
    await until(() => w.got.envelopes.length === 4, 'the first greeting');
    r.http.face.drop();
    await until(() => w.got.envelopes.length === 8, 'the greeting after the cut');
    assert.deepEqual(w.got.envelopes.slice(0, 4), w.got.envelopes.slice(4));
    assert.ok(!w.got.states.includes('closed'));
    w.close();
  } finally { await r.close(); }
});

test('a picture gives the same status, type, headers and bytes through the app\'s scheme and the host\'s address; a bad one never gives bytes', async () => {
  const r = await rig();
  try {
    const respond = makePictureResponse(r.client);
    const addr = (t, server, chat, image) => t.picture(server, chat, image);
    const ask = {
      ipc: async (url) => respond({ url, method: 'GET', signal: new AbortController().signal }),
      http: async (url) => fetch(url),
    };
    const cases = [
      [ENTRY, 'c1', 'a'.repeat(64)], ['local', 'c1', 'b'.repeat(64)], ['local', 'c1', 'c'.repeat(64)], ['local', 'c1', 'd'.repeat(64)],
      ['s_0000000000ff', 'c1', 'a'.repeat(64)],
    ];
    const o = await both(r, async (t, way) => {
      const out = [];
      for (const [s, c, i] of cases) {
        const res = await ask[way](await addr(t, s, c, i));
        const buf = Buffer.from(await res.arrayBuffer());
        out.push({ status: res.status, ...(res.status === 200 ? { type: res.headers.get('content-type'), nosniff: res.headers.get('x-content-type-options'), cache: res.headers.get('cache-control'), csp: res.headers.get('content-security-policy'), bytes: buf.toString('base64') } : {}) });
      }
      return out;
    });
    same({ ipc: { result: o.ipc.result, calls: o.ipc.pictures }, http: { result: o.http.result, calls: o.http.pictures } }, 'pictures');
    assert.deepEqual(o.ipc.result.map((x) => x.status), [200, 200, 404, 502, 404]);
    assert.equal(o.ipc.result[0].type, 'image/png');
    assert.equal(o.ipc.result[0].bytes, PNG.toString('base64'));
    assert.equal(o.ipc.result[1].type, 'image/jpeg');
    assert.equal(o.ipc.result[0].nosniff, 'nosniff');
    assert.match(o.ipc.result[0].csp, /default-src 'none'/);

    // an address that names no picture: neither way gives bytes (the scheme refuses it at 400 before the module is asked, the
    // host passes it on and the module answers; the statuses are the refusals each way has)
    const bad = [['../x', 'c1', 'a'.repeat(64)], [ENTRY, 'c1', 'zz'], [ENTRY, 'c 1', 'a'.repeat(64)], [ENTRY, 'c1', 'A'.repeat(64)]];
    for (const way of ['ipc', 'http']) {
      for (const [s, c, i] of bad) {
        const res = await ask[way](await addr(r.ways[way], s, c, i));
        assert.ok(res.status >= 400 && res.status < 500, `${way}: ${s}/${c}/${i} gave ${res.status}`);
        assert.equal((await res.arrayBuffer()).byteLength === 0 || res.headers.get('content-type')?.startsWith('application/json'), true, `${way}: no bytes of an image`);
      }
    }
  } finally { await r.close(); }
});
