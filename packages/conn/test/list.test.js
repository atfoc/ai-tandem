'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { List: CoreList, ListError, normalFingerprint } = require('../core/list');
const { parseAddress } = require('../core/address');
const { withDefaults, parseAppWaits, backoffFor, DEFAULT_TIMING } = require('../core/timing');
const { fileStore, clientId } = require('../node/store');
const { createNodeClient: createClient } = require('../node');
const { tmpDir } = require('./harness');

// The List over the file Store of a folder, as the Node client opens it.
const List = { open: (dir, now) => CoreList.open(fileStore(dir, { now })) };

const FP = 'AB:'.repeat(31) + 'AB';
const entry = (extra = {}) => ({ name: 'Mac', address: 'https://mac.local:4748', secret: 'sekret', selfSigned: true, pin: FP, instanceId: '', ...extra });
const mode = (p) => fs.statSync(p).mode & 0o777;

test('parseAddress: the stored form, and every refusal of the Go parser', () => {
  assert.deepEqual(parseAddress(' HTTPS://Mac.Local:4748/ '), { address: 'https://mac.local:4748', host: 'mac.local', port: '4748' });
  assert.equal(parseAddress('https://10.0.0.5:0007').address, 'https://10.0.0.5:7');
  for (const bad of [
    '', 'mac.local:4748', 'http://mac.local:4748', 'https://mac.local', 'https://mac.local:', 'https://mac.local:0', 'https://mac.local:65536',
    'https://mac.local:12x', 'https://u@mac.local:4748', 'https://mac.local:4748/x', 'https://mac.local:4748?x=1', 'https://mac.local:4748#f',
    'https://[::1]:4748', 'https://-mac.local:4748', 'https://mac..local:4748', 'https://mac_local:4748', 'https://mac.local:4748//', 'https://a:1:2',
  ]) assert.equal(parseAddress(bad), null, bad);
  assert.equal(parseAddress(undefined), null);
});

test('normalFingerprint: with or without colons, in any case', () => {
  assert.equal(normalFingerprint('ab'.repeat(32)), FP);
  assert.equal(normalFingerprint(' ' + FP.toLowerCase() + ' '), FP);
  assert.equal(normalFingerprint('AB:CD'), null);
  assert.equal(normalFingerprint(undefined), null);
});

test('a fresh folder has no entry and nothing is written; add creates the file 0600', () => {
  const dir = path.join(tmpDir(), 'client');
  const l = List.open(dir);
  assert.deepEqual(l.all(), []);
  assert.equal(fs.existsSync(path.join(dir, 'servers.json')), false);
  const e = l.add(entry());
  assert.match(e.id, /^s_[0-9a-f]{12}$/);
  assert.equal(mode(path.join(dir, 'servers.json')), 0o600);
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'servers.json'), 'utf8'));
  assert.equal(file.version, 1);
  assert.deepEqual(Object.keys(file.servers[0]).sort(), ['address', 'id', 'instanceId', 'name', 'pin', 'secret', 'selfSigned']);
  assert.deepEqual(List.open(dir).all(), [e]);
  assert.equal(fs.readdirSync(dir).includes('servers.json.tmp'), false);
});

test('createClient makes the state folder 0700 and the client id once, 0600', () => {
  const dir = path.join(tmpDir(), 'a', 'client');
  const c = createClient({ stateDir: dir });
  assert.equal(mode(dir), 0o700);
  assert.match(c.clientId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(mode(path.join(dir, 'client-id')), 0o600);
  assert.equal(createClient({ stateDir: dir }).clientId, c.clientId);
  assert.equal(clientId(dir), c.clientId);
  fs.writeFileSync(path.join(dir, 'client-id'), 'not an id\n');
  assert.notEqual(clientId(dir), 'not an id');
});

test('the rules of the fields: name, address, secret, pin', () => {
  const l = List.open(tmpDir());
  const code = (e) => { try { l.add(e); } catch (err) { return err.code; } return 'ok'; };
  assert.equal(code(entry({ name: '  ' })), 'bad_name');
  assert.equal(code(entry({ name: 'x'.repeat(81) })), 'bad_name');
  assert.equal(code(entry({ name: 'é'.repeat(80), address: 'https://a.example:1' })), 'ok');
  assert.equal(code(entry({ address: 'http://x:1' })), 'bad_address');
  assert.equal(code(entry({ secret: '' })), 'bad_secret');
  assert.equal(code(entry({ secret: 'has space' })), 'bad_secret');
  assert.equal(code(entry({ secret: 'ü' })), 'bad_secret');
  assert.equal(code(entry({ secret: 'x'.repeat(257) })), 'bad_secret');
  assert.equal(code(entry({ pin: 'AB:CD' })), 'bad_pin');
  assert.equal(code(entry({ address: 'https://b.example:1', pin: 'ab'.repeat(32) })), 'ok');
  assert.equal(l.all().find((e) => e.address === 'https://b.example:1').pin, FP);
  // without the box the pin is dropped, and a blank pin is none
  assert.equal(l.add(entry({ address: 'https://c.example:1', selfSigned: false, pin: FP })).pin, '');
  assert.equal(l.add(entry({ address: 'https://d.example:1', pin: '  ' })).pin, '');
});

test('two entries cannot have one address; an edit may keep its own', () => {
  const l = List.open(tmpDir());
  const a = l.add(entry());
  assert.throws(() => l.add(entry({ name: 'Other', address: 'HTTPS://MAC.LOCAL:4748' })), (e) => e instanceof ListError && e.code === "duplicate" && e.other === "Mac" && e.message === 'already added as Mac');
  assert.doesNotThrow(() => l.update(a.id, (e) => { e.name = 'Renamed'; }));
  const b = l.add(entry({ name: 'B', address: 'https://b.example:1' }));
  assert.throws(() => l.update(b.id, (e) => { e.address = 'https://mac.local:4748'; }), (e) => e.code === 'duplicate');
  assert.equal(l.get(b.id).address, 'https://b.example:1');
});

test('the local entry cannot be updated or removed; an unknown id is not found', () => {
  const l = List.open(tmpDir());
  assert.throws(() => l.update('local', () => {}), (e) => e.code === 'local_entry');
  assert.throws(() => l.remove('local'), (e) => e.code === 'local_entry');
  assert.throws(() => l.remove('s_000000000000'), (e) => e.code === 'not_found');
});

test('an unreadable file is set aside, never deleted, with a notice; the list starts empty', () => {
  for (const [why, text] of [
    ['not JSON', '{nope'],
    ['a version after this build', JSON.stringify({ version: 2, servers: [] })],
    ['a bad entry', JSON.stringify({ version: 1, servers: [{ id: 's_0123456789ab', name: '', address: 'https://a:1', secret: 'x' }] })],
    ['a bad id', JSON.stringify({ version: 1, servers: [{ id: 'x', name: 'n', address: 'https://a:1', secret: 'x' }] })],
    ['a duplicate id', JSON.stringify({ version: 1, servers: [1, 2].map(() => ({ id: 's_0123456789ab', name: 'n', address: 'https://a:1', secret: 'x' })) })],
  ]) {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'servers.json'), text);
    const l = List.open(dir, () => new Date(Date.UTC(2026, 0, 2, 3, 4, 5)));
    assert.deepEqual(l.all(), [], why);
    assert.match(l.notice, /set aside as servers\.json\.unreadable-20260102T030405Z/, why);
    assert.equal(fs.readFileSync(path.join(dir, 'servers.json.unreadable-20260102T030405Z'), 'utf8'), text, why);
    assert.equal(fs.existsSync(path.join(dir, 'servers.json')), false);
    assert.doesNotMatch(l.notice, /sekret/);
    l.add(entry()); // the list works again
  }
});

