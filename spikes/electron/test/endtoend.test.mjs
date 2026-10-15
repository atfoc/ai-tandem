// The whole path without Electron: the page's Transport (app/src/bridgeTransport.ts) -> what contextBridge lets
// through (a model, helpers.mjs) -> the preload (bridge/preload.js) -> a fake ipcRenderer -> the REAL IPC face of
// the desktop app (desktop/ipcface.js, unchanged, with its checks) -> a client whose calls end on abort.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPreload, faceRenderer, slowClient, exposeThroughBridge, cross } from './helpers.mjs';
import { transportFromBridge } from '../app/src/bridgeTransport.ts';

function rig() {
  const client = slowClient();
  const { renderer, face, webContents } = faceRenderer({ client });
  const { aiwbApp } = loadPreload(renderer);
  const bridge = exposeThroughBridge(aiwbApp);
  return { client, renderer, face, webContents, bridge, transport: transportFromBridge(bridge) };
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('the model: an AbortSignal does not cross (it arrives as {}), an Error keeps only its message, bytes and functions cross', () => {
  const ac = new AbortController();
  const seen = cross({ signal: ac.signal, f: () => 1, u: new Uint8Array([1]), e: Object.assign(new RangeError('x'), { code: 'E' }) });
  assert.deepEqual(Object.keys(seen.signal), []);
  assert.equal(typeof seen.signal.addEventListener, 'undefined');
  assert.equal(seen.f(), 1);
  assert.ok(seen.u instanceof Uint8Array);
  assert.equal(seen.e.name, 'Error');
  assert.equal(seen.e.code, undefined);
});

test('a call goes through every layer and the answer comes back', async () => {
  const { transport, client } = rig();
  const a = await transport.call({ server: 'local', method: 'GET', path: '/api/fast' });
  assert.deepEqual(a, { status: 200, text: '{"path":"/api/fast"}', sceneRev: null });
  assert.equal(client.calls.length, 1);
});

test('cancel: the slow call ends with the signal\'s reason, and the face aborted the request in the main process', async () => {
  const { transport, client } = rig();
  const ac = new AbortController();
  const p = transport.call({ server: 'local', method: 'GET', path: '/slow', signal: ac.signal });
  await tick();
  ac.abort(new Error('mine'));
  await assert.rejects(p, (e) => e === ac.signal.reason);
  await tick();
  assert.equal(client.calls[0].aborted, true);
});

test('cancel with no reason: an AbortError, as fetch makes it', async () => {
  const { transport } = rig();
  const ac = new AbortController();
  const p = transport.call({ server: 'local', method: 'GET', path: '/slow', signal: ac.signal });
  ac.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
});

test('what a bridge that took the signal itself would do: the signal arrives as {}, and the cancel is lost (why abort is a function)', async () => {
  const { renderer } = rig();
  const { aiwbApp } = loadPreload(renderer);
  const bridge = exposeThroughBridge(aiwbApp);
  const ac = new AbortController();
  // the page hands the real signal as `abort`: the preload sees {} (no listen), so it can never hear the abort
  const p = bridge.call({ server: 'local', method: 'GET', path: '/slow', abort: ac.signal });
  await tick();
  ac.abort();
  await tick();
  assert.deepEqual(renderer.sent, [], 'no cancel was sent');
  void p; // the call stays pending until the face's own limit
});

test('concurrent calls with the odd ones cancelled: no cross-talk between identifiers', async () => {
  const { transport, client } = rig();
  const acs = Array.from({ length: 40 }, () => new AbortController());
  const ps = acs.map((ac, i) => transport.call({ server: 'local', method: 'GET', path: i % 2 ? `/slow/${i}` : `/fast/${i}`, signal: ac.signal }).then((a) => ({ i, a }), (e) => ({ i, e })));
  await tick();
  acs.forEach((ac, i) => { if (i % 2) ac.abort(); });
  const rs = await Promise.all(ps);
  for (const r of rs) {
    if (r.i % 2) assert.equal(r.e.name, 'AbortError');
    else assert.equal(JSON.parse(r.a.text).path, `/fast/${r.i}`);
  }
  await tick();
  const aborted = client.calls.filter((c) => c.aborted).map((c) => c.path).sort();
  assert.deepEqual(aborted, client.calls.filter((c) => c.path.startsWith('/slow')).map((c) => c.path).sort());
  assert.equal(aborted.length, 20);
});

test('bytes: a Uint8Array, a view and a Blob arrive at the client intact', async () => {
  const { transport, client } = rig();
  const u = new Uint8Array(100000).map((_, i) => (i * 7) & 255);
  await transport.call({ server: 'local', method: 'POST', path: '/b1', body: { bytes: u, type: 'image/png' } });
  await transport.call({ server: 'local', method: 'POST', path: '/b2', body: { bytes: u.subarray(100, 300), type: 'image/png' } });
  await transport.call({ server: 'local', method: 'POST', path: '/b3', body: { bytes: new Blob([u]), type: 'image/jpeg' } });
  assert.deepEqual(Buffer.from(client.calls[0].body.bytes), Buffer.from(u));
  assert.deepEqual(Buffer.from(client.calls[1].body.bytes), Buffer.from(u.subarray(100, 300)));
  assert.deepEqual(Buffer.from(client.calls[2].body.bytes), Buffer.from(u));
  assert.equal(client.calls[2].body.type, 'image/jpeg');
});

test('the face\'s checks still hold behind the new bridge: a call from a page that is not the app\'s is refused', async () => {
  const client = slowClient();
  const { renderer } = faceRenderer({ client, senderURL: 'https://example.com/index.html' });
  const { aiwbApp } = loadPreload(renderer);
  await assert.rejects(transportFromBridge(exposeThroughBridge(aiwbApp)).call({ server: 'local', method: 'GET', path: '/x' }), (e) => e.name === 'TransportError' && /not from the app window/.test(e.message));
  assert.equal(client.calls.length, 0);
});

test('a bad request is refused by the face (a method it does not know) and reaches no client', async () => {
  const { transport, client } = rig();
  await assert.rejects(transport.call({ server: 'local', method: 'TRACE', path: '/x' }), (e) => e.name === 'TransportError' && /bad call/.test(e.message));
  assert.equal(client.calls.length, 0);
});

test('the stream through every layer: events from the client, in order, big ones whole; close ends the subscription', async () => {
  const { transport, client } = rig();
  const got = []; const states = [];
  const s = transport.stream((e) => got.push(e), (st) => states.push(st));
  await tick();
  assert.equal(client.subscribers.length, 1);
  const sub = client.subscribers[0];
  for (let n = 1; n <= 5; n++) sub.cb({ server: 'local', event: { n, pad: n === 3 ? 'x'.repeat(50000) : '' } });
  await tick(50);
  assert.deepEqual(got.map((e) => e.event.n), [1, 2, 3, 4, 5]);
  assert.equal(got[2].event.pad.length, 50000);
  assert.deepEqual(states, ['open']);
  s.close();
  await tick();
  assert.equal(sub.closed, true);
});
