'use strict';

// Test connection (C3.6): every outcome of the table that a stand-in can produce, at its step.

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const https = require('node:https');
const { standin, blackhole, plainHttp, closedPort, fingerprintOf, pem } = require('./standin');
const { make, addServer } = require('./harness');

const T = { testStep: 700, dial: 700, handshake: 700 };

// run tests a form with a fresh client and returns the result.
async function run(form, opts = {}) {
  const h = make({ timing: T, ...opts });
  try {
    const a = await h.app('servers.test', { form });
    assert.equal(a.status, 200);
    h.rec.keep(a.body);
    return { r: a.body, h };
  } finally {
    await h.close();
    h.cleanup();
  }
}

const pinned = (s, extra = {}) => ({ address: s.address, secret: s.secret, selfSigned: true, pin: s.fingerprint, ...extra });

test('connected: step 5, the version, the instance id, the level and the agents', async () => {
  const s = await standin();
  try {
    const { r } = await run(pinned(s));
    assert.deepEqual(r, {
      ok: true, step: 5, outcome: 'connected', message: 'Connected', version: '1.2.3', instanceId: s.instanceId, featureLevel: 7, agents: ['claude'],
    });
    // hello is asked without the secret (A10); the state with it; both state the client and the level
    const [hello, state] = s.requests;
    assert.equal(hello.path, '/api/hello');
    assert.equal(hello.headers['x-aiwb-secret'], undefined);
    assert.equal(state.path, '/api/state');
    assert.equal(state.headers['x-aiwb-secret'], s.secret);
    assert.equal(state.headers['x-aiwb-level'], '7');
    assert.match(state.headers['x-aiwb-client'], /^[0-9a-f-]{36}$/);
    assert.equal(state.headers[':authority'], `127.0.0.1:${s.port}`);
  } finally { await s.close(); }
});

test('a certificate from a CA the client trusts, for the name in the address: connected without the box', async () => {
  const s = await standin({ cert: 'leaf' });
  try {
    for (const host of ['127.0.0.1', 'localhost']) {
      const { r } = await run({ address: `https://${host}:${s.port}`, secret: s.secret });
      assert.equal(r.outcome, 'connected', host);
    }
  } finally { await s.close(); }
});

test('step 1: bad_address', async () => {
  for (const address of ['', 'http://127.0.0.1:1', 'https://127.0.0.1', 'https://x:1/path']) {
    const { r } = await run({ address, secret: 'sekret-1' });
    assert.deepEqual([r.ok, r.step, r.outcome], [false, 1, 'bad_address'], address);
  }
});

test('step 2: refused, name_not_found, no_route', async () => {
  const port = await closedPort();
  let { r } = await run({ address: `https://127.0.0.1:${port}`, secret: 'sekret-1' });
  assert.deepEqual([r.step, r.outcome, r.message], [2, 'refused', 'Nothing listens there: is the server running on that machine?']);

  ({ r } = await run({ address: 'https://no-such-host.invalid:4748', secret: 'sekret-1' }));
  assert.deepEqual([r.step, r.outcome], [2, 'name_not_found']);

  // a dial that never completes: the dial limit ends it
  const never = () => new net.Socket();
  ({ r } = await run({ address: 'https://10.255.255.1:4748', secret: 'sekret-1' }, { dial: never, timing: { ...T, dial: 150, testStep: 150 } }));
  assert.deepEqual([r.step, r.outcome], [2, 'no_route']);
});

test('step 3: tls_timeout (a TCP server that never answers), not_https (a plain HTTP server)', async () => {
  const b = await blackhole();
  const p = await plainHttp();
  try {
    let { r } = await run({ address: `https://127.0.0.1:${b.port}`, secret: 'sekret-1' }, { timing: { ...T, handshake: 200, testStep: 200 } });
    assert.deepEqual([r.step, r.outcome], [3, 'tls_timeout']);
    ({ r } = await run({ address: `https://127.0.0.1:${p.port}`, secret: 'sekret-1' }));
    assert.deepEqual([r.step, r.outcome, r.message], [3, 'not_https', 'Not HTTPS: is this the address of an AI Whiteboard server?']);
  } finally { b.close(); p.close(); }
});

