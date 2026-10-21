const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadPreload, recorderRenderer, slowClient, exposeThroughBridge, PAGE_URL } = require('./bridgemodel.js');
const { createIpcFace } = require('../ipcface.js');

// ---- window.aiwbTransport (AD-22), the one surface the preload gives the page

const abortLike = () => {
  const l = { aborted: false, listeners: new Set(), removed: 0 };
  l.listen = (cb) => { l.listeners.add(cb); return () => { l.listeners.delete(cb); l.removed++; }; };
  l.abort = () => { l.aborted = true; [...l.listeners].forEach((cb) => cb()); };
  return l;
};
const never = () => new Promise(() => {});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('exposes window.aiwbTransport: the Transport minus the signal and the error classes, and picture() for the address', () => {
  const exposed = loadPreload(recorderRenderer());
  assert.deepEqual(Object.keys(exposed), ['aiwbTransport', 'aiwbVoice'], 'the page gets nothing else');
  assert.deepEqual(Object.keys(exposed.aiwbTransport).sort(), ['app', 'call', 'pickImages', 'picture', 'stream', 'way']);
  assert.equal(exposed.aiwbTransport.way, 'ipc');
});

test('a call gets an identifier, and goes over aiwb:call with five fields at most', async () => {
  const r = recorderRenderer();
  const { aiwbTransport } = loadPreload(r);
  const a = await aiwbTransport.call({ server: 'local', method: 'POST', path: '/api/groups', body: { json: '{}' }, secret: 'no', extra: 1 });
  assert.deepEqual(a, { status: 200, text: '{}', sceneRev: null });
  await aiwbTransport.call({ server: 'local', method: 'GET', path: '/api/state' });
  assert.equal(r.invoked.length, 2);
  const [[c1, p1], [, p2]] = r.invoked;
  assert.equal(c1, 'aiwb:call');
  assert.deepEqual(Object.keys(p1).sort(), ['body', 'id', 'method', 'path', 'server']);
  assert.deepEqual(Object.keys(p2).sort(), ['id', 'method', 'path', 'server']);
  assert.match(p1.id, UUID);
  assert.notEqual(p1.id, p2.id);
});

test('identifiers do not repeat', async () => {
  const r = recorderRenderer();
  const { aiwbTransport } = loadPreload(r);
  await Promise.all(Array.from({ length: 1000 }, () => aiwbTransport.call({ server: 'local', method: 'GET', path: '/x' })));
  assert.equal(new Set(r.invoked.map(([, p]) => p.id)).size, 1000);
});

test('a cancel is carried as the call\'s identifier on aiwb:cancel, once, and the call rejects as an abort', async () => {
  const r = recorderRenderer({ 'aiwb:call': never });
  const { aiwbTransport } = loadPreload(r);
  const abort = abortLike();
  const p = aiwbTransport.call({ server: 'local', method: 'GET', path: '/slow', abort });
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(r.sent, []);
  abort.abort();
  abort.abort(); // a second abort does nothing more
  await assert.rejects(p, (e) => e.name === 'AbortError');
  const id = r.invoked[0][1].id;
  assert.deepEqual(r.sent, [['aiwb:cancel', { id }]]);
  assert.equal(abort.listeners.size, 0, 'the page\'s listener is removed');
});

test('an abort after the call has finished sends nothing, and the listener is gone', async () => {
  const r = recorderRenderer();
  const { aiwbTransport } = loadPreload(r);
  const abort = abortLike();
  await aiwbTransport.call({ server: 'local', method: 'GET', path: '/x', abort });
  assert.equal(abort.listeners.size, 0);
  abort.abort();
  assert.deepEqual(r.sent, []);
});

test('a signal already aborted: nothing is sent at all', async () => {
  const r = recorderRenderer();
  const { aiwbTransport } = loadPreload(r);
  const abort = abortLike();
  abort.aborted = true;
  await assert.rejects(aiwbTransport.call({ server: 'local', method: 'GET', path: '/x', abort }), (e) => e.name === 'AbortError');
  assert.deepEqual([r.invoked, r.sent], [[], []]);
});

test('an abort while a Blob body is still being read: the call ends and is never sent', async () => {
  const r = recorderRenderer();
  const { aiwbTransport } = loadPreload(r);
  const abort = abortLike();
  const p = aiwbTransport.call({ server: 'local', method: 'POST', path: '/x', body: { bytes: new Blob([new Uint8Array(1 << 20)]), type: 'image/png' }, abort });
  abort.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
  await new Promise((res) => setTimeout(res, 20));
  assert.deepEqual([r.invoked, r.sent], [[], []]);
});

