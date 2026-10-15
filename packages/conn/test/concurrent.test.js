'use strict';

// Several connections at once: events keep their order per entry, no call or event is lost or
// crossed, an entry that hangs holds nobody up, and closing never waits for a server.

const test = require('node:test');
const assert = require('node:assert/strict');
const { standin } = require('./standin');
const { make, addServer, until, sleep } = require('./harness');

const T = { backoff: [20, 40, 80], stable: 150 };

test('ten entries at once: every event arrives, in order, with its own entry, while one is cut again and again', async () => {
  const N = 10;
  const EVENTS = 150;
  const servers = await Promise.all(Array.from({ length: N }, () => standin()));
  const h = make({ timing: T });
  try {
    h.subscribe();
    const views = await Promise.all(servers.map((s, i) => addServer(h, s, `S${i}`)));
    await until(() => views.every((v) => h.rec.stateOf(v.id) === 'connected'), 'all connected');
    for (const s of servers) s.routes.set('GET /api/chats/*', (req) => ({ json: { from: s.port, path: req.url } }));

    const cutter = setInterval(() => servers[3].cut(), 40);
    const senders = servers.map(async (s, i) => {
      for (let n = 1; n <= EVENTS; n++) {
        s.emit({ type: 'tick', n, of: i });
        if (n % 25 === 0) await sleep(1);
      }
    });
    const callers = servers.map(async (s, i) => {
      const out = [];
      for (let n = 0; n < 40; n++) {
        const r = await h.client.call({ server: views[i].id, method: 'GET', path: `/api/chats/c${n}` });
        out.push(r);
      }
      return out;
    });
    const results = await Promise.all([...senders, ...callers]);
    clearInterval(cutter);

    // calls: each answered by its own server (the cut one may be unreachable for a moment)
    results.slice(N).forEach((answers, i) => {
      answers.forEach((r, n) => {
        if (r.status === 200) {
          const body = JSON.parse(r.text);
          assert.equal(body.from, servers[i].port, `call ${n} of ${i} was answered by another server`);
          assert.equal(body.path, `/api/chats/c${n}`);
        } else {
          assert.equal(i, 3, `only the cut server may fail a call: ${r.status} ${r.text}`);
        }
      });
    });
    for (let i = 0; i < N; i++) if (i !== 3) assert.ok(results[N + i].every((r) => r.status === 200));

    await until(() => servers.every((s, i) => i === 3 || h.rec.eventsOf(views[i].id).filter((e) => e.type === 'tick').length === EVENTS), 'all events');
    servers.forEach((s, i) => {
      const ticks = h.rec.eventsOf(views[i].id).filter((e) => e.type === 'tick');
      assert.ok(ticks.every((t) => t.of === i), `events of ${i} came with another entry`);
      const ns = ticks.map((t) => t.n);
      assert.deepEqual(ns, [...ns].sort((a, b) => a - b), `events of ${i} out of order`);
      if (i !== 3) assert.deepEqual(ns, Array.from({ length: EVENTS }, (_, k) => k + 1));
    });

    // the cut entry: after every cut a hello and a snapshot come before anything else of it
    const mine = h.rec.envelopes.filter((e) => e.server === views[3].id).map((e) => e.event.type);
    for (let k = 0; k < mine.length; k++) {
      if (mine[k] === 'tick') assert.ok(mine[k - 1] === 'tick' || mine[k - 1] === 'snapshot', 'a tick right after a hello?');
    }
    assert.ok(mine.filter((t) => t === 'snapshot').length >= 2, 'the entry came back');
  } finally {
    await h.close();
    h.cleanup();
    await Promise.all(servers.map((s) => s.close()));
  }
});

test('adds, edits and removes at once; the list is whole, every kept entry connects, a removed one is closed', async () => {
  const servers = await Promise.all(Array.from({ length: 6 }, () => standin()));
  const h = make({ timing: T });
  try {
    h.subscribe();
    const added = await Promise.all(servers.map((s, i) => h.app('servers.add', { force: true, form: { name: `S${i}`, address: s.address, secret: s.secret, selfSigned: true, pin: s.fingerprint } })));
    const ids = added.map((a) => a.body.server.id);
    assert.equal(new Set(ids).size, 6);
    await Promise.all([
      h.app('servers.remove', { id: ids[0] }),
      h.app('servers.edit', { id: ids[1], patch: { name: 'Renamed' }, force: true }),
      h.app('servers.edit', { id: ids[2], patch: { address: `https://localhost:${servers[2].port}` }, force: true }),
      h.app('servers.remove', { id: ids[3] }),
      h.app('servers.add', { force: true, form: { name: 'dup of 4', address: servers[4].address, secret: 'sekret-x', selfSigned: true, pin: servers[4].fingerprint } }),
    ]);
    const list = (await h.app('servers.list')).body.servers;
    assert.deepEqual(list.map((x) => x.name).sort(), ['Renamed', 'S2', 'S4', 'S5'].sort());
    await until(() => [ids[1], ids[2], ids[4], ids[5]].every((id) => h.rec.stateOf(id) === 'connected' || h.rec.viewOf(id)?.state === 'connected'), 'kept entries');
    await until(() => servers[0].streams.size === 0 && servers[3].streams.size === 0, 'removed entries closed');
    assert.equal(servers[1].streams.size, 1);
    assert.equal(servers[2].streams.size, 1);
    assert.deepEqual(JSON.parse(require('node:fs').readFileSync(require('node:path').join(h.dir, 'servers.json'), 'utf8')).servers.map((x) => x.name).sort(), ['Renamed', 'S2', 'S4', 'S5'].sort());
  } finally {
    await h.close();
    h.cleanup();
    await Promise.all(servers.map((s) => s.close()));
  }
});

