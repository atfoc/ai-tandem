'use strict';

// Pictures (C3.8): a picture is taken from its bytes alone, whatever type the server claimed, within
// the size limit; ids are checked; eight fetches at a time per entry.

const test = require('node:test');
const assert = require('node:assert/strict');
const { standin } = require('./standin');
const { make, addServer, until, sleep } = require('./harness');

const T = { backoff: [20, 40, 80], stable: 150 };
const IMG = 'a'.repeat(64);
const IMG_PATH = `/api/chats/c1/images/${IMG}`;
const MiB = 1 << 20;

const PNG = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.from('rest of the png')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jfif')]);
const GIF87 = Buffer.from('GIF87a....');
const GIF89 = Buffer.from('GIF89a....');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 ')]);

async function connected(fn, { timing = T } = {}) {
  const s = await standin();
  const h = make({ timing });
  try {
    h.subscribe();
    const v = await addServer(h, s);
    await until(() => h.rec.stateOf(v.id) === 'connected', 'connected');
    await fn({ h, s, id: v.id, picture: (req) => h.client.picture({ server: v.id, chat: 'c1', image: IMG, ...req }) });
  } finally {
    await h.close();
    h.cleanup();
    await s.close();
  }
}

test('each image type is accepted and the type is found from the bytes, whatever the server claimed', async () => {
  await connected(async ({ s, picture }) => {
    for (const [bytes, type] of [[PNG, 'image/png'], [JPEG, 'image/jpeg'], [GIF87, 'image/gif'], [GIF89, 'image/gif'], [WEBP, 'image/webp']]) {
      for (const claimed of ['image/png', 'text/html', 'image/svg+xml', 'application/json', 'text/plain']) {
        s.routes.set(`GET ${IMG_PATH}`, () => ({ type: claimed, bytes }));
        const r = await picture();
        assert.equal(r.ok, true, `${type} claimed ${claimed}`);
        assert.equal(r.type, type);
        assert.deepEqual(Buffer.from(r.data), bytes);
      }
    }
    const req = s.requests.find((r) => r.path === IMG_PATH);
    assert.equal(req.headers['x-aiwb-secret'], s.secret);
  });
});

