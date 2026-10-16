'use strict';

// The connection of an entry (C3.4, C3.5): the states of every attempt, the order of events, the
// silence watchdog, the back-off, the stops, and the life of a subscription.

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { standin, blackhole, plainHttp, closedPort, fingerprintOf, uuid4, StandIn } = require('./standin');
const { make, addServer, until, sleep } = require('./harness');

const T = { backoff: [20, 40, 80], stable: 150 };

// withEntry runs fn with a subscribed client whose list has the stand-in as its one entry.
async function withEntry(s, fn, { timing = T, form = {}, ...opts } = {}) {
  const h = make({ timing, ...opts });
  try {
    h.subscribe();
    const v = await addServer(h, s, 'Remote', form);
    await fn(h, v);
  } finally {
    await h.close();
    h.cleanup();
    await s.close();
  }
}

const stateOf = (h, id) => h.rec.stateOf(id);
const reaches = (h, id, state) => until(() => stateOf(h, id) === state, `${id} to be ${state}`);
const eventsRequests = (s) => s.requests.filter((r) => r.path.startsWith('/api/events')).length;
const helloRequests = (s) => s.requests.filter((r) => r.path === '/api/hello').length;

test('connected: hello and the snapshot as the server sent them, then connected, then the events in order', async () => {
  const s = await standin();
  await withEntry(s, async (h, v) => {
    await reaches(h, v.id, 'connected');
    for (let i = 1; i <= 5; i++) s.emit({ type: 'tick', n: i });
    s.ping();
    await until(() => h.rec.eventsOf(v.id).length === 7, 'five events');
    const mine = h.rec.envelopes.filter((e) => e.server === v.id || (e.app && e.app.type === 'server_state' && e.app.server.id === v.id));
    assert.deepEqual(mine.map((e) => (e.server ? e.event.type + (e.event.n || '') : `state:${e.app.server.state}`)), [
      'hello', 'snapshot', 'state:connected', 'tick1', 'tick2', 'tick3', 'tick4', 'tick5',
    ]);
    assert.deepEqual(h.rec.eventsOf(v.id)[0], { type: 'hello', instanceId: s.instanceId });
    assert.deepEqual(h.rec.eventsOf(v.id)[1], s.snapshotEvent());
    const view = h.rec.viewOf(v.id);
    assert.deepEqual([view.state, view.version, view.agents, view.address, view.instanceId], ['connected', '1.2.3', ['claude'], s.address, s.instanceId]);
    assert.equal('secret' in view, false);
  });
});

test('every request states the secret, the client id, the level and the entry as host', async () => {
  const s = await standin();
  await withEntry(s, async (h, v) => {
    await reaches(h, v.id, 'connected');
    const events = s.requests.find((r) => r.path.startsWith('/api/events'));
    assert.equal(events.path, `/api/events?client=${h.client.clientId}`);
    for (const r of s.requests) {
      assert.equal(r.headers['x-aiwb-secret'], s.secret);
      assert.equal(r.headers['x-aiwb-client'], h.client.clientId);
      assert.equal(r.headers['x-aiwb-level'], '7');
      assert.equal(r.headers[':authority'], `127.0.0.1:${s.port}`);
    }
    assert.equal(events.headers.accept, 'text/event-stream');
    // one HTTP/2 connection carries everything
    assert.equal(s.sessions.size, 1);
    const r = await h.client.call({ server: v.id, method: 'GET', path: '/api/state' });
    assert.equal(r.status, 200);
    assert.equal(s.sessions.size, 1);
  });
});

test('events before the snapshot (the hello) come after it is read whole, in order', async () => {
  const s = await standin({ withHello: true });
  await withEntry(s, async (h, v) => {
    await reaches(h, v.id, 'connected');
    const types = h.rec.eventsOf(v.id).map((e) => e.type);
    assert.deepEqual(types, ['hello', 'snapshot']);
  });
});

