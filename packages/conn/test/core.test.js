'use strict';

// The shared code against fake ports (goal 7.2): the Manager and its connections run over the
// scripted server and the fake Connector of test/fakes, in memory, with the waits lowered and
// jitter off. These are the cases of the desktop's tests that do not depend on TLS or HTTP/2 —
// the retry intervals, the silence, a refused secret, a changed certificate, the stream that starts
// with a snapshot, a server too old and its wait — and the states one by one. The same code runs
// over the Node ports in connection.test.js against the stand-in.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('..');
const { ScriptedServer, fingerprintFor } = require('./fakes/scripted-server');
const { fakeConnector } = require('./fakes/fake-connector');
const { memoryStore } = require('./fakes/memory-store');
const { FAST, sleep, until, seededRandom, Recorder } = require('./fakes/support');

// Back-off steps no other timer of the module has, so that the waits can be told by their length.
const STEPS = [31, 62, 124];
const T = { backoff: STEPS, stable: 400 };

// setup makes a client over one scripted server and a fake Connector.
function setup({ timing = T, server = {}, store = memoryStore() } = {}) {
  const s = new ScriptedServer(server);
  const connector = fakeConnector({ servers: [s] });
  const rec = new Recorder();
  const client = createClient({ connector, store, timing: { ...FAST, ...timing }, log: rec.onLog, random: seededRandom() });
  let sub = null;
  const h = {
    s, connector, store, rec, client,
    subscribe() { sub = client.subscribe(rec.onEnvelope); return sub; },
    async app(op, args) { const a = await client.app(op, args); rec.keep(a); return a; },
    // add saves the server as an entry without a test (pinned, the self-signed box on).
    async add(extra = {}, name = 'Remote') {
      rec.secrets.add(s.secret);
      const a = await h.app('servers.add', { force: true, form: { name, address: s.address, secret: s.secret, selfSigned: true, pin: s.fingerprint, ...extra } });
      assert.equal(a.status, 200, JSON.stringify(a.body));
      assert.equal(a.body.saved, true);
      return a.body.server;
    },
    state: (id) => rec.stateOf(id),
    reaches: (id, state) => until(() => rec.stateOf(id) === state, `${id} to be ${state}`),
    detail: (id) => (rec.viewOf(id) || {}).detail,
    async close() { if (sub) sub.close(); await client.close(); },
  };
  return h;
}

// withEntry runs fn with a subscribed client whose list has the server as its one entry.
async function withEntry(opts, fn) {
  const h = setup(opts);
  try {
    h.subscribe();
    const v = await h.add((opts && opts.form) || {});
    await fn(h, v);
    h.rec.assertNoSecrets();
  } finally {
    await h.close();
  }
}

const eventsRequests = (s) => s.requests.filter((r) => r.path.startsWith('/api/events')).length;
const helloRequests = (s) => s.requests.filter((r) => r.path === '/api/hello').length;
const opens = (h) => h.connector.calls.filter((c) => c.op === 'open');

// spyWaits records the length of every timer set while fn runs; the answer is the ones that are steps.
async function spyWaits(fn) {
  const all = [];
  const real = globalThis.setTimeout;
  globalThis.setTimeout = function setTimeoutSpy(f, ms, ...rest) { all.push(ms); return real.call(this, f, ms, ...rest); };
  try { await fn(all); } finally { globalThis.setTimeout = real; }
  return all.filter((ms) => STEPS.includes(ms));
}

test('connected: hello and the snapshot as the server sent them, then connected, then the events in order', async () => {
  await withEntry({}, async (h, v) => {
    await h.reaches(v.id, 'connected');
    for (let i = 1; i <= 5; i++) h.s.emit({ type: 'tick', n: i });
    h.s.ping();
    await until(() => h.rec.eventsOf(v.id).length === 7, 'five events');
    const mine = h.rec.envelopes.filter((e) => e.server === v.id || (e.app && e.app.type === 'server_state' && e.app.server.id === v.id));
    assert.deepEqual(mine.map((e) => (e.server ? e.event.type + (e.event.n || '') : `state:${e.app.server.state}`)), [
      'hello', 'snapshot', 'state:connected', 'tick1', 'tick2', 'tick3', 'tick4', 'tick5',
    ]);
    assert.deepEqual(h.rec.eventsOf(v.id)[0], { type: 'hello', instanceId: h.s.instanceId });
    assert.deepEqual(h.rec.eventsOf(v.id)[1], h.s.snapshotEvent());
    const view = h.rec.viewOf(v.id);
    assert.deepEqual([view.state, view.version, view.agents, view.address, view.instanceId], ['connected', '1.2.3', ['claude'], h.s.address, h.s.instanceId]);
    assert.equal('secret' in view, false);
  });
});