test('a second unreadable file the same second gets another name', () => {
  const dir = tmpDir();
  const now = () => new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
  fs.writeFileSync(path.join(dir, 'servers.json'), '{x');
  List.open(dir, now);
  fs.writeFileSync(path.join(dir, 'servers.json'), '{y');
  List.open(dir, now);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['servers.json.unreadable-20260102T030405Z', 'servers.json.unreadable-20260102T030405Z-2']);
});

test('a file that could not be set aside: the list works in memory and no write goes through', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'servers.json'), '{x');
  fs.chmodSync(dir, 0o500);
  try {
    if (process.getuid && process.getuid() === 0) return; // root writes anywhere
    const l = List.open(dir);
    assert.match(l.notice, /could not be set aside/);
    assert.throws(() => l.add(entry()), /could not be set aside/);
  } finally {
    fs.chmodSync(dir, 0o700);
  }
});

test('an empty file is a list without entries and is not set aside', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'servers.json'), '  \n');
  const l = List.open(dir);
  assert.deepEqual(l.all(), []);
  assert.equal(l.notice, '');
});

test('timing: defaults, stable follows the back-off, AIWB_APP_WAITS', () => {
  assert.equal(withDefaults().silence, 35000);
  assert.equal(withDefaults({ backoff: [5, 7] }).stable, 7);
  assert.equal(withDefaults({ backoff: [5, 7], stable: 1 }).stable, 1);
  assert.deepEqual(withDefaults({ call: 1 }).backoff, DEFAULT_TIMING.backoff);
  assert.deepEqual(parseAppWaits(''), {});
  assert.deepEqual(parseAppWaits('silence=3.5s, tooold=2m,call=500ms'), { silence: 3500, tooOld: 120000, call: 500 });
  const b = parseAppWaits('backoff=3s');
  assert.deepEqual(b.backoff, [100, 200, 500, 1000, 3000]);
  assert.equal(b.stable, 3000);
  assert.equal(parseAppWaits('imagecall=1s,firstevent=2s,hello=1500ms,start=1s,scene=1s,delete=1s').imageCall, 1000);
  for (const bad of ['silence', 'silence=', 'silence=0s', 'silence=-1s', 'nope=1s', 'silence=3', 'silence=3x', 'silence=1s,,call=1s']) {
    assert.throws(() => parseAppWaits(bad), bad);
  }
});

test('backoffFor: the steps, then the last one; jitter stays within its part', () => {
  const t = withDefaults({ backoff: [100, 200, 500], jitter: 0 });
  assert.deepEqual([0, 1, 2, 3, 9].map((n) => backoffFor(t, n)), [100, 200, 500, 500, 500]);
  const j = { ...t, jitter: 0.2 };
  assert.equal(backoffFor(j, 0, () => 0), 80);
  assert.equal(backoffFor(j, 0, () => 1), 120);
  assert.equal(backoffFor(j, 0, () => 0.5), 100);
});

test('routes.json is the client API of the plan: 51 rows, hello and the stream first', () => {
  const routes = require('../core/routes.json');
  assert.equal(routes.length, 51);
  assert.deepEqual(routes.slice(0, 3), ['GET /api/hello', 'GET /api/events', 'GET /api/state']);
  assert.equal(new Set(routes).size, routes.length);
  assert.ok(routes.every((r) => /^(GET|POST|PUT|PATCH|DELETE) \/api\//.test(r)));
});