test('bodies: JSON, a Uint8Array, a view cut to its bytes, an ArrayBuffer and a Blob all reach the face as { bytes: Uint8Array, type }', async () => {
  const r = recorderRenderer();
  const { aiwbTransport } = loadPreload(r);
  const call = (body) => aiwbTransport.call({ server: 'local', method: 'POST', path: '/x', body });
  await call({ json: '{"a":1}' });
  await call({ bytes: new Uint8Array([1, 2, 3]), type: 'image/png' });
  const big = new Uint8Array(1000).map((_, i) => i & 255);
  await call({ bytes: big.subarray(10, 20), type: 'image/png' });
  await call({ bytes: new Uint8Array([4, 5]).buffer, type: 'image/png' });
  await call({ bytes: new Blob([new Uint8Array([6, 7, 8, 9])]), type: 'image/jpeg' });
  const bodies = r.invoked.map(([, p]) => p.body);
  assert.deepEqual(bodies[0], { json: '{"a":1}' });
  assert.deepEqual(Array.from(bodies[1].bytes), [1, 2, 3]);
  assert.deepEqual(Array.from(bodies[2].bytes), [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  assert.equal(bodies[2].bytes.buffer.byteLength, 10, 'a view is cut: IPC would clone the whole buffer under it');
  assert.deepEqual(Array.from(bodies[3].bytes), [4, 5]);
  assert.deepEqual([Array.from(bodies[4].bytes), bodies[4].type], [[6, 7, 8, 9], 'image/jpeg']);
});

test('a bad body or a failing IPC is a TransportError-shaped rejection with a message, never a hang', async () => {
  const r = recorderRenderer({ 'aiwb:call': async () => { throw new Error('boom'); } });
  const { aiwbTransport } = loadPreload(r);
  await assert.rejects(aiwbTransport.call({ server: 'local', method: 'POST', path: '/x', body: { bytes: 'text', type: 'x' } }), (e) => e.name === 'TransportError' && /bad call body/.test(e.message));
  await assert.rejects(aiwbTransport.call({ server: 'local', method: 'GET', path: '/x' }), (e) => e.name === 'TransportError' && /boom/.test(e.message));
});

test('the stream: batches reach the callbacks in order, close removes the listeners and ends the subscription', async () => {
  const r = recorderRenderer();
  const { aiwbTransport } = loadPreload(r);
  const got = []; const states = [];
  const s = aiwbTransport.stream((e) => got.push(e), (st) => states.push(st));
  assert.deepEqual(r.invoked, [['aiwb:stream', { open: true }]]);
  r.emit('aiwb:stream-state', 'open');
  r.emit('aiwb:events', [{ n: 1 }, { n: 2 }]);
  r.emit('aiwb:events', [{ n: 3 }]);
  s.close(); s.close();
  r.emit('aiwb:events', [{ n: 4 }]);
  assert.deepEqual(got, [{ n: 1 }, { n: 2 }, { n: 3 }]);
  assert.deepEqual(states, ['open']);
  assert.deepEqual([r.listeners.get('aiwb:events'), r.listeners.get('aiwb:stream-state')], [[], []]);
  assert.deepEqual(r.invoked.at(-1), ['aiwb:stream', { open: false }]);
});

test('picture() answers the address at once; app and pickImages go the way the app\'s face expects', async () => {
  const r = recorderRenderer({ 'aiwb:app': async () => ({ status: 200, text: '[]' }) });
  const { aiwbTransport } = loadPreload(r);
  assert.equal(await aiwbTransport.picture('s_000000000001', 'c 1', 'ab'), 'aiwb-picture://p/s_000000000001/c%201/ab');
  assert.deepEqual(r.invoked, [], 'no IPC for an address');
  assert.deepEqual(await aiwbTransport.app('servers.list'), { status: 200, text: '[]' });
  assert.deepEqual(r.invoked[0], ['aiwb:app', { op: 'servers.list', args: undefined }]);
  await aiwbTransport.pickImages();
  assert.deepEqual(r.invoked[1], ['aiwb:pick-images', undefined]);
});

test('pickImages takes no argument and names no path', async () => {
  const r = recorderRenderer({ 'aiwb:pick-images': () => 'answer' });
  const { aiwbTransport } = loadPreload(r);
  assert.equal(await aiwbTransport.pickImages('/etc/passwd', { filePaths: ['/etc/passwd'] }), 'answer');
  assert.deepEqual(r.invoked, [['aiwb:pick-images', undefined]]);
});

// ---- window.aiwbVoice (VC-5), the voice service's face: the shape of app/src/voice/platform/bridge.types.ts

const VOICE_KEY = 'sk_test_RECOGNISABLE_0123456789abcdef';

test('exposes window.aiwbVoice with the shape of the bridge type, and every method is a function', () => {
  const { aiwbVoice } = loadPreload(recorderRenderer());
  assert.deepEqual(Object.keys(aiwbVoice).sort(), ['cancel', 'key', 'mic', 'on', 'preview', 'request', 'socket']);
  assert.deepEqual(Object.keys(aiwbVoice.key).sort(), ['clear', 'has', 'set']);
  assert.deepEqual(Object.keys(aiwbVoice.socket).sort(), ['close', 'open', 'send']);
  assert.deepEqual(Object.keys(aiwbVoice.mic).sort(), ['ask', 'openSettings', 'status']);
  const seen = exposeThroughBridge(aiwbVoice);
  for (const f of [seen.cancel, seen.on, seen.preview, seen.request, seen.key.has, seen.key.set, seen.key.clear, seen.socket.open, seen.socket.send, seen.socket.close, seen.mic.status, seen.mic.ask, seen.mic.openSettings]) {
    assert.equal(typeof f, 'function');
  }
});

test('the calls go over aiwb:voice with an op and the fields the face reads, and nothing else', async () => {
  const r = recorderRenderer({ 'aiwb:voice': async () => 'answer' });
  const { aiwbVoice } = loadPreload(r);
  await aiwbVoice.key.has();
  await aiwbVoice.key.set('k1');
  await aiwbVoice.key.clear();
  await aiwbVoice.request({ id: 4, method: 'GET', path: '/v2/voices', query: { page_size: '1' }, json: undefined, key: 'k2', extra: 'no', headers: { a: 'b' } });
  await aiwbVoice.socket.open({ id: 5, path: '/v1/speech-to-text/realtime', query: { model_id: 'm' }, headers: { a: 'b' } });
  await aiwbVoice.preview('https://storage.example/a.mp3');
  await aiwbVoice.mic.status();
  await aiwbVoice.mic.ask();
  await aiwbVoice.mic.openSettings();
  assert.deepEqual(r.invoked, [
    ['aiwb:voice', { op: 'key.has', args: undefined }],
    ['aiwb:voice', { op: 'key.set', args: { key: 'k1' } }],
    ['aiwb:voice', { op: 'key.clear', args: undefined }],
    ['aiwb:voice', { op: 'request', args: { id: 4, method: 'GET', path: '/v2/voices', query: { page_size: '1' }, json: undefined, key: 'k2' } }],
    ['aiwb:voice', { op: 'socket.open', args: { id: 5, path: '/v1/speech-to-text/realtime', query: { model_id: 'm' } } }],
    ['aiwb:voice', { op: 'preview', args: { url: 'https://storage.example/a.mp3' } }],
    ['aiwb:voice', { op: 'mic.status', args: undefined }],
    ['aiwb:voice', { op: 'mic.ask', args: undefined }],
    ['aiwb:voice', { op: 'mic.openSettings', args: undefined }],
  ]);
  await aiwbVoice.request(null); // nothing to read: the face refuses it
  assert.deepEqual(r.invoked.at(-1)[1].args, { id: undefined, method: undefined, path: undefined, query: undefined, json: undefined, key: undefined });
});

test('cancel, a socket\'s frames and its close are fire and forget on their own channels', () => {
  const r = recorderRenderer();
  const { aiwbVoice } = loadPreload(r);
  aiwbVoice.cancel(3);
  aiwbVoice.socket.send(5, '{"a":1}');
  aiwbVoice.socket.close(5);
  assert.deepEqual(r.sent, [
    ['aiwb:voice-cancel', { id: 3 }],
    ['aiwb:voice-send', { id: 5, text: '{"a":1}' }],
    ['aiwb:voice-send', { id: 5, close: true }],
  ]);
  assert.deepEqual(r.invoked, []);
});

test('a failure rejects with the one word main gave, or voice_failed; Electron\'s text never reaches the page', async () => {
  const fail = (m) => async () => { throw new Error(`Error invoking remote method 'aiwb:voice': ${m}`); };
  for (const [thrown, word] of [['VoiceError: voice_no_key', 'voice_no_key'], ['VoiceError: voice_refused', 'voice_refused'], ['VoiceError: voice_unreachable', 'voice_unreachable'], ['VoiceError: voice_cancelled', 'voice_cancelled'], ['Error: the call is not from the app window', 'voice_failed'], ['TypeError: x is not a function', 'voice_failed']]) {
    const { aiwbVoice } = loadPreload(recorderRenderer({ 'aiwb:voice': fail(thrown) }));
    await assert.rejects(aiwbVoice.key.has(), (e) => e.message === word, thrown);
    await assert.rejects(aiwbVoice.mic.ask(), (e) => e.message === word, thrown);
  }
});

test('events reach the listener cut to the fields of their kind, in order; off stops them; a throwing listener hurts no other', () => {
  const r = recorderRenderer();
  const { aiwbVoice } = loadPreload(r);
  const a = []; const b = [];
  const offA = aiwbVoice.on((e) => a.push(e));
  aiwbVoice.on((e) => { b.push(e); throw new Error('the page\'s own'); });
  const bytes = new Uint8Array([1, 2, 3]);
  r.emit('aiwb:voice-event', { id: 1, kind: 'data', bytes, secret: 'x' });
  r.emit('aiwb:voice-event', { id: 1, kind: 'end', text: 'no' });
  r.emit('aiwb:voice-event', { id: 2, kind: 'error', status: 500, message: 'https://api.elevenlabs.io failed' });
  r.emit('aiwb:voice-event', { id: 3, kind: 'open' });
  r.emit('aiwb:voice-event', { id: 3, kind: 'message', text: '{}', bytes });
  r.emit('aiwb:voice-event', { id: 3, kind: 'close', code: 1000, text: 'no' });
  r.emit('aiwb:voice-event', { id: 3, kind: 'unknown' });
  r.emit('aiwb:voice-event', null);
  r.emit('aiwb:voice-event', 'text');
  const want = [
    { id: 1, kind: 'data', bytes }, { id: 1, kind: 'end' }, { id: 2, kind: 'error' }, { id: 3, kind: 'open' },
    { id: 3, kind: 'message', text: '{}' }, { id: 3, kind: 'close', code: 1000 },
  ];
  assert.deepEqual(a, want);
  assert.deepEqual(b, want);
  offA();
  r.emit('aiwb:voice-event', { id: 4, kind: 'end' });
  assert.equal(a.length, want.length);
  assert.equal(b.length, want.length + 1);
  assert.equal(aiwbVoice.on('not a function')(), undefined, 'a listener that is no function is ignored, and its remover does nothing');
});

// voiceRig wires the real preload to the real face and the real voice module, the way Electron does (the payload is
// cloned, the handler gets the sender frame, a rejection comes back as Electron's "Error invoking remote method" text).
// The service is fetch: a fake that records what it is asked.
function voiceRig({ senderURL = PAGE_URL, fetchImpl } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwb-voice-face-'));
  const handlers = new Map();
  const listeners = new Map();
  const frame = { url: senderURL };
  const renderer = recorderRenderer();
  const webContents = { mainFrame: frame, send(channel, payload) { renderer.emit(channel, structuredClone(payload)); }, isDestroyed: () => false, on() {} };
  const win = { webContents, isDestroyed: () => false, on() {} };
  const ipcMain = {
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => listeners.set(ch, fn),
    removeHandler: (ch) => handlers.delete(ch),
    removeAllListeners: (ch) => listeners.delete(ch),
  };
  const face = createIpcFace({
    ipcMain, client: slowClient(), getWindow: () => win, pageURL: PAGE_URL, shell: {}, dialog: {}, home: '/tmp',
    voice: { app: { isPackaged: true }, systemPreferences: {}, userData, platform: 'linux', env: {}, fetchImpl },
  });
  const event = { sender: webContents, senderFrame: frame };
  renderer.invoke = async (ch, payload) => {
    renderer.invoked.push([ch, payload]);
    try { return await handlers.get(ch)(event, structuredClone(payload)); }
    catch (e) { throw new Error(`Error invoking remote method '${ch}': ${e}`); }
  };
  renderer.send = (ch, payload) => { renderer.sent.push([ch, payload]); const fn = listeners.get(ch); if (fn) fn(event, structuredClone(payload)); };
  const { aiwbVoice } = loadPreload(renderer);
  return { aiwbVoice: exposeThroughBridge(aiwbVoice), handlers, listeners, face, userData, keyFile: path.join(userData, 'client', 'voice-key'), cleanup: () => { face.dispose(); fs.rmSync(userData, { recursive: true, force: true }); } };
}

const waitUntil = async (what, pred) => {
  const end = Date.now() + 15000;
  while (!pred()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((res) => setTimeout(res, 5));
  }
};

test('through the real face: the key is set, a request is answered with a status and events, and the key is nowhere the page can see', async () => {
  const asked = [];
  const fetchImpl = async (url, o) => { asked.push([url, o.headers]); return new Response(new Uint8Array([9, 8, 7]), { status: 200 }); };
  const rig = voiceRig({ fetchImpl });
  try {
    const { aiwbVoice } = rig;
    const seen = [];
    aiwbVoice.on((e) => seen.push(e));
    assert.equal(await aiwbVoice.key.has(), false);
    await aiwbVoice.key.set(VOICE_KEY);
    assert.equal(await aiwbVoice.key.has(), true);
    assert.equal(fs.statSync(rig.keyFile).mode & 0o777, 0o600);
    const answer = await aiwbVoice.request({ id: 1, method: 'GET', path: '/v2/voices', query: { page_size: '1' } });
    assert.deepEqual(answer, { status: 200 });
    await waitUntil('the end', () => seen.some((e) => e.kind === 'end'));
    assert.deepEqual(seen.map((e) => e.kind), ['data', 'end']);
    assert.deepEqual(Array.from(seen[0].bytes), [9, 8, 7]);
    assert.deepEqual(asked, [['https://api.elevenlabs.io/v2/voices?page_size=1', { 'xi-api-key': VOICE_KEY }]]);
    assert.ok(!JSON.stringify([answer, seen.map((e) => ({ ...e, bytes: e.bytes && Array.from(e.bytes) }))]).includes(VOICE_KEY));
    await assert.rejects(aiwbVoice.request({ id: 2, method: 'GET', path: '/v1/user' }), (e) => e.message === 'voice_refused');
    await aiwbVoice.key.clear();
    assert.equal(await aiwbVoice.key.has(), false);
    await assert.rejects(aiwbVoice.request({ id: 3, method: 'GET', path: '/v2/voices' }), (e) => e.message === 'voice_no_key');
    assert.equal(asked.length, 1);
  } finally {
    rig.cleanup();
  }
});

test('through the real face: a cancel from the page aborts the request', async () => {
  let signal = null;
  const fetchImpl = async (url, o) => {
    signal = o.signal;
    return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); } }), { status: 200 });
  };
  const rig = voiceRig({ fetchImpl });
  try {
    await rig.aiwbVoice.key.set(VOICE_KEY);
    const seen = [];
    rig.aiwbVoice.on((e) => seen.push(e));
    await rig.aiwbVoice.request({ id: 1, method: 'GET', path: '/v2/voices' });
    await waitUntil('the first chunk', () => seen.length > 0);
    assert.equal(signal.aborted, false);
    rig.aiwbVoice.cancel(1);
    assert.equal(signal.aborted, true);
  } finally {
    rig.cleanup();
  }
});