test('a cut: unreachable at once, no event of the entry until the next hello, then connected again', async () => {
  const s = await standin();
  await withEntry(s, async (h, v) => {
    await reaches(h, v.id, 'connected');
    s.emit({ type: 'tick', n: 1 });
    await until(() => h.rec.eventsOf(v.id).length === 3, 'tick');
    s.cut();
    await until(() => h.rec.states(v.id).filter((x) => x === 'connected').length === 1 && stateOf(h, v.id) !== 'connected', 'the cut');
    const afterCut = h.rec.envelopes.length;
    await until(() => stateOf(h, v.id) === 'connected' && h.rec.eventsOf(v.id).length === 5, 'the return');
    const tail = h.rec.envelopes.slice(afterCut).filter((e) => e.server === v.id || (e.app && e.app.server && e.app.server.id === v.id));
    assert.deepEqual(tail.map((e) => (e.server ? e.event.type : `state:${e.app.server.state}`)).filter((x) => x !== 'state:unreachable'),
      ['hello', 'snapshot', 'state:connected']);
    // the new stream begins with the snapshot; the first event of it is a hello
    assert.equal(h.rec.states(v.id).includes('unreachable'), true);
    const view = h.rec.viewOf(v.id);
    assert.equal(view.state, 'connected');
    s.emit({ type: 'tick', n: 2 });
    await until(() => h.rec.eventsOf(v.id).length === 6, 'tick 2 after the return');
  });
});

test('a stream the server ends politely: unreachable "The connection to the server ended", then again', async () => {
  const s = await standin();
  await withEntry(s, async (h, v) => {
    await reaches(h, v.id, 'connected');
    s.endStreams();
    await until(() => h.rec.envelopes.some((e) => e.app && e.app.server && e.app.server.detail === 'The connection to the server ended'), 'the end');
    await until(() => stateOf(h, v.id) === 'connected' && s.streamsOpened === 2, 'the stream again');
  });
});

test('silence: no byte for the silence limit ends the stream; pings keep it', async () => {
  const s = await standin();
  await withEntry(s, async (h, v) => {
    await reaches(h, v.id, 'connected');
    const t = setInterval(() => s.ping(), 100);
    await sleep(1500); // 2.5 times the silence limit
    clearInterval(t);
    assert.equal(s.streamsOpened, 1);
    assert.equal(stateOf(h, v.id), 'connected');
    await until(() => h.rec.envelopes.some((e) => e.app && e.app.server && e.app.server.detail === 'The server went silent'), 'silence');
    await until(() => s.streamsOpened === 2 && stateOf(h, v.id) === 'connected', 'the stream again');
  }, { timing: { ...T, silence: 600 } });
});

test('a server that sends no snapshot, or a snapshot with no state: not connected', async () => {
  const s = await standin();
  s.noSnapshot = true;
  await withEntry(s, async (h, v) => {
    await until(() => h.rec.envelopes.some((e) => e.app && e.app.server && e.app.server.detail === "The server's event stream did not open"), 'no stream');
    assert.equal(stateOf(h, v.id) === 'connected', false);
  }, { timing: { ...T, firstEvent: 300, backoff: [60000] } });

  const bad = await standin({ snapshot: { agents: [], chats: [] } });
  await withEntry(bad, async (h, v) => {
    await until(() => h.rec.envelopes.some((e) => e.app && e.app.server && e.app.server.detail === "Connected, but the server's state could not be read"), 'no state');
    assert.equal(h.rec.eventsOf(v.id).length, 0, 'no event of a stream whose snapshot cannot be read');
  }, { timing: { ...T, backoff: [60000] } });
});