test('every request states the secret, the client id, the level and the entry as host; one session carries all', async () => {
  await withEntry({}, async (h, v) => {
    await h.reaches(v.id, 'connected');
    const events = h.s.requests.find((r) => r.path.startsWith('/api/events'));
    assert.equal(events.path, `/api/events?client=${h.client.clientId}`);
    assert.equal(events.headers.accept, 'text/event-stream');
    for (const r of h.s.requests) {
      assert.equal(r.headers['x-aiwb-secret'], h.s.secret);
      assert.equal(r.headers['x-aiwb-client'], h.client.clientId);
      assert.equal(r.headers['x-aiwb-level'], '7');
      assert.equal(r.headers[':authority'], `${h.s.host}:${h.s.port}`);
    }
    assert.equal(h.s.sessions.size, 1);
    assert.equal((await h.client.call({ server: v.id, method: 'GET', path: '/api/state' })).status, 200);
    assert.equal(h.s.sessions.size, 1);
    assert.equal(opens(h).length, 1);
  });
});

test('the stream starts with a snapshot: what came before it is held and comes after it, in order, every time', async () => {
  await withEntry({ server: { beforeSnapshot: [{ type: 'a' }, { type: 'b' }] } }, async (h, v) => {
    await h.reaches(v.id, 'connected');
    assert.deepEqual(h.rec.eventsOf(v.id).map((e) => e.type), ['hello', 'a', 'b', 'snapshot']);
    // not one state of the entry says connected before the snapshot was read whole
    const firstConnected = h.rec.envelopes.findIndex((e) => e.app && e.app.server && e.app.server.state === 'connected');
    const lastBefore = h.rec.envelopes.map((e, i) => (e.event && e.event.type === 'snapshot' ? i : -1)).filter((i) => i >= 0)[0];
    assert.ok(lastBefore < firstConnected);
    h.s.cut();
    await until(() => h.rec.eventsOf(v.id).length === 8, 'the stream again');
    assert.deepEqual(h.rec.eventsOf(v.id).slice(4).map((e) => e.type), ['hello', 'a', 'b', 'snapshot']);
    h.s.emit({ type: 'tick' });
    await until(() => h.rec.eventsOf(v.id).length === 9, 'a tick after the return');
  });
});

test('the events before the snapshot are held up to a limit; a snapshot cut into pieces of three characters is the same snapshot', async () => {
  const many = Array.from({ length: 70 }, (_, i) => ({ type: 'early', n: i }));
  await withEntry({ server: { beforeSnapshot: many, snapshot: { agents: ['claude', 'é✓😀'], catalogs: {}, home: '/h', defaultCwd: '/h', chats: [] }, chunkSize: 3 } }, async (h, v) => {
    await h.reaches(v.id, 'connected');
    const early = h.rec.eventsOf(v.id).filter((e) => e.type === 'early');
    assert.equal(early.length, 63, 'sixty-four are held, the hello is one of them');
    assert.deepEqual(early.map((e) => e.n), many.slice(0, 63).map((e) => e.n));
    assert.deepEqual(h.rec.viewOf(v.id).agents, ['claude', 'é✓😀']);
    h.s.emit({ type: 'say', text: 'héllo ✓ 😀' });
    await until(() => h.rec.eventsOf(v.id).some((e) => e.type === 'say'), 'the event');
    assert.equal(h.rec.eventsOf(v.id).find((e) => e.type === 'say').text, 'héllo ✓ 😀');
  });
});

test('a server that sends no snapshot, or a snapshot with no state: not connected', async () => {
  await withEntry({ server: { noSnapshot: true }, timing: { ...T, firstEvent: 300, backoff: [60000] } }, async (h, v) => {
    await until(() => h.detail(v.id) === "The server's event stream did not open", 'no stream');
    assert.notEqual(h.state(v.id), 'connected');
  });
  await withEntry({ server: { snapshot: { agents: [], chats: [] } }, timing: { ...T, backoff: [60000] } }, async (h, v) => {
    await until(() => h.detail(v.id) === "Connected, but the server's state could not be read", 'no state');
    assert.equal(h.rec.eventsOf(v.id).length, 0, 'no event of a stream whose snapshot cannot be read');
  });
});

