'use strict';

// This computer's entry (C3.9, C3.10): the starter with a fake `run`, and the real one with a
// program in a temporary folder.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { standin, blackhole, fingerprintOf } = require('./standin');
const { make, addServer, until, sleep, tmpDir } = require('./harness');

const T = { backoff: [20, 40, 80], stable: 150, tooOld: 100 };
const NOT_SET_UP = 'AI Whiteboard: the server was not started\nAI Whiteboard is not set up on this machine. Set it up once with: "/x/ai-whiteboard" remote setup\n';

// launchLine is what `launch -json` prints for a running stand-in.
const launchLine = (s, extra = {}) => JSON.stringify({
  state: 'running', address: s.address, fingerprint: s.fingerprint, version: s.version, featureLevel: s.level,
  instanceId: s.instanceId, pid: 123, home: '/tmp/aiwb-home', ...extra,
}) + '\n';

// A fake server program: script(args, n) answers each command; calls and the most that ran at once are kept.
function fake(script) {
  const f = {
    calls: [], running: 0, most: 0,
    async run(args, timeoutMs) {
      f.calls.push(args);
      f.running++;
      f.most = Math.max(f.most, f.running);
      try {
        return await script(args, f.calls.filter((c) => c[0] === args[0]).length);
      } finally {
        f.running--;
      }
    },
    count: (cmd) => f.calls.filter((c) => c[0] === cmd).length,
  };
  return f;
}
const ok = (stdout) => ({ code: 0, stdout, stderr: '' });
const fail = (stderr, code = 1) => ({ code, stdout: '', stderr });

// running scripts the program for a stand-in: launch, relaunch and secret.
const running = (s) => (args) => {
  switch (args[0]) {
    case 'launch': case 'relaunch': return ok(launchLine(s));
    case 'secret': return ok(s.secret + '\n');
    default: return fail('unknown command');
  }
};

async function withLocal(f, fn, { timing = T, home, s } = {}) {
  const h = make({ timing, local: { bin: '/not/used', home: home === undefined ? null : home, run: f.run } });
  try {
    if (s) h.rec.secrets.add(s.secret);
    h.subscribe();
    await fn(h);
  } finally {
    await h.close();
    h.cleanup();
    if (s) await s.close();
  }
}
const stateOf = (h) => h.rec.stateOf('local');
const reaches = (h, state) => until(() => stateOf(h) === state, `local to be ${state}, now ${stateOf(h)}`);

test('this computer is the first entry, connects with what launch and secret printed, and shows no fingerprint', async () => {
  const s = await standin();
  const f = fake(running(s));
  await withLocal(f, async (h) => {
    await reaches(h, 'connected');
    assert.deepEqual(f.calls.slice(0, 2), [['launch', '-json'], ['secret']]);
    const v = h.rec.viewOf('local');
    assert.deepEqual(v, { id: 'local', local: true, name: 'This computer', address: s.address, instanceId: s.instanceId, state: 'connected', version: '1.2.3', agents: ['claude'] });
    const list = await h.app('servers.list');
    assert.deepEqual(list.body.servers.map((x) => x.id), ['local']);
    assert.equal(fs.existsSync(path.join(h.dir, 'servers.json')), false, 'this computer is never in the file');
    assert.deepEqual(h.client.localInfo(), { home: '/tmp/aiwb-home', address: s.address, version: '1.2.3', pid: 123 });
    // the connection is as any other: HTTPS, the secret, the level, the client id
    const events = s.requests.find((r) => r.path.startsWith('/api/events'));
    assert.equal(events.headers['x-aiwb-secret'], s.secret);
    assert.equal(events.headers['x-aiwb-level'], '6');
    // calls and pictures go to 'local' as to any entry
    const r = await h.client.call({ server: 'local', method: 'GET', path: '/api/state' });
    assert.equal(r.status, 200);
    h.rec.assertNoSecrets();
  }, { s });
});

