'use strict';

// What the split into ports added to the module, without a server: the UTF-8 of core/utf8.js is
// Node's own, the query reading of a call is URLSearchParams', the List works over any Store and
// takes its ids from `random`, the client works with no LocalPort, and the outcome
// local_network_denied is a state that retries.

const test = require('node:test');
const assert = require('node:assert/strict');
const { decode, decodeLenient, encode, encodeJs } = require('../core/utf8');
const { queryValue } = require('../core/calls');
const { List } = require('../core/list');
const { OUTCOMES, stateOf, retries, step, message } = require('../core/outcomes');
const { abortError } = require('../core/abort');
const { createClient } = require('..');
const { memoryStore } = require('./fakes/memory-store');

// rng is a seeded generator, so that a failure can be run again.
function rng(seed) {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
}

test('decodeLenient is Buffer#toString("utf8") and decode is the fatal TextDecoder, on any bytes', () => {
  const r = rng(7);
  const strict = new TextDecoder('utf-8', { fatal: true });
  for (let t = 0; t < 20000; t++) {
    const b = new Uint8Array(Math.floor(r() * 12));
    for (let i = 0; i < b.length; i++) {
      const p = r();
      b[i] = p < 0.3 ? Math.floor(r() * 128) : p < 0.5 ? 0x80 + Math.floor(r() * 64) : Math.floor(r() * 256);
    }
    assert.equal(decodeLenient(b), Buffer.from(b).toString('utf8'), `lenient ${[...b]}`);
    let want;
    try { want = strict.decode(b); } catch { want = 'THROWS'; }
    let got;
    try { got = decode(b); } catch (err) { assert.ok(err instanceof TypeError); got = 'THROWS'; }
    assert.equal(got, want, `fatal ${[...b]}`);
  }
  // a byte order mark: dropped by the fatal decoder, kept by the lenient one, as Node does
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]);
  assert.equal(decode(bom), '{}');
  assert.equal(decodeLenient(bom), '﻿{}');
  // a long text crosses the chunks of String.fromCharCode
  const long = 'é✓😀x'.repeat(10000);
  assert.equal(decode(Buffer.from(long)), long);
});

test('encode and encodeJs are Buffer.from(s, "utf8"), lone surrogates included', () => {
  const r = rng(11);
  for (let t = 0; t < 20000; t++) {
    let s = '';
    for (let i = Math.floor(r() * 8); i > 0; i--) {
      const p = r();
      s += String.fromCharCode(p < 0.3 ? Math.floor(r() * 128) : p < 0.6 ? 0xd800 + Math.floor(r() * 0x800) : Math.floor(r() * 0x10000));
    }
    const want = Buffer.from(s, 'utf8');
    assert.ok(want.equals(Buffer.from(encodeJs(s))), `encodeJs ${[...s].map((c) => c.charCodeAt(0))}`);
    assert.ok(want.equals(Buffer.from(encode(s))), `encode ${[...s].map((c) => c.charCodeAt(0))}`);
  }
});

test('queryValue says "contents=delete" wherever URLSearchParams does', () => {
  for (const q of [
    'contents=delete', 'a=1&contents=delete', 'contents=keep&contents=delete', 'contents=delete&contents=keep', 'cont%65nts=del%65te',
    'contents=delete%', 'contents=delete%ZZ', 'contents', 'contents=', '=delete', 'contents+=delete', 'contents=de+lete', '&&contents=delete&',
    '%ZZ=1&contents=delete', 'contents=%E2%82', 'x=%ZZ&contents=delete', 'contents%=delete', 'contents=delete=x', 'CONTENTS=delete',
  ]) {
    assert.equal(queryValue(q, 'contents') === 'delete', new URLSearchParams(q).get('contents') === 'delete', q);
  }
});

const FP = 'AB:'.repeat(31) + 'AB';
const entry = (extra = {}) => ({ name: 'Mac', address: 'https://mac.local:4748', secret: 'sekret', selfSigned: true, pin: FP, instanceId: '', ...extra });

test('the List over a Store: ids from random, the whole list written before it changes, an unreadable one set aside', () => {
  const store = memoryStore();
  const l = List.open(store, { random: (a) => { a.fill(0xab); return a; } });
  const e = l.add(entry());
  assert.equal(e.id, 's_abababababab');
  assert.deepEqual(store.saved, { version: 1, servers: [{ id: e.id, name: 'Mac', address: 'https://mac.local:4748', secret: 'sekret', selfSigned: true, pin: FP, instanceId: '' }] });
  assert.deepEqual(List.open(store).all(), [e]);

  // a failed write changes nothing
  store.write = () => { throw new Error('full'); };
  assert.throws(() => l.update(e.id, (x) => { x.name = 'Other'; }), /full/);
  assert.equal(l.get(e.id).name, 'Mac');

  // a list the Store cannot read, and one of a later version: set aside, with the Store's place in the notice
  for (const [saved, reason] of [[Object.assign(new Error('x'), { code: 'EIO' }), 'EIO'], [{ version: 2, servers: [] }, "version 2 is after this build's 1"]]) {
    const bad = memoryStore(saved);
    const b = List.open(bad);
    assert.deepEqual(b.all(), []);
    assert.deepEqual(bad.asides, [reason]);
    assert.equal(b.notice, `server list: the app's storage cannot be read (${reason}); set aside as list.unreadable-1; starting with this computer only`);
  }

  // an entry without its secret is refused as the List refuses any bad entry
  const noSecret = memoryStore({ version: 1, servers: [{ ...entry(), id: 's_000000000001', secret: '' }] });
  List.open(noSecret);
  assert.deepEqual(noSecret.asides, ['entry 1: bad secret']);

  // a Store that cannot set aside: the list works in memory and no write goes through
  const stuck = memoryStore({ version: 9 });
  stuck.setAside = () => { throw new Error('read-only'); };
  const s = List.open(stuck);
  assert.match(s.notice, /it could not be set aside \(read-only\)/);
  assert.throws(() => s.add(entry()), /could not be set aside: read-only/);
});

test('a client with no LocalPort: no section of this computer, owner.* answers no_owner, localInfo is null', async () => {
  const connector = {
    open: async () => { throw abortError(); },
    readCertificate: async () => { throw abortError(); },
  };
  const c = createClient({ connector, store: memoryStore() });
  assert.equal(c.clientId, '00000000-0000-4000-8000-000000000000');
  assert.equal(c.localInfo(), null);
  assert.deepEqual((await c.app('servers.list')).body, { servers: [], notice: '' });
  for (const op of ['owner.restart', 'owner.status', 'owner.nothing']) assert.equal((await c.app(op)).body.code, 'no_owner', op);
  assert.equal((await c.app('servers.nothing')).body.code, 'no_op');
  assert.throws(() => createClient({ store: memoryStore() }), /connector and store are required/);
  await c.close();
});

test('local_network_denied: step 2, its sentence, a state that retries', () => {
  assert.equal(step('local_network_denied'), 2);
  assert.equal(message('local_network_denied'), 'This app may not reach the local network: allow it in the system settings');
  assert.equal(stateOf('local_network_denied'), 'unreachable');
  assert.ok(retries(stateOf('local_network_denied')));
  assert.equal(Object.keys(OUTCOMES).length, 24);
});

test('abortError is an Error named AbortError with the platform\'s sentence', () => {
  const e = abortError();
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'AbortError');
  assert.equal(e.message, new DOMException('This operation was aborted', 'AbortError').message);
});