test('an entry that hangs at every step holds nobody up', async () => {
  const hung = await standin();
  hung.hang = true;
  const good = await standin();
  const h = make({ timing: { ...T, hello: 5000, headers: 5000 } });
  try {
    h.subscribe();
    const a = await addServer(h, hung, 'Hung');
    const b = await addServer(h, good, 'Good');
    await until(() => h.rec.stateOf(b.id) === 'connected', 'the good one');
    good.routes.set('GET /api/dirs', () => ({ json: { ok: 1 } }));
    for (let i = 0; i < 5; i++) assert.equal((await h.client.call({ server: b.id, method: 'GET', path: '/api/dirs' })).status, 200);
    good.emit({ type: 'tick' });
    await until(() => h.rec.eventsOf(b.id).some((e) => e.type === 'tick'), 'an event');
    assert.notEqual(h.rec.stateOf(a.id), 'connected');
    const r = await h.client.call({ server: a.id, method: 'GET', path: '/api/dirs' });
    assert.equal(r.status, 503);
  } finally {
    await h.close();
    h.cleanup();
    await hung.close();
    await good.close();
  }
});

test('close() does not wait for a server: calls in flight end, nothing is left running', async () => {
  const s = await standin();
  const hung = await standin();
  hung.hang = true;
  const h = make({ timing: { ...T, call: 30000, hello: 30000 } });
  h.subscribe();
  const v = await addServer(h, s);
  await addServer(h, hung, 'Hung');
  await until(() => h.rec.stateOf(v.id) === 'connected', 'connected');
  s.hangPaths.add('/api/dirs');
  const call = h.client.call({ server: v.id, method: 'GET', path: '/api/dirs' });
  await until(() => s.requests.some((r) => r.path === '/api/dirs'), 'the call to reach the server');
  const t0 = Date.now();
  await h.client.close();
  assert.ok(Date.now() - t0 < 5000, 'close was quick');
  assert.equal((await call).status, 504);
  await until(() => s.streams.size === 0 && s.sessions.size === 0, 'the sessions to be closed');
  assert.deepEqual(h.rec.logs, []);
  await h.close();
  h.cleanup();
  await s.close();
  await hung.close();
});

test('an event that is no JSON object ends the stream; the next one starts from a snapshot again', async () => {
  const s = await standin();
  const h = make({ timing: T });
  try {
    h.subscribe();
    const v = await addServer(h, s);
    await until(() => h.rec.stateOf(v.id) === 'connected', 'connected');
    for (const raw of ['not json', '[1,2]', 'null', '42']) {
      const opened = s.streamsOpened;
      s.emit(null, raw);
      await until(() => s.streamsOpened === opened + 1 && h.rec.stateOf(v.id) === 'connected', `a new stream after ${raw}`);
    }
    assert.equal(h.rec.eventsOf(v.id).some((e) => e === null || typeof e !== 'object'), false);
  } finally { await h.close(); h.cleanup(); await s.close(); }
});

test('an event of several lines and chunks, and comments, are read whole', async () => {
  const s = await standin();
  const h = make({ timing: T });
  try {
    h.subscribe();
    const v = await addServer(h, s);
    await until(() => h.rec.stateOf(v.id) === 'connected', 'connected');
    const big = 'é'.repeat(200000);
    const text = JSON.stringify({ type: 'big', big, n: 1 });
    // one event sent in three pieces, cut in the middle of a multi-byte character, with a comment and a CRLF event between
    const bytes = Buffer.from(`: comment\ndata: ${text}\n\n`, 'utf8');
    const stream = [...s.streams][0];
    stream.write(bytes.subarray(0, 10001));
    await sleep(10);
    stream.write(bytes.subarray(10001, 100001));
    await sleep(10);
    stream.write(bytes.subarray(100001));
    stream.write('event: other\r\ndata: {"type":"crlf",\r\ndata: "n":2}\r\n\r\n');
    await until(() => h.rec.eventsOf(v.id).some((e) => e.type === 'crlf'), 'both events');
    const events = h.rec.eventsOf(v.id);
    assert.equal(events.find((e) => e.type === 'big').big, big);
    assert.deepEqual(events.find((e) => e.type === 'crlf'), { type: 'crlf', n: 2 });
  } finally { await h.close(); h.cleanup(); await s.close(); }
});