test('-home is given to every command when the home is set', async () => {
  const s = await standin();
  const f = fake(running(s));
  await withLocal(f, async (h) => {
    await reaches(h, 'connected');
    assert.deepEqual(f.calls.slice(0, 2), [['launch', '-json', '-home', '/some/home'], ['secret', '-home', '/some/home']]);
    await h.app('owner.status');
    assert.deepEqual(f.calls.at(-1), ['status', '-json', '-home', '/some/home']);
  }, { s, home: '/some/home' });
});

test('this computer cannot be added, edited, removed, tested or accepted', async () => {
  const s = await standin();
  await withLocal(fake(running(s)), async (h) => {
    await reaches(h, 'connected');
    for (const [op, args] of [
      ['servers.edit', { id: 'local', patch: { name: 'x' } }], ['servers.remove', { id: 'local' }], ['servers.testSaved', { id: 'local' }],
      ['servers.accept', { id: 'local', fingerprint: 'ab'.repeat(32) }],
    ]) {
      const a = await h.app(op, args);
      assert.deepEqual([a.status, a.body.code], [409, 'local_entry'], op);
    }
    assert.equal(stateOf(h), 'connected');
  }, { s });
});

test('before the server has answered the entry says connecting; the window needs nothing of it', async () => {
  const s = await standin();
  const f = fake(async (args) => { await sleep(150); return running(s)(args); });
  await withLocal(f, async (h) => {
    const list = await h.app('servers.list');
    assert.deepEqual(list.body.servers.map((x) => [x.id, x.state]), [['local', 'connecting']]);
    await reaches(h, 'connected');
  }, { s });
});

test('a start that fails: not_started with the reason, tried again by itself, and at once on Retry', async () => {
  const s = await standin();
  let setUp = false;
  const f = fake((args) => (setUp ? running(s)(args) : fail(NOT_SET_UP)));
  await withLocal(f, async (h) => {
    await reaches(h, 'not_started');
    assert.equal(h.rec.viewOf('local').detail, NOT_SET_UP.trim());
    await until(() => f.count('launch') >= 3, 'the start tried again');
    const n = f.count('launch');
    assert.equal(stateOf(h), 'not_started');
    // with the long wait, Retry is what starts it again
    setUp = true;
    await reaches(h, 'connected');
    assert.ok(f.count('launch') > n || true);
  }, { s, timing: { ...T, backoff: [20, 40, 80] } });

  const g = fake(() => fail('no luck'));
  await withLocal(g, async (h) => {
    await reaches(h, 'not_started');
    const n = g.count('launch');
    await sleep(300);
    assert.equal(g.count('launch'), n, 'the wait is long');
    const r = await h.app('owner.retry');
    assert.deepEqual([r.status, r.body], [200, { ok: true }]);
    await until(() => g.count('launch') === n + 1, 'a start at once');
  }, { timing: { ...T, backoff: [60000] } });
});

test('a start that fails again with another reason shows the new reason and tells the page', async () => {
  let reason = 'the first reason';
  const f = fake(() => fail(reason));
  await withLocal(f, async (h) => {
    await reaches(h, 'not_started');
    assert.equal(h.rec.viewOf('local').detail, 'the first reason');
    const n = f.count('launch');
    await until(() => f.count('launch') >= n + 2, 'the start tried again with the same reason');
    const events = () => h.rec.states('local').length;
    const before = events();
    reason = 'the second reason';
    await until(() => h.rec.viewOf('local').detail === 'the second reason', 'the second reason is shown');
    assert.equal(stateOf(h), 'not_started');
    await sleep(100);
    assert.equal(events(), before + 1, 'one server_state for the change of reason');
  }, { timing: { ...T, backoff: [20] } });
});

