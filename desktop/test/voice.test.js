const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createVoice, makePermissionHandler, serviceBase, VOICE_HTTP, VOICE_WS } = require('../voice');

// The key of these tests: a string that cannot be mistaken for anything else, so that a search for it in what goes back to
// the page, in an error or in a file means something.
const KEY = 'sk_test_RECOGNISABLE_0123456789abcdef';
const OTHER_KEY = 'sk_test_ANOTHER_KEY_fedcba9876543210';
const PAGE = 'file:///Applications/AI%20Whiteboard.app/Contents/Resources/web/index.html';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, pred, ms = 15000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

// ---- a tiny stand-in voice service: HTTP under /voice and one WebSocket route, with the handshake and the frames written by hand

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(opcode, payload) {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]);
  return Buffer.concat([head, payload]);
}

// readFrames takes the complete client frames out of a buffer: [{ opcode, payload }], and what is left.
function readFrames(buf) {
  const out = [];
  for (;;) {
    if (buf.length < 2) break;
    let len = buf[1] & 127;
    let at = 2;
    if (len === 126) {
      if (buf.length < 4) break;
      len = buf.readUInt16BE(2);
      at = 4;
    }
    const masked = (buf[1] & 128) !== 0;
    const total = at + (masked ? 4 : 0) + len;
    if (buf.length < total) break;
    const mask = masked ? buf.subarray(at, at + 4) : null;
    const data = Buffer.from(buf.subarray(at + (masked ? 4 : 0), total));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    out.push({ opcode: buf[0] & 15, payload: data });
    buf = buf.subarray(total);
  }
  return { frames: out, rest: buf };
}