test('states of an attempt, one by one', async (t) => {
  const port = await closedPort();
  const plain = await plainHttp();
  const black = await blackhole();
  t.after(() => { plain.close(); black.close(); });
  const cases = [
    ['refused', async () => ({ address: `https://127.0.0.1:${port}` }), 'unreachable', 'Nothing listens there: is the server running on that machine?'],
    ['not https', async () => ({ address: `https://127.0.0.1:${plain.port}` }), 'unreachable', 'Not HTTPS: is this the address of an AI Whiteboard server?'],
    ['tls timeout', async () => ({ address: `https://127.0.0.1:${black.port}` }), 'unreachable', "No answer: is the VPN up, and does a firewall on the server's machine let the port through?", { handshake: 200 }],
    ['name not found', async () => ({ address: 'https://no-such-host.invalid:4748' }), 'unreachable', 'Name not found'],
    ['no pin', async (s) => ({ pin: '' }), 'fingerprint_not_accepted', undefined],
    ['changed certificate', async (s) => ({ pin: fingerprintOf('b') }), 'certificate_changed', undefined],
    ['self-signed without the box', async (s) => ({ selfSigned: false, pin: '' }), 'certificate_not_accepted', undefined],
    ['wrong secret', async (s) => ({ secret: 'wrong-secret' }), 'secret_not_accepted', undefined],
    ['bad host', async (s) => { s.badHost = true; return {}; }, 'name_not_known', undefined],
    ['not aiwb', async (s) => { s.helloAnswer = () => ({ status: 200, text: 'hello' }); return {}; }, 'not_aiwb', undefined],
    ['too old', async (s) => { s.level = 5; return {}; }, 'too_old', undefined],
    ['events refused', async (s) => { s.eventsAnswer = () => ({ status: 500, text: '{}' }); return {}; }, 'unreachable', "The server's event stream did not open"],
    ['events not a stream', async (s) => { s.eventsAnswer = () => ({ status: 200, text: '{}' }); return {}; }, 'unreachable', "The server's event stream did not open"],
    ['events bad host', async (s) => { s.eventsAnswer = () => ({ status: 403, text: '{"error":"bad host"}' }); return {}; }, 'name_not_known', undefined],
    ['events 403', async (s) => { s.eventsAnswer = () => ({ status: 403, text: '{"error":"x"}' }); return {}; }, 'unreachable', "The server's event stream did not open"],
    ['events 401', async (s) => { s.eventsAnswer = () => ({ status: 401, text: '{}' }); return {}; }, 'secret_not_accepted', undefined],
    ['hello hangs', async (s) => { s.hangPaths.add('/api/hello'); return {}; }, 'unreachable', 'No answer from the server', { hello: 250 }],
  ];
  for (const [name, setup, state, detail, timing] of cases) {
    const s = await standin();
    const over = await setup(s);
    const h = make({ timing: { ...T, backoff: [60000], tooOld: 60000, ...timing } });
    try {
      h.subscribe();
      h.rec.secrets.add(s.secret);
      const a = await h.app('servers.add', { force: true, form: { name: 'R', address: s.address, secret: s.secret, selfSigned: true, pin: s.fingerprint, ...over } });
      assert.equal(a.status, 200, `${name}: ${JSON.stringify(a.body)}`);
      const id = a.body.server.id;
      await until(() => stateOf(h, id) === state && (detail === undefined || h.rec.viewOf(id).detail === detail), `${name}: ${state}`);
      const v = h.rec.viewOf(id);
      assert.equal(v.state, state, name);
      if (state === 'certificate_changed') assert.equal(v.fingerprint, s.fingerprint, name);
      if (state === 'too_old') assert.equal(v.version, '1.2.3', name);
      if (state === 'fingerprint_not_accepted' || state === 'certificate_changed') assert.equal(s.requests.length, 0, `${name}: nothing is sent`);
      h.rec.assertNoSecrets();
    } finally { await h.close(); h.cleanup(); await s.close(); }
  }
});