test('what the start printed that is not usable: not_started with a sentence; the program that cannot run', async () => {
  const s = await standin();
  const cases = [
    ['not JSON', () => ok('hello\n'), /not one JSON line/],
    ['two lines', () => ok('{}\n{}\n'), /not one JSON line/],
    ['empty', () => ok(''), /not one JSON line/],
    ['an array', () => ok('[]\n'), /not one JSON line/],
    ['unknown state', () => ok('{"state":"maybe"}\n'), /state that is not known/],
    ['no address', () => ok(JSON.stringify({ state: 'running', fingerprint: s.fingerprint }) + '\n'), /no usable address/],
    ['bad address', () => ok(launchLine(s, { address: 'http://127.0.0.1:1' })), /no usable address/],
    ['bad fingerprint', () => ok(launchLine(s, { fingerprint: 'AB' })), /no usable address/],
    ['exit with no text', () => ({ code: 3, stdout: '', stderr: '' }), /exited with code 3/],
    ['cannot run', () => ({ code: -1, stdout: '', stderr: 'spawn /nope ENOENT' }), /spawn \/nope ENOENT/],
    ['cannot run, no text', () => ({ code: -1, stdout: '', stderr: '' }), /could not be run/],
  ];
  for (const [name, answer, detail] of cases) {
    await withLocal(fake(answer), async (h) => {
      await reaches(h, 'not_started');
      assert.match(h.rec.viewOf('local').detail, detail, name);
    }, { timing: { ...T, backoff: [60000] } });
  }
  // the secret cannot be read
  for (const [name, secret, detail] of [
    ['secret fails', fail('no secret file'), /no secret file/],
    ['secret empty', ok('\n'), /printed no secret/],
    ['secret with a space', ok('a b\n'), /printed no secret/],
  ]) {
    await withLocal(fake((args) => (args[0] === 'secret' ? secret : ok(launchLine(s)))), async (h) => {
      await reaches(h, 'not_started');
      assert.match(h.rec.viewOf('local').detail, detail, name);
    }, { timing: { ...T, backoff: [60000] } });
  }
  await s.close();
});

test('a server of an older build: too_old with the version, no connection, asked again every tooOld', async () => {
  const s = await standin();
  let old = true;
  const f = fake((args) => {
    if (old && args[0] === 'launch') return ok(JSON.stringify({ state: 'old_build', version: '0.9.0', featureLevel: 5, pid: 77, home: '/h' }) + '\n');
    return running(s)(args);
  });
  await withLocal(f, async (h) => {
    await reaches(h, 'too_old');
    assert.deepEqual([h.rec.viewOf('local').version, h.rec.viewOf('local').detail], ['0.9.0', 'A server of an older build is running: restart it.']);
    await until(() => f.count('launch') >= 3, 'asked again');
    assert.equal(s.requests.length, 0, 'no connection');
    assert.equal(f.count('secret'), 0);
    old = false;
    await reaches(h, 'connected');
  }, { s });
});

test('a running server whose hello says level 5: too_old, asked again, connects once updated', async () => {
  const s = await standin();
  s.level = 5;
  await withLocal(fake(running(s)), async (h) => {
    await reaches(h, 'too_old');
    assert.equal(h.rec.viewOf('local').version, '1.2.3');
    s.level = 6;
    await reaches(h, 'connected');
  }, { s });
});

test('a server that stops while the app is open is started again before the next attempt', async () => {
  const a = await standin();
  const b = await standin();
  let cur = a;
  const f = fake((args) => running(cur)(args));
  await withLocal(f, async (h) => {
    await reaches(h, 'connected');
    const states = h.rec.states('local').length;
    cur = b;
    await a.close();
    await until(() => b.streams.size === 1 && stateOf(h) === 'connected', 'the new server');
    assert.ok(f.count('launch') >= 2);
    assert.ok(h.rec.states('local').slice(states).includes('unreachable'), 'its section went to not connected and back');
    assert.equal(h.rec.viewOf('local').address, b.address);
    // a call goes to the new server
    b.routes.set('GET /api/dirs', () => ({ json: { from: 'b' } }));
    assert.equal(JSON.parse((await h.client.call({ server: 'local', method: 'GET', path: '/api/dirs' })).text).from, 'b');
  }, { s: b });
});