test('bytes that are no image of the taken types are refused as 502 bad_answer, whatever the claimed type', async () => {
  await connected(async ({ s, picture }) => {
    const bad = [
      ['svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
      ['html', Buffer.from('<!doctype html><script>alert(1)</script>')],
      ['text', Buffer.from('hello')],
      ['empty', Buffer.alloc(0)],
      ['png prefix cut', Buffer.from('\x89PNG', 'latin1')],
      ['riff without webp', Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WAVEfmt ')])],
      ['riff too short', Buffer.from('RIFFxxxxWEB')],
      ['gif without version', Buffer.from('GIF90a....')],
      ['bmp', Buffer.from('BM......')],
      ['json', Buffer.from('{"error":"x"}')],
    ];
    for (const [name, bytes] of bad) {
      for (const claimed of ['image/png', 'image/svg+xml', 'text/html']) {
        s.routes.set(`GET ${IMG_PATH}`, () => ({ type: claimed, bytes }));
        const r = await picture();
        assert.equal(r.ok, false, `${name} claimed ${claimed}`);
        assert.equal(r.status, 502, name);
        assert.deepEqual(JSON.parse(r.text), { error: 'Remote gave an answer that cannot be read.', code: 'bad_answer' }, name);
        assert.equal('data' in r, false);
      }
    }
  });
});

test('the size limit: 5 MiB is taken, one byte more is refused', async () => {
  await connected(async ({ s, picture }) => {
    const exact = Buffer.concat([PNG, Buffer.alloc(5 * MiB - PNG.length)]);
    s.routes.set(`GET ${IMG_PATH}`, () => ({ type: 'image/png', bytes: exact }));
    const ok = await picture();
    assert.equal(ok.ok, true);
    assert.equal(ok.data.length, 5 * MiB);
    s.routes.set(`GET ${IMG_PATH}`, () => ({ type: 'image/png', bytes: Buffer.concat([exact, Buffer.from([0])]) }));
    const r = await picture();
    assert.deepEqual([r.ok, r.status, JSON.parse(r.text).code], [false, 502, 'bad_answer']);
  });
});

test('bad ids are refused before anything is sent: 400 image_id', async () => {
  await connected(async ({ s, picture }) => {
    const before = s.requests.length;
    for (const req of [
      { image: 'A'.repeat(64) }, { image: 'a'.repeat(63) }, { image: 'a'.repeat(65) }, { image: 'g'.repeat(64) }, { image: '../' + 'a'.repeat(61) },
      { image: undefined }, { image: 5 }, { chat: '' }, { chat: 'a/b' }, { chat: '..' }, { chat: 'a b' }, { chat: 'a?b' }, { chat: 'x'.repeat(101) },
      { chat: undefined }, { chat: '%2e%2e' },
    ]) {
      const r = await picture(req);
      assert.deepEqual([r.ok, r.status, JSON.parse(r.text).code], [false, 400, 'image_id'], JSON.stringify(req));
    }
    assert.equal(s.requests.length, before);
    assert.equal((await picture({ chat: 'a'.repeat(100) })).status, 404); // a good id the server does not know
  });
});

test('a server that is not in the list: 404 no_server; not connected: 503', async () => {
  await connected(async ({ h, s, id, picture }) => {
    for (const server of ['s_000000000000', 'local', undefined]) {
      const r = await picture({ server });
      assert.deepEqual([r.ok, r.status, JSON.parse(r.text).code], [false, 404, 'no_server']);
    }
    s.routes.set(`GET ${IMG_PATH}`, () => ({ status: 401, json: { error: 'unauthorized' } }));
    const r = await picture();
    assert.deepEqual([r.ok, r.status, JSON.parse(r.text).code], [false, 503, 'server_unreachable']);
    await until(() => h.rec.stateOf(id) === 'secret_not_accepted', 'secret_not_accepted');
    const again = await picture();
    assert.equal(again.status, 503);
  });
});

test('a refusal of the server is passed with its status, code and sentence and nothing else', async () => {
  await connected(async ({ s, picture }) => {
    s.routes.set(`GET ${IMG_PATH}`, () => ({ status: 404, json: { error: 'no such image', code: 'not_found', html: '<script>', extra: 1 } }));
    let r = await picture();
    assert.deepEqual([r.ok, r.status, r.text], [false, 404, '{"error":"no such image","code":"not_found"}']);
    s.routes.set(`GET ${IMG_PATH}`, () => ({ status: 500, text: '<html>boom</html>', type: 'text/html' }));
    r = await picture();
    assert.deepEqual([r.status, JSON.parse(r.text)], [500, { error: 'Remote answered with status 500.' }]);
    s.routes.set(`GET ${IMG_PATH}`, () => ({ status: 204, text: '' }));
    r = await picture();
    assert.deepEqual([r.status, JSON.parse(r.text).code], [502, 'bad_answer']);
    s.routes.set(`GET ${IMG_PATH}`, () => ({ status: 302, text: '', headers: { location: 'https://evil.example/x.png' } }));
    r = await picture();
    assert.deepEqual([r.status, JSON.parse(r.text).code], [502, 'bad_answer']);
    assert.equal(s.requests.filter((q) => q.path === IMG_PATH).length, 4, 'a redirect is not followed');
  });
});

test('no answer in time: 504 no_answer; a server that dies in the middle of a picture: 504 and the entry goes on', async () => {
  await connected(async ({ h, s, id, picture }) => {
    s.hangPaths.add(IMG_PATH);
    let r = await picture();
    assert.deepEqual([r.ok, r.status, JSON.parse(r.text).code], [false, 504, 'no_answer']);
    s.hangPaths.clear();
    s.routes.set(`GET ${IMG_PATH}`, () => { s.cut(); return new Promise(() => {}); });
    r = await picture();
    assert.deepEqual([r.status, JSON.parse(r.text).code], [504, 'no_answer']);
    await until(() => h.rec.stateOf(id) === 'connected' && s.streamsOpened === 2, 'back');
    s.routes.set(`GET ${IMG_PATH}`, () => ({ type: 'image/png', bytes: PNG }));
    assert.equal((await picture()).ok, true);
  }, { timing: { ...T, imageCall: 300 } });
});

test('at most eight fetches at a time per entry, the rest wait in order', async () => {
  await connected(async ({ s, picture }) => {
    let inflight = 0;
    let most = 0;
    const order = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    s.routes.set('GET /api/chats/c1/images/*', async (req) => {
      order.push(req.url);
      most = Math.max(most, ++inflight);
      await gate;
      inflight--;
      return { type: 'image/png', bytes: PNG };
    });
    const ids = Array.from({ length: 20 }, (_, i) => String(i).padStart(2, '0').repeat(32).replace(/[^0-9a-f]/g, 'a'));
    const all = ids.map((image) => picture({ image }));
    await until(() => inflight === 8, 'eight in flight');
    await sleep(100);
    assert.equal(inflight, 8, 'the ninth waits');
    assert.equal(order.length, 8);
    assert.deepEqual([...order].sort(), ids.slice(0, 8).map((i) => `/api/chats/c1/images/${i}`).sort());
    release();
    const results = await Promise.all(all);
    assert.ok(results.every((r) => r.ok));
    assert.equal(most, 8);
    const paths = ids.map((i) => `/api/chats/c1/images/${i}`);
    assert.deepEqual([...order.slice(0, 8)].sort(), paths.slice(0, 8).sort(), 'the first eight asked are the first eight waiting');
    assert.deepEqual([...order.slice(8)].sort(), paths.slice(8).sort());
  });
});

test('a picture that waits its turn and is cancelled leaves the queue without being asked', async () => {
  await connected(async ({ s, picture }) => {
    let release;
    const gate = new Promise((r) => { release = r; });
    s.routes.set('GET /api/chats/c1/images/*', async () => { await gate; return { type: 'image/png', bytes: PNG }; });
    const first = Array.from({ length: 8 }, (_, i) => picture({ image: String(i).repeat(64) }));
    await until(() => s.requests.filter((r) => r.path.startsWith('/api/chats/c1/images/')).length === 8, 'eight asked');
    const ac = new AbortController();
    const waiting = picture({ image: 'f'.repeat(64), signal: ac.signal });
    await sleep(50);
    ac.abort();
    await assert.rejects(waiting, { name: 'AbortError' });
    release();
    await Promise.all(first);
    assert.equal(s.requests.filter((r) => r.path === `/api/chats/c1/images/${'f'.repeat(64)}`).length, 0);
    // the slot of the cancelled one was not lost: eight more go at once
    const more = await Promise.all(Array.from({ length: 9 }, (_, i) => picture({ image: String(i).repeat(64) })));
    assert.ok(more.every((r) => r.ok));
  });
});

test('a picture request in flight can be cancelled', async () => {
  await connected(async ({ s, picture }) => {
    s.hangPaths.add(IMG_PATH);
    const ac = new AbortController();
    const p = picture({ signal: ac.signal });
    await until(() => s.requests.some((r) => r.path === IMG_PATH), 'asked');
    ac.abort();
    await assert.rejects(p, { name: 'AbortError' });
    await assert.rejects(picture({ signal: AbortSignal.abort() }), { name: 'AbortError' });
  });
});
