'use strict';

// Calls (C3.7): the route check, the body limits, the time limits and an answer in each state.

const test = require('node:test');
const assert = require('node:assert/strict');
const { standin, closedPort } = require('./standin');
const { make, addServer, until, sleep } = require('./harness');

const T = { backoff: [20, 40, 80], stable: 150 };

// connected runs fn with a connected entry on a stand-in.
async function connected(fn, { timing = T, s: given } = {}) {
  const s = given || (await standin());
  const h = make({ timing });
  try {
    h.subscribe();
    const v = await addServer(h, s);
    await until(() => h.rec.stateOf(v.id) === 'connected', 'connected');
    await fn({ h, s, id: v.id, call: (req) => h.client.call({ server: v.id, ...req }) });
  } finally {
    await h.close();
    h.cleanup();
    await s.close();
  }
}

const json = (v) => ({ json: JSON.stringify(v) });
const sent = (s, path) => s.requests.filter((r) => r.path === path || r.path.startsWith(path + '?'));

test('a call is passed on as it is and answered as the server answered: status and text', async () => {
  await connected(async ({ s, call }) => {
    s.routes.set('POST /api/chats/c1/messages', (req, res, body) => ({ status: 202, json: { got: JSON.parse(body.toString()) } }));
    s.routes.set('GET /api/chats/c1', () => ({ status: 404, json: { error: 'no chat', code: 'not_found' } }));
    s.routes.set('GET /api/dirs', (req, res, body, url) => ({ json: { path: url.searchParams.get('path') } }));
    let r = await call({ method: 'POST', path: '/api/chats/c1/messages', body: json({ text: 'hi' }) });
    assert.deepEqual(r, { status: 202, text: '{"got":{"text":"hi"}}', sceneRev: null });
    const m = sent(s, '/api/chats/c1/messages')[0];
    assert.equal(m.headers['content-type'], 'application/json');
    assert.equal(m.headers['x-aiwb-secret'], s.secret);
    r = await call({ method: 'GET', path: '/api/chats/c1' });
    assert.deepEqual(r, { status: 404, text: '{"error":"no chat","code":"not_found"}', sceneRev: null });
    r = await call({ method: 'GET', path: '/api/dirs?path=%2Ftmp%2Fa%20b' });
    assert.equal(r.text, '{"path":"/tmp/a b"}');
  });
});

test('an empty body is an answer; the scene revision is a number or null', async () => {
  await connected(async ({ s, call }) => {
    s.routes.set('POST /api/chats/c1/interrupt', () => ({ status: 204, text: '' }));
    s.routes.set('GET /api/boards/b_1/scene', () => ({ json: { elements: [] }, headers: { 'x-aiwb-scene-rev': '42' } }));
    s.routes.set('PUT /api/boards/b_1/scene', () => ({ json: { ok: true }, headers: { 'x-aiwb-scene-rev': 'abc' } }));
    assert.deepEqual(await call({ method: 'POST', path: '/api/chats/c1/interrupt' }), { status: 204, text: '', sceneRev: null });
    assert.equal((await call({ method: 'GET', path: '/api/boards/b_1/scene' })).sceneRev, 42);
    assert.equal((await call({ method: 'PUT', path: '/api/boards/b_1/scene', body: json({}) })).sceneRev, null);
  });
});

test('a server that is not in the list, or is the local one with no local entry: 404 no_server, nothing sent', async () => {
  await connected(async ({ h, s }) => {
    for (const server of ['s_000000000000', 'local', '', undefined, 'x/../y']) {
      const r = await h.client.call({ server, method: 'GET', path: '/api/state' });
      assert.equal(r.status, 404);
      assert.deepEqual(JSON.parse(r.text), { error: 'This server is not in the list.', code: 'no_server' });
    }
    assert.equal(sent(s, '/api/state').length, 0);
  });
});