test('retry intervals: a refused entry is asked again after each step of the back-off, the last one repeating', async () => {
  const h = setup();
  try {
    h.s.down('refused');
    const waits = await spyWaits(async () => {
      h.subscribe();
      await h.add();
      await until(() => opens(h).length >= 5, 'five attempts');
    });
    assert.deepEqual(waits.slice(0, 4), [31, 62, 124, 124]);
    const at = opens(h).map((c) => c.at);
    waits.slice(0, 4).forEach((w, i) => assert.ok(at[i + 1] - at[i] >= w - 2, `attempt ${i + 2} came ${at[i + 1] - at[i]} ms after the one before, the step is ${w}`));
    assert.equal(h.s.dials, opens(h).length);
    assert.equal(h.s.requests.length, 0, 'nothing was sent to a server that was not reached');
    // the server comes back: the next attempt connects, with no one doing anything
    h.s.up();
    await h.reaches(h.rec.envelopes.find((e) => e.app && e.app.server).app.server.id, 'connected');
  } finally { await h.close(); }
});

test('back-off: a stream that ends at once counts as one more failed attempt; one that stayed open for `stable` starts it again', async () => {
  const h = setup({ timing: { ...T, stable: 300 } });
  try {
    h.s.onStream = () => { if (h.s.streamsOpened <= 2) setTimeout(() => h.s.cut(), 0); };
    const waits = await spyWaits(async () => {
      h.subscribe();
      const v = await h.add();
      await until(() => h.s.streamsOpened === 3, 'the third stream');
      await h.reaches(v.id, 'connected');
      await sleep(400); // above stable
      h.s.cut();
      await until(() => h.s.streamsOpened === 4, 'the fourth stream');
    });
    assert.deepEqual(waits, [31, 62, 31]);
  } finally { await h.close(); }
});

test('a cut: unreachable at once, no event of the entry until the next hello, then connected again', async () => {
  await withEntry({}, async (h, v) => {
    await h.reaches(v.id, 'connected');
    h.s.emit({ type: 'tick', n: 1 });
    await until(() => h.rec.eventsOf(v.id).length === 3, 'tick');
    h.s.cut();
    await until(() => h.state(v.id) !== 'connected', 'the cut');
    const afterCut = h.rec.envelopes.length;
    await until(() => h.state(v.id) === 'connected' && h.rec.eventsOf(v.id).length === 5, 'the return');
    const tail = h.rec.envelopes.slice(afterCut).filter((e) => e.server === v.id || (e.app && e.app.server && e.app.server.id === v.id));
    assert.deepEqual(tail.map((e) => (e.server ? e.event.type : `state:${e.app.server.state}`)).filter((x) => x !== 'state:unreachable'), ['hello', 'snapshot', 'state:connected']);
    assert.ok(h.rec.states(v.id).includes('unreachable'));
  });
});

test('a stream the server ends politely: unreachable "The connection to the server ended", then again', async () => {
  await withEntry({}, async (h, v) => {
    await h.reaches(v.id, 'connected');
    h.s.endStreams();
    await until(() => h.detail(v.id) === 'The connection to the server ended', 'the end');
    await until(() => h.state(v.id) === 'connected' && h.s.streamsOpened === 2, 'the stream again');
  });
});

test('silence: no byte for the silence limit ends the stream, and any byte keeps it, a ping or half a line', async () => {
  await withEntry({ timing: { ...T, silence: 200 } }, async (h, v) => {
    await h.reaches(v.id, 'connected');
    const t = setInterval(() => h.s.write(': p'), 40); // never a whole line
    await sleep(500); // more than twice the silence limit
    clearInterval(t);
    assert.equal(h.s.streamsOpened, 1);
    assert.equal(h.state(v.id), 'connected');
    await until(() => h.detail(v.id) === 'The server went silent', 'silence');
    await until(() => h.s.streamsOpened === 2 && h.state(v.id) === 'connected', 'the stream again');
  });
});

test('a refused secret stops the trying; the entry with another secret connects', async () => {
  const h = setup();
  try {
    h.subscribe();
    h.s.secret = 'the-secret-of-the-server';
    const v = await h.add({ secret: 'the-wrong-secret' });
    h.rec.secrets.add('the-wrong-secret');
    await h.reaches(v.id, 'secret_not_accepted');
    const asked = eventsRequests(h.s);
    await sleep(400); // seven steps of the back-off, were it trying
    assert.equal(eventsRequests(h.s), asked);
    assert.equal(opens(h).length, 1);
    assert.equal(h.state(v.id), 'secret_not_accepted');
    // a call to an entry in this state does not start it again
    assert.equal((await h.client.call({ server: v.id, method: 'GET', path: '/api/state' })).status, 503);
    assert.equal(opens(h).length, 1);
    // an edit of the secret makes a new connection
    h.rec.secrets.add(h.s.secret);
    const e = await h.app('servers.edit', { id: v.id, patch: { secret: h.s.secret }, force: true });
    assert.equal(e.body.saved, true);
    await h.reaches(v.id, 'connected');
    h.rec.assertNoSecrets();
  } finally { await h.close(); }
});