test('duplicate and another_server are the one state another_server', async () => {
  const s = await standin();
  const h = make({ timing: T });
  try {
    h.subscribe();
    const first = await addServer(h, s, 'First');
    await reaches(h, first.id, 'connected');
    // the same server at another address of the machine
    const twice = await h.app('servers.add', { force: true, form: { name: 'Twice', address: `https://localhost:${s.port}`, secret: s.secret, selfSigned: true, pin: s.fingerprint } });
    const id = twice.body.server.id;
    await until(() => stateOf(h, id) === 'another_server', 'another_server');
    assert.equal(h.rec.viewOf(id).detail, 'Already added as First');
    // an entry that has an instance id and meets another server
    s.instanceId = uuid4();
    const edited = await h.app('servers.edit', { id: first.id, patch: { name: 'First' }, force: true });
    assert.equal(edited.body.saved, true);
    assert.equal(stateOf(h, first.id), 'connected', 'a rename keeps the connection');
    s.cut();
    await until(() => stateOf(h, first.id) === 'another_server', 'another server answers');
    assert.equal(h.rec.viewOf(first.id).detail, 'Another server answers at this address');
  } finally { await h.close(); h.cleanup(); await s.close(); }
});

test('back-off: a refused entry is asked again by itself, ever less often, and Retry (a call) asks at once', async () => {
  const s = await standin();
  s.eventsAnswer = () => ({ status: 500, text: '{}' });
  await withEntry(s, async (h, v) => {
    await until(() => eventsRequests(s) === 2, 'two attempts');
    await sleep(300); // the next wait is 60 s
    assert.equal(eventsRequests(s), 2);
    assert.equal(stateOf(h, v.id), 'unreachable');
    // a call to an entry in its back-off tries now, and answers 503 for the call itself
    s.eventsAnswer = null;
    const r = await h.client.call({ server: v.id, method: 'GET', path: '/api/state' });
    assert.equal(r.status, 503);
    await reaches(h, v.id, 'connected');
    assert.equal(eventsRequests(s), 3);
  }, { timing: { ...T, backoff: [30, 60000], stable: 60000 } });
});

test('a stream that stayed open for the stable time starts the back-off again at its first step', async () => {
  const s = await standin();
  await withEntry(s, async (h, v) => {
    await reaches(h, v.id, 'connected');
    s.cut(); // a stream that ended at once: the first wait (10 ms), then the long one
    await until(() => s.streamsOpened === 2 && stateOf(h, v.id) === 'connected', 'the second stream');
    await sleep(400); // longer than the stable time
    s.cut();
    await until(() => s.streamsOpened === 3 && stateOf(h, v.id) === 'connected', 'the third stream: the wait began at its first step again');
    s.cut();
    await sleep(500);
    assert.equal(s.streamsOpened, 3, 'a stream that ended at once counts as one more failed attempt: the wait is the long one');
  }, { timing: { ...T, backoff: [10, 60000], stable: 300, silence: 5000 } });
});

test('stopped states wait for the user: a refused secret is not asked again until an edit or a test', async () => {
  const s = await standin();
  await withEntry(s, async (h, v) => {
    await reaches(h, v.id, 'secret_not_accepted');
    const hellos = helloRequests(s);
    await sleep(300);
    assert.equal(helloRequests(s), hellos, 'nothing is sent while the user has not done something');
    // the server now takes the secret; testing the saved entry gets the connection going again
    s.secret = 'wrong-secret-x';
    const t = await h.app('servers.testSaved', { id: v.id });
    assert.equal(t.body.outcome, 'connected');
    await reaches(h, v.id, 'connected');
  }, { form: { secret: 'wrong-secret' + '-x' } });
});

test('an edit that gives the secret again leaves a stopped state; a plain rename does not', async () => {
  const s = await standin();
  await withEntry(s, async (h, v) => {
    await reaches(h, v.id, 'secret_not_accepted');
    const hellos = helloRequests(s);
    const r = await h.app('servers.edit', { id: v.id, patch: { name: 'Renamed' }, force: true });
    assert.equal(r.body.saved, true);
    await sleep(200);
    assert.equal(helloRequests(s), hellos, 'a rename asks nothing');
    const e = await h.app('servers.edit', { id: v.id, patch: { secret: s.secret }, force: true });
    assert.equal(e.body.saved, true);
    await reaches(h, v.id, 'connected');
  }, { form: { secret: 'not-the-secret' } });
});