test('a path outside the client API is refused before anything is sent', async () => {
  await connected(async ({ s, call }) => {
    const before = s.requests.length;
    const refused = [
      ['GET', '/api/events'], ['GET', '/api/events?client=x'], ['GET', '/api/servers'], ['POST', '/api/servers'], ['POST', '/api/restart'],
      ['GET', '/'], ['GET', '/index.html'], ['GET', 'api/state'], ['GET', '/api'], ['GET', '/api/'], ['GET', '/api/state/'],
      ['POST', '/api/state'], ['PUT', '/api/state'], ['GET', '/api/chats/../state'], ['GET', '/api/chats/./items'], ['GET', '/api/chats/%2e%2e/items'],
      ['GET', '/api/chats/%2E/items'], ['GET', '/api/chats//items'], ['GET', '/api/chats/a/b/items'], ['GET', '/api/state#x'], ['GET', '/api/state?a#b'],
      ['GET', '/api/state x'], ['GET', '/api/state\n'], ['GET', 'https://evil.example/api/state'], ['GET', '//evil.example/api/state'],
      ['GET', '/api/chats/%zz/items'], ['get', '/api/state'], ['GET ', '/api/state'], ['GET', 42], [undefined, '/api/state'], ['POST', '/api/groups/order'],
      ['PUT', '/api/groups/order'], ['POST', '/api/boards/b_1/reveal'], ['GET', '/api/remote/status'], ['GET', '/api/mcp/status'],
    ];
    for (const [method, path] of refused) {
      const r = await call({ method, path });
      assert.equal(r.status, 400, `${method} ${path}`);
      assert.deepEqual(JSON.parse(r.text), { error: 'not a call of the client API', code: 'not_client_api' }, `${method} ${path}`);
    }
    assert.equal(s.requests.length, before);
    // a body that is neither JSON nor bytes
    const r = await call({ method: 'POST', path: '/api/groups', body: { nope: 1 } });
    assert.equal(r.status, 400);
  });
});

test('every route of routes.json but the stream is a call; a name matches one segment', async () => {
  const { matchRoute } = require('../core/calls');
  const routes = require('../core/routes.json');
  for (const raw of routes) {
    const [method, pattern] = raw.split(' ');
    const path = pattern.replace(/\{[a-z]+\}/g, 'x1');
    assert.equal(matchRoute(method, path), raw === 'GET /api/events' ? null : raw, raw);
  }
  assert.equal(matchRoute('GET', '/api/library/local/groups'), null); // that is POST only
  assert.equal(matchRoute('POST', '/api/library/local/groups'), 'POST /api/library/{server}/groups');
  assert.equal(matchRoute('GET', '/api/chats/a%20b/items'), 'GET /api/chats/{id}/items');
});

test('body limits: JSON 2 MiB, a scene 128 MiB, an image 5 MiB; nothing is sent over', async () => {
  await connected(async ({ s, call }) => {
    s.routes.set('PUT /api/boards/b_1/scene', (req, res, body) => ({ json: { size: body.length } }));
    s.routes.set('POST /api/chats/c1/images', (req, res, body) => ({ json: { size: body.length, type: req.headers['content-type'] } }));
    const before = s.requests.length;
    const mib = 1 << 20;
    let r = await call({ method: 'POST', path: '/api/groups', body: { json: 'x'.repeat(2 * mib + 1) } });
    assert.deepEqual([r.status, JSON.parse(r.text).code], [413, 'too_large']);
    r = await call({ method: 'PUT', path: '/api/boards/b_1/scene', body: { bytes: new Uint8Array(128 * mib + 1), type: 'application/json' } });
    assert.deepEqual([r.status, JSON.parse(r.text).code], [413, 'too_large']);
    r = await call({ method: 'POST', path: '/api/chats/c1/images?name=a.png', body: { bytes: new Uint8Array(5 * mib + 1), type: 'image/png' } });
    assert.deepEqual([r.status, JSON.parse(r.text).code], [413, 'image_too_large']);
    assert.equal(s.requests.length, before);
    // at the limits they go
    r = await call({ method: 'PUT', path: '/api/boards/b_1/scene', body: { json: '"' + 'x'.repeat(3 * mib) + '"' } });
    assert.equal(JSON.parse(r.text).size, 3 * mib + 2);
    r = await call({ method: 'POST', path: '/api/chats/c1/images?name=a.png', body: { bytes: new Uint8Array(5 * mib).fill(7), type: 'image/png' } });
    assert.deepEqual(JSON.parse(r.text), { size: 5 * mib, type: 'image/png' });
    const post = await call({ method: 'POST', path: '/api/chats/c1/images', body: { bytes: new Uint8Array([1, 2, 3]), type: 'bad\ntype' } });
    assert.equal(JSON.parse(post.text).type, 'application/octet-stream');
  });
});