test('a secret the server takes back while the entry is connected: the next call ends it as secret_not_accepted', async () => {
  await withEntry({}, async (h, v) => {
    await h.reaches(v.id, 'connected');
    h.s.secret = 'changed-on-the-server';
    const r = await h.client.call({ server: v.id, method: 'GET', path: '/api/state' });
    assert.equal(r.status, 503);
    assert.equal(JSON.parse(r.text).code, 'server_unreachable');
    await h.reaches(v.id, 'secret_not_accepted');
    const asked = eventsRequests(h.s);
    await sleep(250);
    assert.equal(eventsRequests(h.s), asked, 'not asked again');
  });
});

test('a changed certificate: certificate_changed with the presented fingerprint, nothing sent, and an accept connects', async () => {
  const h = setup();
  try {
    h.subscribe();
    const pinned = h.s.fingerprint;
    h.s.setCert('b');
    assert.notEqual(h.s.fingerprint, pinned);
    const v = await h.add({ pin: pinned });
    await h.reaches(v.id, 'certificate_changed');
    assert.equal(h.rec.viewOf(v.id).fingerprint, h.s.fingerprint);
    assert.equal(h.rec.viewOf(v.id).pin, pinned);
    assert.equal(h.s.requests.length, 0, 'not a byte was sent to the new certificate');
    await sleep(200);
    assert.equal(opens(h).length, 1, 'it does not try again by itself');
    const a = await h.app('servers.accept', { id: v.id, fingerprint: h.s.fingerprint });
    assert.equal(a.status, 200);
    await h.reaches(v.id, 'connected');
    assert.equal(h.rec.viewOf(v.id).pin, h.s.fingerprint);
  } finally { await h.close(); }
});

test('a certificate that changes under a connected entry: the connection ends and the new one is not trusted', async () => {
  await withEntry({}, async (h, v) => {
    await h.reaches(v.id, 'connected');
    const sent = h.s.requests.length;
    h.s.setCert('b');
    h.s.cut();
    await h.reaches(v.id, 'certificate_changed');
    assert.equal(h.rec.viewOf(v.id).fingerprint, fingerprintFor('b'));
    assert.equal(h.s.requests.length, sent);
  });
});

test('no pin with the box on: fingerprint_not_accepted without dialing, and the test reads the certificate and sends nothing', async () => {
  const h = setup();
  try {
    h.subscribe();
    const v = await h.add({ pin: '' });
    await h.reaches(v.id, 'fingerprint_not_accepted');
    assert.equal(h.s.dials, 0);
    assert.equal(opens(h).length, 0);
    const a = await h.app('servers.test', { form: { address: h.s.address, secret: h.s.secret, selfSigned: true, pin: '' } });
    assert.deepEqual([a.body.ok, a.body.step, a.body.outcome, a.body.fingerprint], [false, 3, 'fingerprint', h.s.fingerprint]);
    assert.equal(h.connector.calls.filter((c) => c.op === 'readCertificate').length, 1);
    assert.equal(h.s.requests.length, 0);
  } finally { await h.close(); }
});

test('too old: the state, the version, hello asked again every tooOld and nothing else; it connects once the server was updated', async () => {
  await withEntry({ server: { level: 5 }, timing: { ...T, tooOld: 120 } }, async (h, v) => {
    await h.reaches(v.id, 'too_old');
    assert.equal(h.rec.viewOf(v.id).version, '1.2.3');
    await until(() => helloRequests(h.s) >= 4, 'hello again and again');
    assert.equal(eventsRequests(h.s), 0);
    assert.equal(h.state(v.id), 'too_old');
    const call = await h.client.call({ server: v.id, method: 'GET', path: '/api/state' });
    assert.equal(call.status, 503);
    assert.match(call.text, /too old: update the server on that machine/);
    h.s.level = 7; // updated on its machine
    await h.reaches(v.id, 'connected');
    assert.ok(eventsRequests(h.s) >= 1);
  });
});

test('local_network_denied is a state that retries by itself and connects once the permission is given', async () => {
  const h = setup();
  try {
    h.s.down('local_network_denied');
    h.subscribe();
    const v = await h.add();
    await until(() => h.detail(v.id) === 'This app may not reach the local network: allow it in the system settings', 'the denial');
    assert.equal(h.state(v.id), 'unreachable');
    const n = opens(h).length;
    await until(() => opens(h).length > n, 'another attempt');
    h.s.up();
    await h.reaches(v.id, 'connected');
  } finally { await h.close(); }
});