test('through the real face: a call from another page or frame is refused, and a cancel or a frame from it does nothing', async () => {
  let fetched = 0;
  const rig = voiceRig({ senderURL: 'https://evil.example/', fetchImpl: async () => { fetched++; return new Response('x'); } });
  try {
    await assert.rejects(rig.aiwbVoice.key.set(VOICE_KEY), (e) => e.message === 'voice_failed');
    await assert.rejects(rig.aiwbVoice.key.has(), (e) => e.message === 'voice_failed');
    await assert.rejects(rig.aiwbVoice.mic.status(), (e) => e.message === 'voice_failed');
    await assert.rejects(rig.aiwbVoice.preview('https://storage.example/a.mp3'), (e) => e.message === 'voice_failed');
    assert.equal(fs.existsSync(rig.keyFile), false);
    rig.aiwbVoice.cancel(1);
    rig.aiwbVoice.socket.send(1, 'x');
    rig.aiwbVoice.socket.close(1);
    assert.equal(fetched, 0);
  } finally {
    rig.cleanup();
  }
});

test('the face registers the voice channels only when it is given voice, and dispose removes them', () => {
  const rig = voiceRig();
  assert.deepEqual([...rig.handlers.keys()].filter((c) => c.startsWith('aiwb:voice')), ['aiwb:voice']);
  assert.deepEqual([...rig.listeners.keys()].filter((c) => c.startsWith('aiwb:voice')).sort(), ['aiwb:voice-cancel', 'aiwb:voice-send']);
  rig.cleanup();
  assert.deepEqual([...rig.handlers.keys(), ...rig.listeners.keys()], []);
});