test('an entry that is not connected: 503 server_unreachable and nothing sent; unfollow and release answer without it', async () => {
  const port = await closedPort();
  const h = make({ timing: { ...T, backoff: [60000] } });
  try {
    h.subscribe();
    const a = await h.app('servers.add', { force: true, form: { name: 'Down', address: `https://127.0.0.1:${port}`, secret: 'sekret-1' } });
    const id = a.body.server.id;
    await until(() => h.rec.stateOf(id) === 'unreachable', 'unreachable');
    let r = await h.client.call({ server: id, method: 'POST', path: '/api/chats/c1/messages', body: json({ text: 'x' }) });
    assert.equal(r.status, 503);
    assert.deepEqual(JSON.parse(r.text), { error: 'Down is not connected.', code: 'server_unreachable' });
    r = await h.client.call({ server: id, method: 'POST', path: '/api/chats/c1/unfollow' });
    assert.deepEqual([r.status, r.text], [200, '{"ok":true}']);
    r = await h.client.call({ server: id, method: 'POST', path: '/api/boards/b_1/release' });
    assert.deepEqual([r.status, r.text], [200, '{"state":"none"}']);
    // a bad path is a bad path whatever the state
    r = await h.client.call({ server: id, method: 'GET', path: '/api/servers' });
    assert.equal(r.status, 400);
  } finally { await h.close(); h.cleanup(); }
});

test('a server that is too old: the call says so', async () => {
  const s = await standin();
  s.level = 5;
  const h = make({ timing: { ...T, tooOld: 60000 } });
  try {
    h.subscribe();
    const v = await addServer(h, s, 'Old');
    await until(() => h.rec.stateOf(v.id) === 'too_old', 'too_old');
    const r = await h.client.call({ server: v.id, method: 'GET', path: '/api/state' });
    assert.deepEqual([r.status, JSON.parse(r.text)], [503, { error: 'Old is too old: update the server on that machine.', code: 'server_unreachable' }]);
  } finally { await h.close(); h.cleanup(); await s.close(); }
});

test('a call answered 401: 503 server_unreachable, and the entry shows secret_not_accepted', async () => {
  await connected(async ({ h, s, id, call }) => {
    s.routes.set('GET /api/dirs', () => ({ status: 401, json: { error: 'unauthorized' } }));
    const r = await call({ method: 'GET', path: '/api/dirs' });
    assert.deepEqual([r.status, JSON.parse(r.text).code], [503, 'server_unreachable']);
    await until(() => h.rec.stateOf(id) === 'secret_not_accepted', 'secret_not_accepted');
    h.rec.assertNoSecrets();
  });
});

test('an answer that is not JSON, or not UTF-8: 502 bad_answer', async () => {
  await connected(async ({ s, call }) => {
    s.routes.set('GET /api/dirs', () => ({ text: '<html>' }));
    s.routes.set('GET /api/chats/c1', () => ({ bytes: Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]) }));
    for (const path of ['/api/dirs', '/api/chats/c1']) {
      const r = await call({ method: 'GET', path });
      assert.deepEqual([r.status, JSON.parse(r.text)], [502, { error: 'Remote gave an answer that cannot be read.', code: 'bad_answer' }]);
    }
  });
});

test('no answer in time: 504 no_answer; a message says it is not known whether it arrived', async () => {
  await connected(async ({ s, call }) => {
    s.hangPaths.add('/api/dirs');
    s.hangPaths.add('/api/chats/c1/messages');
    let r = await call({ method: 'GET', path: '/api/dirs' });
    assert.deepEqual([r.status, JSON.parse(r.text)], [504, { error: 'Remote did not answer.', code: 'no_answer' }]);
    r = await call({ method: 'POST', path: '/api/chats/c1/messages', body: json({ text: 'x' }) });
    assert.deepEqual([r.status, JSON.parse(r.text)], [504, { error: 'Remote did not answer: it is not known whether the message arrived.', code: 'send_unknown' }]);
  }, { timing: { ...T, dirs: 200, start: 200 } });
});