// The states of an attempt, one by one: [name, setup(server) → form fields to change, state, detail, timing].
const MESSAGES = {
  refused: 'Nothing listens there: is the server running on that machine?',
  tls: "No answer: is the VPN up, and does a firewall on the server's machine let the port through?",
};
const CASES = [
  ['refused', (s) => s.down('refused'), 'unreachable', MESSAGES.refused],
  ['nothing at the address', () => ({ address: 'https://nowhere.test:4748' }), 'unreachable', MESSAGES.refused],
  ['name not found', (s) => s.down('name_not_found'), 'unreachable', 'Name not found'],
  ['no route', (s) => s.down('no_route'), 'unreachable', 'No answer: is the VPN up?'],
  ['a dial that never ends', (s) => s.down('hang'), 'unreachable', 'No answer: is the VPN up?', { dial: 150 }],
  ['local network denied', (s) => s.down('local_network_denied'), 'unreachable', 'This app may not reach the local network: allow it in the system settings'],
  ['not https', (s) => { s.transport = 'plain'; }, 'unreachable', 'Not HTTPS: is this the address of an AI Whiteboard server?'],
  ['tls timeout', (s) => { s.handshakeHang = true; }, 'unreachable', MESSAGES.tls, { handshake: 150 }],
  ['no pin', () => ({ pin: '' }), 'fingerprint_not_accepted'],
  ['changed certificate', (s) => { s.setCert('b'); }, 'certificate_changed'],
  ['self-signed without the box', () => ({ selfSigned: false, pin: '' }), 'certificate_not_accepted', 'Self-signed certificate: tick the box'],
  ['a name the certificate is not for', (s) => { s.verdict = 'cert_name'; return { selfSigned: false, pin: '' }; }, 'certificate_not_accepted', 'The certificate is not for this name'],
  ['an expired certificate', (s) => { s.verdict = 'cert_expired'; return { selfSigned: false, pin: '' }; }, 'certificate_not_accepted', 'The certificate has expired'],
  ['an untrusted certificate', (s) => { s.verdict = 'cert_untrusted'; return { selfSigned: false, pin: '' }; }, 'certificate_not_accepted', 'The certificate is not trusted'],
  ['a certificate the roots trust, without the box', (s) => { s.verdict = 'trusted'; return { selfSigned: false, pin: '' }; }, 'connected'],
  ['no h2', (s) => { s.transport = 'http1'; }, 'not_aiwb'],
  ['wrong secret', (s) => { s.secret = 'the-secret-of-the-server'; return { secret: 'the-wrong-secret' }; }, 'secret_not_accepted'],
  ['bad host', (s) => { s.badHost = true; }, 'name_not_known'],
  ['not aiwb', (s) => { s.helloAnswer = () => ({ status: 200, text: 'hello' }); }, 'not_aiwb'],
  ['too old', (s) => { s.level = 5; }, 'too_old'],
  ['events refused', (s) => { s.eventsAnswer = () => ({ status: 500, text: '{}' }); }, 'unreachable', "The server's event stream did not open"],
  ['events not a stream', (s) => { s.eventsAnswer = () => ({ status: 200, text: '{}' }); }, 'unreachable', "The server's event stream did not open"],
  ['events bad host', (s) => { s.eventsAnswer = () => ({ status: 403, text: '{"error":"bad host"}' }); }, 'name_not_known'],
  ['events 403', (s) => { s.eventsAnswer = () => ({ status: 403, text: '{"error":"x"}' }); }, 'unreachable', "The server's event stream did not open"],
  ['events 401', (s) => { s.eventsAnswer = () => ({ status: 401, text: '{}' }); }, 'secret_not_accepted'],
  ['hello hangs', (s) => { s.hangPaths.add('/api/hello'); }, 'unreachable', 'No answer from the server', { hello: 200 }],
];

for (const [name, change, state, detail, timing] of CASES) {
  test(`state of an attempt: ${name} is ${state}`, async () => {
    const h = setup({ timing: { ...T, backoff: [60000], tooOld: 60000, ...timing } });
    try {
      h.subscribe();
      const over = change(h.s) || {};
      h.rec.secrets.add(h.s.secret);
      // the entry is pinned to the certificate the server has now, unless the case changes the pin
      const pin = name === 'changed certificate' ? fingerprintFor('a') : h.s.fingerprint;
      const v = await h.add({ pin, ...over });
      await until(() => h.state(v.id) === state && (detail === undefined || h.detail(v.id) === detail), `${name}: ${state}`);
      if (state === 'certificate_changed') assert.equal(h.rec.viewOf(v.id).fingerprint, h.s.fingerprint);
      if (state === 'too_old') assert.equal(h.rec.viewOf(v.id).version, '1.2.3');
      if (state === 'fingerprint_not_accepted' || state === 'certificate_changed') assert.equal(h.s.requests.length, 0, 'nothing is sent');
      h.rec.assertNoSecrets();
    } finally { await h.close(); }
  });
}