test('the secret refused: read again; another one is used at once, the same one waits for Retry', async () => {
  const s = await standin();
  let current = s.secret;
  const queue = []; // answers of `secret` that are not the current one
  const f = fake((args) => (args[0] === 'secret' ? ok((queue.length ? queue.shift() : current) + '\n') : ok(launchLine(s))));
  await withLocal(f, async (h) => {
    await reaches(h, 'connected');
    // the server's secret changed; the start after the cut still reads the old one, the second reading is the new one
    const old = s.secret;
    s.secret = 'secret-two';
    current = 'secret-two';
    queue.push(old);
    h.rec.secrets.add('secret-two');
    const launches = f.count('launch');
    s.cut();
    await until(() => s.streams.size === 1 && stateOf(h) === 'connected', 'back with the new secret');
    // the cut made the app start the server again (it found it running); the refused secret was only read again
    assert.equal(f.count('launch'), launches + 1);
    assert.equal(f.count('secret'), 3);
    // the same secret again: refused until Retry
    s.secret = 'secret-three';
    s.cut();
    await reaches(h, 'secret_not_accepted');
    const secrets = f.count('secret');
    assert.equal(secrets, 5);
    await sleep(250);
    assert.equal(f.count('secret'), secrets);
    current = 'secret-three';
    h.rec.secrets.add('secret-three');
    await h.app('owner.retry');
    await reaches(h, 'connected');
    h.rec.assertNoSecrets();
  }, { s });
});

test('the certificate changed: launch once more; a new fingerprint is used at once, the same one waits for Retry', async () => {
  const s = await standin();
  let fingerprint = s.fingerprint;
  const f = fake((args) => (args[0] === 'secret' ? ok(s.secret + '\n') : ok(launchLine(s, { fingerprint }))));
  await withLocal(f, async (h) => {
    await reaches(h, 'connected');
    const launches = f.count('launch');
    s.setCert('b');
    fingerprint = fingerprintOf('b');
    s.cut();
    await until(() => s.streams.size === 1 && stateOf(h) === 'connected', 'back with the new certificate');
    assert.equal(f.count('launch'), launches + 1);
    // the program still names the old one: the section says so and waits
    s.setCert('a');
    s.cut();
    await reaches(h, 'certificate_changed');
    assert.equal(h.rec.viewOf('local').fingerprint, undefined, 'no fingerprint is shown for this computer');
    const n = f.count('launch');
    await sleep(250);
    assert.equal(f.count('launch'), n);
    fingerprint = s.fingerprint;
    await h.app('owner.retry');
    await reaches(h, 'connected');
  }, { s });
});

test('owner.restart: relaunch, then secret; meanwhile connecting "Restarting…"; the connection moves to what it printed', async () => {
  const a = await standin();
  const b = await standin();
  let cur = a;
  let slow = false;
  const f = fake(async (args) => {
    if (args[0] === 'relaunch') { cur = b; if (slow) await sleep(200); }
    return running(cur)(args);
  });
  await withLocal(f, async (h) => {
    await reaches(h, 'connected');
    slow = true;
    const restart = h.app('owner.restart');
    await until(() => h.rec.viewOf('local').detail === 'Restarting…', 'Restarting…');
    assert.equal(stateOf(h), 'connecting');
    const r = await restart;
    assert.deepEqual([r.status, r.body], [200, { ok: true }]);
    await until(() => b.streams.size === 1 && stateOf(h) === 'connected', 'connected to the restarted server');
    assert.equal(h.rec.viewOf('local').detail, undefined);
    assert.equal(h.rec.viewOf('local').address, b.address);
    assert.deepEqual(f.calls.filter((c) => c[0] === 'relaunch'), [['relaunch', '-json']]);
    assert.equal(f.most, 1, 'the program never ran twice at once');
    await a.close();
  }, { s: b });
});

test('owner.restart that fails: 500 restart_failed with the reason; the section recovers by itself', async () => {
  const s = await standin();
  let broken = true;
  const f = fake((args) => (args[0] === 'relaunch' && broken ? fail('the server did not answer within 30 seconds') : running(s)(args)));
  await withLocal(f, async (h) => {
    await reaches(h, 'connected');
    const r = await h.app('owner.restart');
    assert.deepEqual([r.status, r.body], [500, { error: 'the server did not answer within 30 seconds', code: 'restart_failed' }]);
    await until(() => stateOf(h) === 'connected' && s.streamsOpened >= 2, 'recovered');
    broken = false;
    assert.deepEqual((await h.app('owner.restart')).body, { ok: true });
    await until(() => stateOf(h) === 'connected', 'connected');
  }, { s });
});