test('the time limit of each route of the table', async () => {
  const limits = { call: 300, start: 1500, scene: 900, imageCall: 1200, delete: 2100, dirs: 600, usage: 1800, unfollow: 450 };
  await connected(async ({ s, call }) => {
    for (const p of ['/api/chats/c1/messages', '/api/chats/c1/fork', '/api/chats/c1/open', '/api/chats/c1/context', '/api/groups/g1/archive',
      '/api/boards/b_1/scene', '/api/chats/c1/images', '/api/groups/g1', '/api/dirs', '/api/usage/claude', '/api/chats/c1/unfollow', '/api/chats/c1/label']) s.hangPaths.add(p);
    const rows = [
      ['POST', '/api/chats/c1/messages', 'start'], ['POST', '/api/chats/c1/fork', 'start'], ['POST', '/api/chats/c1/open', 'start'],
      ['GET', '/api/chats/c1/context', 'start'], ['POST', '/api/groups/g1/archive', 'start'],
      ['GET', '/api/boards/b_1/scene', 'scene'], ['PUT', '/api/boards/b_1/scene', 'scene'],
      ['POST', '/api/chats/c1/images', 'imageCall'],
      ['DELETE', '/api/groups/g1?contents=delete', 'delete'], ['DELETE', '/api/groups/g1', 'call'], ['DELETE', '/api/groups/g1?contents=move', 'call'],
      ['GET', '/api/dirs', 'dirs'], ['GET', '/api/usage/claude', 'usage'], ['POST', '/api/chats/c1/unfollow', 'unfollow'],
      ['PUT', '/api/chats/c1/label', 'call'],
    ];
    await Promise.all(rows.map(async ([method, path, name]) => {
      const t0 = Date.now();
      const r = await call({ method, path, body: method === 'GET' || method === 'DELETE' ? undefined : json({}) });
      const took = Date.now() - t0;
      assert.equal(r.status, 504, `${method} ${path}`);
      assert.ok(took >= limits[name] - 30, `${method} ${path} took ${took} ms: under ${name} ${limits[name]}`);
      assert.ok(took < limits[name] + 1200, `${method} ${path} took ${took} ms: over ${name} ${limits[name]}`);
    }));
  }, { timing: { ...T, ...limits, silence: 30000 } });
});

test('a server that dies in the middle of a call: 504 no_answer, and the entry goes on from there', async () => {
  await connected(async ({ h, s, id, call }) => {
    s.routes.set('GET /api/dirs', () => { s.cut(); return new Promise(() => {}); });
    const r = await call({ method: 'GET', path: '/api/dirs' });
    assert.deepEqual([r.status, JSON.parse(r.text).code], [504, 'no_answer']);
    await until(() => h.rec.stateOf(id) === 'connected' && s.streamsOpened === 2, 'back');
    s.routes.set('GET /api/dirs', () => ({ json: { ok: 1 } }));
    assert.equal((await call({ method: 'GET', path: '/api/dirs' })).status, 200);
  });
});

test('a cancelled call rejects with AbortError and the server is told to stop', async () => {
  await connected(async ({ s, call }) => {
    let reset = false;
    s.routes.set('GET /api/dirs', (req, res) => { req.stream.on('aborted', () => { reset = true; }); req.stream.on('close', () => { reset = true; }); return new Promise(() => {}); });
    const ac = new AbortController();
    const p = call({ method: 'GET', path: '/api/dirs', signal: ac.signal });
    await until(() => sent(s, '/api/dirs').length === 1, 'the request');
    ac.abort();
    await assert.rejects(p, { name: 'AbortError' });
    await until(() => reset, 'the server to see the cancel');
    await assert.rejects(call({ method: 'GET', path: '/api/dirs', signal: AbortSignal.abort() }), { name: 'AbortError' });
    assert.equal(sent(s, '/api/dirs').length, 1);
    // a call that is answered before the abort is an answer
    s.routes.set('GET /api/state', () => ({ json: { a: 1 } }));
    const ac2 = new AbortController();
    const r = await call({ method: 'GET', path: '/api/state', signal: ac2.signal });
    ac2.abort();
    assert.equal(r.status, 200);
  });
});

test('many calls at once share one session and are answered each its own', async () => {
  await connected(async ({ s, call }) => {
    s.routes.set('GET /api/chats/*', async (req) => {
      await sleep(Math.floor(Math.random() * 20));
      return { json: { path: req.url } };
    });
    const results = await Promise.all(Array.from({ length: 60 }, (_, i) => call({ method: 'GET', path: `/api/chats/c${i}` })));
    results.forEach((r, i) => assert.equal(JSON.parse(r.text).path, `/api/chats/c${i}`));
    assert.equal(s.sessions.size, 1);
  });
});

test('a header that the secret of the entry could not carry never reaches the call', async () => {
  // the secret is checked when it is saved: a form with a bad one is refused
  const h = make({ timing: T });
  try {
    const a = await h.app('servers.add', { force: true, form: { name: 'X', address: 'https://127.0.0.1:1', secret: 'bad\r\nx-evil: 1' } });
    assert.deepEqual([a.status, a.body.code], [400, 'bad_secret']);
  } finally { await h.close(); h.cleanup(); }
});