test('duplicate and another_server are the one state another_server', async () => {
  const h = setup();
  try {
    h.subscribe();
    const first = await h.add({}, 'First');
    await h.reaches(first.id, 'connected');
    // the same server under another name of the machine
    const twin = new ScriptedServer({ host: 'twin.test', port: 4748, cert: 'a', secret: h.s.secret, instanceId: h.s.instanceId });
    h.connector.add(twin);
    const twice = await h.app('servers.add', { force: true, form: { name: 'Twice', address: twin.address, secret: twin.secret, selfSigned: true, pin: twin.fingerprint } });
    await h.reaches(twice.body.server.id, 'another_server');
    assert.equal(h.detail(twice.body.server.id), 'Already added as First');
    // an entry that has an instance id and meets another server
    h.s.instanceId = 'cafecafe-cafe-4afe-8afe-cafecafecafe';
    h.s.cut();
    await h.reaches(first.id, 'another_server');
    assert.equal(h.detail(first.id), 'Another server answers at this address');
  } finally { await h.close(); }
});

test('Test connection: the five steps, hello without the secret and the state with it', async () => {
  const h = setup();
  try {
    const form = (extra = {}) => ({ address: h.s.address, secret: h.s.secret, selfSigned: true, pin: h.s.fingerprint, ...extra });
    h.rec.secrets.add(h.s.secret);
    let a = await h.app('servers.test', { form: form() });
    assert.deepEqual(a.body, { ok: true, step: 5, outcome: 'connected', message: 'Connected', version: '1.2.3', instanceId: h.s.instanceId, featureLevel: 7, agents: ['claude'] });
    const [hello, state] = h.s.requests;
    assert.equal(hello.path, '/api/hello');
    assert.equal(hello.headers['x-aiwb-secret'], undefined);
    assert.equal(state.path, '/api/state');
    assert.equal(state.headers['x-aiwb-secret'], h.s.secret);
    assert.equal(h.s.sessions.size, 0, 'the session of a test is closed');

    // a changed certificate names both fingerprints and sends nothing
    h.s.requests.length = 0;
    const wrong = fingerprintFor('someone else');
    a = await h.app('servers.test', { form: form({ pin: wrong }) });
    assert.deepEqual([a.body.ok, a.body.step, a.body.outcome, a.body.fingerprint, a.body.pinned], [false, 3, 'cert_changed', h.s.fingerprint, wrong]);
    assert.equal(h.s.requests.length, 0);

    // a refused secret ends at step 5, a hello that is not ours at step 4
    a = await h.app('servers.test', { form: form({ secret: 'the-wrong-secret' }) });
    assert.deepEqual([a.body.step, a.body.outcome], [4, 'secret_refused']); // the table puts it at step 4, the state is asked at 5
    h.s.helloAnswer = () => ({ status: 200, text: 'hello' });
    a = await h.app('servers.test', { form: form() });
    assert.deepEqual([a.body.step, a.body.outcome], [4, 'not_aiwb']);
    h.rec.assertNoSecrets();
  } finally { await h.close(); }
});

test('an entry added without force is tested first and saved with the server\'s instance id', async () => {
  const h = setup();
  try {
    const a = await h.app('servers.add', { form: { name: 'Tested', address: h.s.address, secret: h.s.secret, selfSigned: true, pin: h.s.fingerprint } });
    assert.equal(a.body.saved, true);
    assert.equal(a.body.server.instanceId, h.s.instanceId);
    assert.equal(h.store.saved.servers[0].instanceId, h.s.instanceId);
    const two = h.connector.add(new ScriptedServer({ host: 'two.test', secret: 'the-secret-of-two' }));
    const bad = await h.app('servers.add', { form: { name: 'Bad', address: two.address, secret: 'the-wrong-secret', selfSigned: true, pin: two.fingerprint } });
    assert.deepEqual([bad.body.saved, bad.body.result.outcome], [false, 'secret_refused']);
    assert.equal(h.store.saved.servers.length, 1);
  } finally { await h.close(); }
});

test('back-off: a call to an entry in its back-off tries now', async () => {
  await withEntry({ server: { eventsAnswer: () => ({ status: 500, text: '{}' }) }, timing: { ...T, backoff: [60000] } }, async (h, v) => {
    await until(() => eventsRequests(h.s) === 1, 'the first attempt');
    await h.reaches(v.id, 'unreachable');
    await sleep(150);
    assert.equal(eventsRequests(h.s), 1);
    h.s.eventsAnswer = null;
    const r = await h.client.call({ server: v.id, method: 'GET', path: '/api/state' });
    assert.equal(JSON.parse(r.text).code, 'server_unreachable');
    await h.reaches(v.id, 'connected');
    assert.equal(eventsRequests(h.s), 2);
  });
});