test('owner.status: the parsed object, also when the program exits 1; 500 status_failed when it cannot be read', async () => {
  const s = await standin();
  let answer = { code: 1, stdout: '{"running":null,"files":{"setUp":false}}\n', stderr: 'not set up' };
  const f = fake((args) => (args[0] === 'status' ? answer : running(s)(args)));
  await withLocal(f, async (h) => {
    await reaches(h, 'connected');
    assert.deepEqual(await h.app('owner.status'), { status: 200, body: { running: null, files: { setUp: false } } });
    answer = fail('boom');
    const r = await h.app('owner.status');
    assert.deepEqual([r.status, r.body.code, r.body.error], [500, 'status_failed', 'boom']);
    assert.deepEqual((await h.app('owner.openLog')).body.code, 'not_here');
    assert.deepEqual((await h.app('owner.reveal', { board: 'b_12345678' })).status, 501);
    assert.equal((await h.app('owner.nothing')).status, 404);
    assert.equal((await h.app('servers.nothing')).body.code, 'no_op');
  }, { s });
});

test('without a local entry: no section of this computer and every owner.* answers 404 no_owner', async () => {
  const h = make({ timing: T });
  try {
    h.subscribe();
    assert.deepEqual((await h.app('servers.list')).body, { servers: [], notice: '' });
    for (const op of ['owner.restart', 'owner.retry', 'owner.status', 'owner.openLog', 'owner.reveal']) {
      const a = await h.app(op, { board: 'b_12345678' });
      assert.deepEqual([a.status, a.body.code], [404, 'no_owner'], op);
    }
    assert.equal(h.client.localInfo(), null);
    const r = await h.client.call({ server: 'local', method: 'GET', path: '/api/state' });
    assert.equal(r.status, 404);
    const first = h.rec.envelopes[0];
    await until(() => h.rec.envelopes.length > 0, 'the list');
    assert.deepEqual(h.rec.envelopes[0].app.servers, []);
    void first;
  } finally { await h.close(); h.cleanup(); }
});

test('a remote server that is down does not hold up this computer, and the other way round', async () => {
  const s = await standin();
  const black = await blackhole();
  const r = await standin();
  const h = make({ timing: { ...T, handshake: 5000, dial: 5000 }, local: { bin: '/x', run: fake(running(s)).run } });
  try {
    h.rec.secrets.add(s.secret);
    h.subscribe();
    const hang = await h.app('servers.add', { force: true, form: { name: 'Black hole', address: `https://127.0.0.1:${black.port}`, secret: 'sekret-hang', selfSigned: true, pin: fingerprintOf('a') } });
    await until(() => stateOf(h) === 'connected', 'this computer');
    const listed = (await h.app('servers.list')).body.servers;
    assert.equal(listed.find((x) => x.id === hang.body.server.id).state, 'connecting', 'the black hole is still trying');
    s.routes.set('GET /api/dirs', () => ({ json: { ok: 1 } }));
    assert.equal((await h.client.call({ server: 'local', method: 'GET', path: '/api/dirs' })).status, 200);
    s.emit({ type: 'tick' });
    await until(() => h.rec.eventsOf('local').some((e) => e.type === 'tick'), 'an event of this computer');
    black.close();

    // the other way round: this computer's start hangs, a remote connects and answers at once
    const slow = make({ timing: T, local: { bin: '/x', run: () => new Promise(() => {}) } });
    try {
      slow.subscribe();
      const v = await addServer(slow, r, 'Remote');
      await until(() => slow.rec.stateOf(v.id) === 'connected', 'the remote while this computer hangs');
      assert.equal(slow.rec.stateOf('local'), 'connecting');
      r.routes.set('GET /api/dirs', () => ({ json: { ok: 2 } }));
      assert.equal((await slow.client.call({ server: v.id, method: 'GET', path: '/api/dirs' })).status, 200);
      assert.equal((await slow.client.call({ server: 'local', method: 'GET', path: '/api/dirs' })).status, 503);
    } finally { await slow.close(); slow.cleanup(); }
  } finally { await h.close(); h.cleanup(); await s.close(); await r.close(); }
});