async function startRig() {
  const rig = { requests: [], sockets: [], held: [], previewFetches: [] };
  const voices = (origin) => ({
    voices: [
      { voice_id: 'vs_alice', name: 'Alice', preview_url: `${origin}/voice/_preview/alice.wav` },
      { voice_id: 'vs_bob', name: 'Bob', preview_url: `${origin}/voice/_preview/big.wav` },
      { voice_id: 'vs_none', name: 'None' },
    ],
    has_more: false,
    total_count: 3,
  });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const entry = { method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), key: req.headers['xi-api-key'], type: req.headers['content-type'], body: Buffer.concat(chunks).toString('utf8'), closedEarly: false };
      if (u.pathname.startsWith('/voice/_preview/')) {
        rig.previewFetches.push(entry);
        if (u.pathname.endsWith('big.wav')) {
          res.writeHead(200, { 'content-type': 'audio/wav' });
          res.end(Buffer.alloc(2 * 1024 * 1024 + 10, 1));
        } else {
          res.writeHead(200, { 'content-type': 'audio/wav' });
          res.end(Buffer.from('RIFF-clip'));
        }
        return;
      }
      rig.requests.push(entry);
      if (!entry.key || !entry.key.startsWith('sk_test_')) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ detail: { code: 'invalid_api_key', status: 'invalid_api_key', message: 'no' } }));
        return;
      }
      if (u.pathname === '/voice/v2/voices') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(voices(`http://127.0.0.1:${server.address().port}`)));
        return;
      }
      const m = /^\/voice\/v1\/text-to-speech\/([A-Za-z0-9]+)\/stream$/.exec(u.pathname);
      if (m) {
        res.writeHead(200, { 'content-type': 'audio/pcm' });
        res.write(Buffer.alloc(3001, 1));
        if (m[1] === 'hold') {
          rig.held.push(entry);
          res.on('close', () => { entry.closedEarly = !res.writableEnded; });
          return;
        }
        res.write(Buffer.alloc(3000, 2));
        res.end(Buffer.alloc(7, 3));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  server.on('upgrade', (req, socket) => {
    const u = new URL(req.url, 'http://x');
    const entry = { path: u.pathname, query: Object.fromEntries(u.searchParams), key: req.headers['xi-api-key'], received: [], closed: false, closeCode: null, socket };
    rig.sockets.push(entry);
    if (u.pathname !== '/voice/v1/speech-to-text/realtime' || !entry.key || !entry.key.startsWith('sk_test_')) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    entry.send = (text) => socket.write(frame(1, Buffer.from(text)));
    entry.close = (code) => socket.write(frame(8, Buffer.from([code >> 8, code & 255])));
    entry.send(JSON.stringify({ message_type: 'session_started' }));
    let buf = Buffer.alloc(0);
    socket.on('data', (d) => {
      const r = readFrames(Buffer.concat([buf, d]));
      buf = r.rest;
      for (const f of r.frames) {
        if (f.opcode === 1) entry.received.push(f.payload.toString('utf8'));
        if (f.opcode === 8) {
          entry.closeCode = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
          socket.write(frame(8, f.payload.subarray(0, 2)));
          socket.end();
        }
      }
    });
    socket.on('close', () => { entry.closed = true; });
    socket.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  rig.port = server.address().port;
  rig.origin = `http://127.0.0.1:${rig.port}`;
  rig.base = `${rig.origin}/voice`;
  rig.close = () => new Promise((r) => { for (const s of rig.sockets) s.socket.destroy(); server.closeAllConnections(); server.close(r); });
  return rig;
}

// ---- the voice face on a temporary data folder

function makeVoice(over = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwb-voice-'));
  const events = [];
  const calls = { opened: [], asked: [], statusOf: 'granted' };
  const app = { isPackaged: false };
  const systemPreferences = {
    getMediaAccessStatus: (kind) => { calls.asked.push(`status ${kind}`); return calls.statusOf; },
    askForMediaAccess: async (kind) => { calls.asked.push(`ask ${kind}`); return calls.grant !== false; },
  };
  const shell = { openExternal: async (url) => { calls.opened.push(url); } };
  const voice = createVoice({ app, systemPreferences, shell, userData, emit: (e) => events.push(e), platform: 'darwin', env: {}, ...over });
  return { voice, userData, events, calls, keyFile: path.join(userData, 'client', 'voice-key'), cleanup: () => fs.rmSync(userData, { recursive: true, force: true }) };
}

async function withRig(fn, over = {}) {
  const rig = await startRig();
  const v = makeVoice({ env: { AIWB_VOICE_BASE: rig.base }, ...over });
  try {
    await fn(rig, v);
  } finally {
    v.voice.closeAll();
    v.cleanup();
    await rig.close();
  }
}

const ended = (events, id) => events.some((e) => e.id === id && (e.kind === 'end' || e.kind === 'error'));
const bytesOf = (events, id) => Buffer.concat(events.filter((e) => e.id === id && e.kind === 'data').map((e) => Buffer.from(e.bytes)));

// ---- the key file

test('the key is a file of mode 0600 in a folder of 0700, written whole, and has/clear follow it', async () => {
  const v = makeVoice();
  try {
    assert.equal(await v.voice.handle('key.has'), false);
    await v.voice.handle('key.set', { key: `  ${KEY}\n` });
    assert.equal(fs.readFileSync(v.keyFile, 'utf8'), `${KEY}\n`);
    assert.equal(fs.statSync(v.keyFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(v.keyFile)).mode & 0o777, 0o700);
    assert.deepEqual(fs.readdirSync(path.dirname(v.keyFile)), ['voice-key'], 'no temporary file is left');
    assert.equal(await v.voice.handle('key.has'), true);

    await v.voice.handle('key.set', { key: OTHER_KEY });
    assert.equal(fs.readFileSync(v.keyFile, 'utf8'), `${OTHER_KEY}\n`, 'a new key replaces the old');
    assert.equal(fs.statSync(v.keyFile).mode & 0o777, 0o600);

    await v.voice.handle('key.clear');
    assert.equal(fs.existsSync(v.keyFile), false);
    assert.equal(await v.voice.handle('key.has'), false);
    await v.voice.handle('key.clear'); // clearing nothing is fine
  } finally {
    v.cleanup();
  }
});

test('the key is written atomically: the old key stays whole when the write fails', async () => {
  const written = [];
  const v = makeVoice({
    files: {
      ensureStateDir: require('@aiwb/conn/node').ensureStateDir,
      writeFileAtomic: (file, data, mode) => { written.push([file, data, mode]); if (written.length === 2) throw new Error(`disk full ${KEY}`); require('@aiwb/conn/node').writeFileAtomic(file, data, mode); },
    },
  });
  try {
    await v.voice.handle('key.set', { key: KEY });
    await assert.rejects(v.voice.handle('key.set', { key: OTHER_KEY }), (e) => e.message === 'voice_failed');
    assert.equal(fs.readFileSync(v.keyFile, 'utf8'), `${KEY}\n`);
    assert.deepEqual(written.map(([, , mode]) => mode), [0o600, 0o600]);
  } finally {
    v.cleanup();
  }
});

test('a key a header cannot carry is refused and nothing is written', async () => {
  const v = makeVoice();
  try {
    for (const key of ['', '   ', 'has space', 'new\nline', 'tab\tkey', 'x'.repeat(513), 'ünï', 42, null, undefined]) {
      await assert.rejects(v.voice.handle('key.set', { key }), (e) => e.message === 'voice_refused', JSON.stringify(key));
    }
    await assert.rejects(v.voice.handle('key.set'), (e) => e.message === 'voice_refused');
    assert.equal(fs.existsSync(v.keyFile), false);
  } finally {
    v.cleanup();
  }
});

test('an operation the face does not have is refused', async () => {
  const v = makeVoice();
  try {
    for (const op of ['key.get', 'constructor', '__proto__', 'toString', 'hasOwnProperty', '', 7, undefined]) {
      await assert.rejects(v.voice.handle(op, {}), (e) => e.message === 'voice_refused', String(op));
    }
  } finally {
    v.cleanup();
  }
});

// ---- requests

test('a request carries the key in a header, and the answer comes back as a status and events without the key', async () => {
  await withRig(async (rig, v) => {
    await v.voice.handle('key.set', { key: KEY });
    const sent = await v.voice.handle('request', { id: 1, method: 'GET', path: '/v2/voices', query: { page_size: '1', include_total_count: 'true' } });
    assert.deepEqual(sent, { status: 200 });
    await until('the end', () => ended(v.events, 1));
    assert.equal(rig.requests.length, 1);
    assert.equal(rig.requests[0].key, KEY);
    assert.deepEqual(rig.requests[0].query, { page_size: '1', include_total_count: 'true' });
    assert.equal(JSON.parse(bytesOf(v.events, 1)).total_count, 3);
    assert.deepEqual(v.events.at(-1), { id: 1, kind: 'end' });
    assert.ok(!JSON.stringify([sent, ...v.events.map((e) => ({ ...e, bytes: undefined }))]).includes(KEY));
    assert.ok(!bytesOf(v.events, 1).toString('utf8').includes(KEY));
  });
});

test('a speech request posts the sentence as JSON, and the audio comes back as data events in order', async () => {
  await withRig(async (rig, v) => {
    await v.voice.handle('key.set', { key: KEY });
    const sent = await v.voice.handle('request', {
      id: 7, method: 'POST', path: '/v1/text-to-speech/vsalice/stream', query: { output_format: 'pcm_24000' },
      json: { text: 'Hello there.', model_id: 'eleven_flash_v2_5' },
    });
    assert.deepEqual(sent, { status: 200 });
    await until('the end', () => ended(v.events, 7));
    const r = rig.requests[0];
    assert.equal(r.method, 'POST');
    assert.equal(r.type, 'application/json');
    assert.equal(r.key, KEY);
    assert.deepEqual(JSON.parse(r.body), { text: 'Hello there.', model_id: 'eleven_flash_v2_5' });
    assert.deepEqual(r.query, { output_format: 'pcm_24000' });
    const audio = bytesOf(v.events, 7);
    assert.equal(audio.length, 3001 + 3000 + 7);
    assert.equal(audio[0], 1);
    assert.equal(audio[3001], 2);
    assert.equal(audio[audio.length - 1], 3);
    for (const e of v.events.filter((x) => x.kind === 'data')) assert.ok(e.bytes instanceof Uint8Array);
  });
});

test('a key given with the request is used for that call and not stored', async () => {
  await withRig(async (rig, v) => {
    const sent = await v.voice.handle('request', { id: 1, method: 'GET', path: '/v2/voices', query: { page_size: '1' }, key: OTHER_KEY });
    assert.equal(sent.status, 200);
    await until('the end', () => ended(v.events, 1));
    assert.equal(rig.requests[0].key, OTHER_KEY);
    assert.equal(fs.existsSync(v.keyFile), false);
    assert.equal(await v.voice.handle('key.has'), false);
    // A key that is stored is not used when another is given, and is used again after.
    await v.voice.handle('key.set', { key: KEY });
    await v.voice.handle('request', { id: 2, method: 'GET', path: '/v2/voices', key: OTHER_KEY });
    await until('the end', () => ended(v.events, 2));
    await v.voice.handle('request', { id: 3, method: 'GET', path: '/v2/voices' });
    await until('the end', () => ended(v.events, 3));
    assert.deepEqual(rig.requests.map((r) => r.key), [OTHER_KEY, OTHER_KEY, KEY]);
  });
});

test('the key file is read at each call: a key changed between two calls is the one used', async () => {
  await withRig(async (rig, v) => {
    await v.voice.handle('key.set', { key: KEY });
    await v.voice.handle('request', { id: 1, method: 'GET', path: '/v2/voices' });
    await until('the end', () => ended(v.events, 1));
    fs.writeFileSync(v.keyFile, `${OTHER_KEY}\n`);
    await v.voice.handle('request', { id: 2, method: 'GET', path: '/v2/voices' });
    await until('the end', () => ended(v.events, 2));
    fs.rmSync(v.keyFile);
    await assert.rejects(v.voice.handle('request', { id: 3, method: 'GET', path: '/v2/voices' }), (e) => e.message === 'voice_no_key');
    assert.deepEqual(rig.requests.map((r) => r.key), [KEY, OTHER_KEY]);
  });
});

test('with no key nothing is sent', async () => {
  await withRig(async (rig, v) => {
    await assert.rejects(v.voice.handle('request', { id: 1, method: 'GET', path: '/v2/voices' }), (e) => e.message === 'voice_no_key');
    await assert.rejects(v.voice.handle('socket.open', { id: 2, path: '/v1/speech-to-text/realtime', query: {} }), (e) => e.message === 'voice_no_key');
    assert.deepEqual([rig.requests.length, rig.sockets.length, v.events.length], [0, 0, 0]);
  });
});

test('a rejected key is an answer like any other: its status and body come back, the key does not', async () => {
  await withRig(async (rig, v) => {
    const sent = await v.voice.handle('request', { id: 1, method: 'GET', path: '/v2/voices', key: 'not_a_test_key' });
    assert.deepEqual(sent, { status: 401 });
    await until('the end', () => ended(v.events, 1));
    assert.equal(JSON.parse(bytesOf(v.events, 1)).detail.code, 'invalid_api_key');
    assert.ok(!JSON.stringify(v.events).includes('not_a_test_key'));
  });
});

test('only the calls of the table are made: other paths, methods, query keys and bodies are refused, and nothing reaches the service', async () => {
  await withRig(async (rig, v) => {
    await v.voice.handle('key.set', { key: KEY });
    const tts = '/v1/text-to-speech/vsalice/stream';
    const bad = [
      { method: 'GET', path: '/v1/user' },
      { method: 'POST', path: '/v2/voices', json: {} },
      { method: 'DELETE', path: '/v2/voices' },
      { method: 'GET', path: '/v1/text-to-speech/vsalice/stream' },
      { method: 'POST', path: '/v1/single-use-token/realtime_scribe', json: {} },
      { method: 'POST', path: '/v1/text-to-speech/../../v1/user/stream', json: {} },
      { method: 'POST', path: '/v1/text-to-speech/vs_alice/stream', json: {} },
      { method: 'POST', path: '/v1/text-to-speech//stream', json: {} },
      { method: 'POST', path: `/v1/text-to-speech/${'a'.repeat(65)}/stream`, json: {} },
      { method: 'POST', path: `${tts}?x=1`, json: {} },
      { method: 'POST', path: `${tts}/`, json: {} },
      { method: 'POST', path: `${tts}#x`, json: {} },
      { method: 'POST', path: tts },
      { method: 'POST', path: tts, json: null },
      { method: 'POST', path: tts, json: 'text' },
      { method: 'POST', path: tts, json: { text: 'x'.repeat(17000) } },
      { method: 'POST', path: tts, json: {}, query: { output_format: 'pcm_24000', xi_api_key: 'x' } },
      { method: 'POST', path: tts, json: {}, query: { token: 'sutkn_1' } },
      { method: 'POST', path: tts, json: {}, query: { output_format: ['a'] } },
      { method: 'POST', path: tts, json: {}, query: { output_format: 5 } },
      { method: 'POST', path: tts, json: {}, query: ['output_format'] },
      { method: 'GET', path: '/v2/voices', json: {} },
      { method: 'GET', path: '/v2/voices', query: { voice_id: 'x' } },
      { method: 'GET', path: '/v2/voices', query: { search: 'x'.repeat(513) } },
      { method: 'GET', path: '/v2/voices/' },
      { method: 'GET', path: 'https://evil.example/v2/voices' },
      { method: 'GET', path: '//evil.example/v2/voices' },
      { method: 'GET', path: '/v2/voices', key: 'bad key' },
    ];
    for (const [i, req] of bad.entries()) {
      await assert.rejects(v.voice.handle('request', { id: i + 1, ...req }), (e) => e.message === 'voice_refused', JSON.stringify(req).slice(0, 120));
    }
    for (const id of [0, -1, 1.5, '1', null, undefined, 2 ** 31]) {
      await assert.rejects(v.voice.handle('request', { id, method: 'GET', path: '/v2/voices' }), (e) => e.message === 'voice_refused', String(id));
    }
    await assert.rejects(v.voice.handle('request', null), (e) => e.message === 'voice_refused');
    assert.deepEqual([rig.requests.length, v.events.length], [0, 0]);
    // The query keys the table names go through.
    await v.voice.handle('request', { id: 100, method: 'GET', path: '/v2/voices', query: { page_size: '5', next_page_token: 'abc', search: 'bright voice', sort: 'name', sort_direction: 'asc', include_total_count: 'true' } });
    await until('the end', () => ended(v.events, 100));
    assert.deepEqual(rig.requests[0].query, { page_size: '5', next_page_token: 'abc', search: 'bright voice', sort: 'name', sort_direction: 'asc', include_total_count: 'true' });
  });
});

test('an id in use is refused, and is free again once the request has ended', async () => {
  await withRig(async (rig, v) => {
    await v.voice.handle('key.set', { key: KEY });
    const hold = { method: 'POST', path: '/v1/text-to-speech/hold/stream', json: { text: 'x' } };
    await v.voice.handle('request', { id: 1, ...hold });
    await assert.rejects(v.voice.handle('request', { id: 1, ...hold }), (e) => e.message === 'voice_refused');
    await assert.rejects(v.voice.handle('socket.open', { id: 1, path: '/v1/speech-to-text/realtime', query: {} }), (e) => e.message === 'voice_refused');
    v.voice.cancel(1);
    await v.voice.handle('request', { id: 1, method: 'GET', path: '/v2/voices' });
    await until('the end', () => ended(v.events, 1));
  });
});

test('a cancelled request aborts: the service sees the connection close, and the page gets no end', async () => {
  await withRig(async (rig, v) => {
    await v.voice.handle('key.set', { key: KEY });
    const sent = await v.voice.handle('request', { id: 5, method: 'POST', path: '/v1/text-to-speech/hold/stream', json: { text: 'a long sentence' } });
    assert.deepEqual(sent, { status: 200 });
    await until('the first chunk', () => v.events.some((e) => e.id === 5 && e.kind === 'data'));
    v.voice.cancel(5);
    await until('the service to see the close', () => rig.held[0].closedEarly);
    const seen = v.events.length;
    await sleep(100);
    assert.equal(v.events.length, seen, 'nothing follows a cancel');
    assert.ok(!ended(v.events, 5));
    v.voice.cancel(5); // a second cancel, and one for an id nobody has, do nothing
    v.voice.cancel(999);
  });
});

test('a request cancelled before the answer rejects as cancelled', async () => {
  const gate = {};
  const fetchImpl = (url, { signal }) => new Promise((resolve, reject) => {
    gate.started = true;
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
  const v = makeVoice({ fetchImpl });
  try {
    await v.voice.handle('key.set', { key: KEY });
    const p = v.voice.handle('request', { id: 1, method: 'GET', path: '/v2/voices' });
    await until('the fetch', () => gate.started);
    v.voice.cancel(1);
    await assert.rejects(p, (e) => e.message === 'voice_cancelled');
    assert.deepEqual(v.events, []);
  } finally {
    v.cleanup();
  }
});

test('a service that cannot be reached rejects with a word, not with the network library\'s text', async () => {
  const closed = await startRig();
  const base = closed.base;
  await closed.close();
  const v = makeVoice({ env: { AIWB_VOICE_BASE: base } });
  try {
    await v.voice.handle('key.set', { key: KEY });
    await assert.rejects(v.voice.handle('request', { id: 1, method: 'GET', path: '/v2/voices' }), (e) => {
      assert.equal(e.message, 'voice_unreachable');
      assert.ok(!/127\.0\.0\.1|ECONNREFUSED|fetch/.test(`${e.message} ${e.stack ?? ''}`.split('\n')[0]));
      return true;
    });
    await assert.rejects(v.voice.handle('socket.open', { id: 2, path: '/v1/speech-to-text/realtime', query: {} }), (e) => e.message === 'voice_unreachable');
    assert.deepEqual(v.events, []);
  } finally {
    v.cleanup();
  }
});

test('an answer cut off in the middle ends in an error event with no text', async () => {
  const body = new ReadableStream({
    start(c) { c.enqueue(new Uint8Array([1, 2, 3])); },
    pull() { throw new Error(`reset while talking to https://api.elevenlabs.io with ${KEY}`); },
  });
  const v = makeVoice({ fetchImpl: async () => new Response(body, { status: 200 }) });
  try {
    await v.voice.handle('key.set', { key: KEY });
    await v.voice.handle('request', { id: 1, method: 'GET', path: '/v2/voices' });
    await until('the error', () => ended(v.events, 1));
    assert.deepEqual(v.events.at(-1), { id: 1, kind: 'error' });
    assert.ok(!JSON.stringify(v.events).includes(KEY));
  } finally {
    v.cleanup();
  }
});

test('a redirect is not followed: the key goes to the one address only', async () => {
  const seen = [];
  const v = makeVoice({ fetchImpl: async (url, o) => { seen.push(o.redirect); throw new TypeError('fetch failed'); } });
  try {
    await v.voice.handle('key.set', { key: KEY });
    await assert.rejects(v.voice.handle('request', { id: 1, method: 'GET', path: '/v2/voices' }), (e) => e.message === 'voice_unreachable');
    assert.deepEqual(seen, ['error']);
  } finally {
    v.cleanup();
  }
});

// ---- where the service is

test('the service is ElevenLabs unless the app is not packaged and AIWB_VOICE_BASE names this computer', () => {
  const own = { http: VOICE_HTTP, ws: VOICE_WS, dev: false, origin: null };
  const base = (value, isPackaged = false) => serviceBase({ env: value === undefined ? {} : { AIWB_VOICE_BASE: value }, isPackaged });
  assert.deepEqual(base(undefined), own);
  assert.deepEqual(base(''), own);
  assert.deepEqual(base('http://127.0.0.1:5000/voice', true), own, 'a packaged app ignores it');
  for (const v of ['http://example.com/voice', 'https://api.elevenlabs.io.evil.test', 'http://192.168.1.5:5000/voice', 'http://10.0.2.2:5000', 'http://127.0.0.1.evil.test/', 'http://evil.test/@127.0.0.1', 'http://user:pw@127.0.0.1:5000/voice', 'http://127.0.0.1:5000/voice?x=1', 'ftp://127.0.0.1/voice', 'not a url', 'file:///etc']) {
    assert.deepEqual(base(v), own, v);
  }
  assert.deepEqual(base('http://127.0.0.1:5000/voice'), { http: 'http://127.0.0.1:5000/voice', ws: 'ws://127.0.0.1:5000/voice', dev: true, origin: 'http://127.0.0.1:5000' });
  assert.deepEqual(base('http://localhost:5000/voice/'), { http: 'http://localhost:5000/voice', ws: 'ws://localhost:5000/voice', dev: true, origin: 'http://localhost:5000' });
  assert.deepEqual(base('https://[::1]:5000'), { http: 'https://[::1]:5000', ws: 'wss://[::1]:5000', dev: true, origin: 'https://[::1]:5000' });
});

test('the addresses a request and a socket are made to follow the base', async () => {
  const urls = [];
  const fakeFetch = async (url) => { urls.push(url); return new Response('{}', { status: 200 }); };
  class FakeSocket {
    constructor(url, opts) { urls.push(url); this.opts = opts; this.readyState = 0; }
    addEventListener() {}
  }
  for (const [env, isPackaged, http, ws] of [
    [{}, false, 'https://api.elevenlabs.io', 'wss://api.elevenlabs.io'],
    [{ AIWB_VOICE_BASE: 'http://127.0.0.1:5000/voice' }, true, 'https://api.elevenlabs.io', 'wss://api.elevenlabs.io'],
    [{ AIWB_VOICE_BASE: 'http://example.com/voice' }, false, 'https://api.elevenlabs.io', 'wss://api.elevenlabs.io'],
    [{ AIWB_VOICE_BASE: 'http://127.0.0.1:5000/voice' }, false, 'http://127.0.0.1:5000/voice', 'ws://127.0.0.1:5000/voice'],
  ]) {
    urls.length = 0;
    const v = makeVoice({ env, app: { isPackaged }, fetchImpl: fakeFetch, WebSocketImpl: FakeSocket });
    try {
      await v.voice.handle('key.set', { key: KEY });
      await v.voice.handle('request', { id: 1, method: 'GET', path: '/v2/voices', query: { page_size: '1' } });
      void v.voice.handle('socket.open', { id: 2, path: '/v1/speech-to-text/realtime', query: { model_id: 'scribe_v2_realtime', language_code: 'sr' } });
      assert.deepEqual(urls, [`${http}/v2/voices?page_size=1`, `${ws}/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&language_code=sr`], JSON.stringify(env));
    } finally {
      v.cleanup();
    }
  }
});

// ---- the preview clips

test('a preview is fetched with no key, only for an address seen in a voices answer, and at most 2 MB', async () => {
  await withRig(async (rig, v) => {
    await v.voice.handle('key.set', { key: KEY });
    const alice = `${rig.base}/_preview/alice.wav`;
    const big = `${rig.base}/_preview/big.wav`;
    // Nothing is known yet.
    await assert.rejects(v.voice.handle('preview', { url: alice }), (e) => e.message === 'voice_refused');

    await v.voice.handle('request', { id: 1, method: 'GET', path: '/v2/voices' });
    await until('the end', () => ended(v.events, 1));

    const clip = await v.voice.handle('preview', { url: alice });
    assert.ok(clip instanceof Uint8Array);
    assert.equal(Buffer.from(clip).toString(), 'RIFF-clip');
    assert.equal(rig.previewFetches.length, 1);
    assert.equal(rig.previewFetches[0].key, undefined, 'the key does not go to a preview host');

    await assert.rejects(v.voice.handle('preview', { url: big }), (e) => e.message === 'voice_unreachable');

    // An address not in an answer is refused, however close it is to one that is.
    for (const url of [`${rig.base}/_preview/other.wav`, `${alice}?x=1`, `${alice}#x`, `${rig.origin}/v2/voices`, 'https://example.com/clip.mp3', 'file:///etc/passwd', 'x', 42, null, undefined]) {
      await assert.rejects(v.voice.handle('preview', { url }), (e) => e.message === 'voice_refused', String(url));
    }
    await assert.rejects(v.voice.handle('preview'), (e) => e.message === 'voice_refused');
    assert.equal(rig.previewFetches.length, 2, 'the refused ones never left');
  });
});

test('only https clips are learnt, and a plain-http one only from the stand-in\'s own origin', async () => {
  const answer = (urls) => new Response(JSON.stringify({ voices: urls.map((u, i) => ({ voice_id: `v${i}`, preview_url: u })) }), { status: 200 });
  const fetched = [];
  const body = [];
  const fetchImpl = async (url) => {
    if (url.includes('/v2/voices')) return answer(body);
    fetched.push(url);
    return new Response('clip', { status: 200 });
  };
  const urls = ['https://storage.example/a.mp3', 'http://storage.example/b.mp3', 'http://127.0.0.1:5000/voice/_preview/c.wav', 'http://127.0.0.1:6000/voice/_preview/d.wav', 'javascript:alert(1)', 'not a url'];
  for (const [env, learnt] of [
    [{}, ['https://storage.example/a.mp3']],
    [{ AIWB_VOICE_BASE: 'http://127.0.0.1:5000/voice' }, ['https://storage.example/a.mp3', 'http://127.0.0.1:5000/voice/_preview/c.wav']],
  ]) {
    body.splice(0, body.length, ...urls);
    const v = makeVoice({ env, fetchImpl });
    try {
      await v.voice.handle('key.set', { key: KEY });
      await v.voice.handle('request', { id: 1, method: 'GET', path: '/v2/voices' });
      await until('the end', () => ended(v.events, 1));
      for (const u of urls) {
        const ok = learnt.includes(u);
        await (ok ? v.voice.handle('preview', { url: u }) : assert.rejects(v.voice.handle('preview', { url: u }), (e) => e.message === 'voice_refused', u));
      }
    } finally {
      v.cleanup();
    }
  }
  assert.deepEqual(fetched, ['https://storage.example/a.mp3', 'https://storage.example/a.mp3', 'http://127.0.0.1:5000/voice/_preview/c.wav']);
});

test('an answer that is not a voices list, or a failing one, teaches no preview address', async () => {
  const fetchImpl = async (url) => (url.includes('/v2/voices')
    ? new Response(JSON.stringify({ voices: [{ preview_url: 'https://storage.example/a.mp3' }] }), { status: 401 })
    : new Response('clip', { status: 200 }));
  const v = makeVoice({ fetchImpl });
  try {
    await v.voice.handle('key.set', { key: KEY });
    await v.voice.handle('request', { id: 1, method: 'GET', path: '/v2/voices' });
    await until('the end', () => ended(v.events, 1));
    await assert.rejects(v.voice.handle('preview', { url: 'https://storage.example/a.mp3' }), (e) => e.message === 'voice_refused');
  } finally {
    v.cleanup();
  }
});

// ---- sockets

const STT = { id: 9, path: '/v1/speech-to-text/realtime', query: { model_id: 'scribe_v2_realtime', audio_format: 'pcm_16000', commit_strategy: 'vad', vad_silence_threshold_secs: '1.2', include_timestamps: 'false' } };

test('a socket opens with the key in a header, relays frames both ways and closes', async () => {
  await withRig(async (rig, v) => {
    await v.voice.handle('key.set', { key: KEY });
    await v.voice.handle('socket.open', STT);
    assert.equal(rig.sockets[0].key, KEY);
    assert.deepEqual(rig.sockets[0].query, STT.query);
    assert.deepEqual(v.events[0], { id: 9, kind: 'open' });
    await until('session_started', () => v.events.some((e) => e.kind === 'message'));
    assert.deepEqual(v.events.at(-1), { id: 9, kind: 'message', text: '{"message_type":"session_started"}' });

    const chunk = JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: 'AAAA'.repeat(1067), commit: false, sample_rate: 16000 });
    v.voice.socketSend(9, chunk);
    v.voice.socketSend(9, '{"commit":true}');
    await until('the frames', () => rig.sockets[0].received.length === 2);
    assert.deepEqual(rig.sockets[0].received, [chunk, '{"commit":true}']);

    rig.sockets[0].send('{"message_type":"partial_transcript","text":"hel"}');
    await until('the partial', () => v.events.some((e) => e.text && e.text.includes('partial_transcript')));

    v.voice.socketClose(9);
    await until('the close', () => v.events.some((e) => e.kind === 'close'));
    assert.deepEqual(v.events.at(-1), { id: 9, kind: 'close', code: 1000 });
    assert.equal(rig.sockets[0].closeCode, 1000);
    assert.ok(!JSON.stringify(v.events).includes(KEY));
    v.voice.socketSend(9, 'late'); // a frame to a closed socket is dropped
    v.voice.socketClose(9);
  });
});

test('a socket the service closes says so, with its code', async () => {
  await withRig(async (rig, v) => {
    await v.voice.handle('key.set', { key: KEY });
    await v.voice.handle('socket.open', STT);
    rig.sockets[0].close(4001);
    await until('the close', () => v.events.some((e) => e.kind === 'close'));
    assert.deepEqual(v.events.at(-1), { id: 9, kind: 'close', code: 4001 });
  });
});

test('a socket that cannot be opened rejects, and no event follows', async () => {
  await withRig(async (rig, v) => {
    // A key the service refuses: the handshake answers 401 and the socket never opens.
    fs.mkdirSync(path.dirname(v.keyFile), { recursive: true });
    fs.writeFileSync(v.keyFile, 'not_a_test_key\n');
    await assert.rejects(v.voice.handle('socket.open', STT), (e) => e.message === 'voice_unreachable');
    await sleep(50);
    assert.deepEqual(v.events, []);
    await v.voice.handle('key.set', { key: KEY });
    await v.voice.handle('socket.open', STT); // the id is free again
    v.voice.socketClose(9);
    await until('the close', () => v.events.some((e) => e.kind === 'close'));
  });
});

test('only the speech-to-text path, its query keys, two sockets at a time and text frames are allowed', async () => {
  await withRig(async (rig, v) => {
    await v.voice.handle('key.set', { key: KEY });
    for (const a of [
      { id: 1, path: '/v1/text-to-speech/vsalice/stream', query: {} },
      { id: 1, path: '/v1/speech-to-text/realtime/', query: {} },
      { id: 1, path: '/v1/speech-to-text/realtime?token=x', query: {} },
      { id: 1, path: 'wss://evil.example/v1/speech-to-text/realtime', query: {} },
      { id: 1, path: STT.path, query: { token: 'sutkn_1' } },
      { id: 1, path: STT.path, query: { xi_api_key: 'x' } },
      { id: 1, path: STT.path, query: { model_id: ['a'] } },
      { id: 0, path: STT.path, query: {} },
      { id: 'x', path: STT.path, query: {} },
      null,
    ]) {
      await assert.rejects(v.voice.handle('socket.open', a), (e) => e.message === 'voice_refused', JSON.stringify(a));
    }
    assert.equal(rig.sockets.length, 0);
    await v.voice.handle('socket.open', { id: 1, path: STT.path, query: {} });
    await v.voice.handle('socket.open', { id: 2, path: STT.path, query: {} });
    await assert.rejects(v.voice.handle('socket.open', { id: 3, path: STT.path, query: {} }), (e) => e.message === 'voice_refused');
    // Frames: only strings, and of a bounded size; a frame for an id that is no socket does nothing.
    v.voice.socketSend(1, { not: 'text' });
    v.voice.socketSend(1, 'x'.repeat(256 * 1024 + 1));
    v.voice.socketSend(77, 'x');
    v.voice.socketSend(1, 'ok');
    await until('the frame', () => rig.sockets[0].received.length > 0);
    assert.deepEqual(rig.sockets[0].received, ['ok']);
    // Binary frames from the service are not relayed.
    rig.sockets[0].socket.write(frame(2, Buffer.from([1, 2, 3])));
    rig.sockets[0].send('after');
    await until('the text frame', () => v.events.some((e) => e.text === 'after'));
    assert.ok(!v.events.some((e) => e.bytes));
  });
});

test('closeAll ends requests and sockets without a word to the page', async () => {
  await withRig(async (rig, v) => {
    await v.voice.handle('key.set', { key: KEY });
    await v.voice.handle('request', { id: 1, method: 'POST', path: '/v1/text-to-speech/hold/stream', json: { text: 'x' } });
    await v.voice.handle('socket.open', { id: 2, path: STT.path, query: {} });
    await until('the first chunk', () => v.events.some((e) => e.id === 1 && e.kind === 'data'));
    const seen = v.events.length;
    v.voice.closeAll();
    await until('the service to see both', () => rig.held[0].closedEarly && rig.sockets[0].closed);
    await sleep(50);
    assert.equal(v.events.length, seen);
    // The ids are free again.
    await v.voice.handle('request', { id: 1, method: 'GET', path: '/v2/voices' });
    await until('the end', () => ended(v.events, 1));
  });
});

// ---- the microphone

test('the microphone: macOS status, ask and the Settings pane', async () => {
  const v = makeVoice();
  try {
    for (const [os_, ours] of [['granted', 'granted'], ['denied', 'denied'], ['restricted', 'restricted'], ['not-determined', 'undetermined'], ['unknown', 'undetermined']]) {
      v.calls.statusOf = os_;
      assert.equal(await v.voice.handle('mic.status'), ours, os_);
    }
    assert.equal(await v.voice.handle('mic.ask'), true);
    v.calls.grant = false;
    assert.equal(await v.voice.handle('mic.ask'), false);
    await v.voice.handle('mic.openSettings');
    assert.deepEqual(v.calls.opened, ['x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone']);
    assert.ok(v.calls.asked.every((a) => a.endsWith(' microphone')));
  } finally {
    v.cleanup();
  }
});

test('the microphone on a platform with no prompt of its own is granted, and the Settings pane is the platform\'s', async () => {
  const v = makeVoice({ platform: 'linux' });
  const w = makeVoice({ platform: 'win32' });
  try {
    assert.equal(await v.voice.handle('mic.status'), 'granted');
    assert.equal(await v.voice.handle('mic.ask'), true);
    await v.voice.handle('mic.openSettings');
    assert.deepEqual([v.calls.asked, v.calls.opened], [[], []]);
    w.calls.statusOf = 'denied';
    assert.equal(await w.voice.handle('mic.status'), 'denied');
    assert.equal(await w.voice.handle('mic.ask'), true);
    await w.voice.handle('mic.openSettings');
    assert.deepEqual(w.calls.opened, ['ms-settings:privacy-microphone']);
  } finally {
    v.cleanup();
    w.cleanup();
  }
});

// ---- the permission handler

test('the page may use the microphone (audio only); a camera, another page and a gone window may not; other permissions stay granted', () => {
  const wc = {};
  const win = { webContents: wc, isDestroyed: () => false };
  const handler = makePermissionHandler({ getWindow: () => win, pageURL: PAGE });
  const ask = (permission, details, webContents = wc) => { let out; handler(webContents, permission, (ok) => { out = ok; }, details); return out; };
  assert.equal(ask('media', { mediaTypes: ['audio'], requestingUrl: PAGE }), true);
  assert.equal(ask('media', { mediaTypes: ['audio'], requestingUrl: `${PAGE}#/board` }), true, 'a hash does not matter');
  assert.equal(ask('media', { mediaTypes: ['audio', 'video'], requestingUrl: PAGE }), false);
  assert.equal(ask('media', { mediaTypes: ['video'], requestingUrl: PAGE }), false);
  assert.equal(ask('media', { mediaTypes: [], requestingUrl: PAGE }), false);
  assert.equal(ask('media', { requestingUrl: PAGE }), false);
  assert.equal(ask('media', { mediaTypes: ['audio'], requestingUrl: 'https://evil.example/' }), false);
  assert.equal(ask('media', { mediaTypes: ['audio'] }), false);
  assert.equal(ask('media', undefined), false);
  assert.equal(ask('media', { mediaTypes: ['audio'], requestingUrl: PAGE }, {}), false, 'another window');
  for (const p of ['clipboard-sanitized-write', 'fullscreen', 'notifications']) assert.equal(ask(p, {}), true, p);
  win.isDestroyed = () => true;
  assert.equal(ask('media', { mediaTypes: ['audio'], requestingUrl: PAGE }), false);
  const none = makePermissionHandler({ getWindow: () => null, pageURL: PAGE });
  let out;
  none(wc, 'media', (ok) => { out = ok; }, { mediaTypes: ['audio'], requestingUrl: PAGE });
  assert.equal(out, false);
});