test('wake: every entry in its back-off tries now, and only that; one that waits for the user is left alone', async () => {
  await withEntry({ server: { eventsAnswer: () => ({ status: 500, text: '{}' }) }, timing: { ...T, backoff: [60000] } }, async (h, v) => {
    await until(() => eventsRequests(h.s) === 1, 'the first attempt');
    await h.reaches(v.id, 'unreachable');
    await sleep(150);
    assert.equal(eventsRequests(h.s), 1, 'the back-off holds');
    h.s.eventsAnswer = null;
    h.client.wake();
    await h.reaches(v.id, 'connected');
    assert.equal(eventsRequests(h.s), 2);
    h.client.wake();
    await sleep(100);
    assert.equal(eventsRequests(h.s), 2, 'a connected entry is not touched');
  });
  // a refused secret waits for the user: a wake does not try it again
  const h = setup({ timing: { ...T, backoff: [60000] } });
  try {
    h.s.secret = 'another';
    h.subscribe();
    const e = await h.add({ secret: 'wrong' });
    await h.reaches(e.id, 'secret_not_accepted');
    const before = helloRequests(h.s);
    h.client.wake();
    await sleep(150);
    assert.equal(helloRequests(h.s), before);
    assert.equal(h.state(e.id), 'secret_not_accepted');
  } finally { await h.close(); }
  // after close, wake does nothing and does not throw
  const c = setup();
  await c.close();
  assert.doesNotThrow(() => c.client.wake());
});

test('calls: the answer as it came, the route checked, the limit of the call, abort, a body that is no JSON', async () => {
  await withEntry({ timing: { ...T, call: 200, start: 200 } }, async (h, v) => {
    await h.reaches(v.id, 'connected');
    const call = (r) => h.client.call({ server: v.id, ...r });
    h.s.routes.set('GET /api/dirs', () => ({ json: { dirs: ['/a'] }, headers: { 'x-aiwb-scene-rev': '7' } }));
    h.s.routes.set('POST /api/chats/c1/messages', () => new Promise(() => {}));
    h.s.routes.set('GET /api/usage/claude', () => ({ text: 'not json' }));
    h.s.routes.set('POST /api/chats/c1/open', (req) => ({ json: { body: new TextDecoder().decode(req.body), type: req.headers['content-type'] } }));
    h.s.hangPaths.add('/api/chats/c2/context');

    assert.deepEqual(await call({ method: 'GET', path: '/api/dirs' }), { status: 200, text: '{"dirs":["/a"]}', sceneRev: 7 });
    assert.equal((await call({ method: 'GET', path: '/nothing' })).status, 400);
    assert.equal(JSON.parse((await call({ method: 'GET', path: '/api/usage/claude' })).text).code, 'bad_answer');
    const open = await call({ method: 'POST', path: '/api/chats/c1/open', body: { json: '{"é":1}' } });
    assert.deepEqual(JSON.parse(open.text), { body: '{"é":1}', type: 'application/json' });
    assert.equal((await call({ server: 'nobody', method: 'GET', path: '/api/dirs' })).status, 404);
    // a start has its own limit, a message that got no answer is not known to have arrived
    const sent = await call({ method: 'POST', path: '/api/chats/c1/messages', body: { json: '{}' } });
    assert.equal(JSON.parse(sent.text).code, 'send_unknown');
    assert.equal(JSON.parse((await call({ method: 'GET', path: '/api/chats/c2/context' })).text).code, 'no_answer');
    // abort
    const ac = new AbortController();
    const pending = h.client.call({ server: v.id, method: 'POST', path: '/api/chats/c1/messages', body: { json: '{}' }, signal: ac.signal });
    ac.abort();
    await assert.rejects(pending, (err) => err.name === 'AbortError');
    await assert.rejects(h.client.call({ server: v.id, method: 'GET', path: '/api/dirs', signal: ac.signal }), (err) => err.name === 'AbortError');
    assert.equal(h.state(v.id), 'connected');
  });
});

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