test('step 3: fingerprint (the box on and no pin: the certificate is read and nothing is sent)', async () => {
  const s = await standin();
  try {
    const { r } = await run({ address: s.address, secret: s.secret, selfSigned: true });
    assert.deepEqual([r.step, r.outcome, r.fingerprint], [3, 'fingerprint', s.fingerprint]);
    assert.equal(s.requests.length, 0);
  } finally { await s.close(); }
});

test('step 3: cert_changed (the pin is another certificate): nothing is sent, both fingerprints are told', async () => {
  const s = await standin();
  try {
    const other = fingerprintOf('b');
    const { r } = await run(pinned(s, { pin: other.toLowerCase().replace(/:/g, '') }));
    assert.deepEqual([r.step, r.outcome, r.fingerprint, r.pinned], [3, 'cert_changed', s.fingerprint, other]);
    assert.equal(s.requests.length, 0);
    const bad = await run(pinned(s, { pin: 'not a fingerprint' }));
    assert.equal(bad.r.outcome, 'cert_changed');
    assert.equal(s.requests.length, 0);
  } finally { await s.close(); }
});

test('step 3 without the box: cert_name, cert_expired, self_signed, cert_untrusted', async () => {
  const cases = [
    ['othername', 'cert_name'],
    ['expired', 'cert_expired'],
    ['a', 'self_signed'],
  ];
  for (const [cert, outcome] of cases) {
    const s = await standin({ cert });
    try {
      const { r } = await run({ address: s.address, secret: s.secret });
      assert.deepEqual([r.step, r.outcome], [3, outcome], cert);
      assert.equal(s.requests.length, 0, 'nothing is sent to a certificate that was refused');
    } finally { await s.close(); }
  }
  // signed by a CA that is not trusted
  const s = await standin({ cert: 'leaf' });
  try {
    const { r } = await run({ address: s.address, secret: s.secret }, { roots: null });
    assert.deepEqual([r.step, r.outcome], [3, 'cert_untrusted']);
    assert.equal(s.requests.length, 0);
  } finally { await s.close(); }
});

test('step 4: secret_refused, bad_host, not_aiwb in each form, too_old', async () => {
  const s = await standin();
  try {
    // a wrong secret is found at the state read right after hello (A10)
    let { r } = await run(pinned(s, { secret: 'wrong-secret' }));
    assert.deepEqual([r.step, r.outcome, r.version, r.instanceId], [4, 'secret_refused', '1.2.3', s.instanceId]);
    ({ r } = await run(pinned(s, { secret: 'has a space' })));
    assert.equal(r.outcome, 'secret_refused');
    ({ r } = await run(pinned(s, { secret: '' })));
    assert.equal(r.outcome, 'secret_refused');

    s.helloAnswer = () => ({ status: 401, text: '{}' });
    ({ r } = await run(pinned(s)));
    assert.equal(r.outcome, 'secret_refused');

    s.helloAnswer = null;
    s.badHost = true;
    ({ r } = await run(pinned(s)));
    assert.deepEqual([r.step, r.outcome], [4, 'bad_host']);
    s.badHost = false;

    for (const answer of [
      { status: 200, text: 'not json' },
      { status: 200, text: '[]' },
      { status: 200, text: JSON.stringify({ app: 'other', instanceId: s.instanceId, featureLevel: 7 }) },
      { status: 200, text: JSON.stringify({ app: 'ai-whiteboard', instanceId: 'x', featureLevel: 7 }) },
      { status: 200, text: JSON.stringify({ app: 'ai-whiteboard', featureLevel: 7 }) },
      { status: 200, text: 'x'.repeat(100 << 10) },
    ]) {
      s.helloAnswer = () => answer;
      ({ r } = await run(pinned(s)));
      assert.deepEqual([r.step, r.outcome], [4, 'not_aiwb'], answer.text.slice(0, 20));
    }

    s.helloAnswer = () => ({ status: 500, text: JSON.stringify({ error: `boom ${s.secret} bang` }) });
    ({ r } = await run(pinned(s)));
    assert.deepEqual([r.outcome, r.detail], ['not_aiwb', 'HTTP 500: boom … bang']);
    s.helloAnswer = () => ({ status: 404, text: 'no' });
    ({ r } = await run(pinned(s)));
    assert.deepEqual([r.outcome, r.detail], ['not_aiwb', 'HTTP 404']);

    s.helloAnswer = null;
    s.level = 5;
    ({ r } = await run(pinned(s)));
    assert.deepEqual([r.step, r.outcome, r.version, r.featureLevel], [4, 'too_old', '1.2.3', 5]);
    s.level = 6; // the level before this one is refused the same way
    ({ r } = await run(pinned(s)));
    assert.deepEqual([r.step, r.outcome, r.version, r.featureLevel], [4, 'too_old', '1.2.3', 6]);
    s.level = undefined;
    ({ r } = await run(pinned(s)));
    assert.deepEqual([r.outcome, r.featureLevel], ['too_old', undefined]);
  } finally { await s.close(); }
});