test('a changed certificate stops until it is accepted; accept connects with the new pin', async () => {
  const s = await standin();
  await withEntry(s, async (h, v) => {
    await reaches(h, v.id, 'connected');
    s.setCert('b');
    s.cut();
    await reaches(h, v.id, 'certificate_changed');
    assert.equal(h.rec.viewOf(v.id).fingerprint, fingerprintOf('b'));
    const requests = s.requests.length;
    // a test of the saved entry does not leave this state
    const t = await h.app('servers.testSaved', { id: v.id });
    assert.equal(t.body.outcome, 'cert_changed');
    await sleep(200);
    assert.equal(stateOf(h, v.id), 'certificate_changed');
    assert.equal(s.requests.length, requests, 'nothing is sent to a certificate the pin refuses');
    const a = await h.app('servers.accept', { id: v.id, fingerprint: fingerprintOf('b') });
    assert.equal(a.status, 200);
    assert.equal(a.body.server.pin, fingerprintOf('b'));
    await reaches(h, v.id, 'connected');
    const bad = await h.app('servers.accept', { id: v.id, fingerprint: 'nonsense' });
    assert.deepEqual([bad.status, bad.body.code], [400, 'bad_pin']);
  });
});

test('too_old is the one stopped state that asks again by itself, in that state, and connects once updated', async () => {
  const s = await standin();
  s.level = 5;
  await withEntry(s, async (h, v) => {
    await reaches(h, v.id, 'too_old');
    await until(() => helloRequests(s) >= 3, 'hello asked again');
    assert.equal(stateOf(h, v.id), 'too_old');
    assert.equal(h.rec.states(v.id).filter((x) => x === 'connecting').length, 0, 'the state is not put back on connecting meanwhile');
    s.level = 7;
    await reaches(h, v.id, 'connected');
  }, { timing: { ...T, tooOld: 100 } });
});

test('subscribe / close: connections run only with a subscription, and start again from their first attempt', async () => {
  const s = await standin();
  const h = make({ timing: T });
  try {
    const first = h.subscribe();
    const v = await addServer(h, s);
    await reaches(h, v.id, 'connected');
    first.close();
    await until(() => s.streams.size === 0, 'the stream to close');
    const count = h.rec.envelopes.length;
    s.emit({ type: 'late' });
    await sleep(200);
    assert.equal(h.rec.envelopes.length, count, 'a closed subscription hears nothing');
    assert.equal(s.streamsOpened, 1);
    // a new subscription: the list, the state of every entry, then the entry's events
    const again = [];
    h.client.subscribe((e) => again.push(e));
    await until(() => again.some((e) => e.server === v.id && e.event.type === 'snapshot'), 'a new snapshot');
    assert.deepEqual(again.slice(0, 2).map((e) => e.app && e.app.type), ['servers', 'server_state']);
    assert.equal(again[0].app.servers.length, 1);
    assert.equal(s.streamsOpened, 2);
  } finally { await h.close(); h.cleanup(); await s.close(); }
});

test('a new subscription ends the old one', async () => {
  const s = await standin();
  const h = make({ timing: T });
  try {
    const old = [];
    const fresh = [];
    h.client.subscribe((e) => old.push(e));
    const v = await h.app('servers.add', { force: true, form: { name: 'R', address: s.address, secret: s.secret, selfSigned: true, pin: s.fingerprint } });
    await until(() => old.some((e) => e.server === v.body.server.id && e.event.type === 'snapshot'), 'the first subscriber hears the snapshot');
    h.client.subscribe((e) => fresh.push(e));
    await until(() => fresh.some((e) => e.event && e.event.type === 'snapshot'), 'the second hears one');
    const n = old.length;
    s.emit({ type: 'tick' });
    await until(() => fresh.some((e) => e.event && e.event.type === 'tick'), 'a tick');
    assert.equal(old.length, n);
  } finally { await h.close(); h.cleanup(); await s.close(); }
});

