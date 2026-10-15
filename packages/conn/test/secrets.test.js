'use strict';

// No secret reaches the page: not in an envelope, an answer of the app or a log line; the file that
// holds them is the one place. And the module is plain Node.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { standin, fingerprintOf } = require('./standin');
const { make, addServer, until, sleep } = require('./harness');

const T = { backoff: [20, 40, 80], stable: 150 };
const mode = (p) => fs.statSync(p).mode & 0o777;

test('what a hostile server says is shown without the secret of its entry, in every field the app shows', async () => {
  const s = await standin({ secret: 'sekret-hostile-1' });
  const S = s.secret;
  s.version = `1.0-${S}`;
  s.snapshotBody = { ...s.snapshotBody, agents: [`${S}`, `claude-${S}`] };
  const h = make({ timing: { ...T, backoff: [60000] } });
  const seen = [];
  const keep = (a) => { seen.push(JSON.stringify(a)); return a; };
  try {
    h.rec.secrets.add(S);
    h.subscribe();
    const v = await addServer(h, s, 'Hostile');
    await until(() => h.rec.stateOf(v.id) === 'connected', 'connected');
    // every state a hostile server can put text in
    s.helloAnswer = () => ({ status: 500, text: JSON.stringify({ error: `bad ${S}` }) });
    keep(await h.app('servers.test', { form: { address: s.address, secret: S, selfSigned: true, pin: s.fingerprint } }));
    s.helloAnswer = null;
    s.stateAnswer = () => ({ status: 200, text: JSON.stringify({ agents: [S], catalogs: {}, home: 'h', defaultCwd: 'd', chats: [] }) });
    keep(await h.app('servers.test', { form: { address: s.address, secret: S, selfSigned: true, pin: s.fingerprint } }));
    keep(await h.app('servers.testSaved', { id: v.id }));
    keep(await h.app('servers.list'));
    keep(await h.app('servers.edit', { id: v.id, patch: { name: 'Renamed' }, force: true }));
    s.eventsAnswer = () => ({ status: 403, text: JSON.stringify({ error: S }) });
    s.cut();
    await sleep(100);
    // a certificate problem quotes the network's text: no secret in it either
    const bad = await h.app('servers.test', { form: { address: s.address, secret: 'x'.repeat(8) } });
    keep(bad);
    h.rec.assertNoSecrets({ events: false });
    for (const text of seen) assert.equal(text.includes(S), false);
    // the file holds it, with the mode of a secret
    assert.equal(mode(path.join(h.dir, 'servers.json')), 0o600);
    assert.equal(mode(path.join(h.dir, 'client-id')), 0o600);
    assert.equal(mode(h.dir), 0o700);
    assert.ok(fs.readFileSync(path.join(h.dir, 'servers.json'), 'utf8').includes(S));
  } finally { await h.close(); h.cleanup(); await s.close(); }
});

test('a start that quotes the secret in its error shows it without the secret', async () => {
  const s = await standin({ secret: 'sekret-local-1' });
  let n = 0;
  const run = async (args) => {
    if (args[0] === 'secret') return { code: 0, stdout: s.secret + '\n', stderr: '' };
    n++;
    if (n === 1) return { code: 0, stdout: JSON.stringify({ state: 'running', address: s.address, fingerprint: s.fingerprint, version: '1', instanceId: s.instanceId, pid: 1, home: '/h' }) + '\n', stderr: '' };
    return { code: 1, stdout: '', stderr: `launch failed with secret ${s.secret} in it\n` };
  };
  const h = make({ timing: { ...T, backoff: [60000] }, local: { bin: '/x', run } });
  try {
    h.rec.secrets.add(s.secret);
    h.subscribe();
    await until(() => h.rec.stateOf('local') === 'connected', 'connected');
    s.cut();
    await until(() => h.rec.stateOf('local') === 'unreachable', 'unreachable');
    await h.app('owner.retry');
    await until(() => h.rec.stateOf('local') === 'not_started', 'not_started');
    assert.equal(h.rec.viewOf('local').detail, 'launch failed with secret … in it');
    h.rec.assertNoSecrets({ events: false });
  } finally { await h.close(); h.cleanup(); await s.close(); }
});

test('a subscriber that throws is logged without harm; the log holds no secret', async () => {
  const s = await standin({ secret: 'sekret-throw-1' });
  const h = make({ timing: T });
  try {
    h.rec.secrets.add(s.secret);
    h.client.subscribe(() => { throw new Error('page is gone'); });
    const v = await addServer(h, s);
    await until(() => h.rec.logs.length > 0, 'a log line');
    assert.ok(h.rec.logs.every((l) => l.startsWith('subscriber: page is gone')));
    await until(async () => (await h.app('servers.list')).body.servers[0].state === 'connected', 'connected');
    assert.equal((await h.client.call({ server: v.id, method: 'GET', path: '/api/state' })).status, 200);
    h.rec.assertNoSecrets();
  } finally { await h.close(); h.cleanup(); await s.close(); }
});

test('the module imports Node built-ins and its own files only: no Electron, no npm package', () => {
  const root = path.join(__dirname, '..');
  for (const sub of ['', 'core', 'node']) {
    const dir = path.join(root, sub);
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const m of text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        assert.match(m[1], /^(node:[a-z0-9_/]+|\.\.?\/((core|node)\/)?[a-z0-9]+(\.json)?)$/, `${path.join(sub, f)} requires ${m[1]}`);
      }
      assert.doesNotMatch(text, /^\s*import\s/m, f);
    }
  }
});

test('the fixtures are what the tests say: fingerprints differ, the expired one is expired', () => {
  assert.notEqual(fingerprintOf('a'), fingerprintOf('b'));
  const { X509Certificate } = require('node:crypto');
  const { pem } = require('./standin');
  assert.ok(new Date(new X509Certificate(pem('expired', 'crt')).validTo) < new Date());
  assert.ok(new Date(new X509Certificate(pem('a', 'crt')).validTo) > new Date(Date.now() + 365 * 86400000));
});