test('pictures: the type is taken from the bytes, the size is limited, eight at a time', async () => {
  await withEntry({}, async (h, v) => {
    await h.reaches(v.id, 'connected');
    const id = (n) => n.toString(16).padStart(64, '0');
    const pic = (n) => h.client.picture({ server: v.id, chat: 'c1', image: id(n) });
    h.s.routes.set(`GET /api/chats/c1/images/${id(1)}`, () => ({ bytes: PNG, type: 'text/html' }));
    h.s.routes.set(`GET /api/chats/c1/images/${id(2)}`, () => ({ bytes: new TextEncoder().encode('<svg onload=alert(1)>'), type: 'image/png' }));
    h.s.routes.set(`GET /api/chats/c1/images/${id(3)}`, () => ({ bytes: new Uint8Array((5 << 20) + 1), type: 'image/png' }));
    h.s.routes.set(`GET /api/chats/c1/images/${id(4)}`, () => ({ status: 404, json: { error: 'no such image', code: 'image_not_found' } }));
    const ok = await pic(1);
    assert.equal(ok.ok, true);
    assert.equal(ok.type, 'image/png');
    assert.deepEqual([...ok.data], [...PNG]);
    assert.deepEqual([(await pic(2)).ok, JSON.parse((await pic(2)).text).code], [false, 'bad_answer']);
    assert.equal(JSON.parse((await pic(3)).text).code, 'bad_answer');
    const gone = await pic(4);
    assert.deepEqual([gone.ok, gone.status, JSON.parse(gone.text).code], [false, 404, 'image_not_found']);
    assert.equal((await h.client.picture({ server: v.id, chat: 'c1', image: 'nothex' })).status, 400);

    // sixteen at once: eight are served at a time
    let now = 0;
    let most = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    for (let n = 10; n < 26; n++) {
      h.s.routes.set(`GET /api/chats/c1/images/${id(n)}`, async () => { now++; most = Math.max(most, now); await gate; now--; return { bytes: PNG }; });
    }
    const all = Array.from({ length: 16 }, (_, i) => pic(10 + i));
    await until(() => now === 8, 'eight in flight');
    await sleep(30);
    assert.equal(most, 8);
    release();
    assert.ok((await Promise.all(all)).every((r) => r.ok));
    // a picture on its way when the server takes the secret back ends the entry
    h.s.secret = 'changed-on-the-server';
    assert.equal((await pic(1)).status, 503);
    await h.reaches(v.id, 'secret_not_accepted');
  });
});

test('the list lives in the Store: a second client over it has the entry and the client id, and connects', async () => {
  const store = memoryStore();
  const h = setup({ store });
  let id;
  try {
    h.subscribe();
    id = (await h.add()).id;
    await h.reaches(id, 'connected');
  } finally { await h.close(); }
  assert.equal(h.s.sessions.size, 0, 'closing the client closes its session');
  const calls = h.connector.calls.length;
  await sleep(100);
  assert.equal(h.connector.calls.length, calls, 'a closed client does not try again');

  const again = setup({ store });
  again.connector.add(h.s);
  try {
    assert.equal(again.client.clientId, h.client.clientId);
    again.subscribe();
    await again.reaches(id, 'connected');
    assert.deepEqual(again.rec.viewOf(id).address, h.s.address);
    assert.equal(h.s.requests.at(-1).headers['x-aiwb-client'], h.client.clientId);
  } finally { await again.close(); }
});

test('what the client says holds no secret: not an envelope, an answer or a log line, with a server that quotes it', async () => {
  const h = setup();
  try {
    h.subscribe();
    h.s.secret = 'sekret-that-must-not-leak';
    h.s.helloAnswer = null;
    h.s.snapshotBody = { agents: [`claude-${h.s.secret}`], catalogs: {}, home: '/h', defaultCwd: '/h', chats: [] };
    const v = await h.add();
    await h.reaches(v.id, 'connected');
    assert.deepEqual(h.rec.viewOf(v.id).agents, ['claude-…']);
    h.s.stateAnswer = () => ({ status: 500, text: `{"error":"${h.s.secret}"}` });
    const a = await h.app('servers.test', { form: { address: h.s.address, secret: h.s.secret, selfSigned: true, pin: h.s.fingerprint } });
    h.rec.assertNoSecrets({ events: false }); // the events are the server's own, as it sent them
    assert.ok(!JSON.stringify(a.body).includes(h.s.secret));
  } finally { await h.close(); }
});

test('the fakes are platform-free: they require only core/ and each other', () => {
  const dir = path.join(__dirname, 'fakes');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.deepEqual(files.sort(), ['fake-connector.js', 'memory-store.js', 'scripted-server.js', 'support.js']);
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
    for (const m of text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) assert.match(m[1], /^(\.\.\/\.\.\/core\/[a-z0-9]+|\.\/[a-z-]+)$/, `${f} requires ${m[1]}`);
    for (const re of [/\bBuffer\b/, /\bprocess\b/, /\bDOMException\b/, /\bsetImmediate\b/, /\bTextDecoder\b/]) assert.doesNotMatch(text, re, `${f} names ${re}`);
  }
});