test('remove ends the connection and the server is sent nothing; the entry is gone from the list', async () => {
  const s = await standin();
  await withEntry(s, async (h, v) => {
    await reaches(h, v.id, 'connected');
    const before = s.requests.length;
    const r = await h.app('servers.remove', { id: v.id });
    assert.deepEqual([r.status, r.body], [200, { ok: true }]);
    await until(() => s.streams.size === 0, 'the stream to close');
    assert.equal(s.requests.length, before);
    const list = await h.app('servers.list');
    assert.deepEqual(list.body.servers, []);
    const last = h.rec.envelopes.filter((e) => e.app && e.app.type === 'servers').pop();
    assert.deepEqual(last.app.servers, []);
    const again = await h.client.call({ server: v.id, method: 'GET', path: '/api/state' });
    assert.equal(again.status, 404);
  });
});

test('an edit of the address replaces the connection: the old session is closed and the new one asks as the new name', async () => {
  const s = await standin();
  await withEntry(s, async (h, v) => {
    await reaches(h, v.id, 'connected');
    const edited = await h.app('servers.edit', { id: v.id, patch: { address: `https://localhost:${s.port}` }, force: true });
    assert.equal(edited.body.saved, true);
    assert.equal(edited.body.server.address, `https://localhost:${s.port}`);
    // (the state is `connected` from before the edit until the new connection says otherwise: wait for the view of the new address)
    await until(() => s.streamsOpened === 2 && s.streams.size === 1 && s.sessions.size === 1 && stateOf(h, v.id) === 'connected'
      && h.rec.viewOf(v.id).address === `https://localhost:${s.port}`, 'the connection moved');
    assert.equal(s.requests.at(-1).headers[':authority'], `localhost:${s.port}`);
    assert.equal(h.rec.viewOf(v.id).address, `https://localhost:${s.port}`);
  });
});

test('a pin that is no fingerprint, and a secret in every text: nothing leaks', async () => {
  const s = await standin({ secret: 'sekret-leak-1' });
  s.version = `v-${s.secret}`;
  s.snapshotBody = { ...s.snapshotBody, agents: [`a-${s.secret}`, 'claude'] };
  await withEntry(s, async (h, v) => {
    await reaches(h, v.id, 'connected');
    assert.equal(h.rec.viewOf(v.id).version, 'v-…');
    assert.deepEqual(h.rec.viewOf(v.id).agents, ['a-…', 'claude']);
    s.emit({ type: 'agents', agents: [`x-${s.secret}`] });
    await until(() => h.rec.viewOf(v.id).agents[0] === 'x-…', 'the agents event');
    const list = await h.app('servers.list');
    h.rec.assertNoSecrets({ events: false }); // the server's own events are passed as it sent them
    assert.equal(JSON.stringify(list).includes(s.secret), false);
    // the file holds the secret and nothing else is allowed to
    assert.ok(require('node:fs').readFileSync(require('node:path').join(h.dir, 'servers.json'), 'utf8').includes(s.secret));
  });
});

test('a TLS handshake that stays open and a server that closes at once do not stop the loop', async () => {
  const server = net.createServer((sock) => sock.destroy());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const h = make({ timing: { ...T, backoff: [20] } });
  try {
    h.subscribe();
    const a = await h.app('servers.add', { force: true, form: { name: 'R', address: `https://127.0.0.1:${server.address().port}`, secret: 'sekret-2', selfSigned: true, pin: fingerprintOf('a') } });
    await until(() => stateOf(h, a.body.server.id) === 'unreachable', 'unreachable');
    assert.equal(h.rec.viewOf(a.body.server.id).detail, 'The secure connection failed');
  } finally { await h.close(); h.cleanup(); server.close(); }
});
