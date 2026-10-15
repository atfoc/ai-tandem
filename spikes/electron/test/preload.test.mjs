// The window's bridge (bridge/preload.js) against a fake ipcRenderer: what the preload sends over IPC, with the
// identifiers, and how a cancel is carried. No Electron.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPreload, recorderRenderer } from './helpers.mjs';

const abortLike = () => {
  const l = { aborted: false, listeners: new Set(), removed: 0 };
  l.listen = (cb) => { l.listeners.add(cb); return () => { l.listeners.delete(cb); l.removed++; }; };
  l.abort = () => { l.aborted = true; [...l.listeners].forEach((cb) => cb()); };
  return l;
};
const never = () => new Promise(() => {});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('exposes window.aiwbApp: the Transport minus the signal, nothing else', () => {
  const exposed = loadPreload(recorderRenderer());
  assert.deepEqual(Object.keys(exposed), ['aiwbApp']);
  assert.deepEqual(Object.keys(exposed.aiwbApp).sort(), ['app', 'call', 'pickImages', 'pictureURL', 'stream', 'way']);
});

test('a call gets an identifier, and goes over aiwb:call with five fields at most', async () => {
  const r = recorderRenderer();
  const { aiwbApp } = loadPreload(r);
  const a = await aiwbApp.call({ server: 'local', method: 'POST', path: '/api/groups', body: { json: '{}' }, secret: 'no', extra: 1 });
  assert.deepEqual(a, { status: 200, text: '{}', sceneRev: null });
  await aiwbApp.call({ server: 'local', method: 'GET', path: '/api/state' });
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
  const { aiwbApp } = loadPreload(r);
  await Promise.all(Array.from({ length: 1000 }, () => aiwbApp.call({ server: 'local', method: 'GET', path: '/x' })));
  assert.equal(new Set(r.invoked.map(([, p]) => p.id)).size, 1000);
});

test('a cancel is carried as the call\'s identifier on aiwb:cancel, once, and the call rejects as an abort', async () => {
  const r = recorderRenderer({ 'aiwb:call': never });
  const { aiwbApp } = loadPreload(r);
  const abort = abortLike();
  const p = aiwbApp.call({ server: 'local', method: 'GET', path: '/slow', abort });
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
  const { aiwbApp } = loadPreload(r);
  const abort = abortLike();
  await aiwbApp.call({ server: 'local', method: 'GET', path: '/x', abort });
  assert.equal(abort.listeners.size, 0);
  abort.abort();
  assert.deepEqual(r.sent, []);
});

test('a signal already aborted: nothing is sent at all', async () => {
  const r = recorderRenderer();
  const { aiwbApp } = loadPreload(r);
  const abort = abortLike();
  abort.aborted = true;
  await assert.rejects(aiwbApp.call({ server: 'local', method: 'GET', path: '/x', abort }), (e) => e.name === 'AbortError');
  assert.deepEqual([r.invoked, r.sent], [[], []]);
});

test('an abort while a Blob body is still being read: the call ends and is never sent', async () => {
  const r = recorderRenderer();
  const { aiwbApp } = loadPreload(r);
  const abort = abortLike();
  const p = aiwbApp.call({ server: 'local', method: 'POST', path: '/x', body: { bytes: new Blob([new Uint8Array(1 << 20)]), type: 'image/png' }, abort });
  abort.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
  await new Promise((res) => setTimeout(res, 20));
  assert.deepEqual([r.invoked, r.sent], [[], []]);
});

test('bodies: JSON, a Uint8Array, a view cut to its bytes, an ArrayBuffer and a Blob all reach the face as { bytes: Uint8Array, type }', async () => {
  const r = recorderRenderer();
  const { aiwbApp } = loadPreload(r);
  const call = (body) => aiwbApp.call({ server: 'local', method: 'POST', path: '/x', body });
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
  const { aiwbApp } = loadPreload(r);
  await assert.rejects(aiwbApp.call({ server: 'local', method: 'POST', path: '/x', body: { bytes: 'text', type: 'x' } }), (e) => e.name === 'TransportError' && /bad call body/.test(e.message));
  await assert.rejects(aiwbApp.call({ server: 'local', method: 'GET', path: '/x' }), (e) => e.name === 'TransportError' && /boom/.test(e.message));
});

test('the stream: batches reach the callbacks in order, close removes the listeners and ends the subscription', async () => {
  const r = recorderRenderer();
  const { aiwbApp } = loadPreload(r);
  const got = []; const states = [];
  const s = aiwbApp.stream((e) => got.push(e), (st) => states.push(st));
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

test('pictureURL, app and pickImages go the way the app\'s face expects', async () => {
  const r = recorderRenderer({ 'aiwb:app': async () => ({ status: 200, text: '[]' }) });
  const { aiwbApp } = loadPreload(r);
  assert.equal(aiwbApp.pictureURL('s_000000000001', 'c 1', 'ab'), 'aiwb-picture://p/s_000000000001/c%201/ab');
  assert.deepEqual(await aiwbApp.app('servers.list'), { status: 200, text: '[]' });
  assert.deepEqual(r.invoked[0], ['aiwb:app', { op: 'servers.list', args: undefined }]);
  await aiwbApp.pickImages();
  assert.deepEqual(r.invoked[1], ['aiwb:pick-images', undefined]);
});