test('step 4: not_aiwb for a server that does not speak HTTP/2', async () => {
  const server = https.createServer({ key: pem('a', 'key'), cert: pem('a', 'crt'), ALPNProtocols: ['http/1.1'] }, (req, res) => res.end('{}'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address();
    const { r } = await run({ address: `https://127.0.0.1:${port}`, secret: 'sekret-1', selfSigned: true, pin: fingerprintOf('a') });
    assert.deepEqual([r.step, r.outcome], [4, 'not_aiwb']);
  } finally { server.closeAllConnections(); server.close(); }
});

test('step 4: duplicate (the instance id another entry has) and another_server (not the one the entry has)', async () => {
  const s1 = await standin();
  const s2 = await standin();
  const h = make({ timing: T });
  try {
    const first = await h.app('servers.add', { form: { name: 'First', address: s1.address, secret: s1.secret, selfSigned: true, pin: s1.fingerprint } });
    assert.equal(first.body.saved, true);
    // the same server at another address of the machine
    let a = await h.app('servers.test', { form: { address: `https://localhost:${s1.port}`, secret: s1.secret, selfSigned: true, pin: s1.fingerprint } });
    assert.deepEqual([a.body.step, a.body.outcome, a.body.message], [4, 'duplicate', 'Already added as First']);
    // a saved entry whose server now has another id
    const second = await h.app('servers.add', { form: { name: 'Second', address: s2.address, secret: s2.secret, selfSigned: true, pin: s2.fingerprint } });
    assert.equal(second.body.saved, true);
    assert.equal(second.body.server.instanceId, s2.instanceId);
    s2.instanceId = require('./standin').uuid4();
    a = await h.app('servers.testSaved', { id: second.body.server.id });
    assert.deepEqual([a.body.step, a.body.outcome], [4, 'another_server']);
  } finally { await h.close(); h.cleanup(); await s1.close(); await s2.close(); }
});

test('step 4 or 5: no_answer when hello or the state does not come in time', async () => {
  const s = await standin();
  try {
    s.hangPaths.add('/api/hello');
    let { r } = await run(pinned(s), { timing: { ...T, testStep: 250 } });
    assert.deepEqual([r.step, r.outcome, r.detail], [4, 'no_answer', undefined]);
    s.hangPaths.clear();
    s.hangPaths.add('/api/state');
    ({ r } = await run(pinned(s), { timing: { ...T, testStep: 250 } }));
    assert.deepEqual([r.step, r.outcome, r.version, r.instanceId], [5, 'no_answer', '1.2.3', s.instanceId]);
  } finally { await s.close(); }
});

test('step 5: no_state for a state that is no state; the secret is hidden in every text', async () => {
  const s = await standin();
  try {
    for (const answer of [
      { status: 200, text: 'nope' },
      { status: 200, text: '{}' },
      { status: 200, text: JSON.stringify({ agents: {}, catalogs: {}, home: 'h', defaultCwd: 'd', chats: [] }) },
      { status: 200, text: JSON.stringify({ agents: [], catalogs: {}, home: '', defaultCwd: 'd', chats: [] }) },
      { status: 500, text: '{}' },
    ]) {
      s.stateAnswer = () => answer;
      const { r } = await run(pinned(s));
      assert.deepEqual([r.step, r.outcome], [5, 'no_state'], answer.text);
    }
    // a version that quotes the secret is shown without it
    s.stateAnswer = null;
    s.version = `v ${s.secret} x`;
    const { r, h } = await run(pinned(s));
    assert.equal(r.version, 'v … x');
    h.rec.secrets.add(s.secret);
    h.rec.assertNoSecrets();
  } finally { await s.close(); }
});