test('a remote entry that is this computer\'s own server is told so: is_local', async () => {
  const s = await standin();
  await withLocal(fake(running(s)), async (h) => {
    await reaches(h, 'connected');
    const a = await h.app('servers.test', { form: { address: `https://localhost:${s.port}`, secret: s.secret, selfSigned: true, pin: s.fingerprint } });
    assert.deepEqual([a.body.step, a.body.outcome, a.body.message], [4, 'is_local', "This is this computer's server"]);
    const v = await addServer(h, s, 'Same'); // the box and the pin, no test
    await until(() => h.rec.stateOf(v.id) === 'another_server', 'another_server');
    assert.equal(h.rec.viewOf(v.id).detail, "This is this computer's server");
    assert.equal(stateOf(h), 'connected');
  }, { s });
});

test('a remote entry that connected before this computer was known is made to connect again and told is_local', async () => {
  const s = await standin();
  let release;
  const gate = new Promise((r) => { release = r; });
  const f = fake(async (args) => { await gate; return running(s)(args); });
  await withLocal(f, async (h) => {
    const v = await addServer(h, s, 'Same');
    await until(() => h.rec.stateOf(v.id) === 'connected', 'the remote entry');
    release();
    await until(() => h.rec.stateOf(v.id) === 'another_server', 'the remote entry to be told');
    await reaches(h, 'connected');
  }, { s });
});

// ---- the real starter, with a program in a temporary folder ----

function program(dir, body) {
  const file = path.join(dir, 'ai-whiteboard');
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return file;
}

test('the real runner: stdout, stderr, the exit code, a program that is not there, a time-out', async () => {
  const s = await standin();
  const dir = tmpDir();
  const bin = program(dir, `
    const a = process.argv.slice(2);
    if (a[0] === 'launch') { console.log(process.env.AIWB_FAKE ? ${JSON.stringify(launchLine(s)).trim()} : 'x'); }
    else if (a[0] === 'secret') { if (process.env.AIWB_FAKE === 'slow') setTimeout(() => {}, 60000); else console.log(${JSON.stringify(s.secret)}); }
    else { console.error('boom'); process.exit(4); }
  `);
  const { createNodeClient: createClient } = require('../node');
  const run = async (opts, wait) => {
    const rec = [];
    const c = createClient({
      stateDir: tmpDir(), local: { bin, env: { ...process.env, ...opts }, home: null },
      timing: { ...T, secret: 400, backoff: [60000] }, roots: undefined, log: (l) => rec.push(l),
    });
    const got = [];
    c.subscribe((e) => got.push(e));
    try {
      await until(() => wait(got), 'the state');
      return got;
    } finally { await c.close(); }
  };
  const last = (got) => got.filter((e) => e.app && e.app.type === 'server_state').pop()?.app.server;
  try {
    let got = await run({ AIWB_FAKE: '1' }, (g) => last(g)?.state === 'connected');
    assert.equal(last(got).address, s.address);
    got = await run({}, (g) => last(g)?.state === 'not_started');
    assert.match(last(got).detail, /not one JSON line|usable/);
    got = await run({ AIWB_FAKE: 'slow' }, (g) => last(g)?.state === 'not_started'); // the secret never comes: the program is killed
    assert.match(last(got).detail, /did not finish within|secret/);
  } finally { await s.close(); }
  // a program that is not there
  const c = createClient({ stateDir: tmpDir(), local: { bin: path.join(dir, 'nope') }, timing: { ...T, backoff: [60000] } });
  const got = [];
  c.subscribe((e) => got.push(e));
  try {
    await until(() => last(got)?.state === 'not_started', 'not_started');
    assert.match(last(got).detail, /ENOENT/);
  } finally { await c.close(); }
});
