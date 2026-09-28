const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CHECK_INTERVAL_MS,
  CHECK_TIMEOUT_MS,
  CHECK_FAILURES,
  RELAUNCH_RETRY_MS,
  checkServer,
  createReconnector,
  findServer,
} = require('../lib');

const URL1 = 'http://127.0.0.1:4747/';
const URL2 = 'http://127.0.0.1:4748/';

// fakeClock is a setTimeout/clearTimeout pair driven by advance(ms).
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    pending: () => timers.size,
    // advance moves time forward by ms, running every timer that comes due, in order, and letting
    // the promises they start settle.
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await settle();
        let due = null;
        for (const [id, t] of timers) {
          if (t.at <= end && (!due || t.at < due[1].at)) due = [id, t];
        }
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
      await settle();
    },
  };
}

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise(setImmediate);
}

// deferred is a promise with its resolve and reject.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// setup returns a reconnector over fakes. checks are what check answers, in order (then true);
// launches are what launch answers, in order: a URL, an Error (rejects) or a deferred (settles when
// the test says). Every call is recorded in calls.
function setup({ checks = [], launches = [] } = {}) {
  const clock = fakeClock();
  const calls = [];
  const rc = createReconnector({
    check: async (url) => {
      calls.push(['check', url]);
      return checks.length ? checks.shift() : true;
    },
    launch: () => {
      calls.push(['launch']);
      const r = launches.shift() ?? URL2;
      if (r instanceof Error) return Promise.reject(r);
      if (r && r.promise) return r.promise;
      return Promise.resolve(r);
    },
    load: async (url) => {
      calls.push(['load', url]);
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  const count = (kind) => calls.filter((c) => c[0] === kind).length;
  return { clock, calls, rc, count };
}

test('constants: check every 2 s with a 1 s timeout, relaunch after 3 failures, retry after 5 s', () => {
  assert.equal(CHECK_INTERVAL_MS, 2000);
  assert.equal(CHECK_TIMEOUT_MS, 1000);
  assert.equal(CHECK_FAILURES, 3);
  assert.equal(RELAUNCH_RETRY_MS, 5000);
});

test('reconnect: checks the loaded URL every 2 s', async () => {
  const { clock, calls, rc } = setup();
  rc.start(URL1);
  await clock.advance(1999);
  assert.deepEqual(calls, []);
  await clock.advance(1);
  assert.deepEqual(calls, [['check', URL1]]);
  await clock.advance(4000);
  assert.deepEqual(calls, [['check', URL1], ['check', URL1], ['check', URL1]]);
});

test('reconnect: 1 or 2 failed checks → no launch', async () => {
  const { clock, rc, count } = setup({ checks: [false, false] });
  rc.start(URL1);
  await clock.advance(2000);
  assert.equal(count('launch'), 0);
  await clock.advance(2000);
  assert.equal(count('check'), 2);
  assert.equal(count('launch'), 0);
  await clock.advance(20000);
  assert.equal(count('launch'), 0);
});

test('reconnect: 3 failed checks in a row → one launch, the printed URL is loaded, count resets', async () => {
  const { clock, calls, rc, count } = setup({ checks: [false, false, false, false, false] });
  rc.start(URL1);
  await clock.advance(6000);
  assert.deepEqual(calls, [
    ['check', URL1],
    ['check', URL1],
    ['check', URL1],
    ['launch'],
    ['load', URL2],
  ]);
  // The count starts again at 0: two more failures (checks of the new URL) do not relaunch.
  await clock.advance(4000);
  assert.deepEqual(calls.slice(5), [['check', URL2], ['check', URL2]]);
  assert.equal(count('launch'), 1);
  // A third one after the reload would; the later checks answer true.
  await clock.advance(20000);
  assert.equal(count('launch'), 1);
});

test('reconnect: a successful check between failures resets the count', async () => {
  const { clock, rc, count } = setup({ checks: [false, false, true, false, false, true] });
  rc.start(URL1);
  await clock.advance(12000);
  assert.equal(count('check'), 6);
  assert.equal(count('launch'), 0);
});

test('reconnect: a check that throws counts as a failure', async () => {
  const clock = fakeClock();
  let launches = 0;
  const rc = createReconnector({
    check: async () => {
      throw new Error('boom');
    },
    launch: async () => {
      launches++;
      return URL2;
    },
    load: async () => {},
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  rc.start(URL1);
  await clock.advance(6000);
  assert.equal(launches, 1);
  rc.stop();
});

test('reconnect: did-fail-load → launch at once; error code -3 → nothing', async () => {
  const { clock, calls, rc } = setup();
  rc.start(URL1);
  rc.failLoad(-3);
  await clock.advance(0);
  assert.deepEqual(calls, []);
  rc.failLoad(-102); // ERR_CONNECTION_REFUSED
  await clock.advance(0);
  assert.deepEqual(calls, [['launch'], ['load', URL2]]);
  // Checking starts again 2 s after the reload.
  await clock.advance(2000);
  assert.deepEqual(calls.slice(2), [['check', URL2]]);
});

test('reconnect: launch fails → a new launch 5 s later, and so on until it works', async () => {
  const { clock, calls, rc, count } = setup({
    launches: [new Error('exit 1'), new Error('exit 1'), URL2],
  });
  rc.start(URL1);
  rc.failLoad(-102);
  await clock.advance(0);
  assert.deepEqual(calls, [['launch']]);
  await clock.advance(4999);
  assert.equal(count('launch'), 1);
  assert.equal(count('check'), 0);
  await clock.advance(1);
  assert.equal(count('launch'), 2);
  await clock.advance(5000);
  assert.deepEqual(calls, [['launch'], ['launch'], ['launch'], ['load', URL2]]);
  await clock.advance(2000);
  assert.deepEqual(calls.slice(4), [['check', URL2]]);
});

test('reconnect: a load that fails is retried like a failed launch', async () => {
  const clock = fakeClock();
  const calls = [];
  let loadFails = 1;
  const rc = createReconnector({
    check: async () => true,
    launch: async () => {
      calls.push('launch');
      return URL2;
    },
    load: async () => {
      calls.push('load');
      if (loadFails-- > 0) throw new Error('ERR_CONNECTION_REFUSED');
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  rc.start(URL1);
  rc.failLoad(-102);
  await clock.advance(4999);
  assert.deepEqual(calls, ['launch', 'load']);
  await clock.advance(1);
  assert.deepEqual(calls, ['launch', 'load', 'launch', 'load']);
  rc.stop();
});

test('reconnect: a second trigger while a launch runs → still one launch', async () => {
  const d = deferred();
  const { clock, calls, rc, count } = setup({ launches: [d], checks: [false, false, false] });
  rc.start(URL1);
  rc.failLoad(-102);
  await clock.advance(0);
  rc.failLoad(-102);
  rc.failLoad(-6);
  // Checks do not run (and so cannot trigger) while the launch runs.
  await clock.advance(20000);
  assert.equal(count('launch'), 1);
  assert.equal(count('check'), 0);
  d.resolve(URL2);
  await clock.advance(0);
  assert.deepEqual(calls, [['launch'], ['load', URL2]]);
  // A failure after the launch finished triggers a new one.
  rc.failLoad(-102);
  await clock.advance(0);
  assert.equal(count('launch'), 2);
});

test('reconnect: the third failure while a did-fail-load launch runs does not launch again', async () => {
  const d = deferred();
  const clock = fakeClock();
  let launches = 0;
  const checkAnswers = [];
  const rc = createReconnector({
    // Each check waits for the test to answer it.
    check: () => {
      const c = deferred();
      checkAnswers.push(c);
      return c.promise;
    },
    launch: () => {
      launches++;
      return d.promise;
    },
    load: async () => {},
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  rc.start(URL1);
  await clock.advance(2000);
  checkAnswers[0].resolve(false);
  await clock.advance(2000);
  checkAnswers[1].resolve(false);
  await clock.advance(2000);
  rc.failLoad(-102); // launch starts while the third check is in flight
  checkAnswers[2].resolve(false);
  await clock.advance(0);
  assert.equal(launches, 1);
  d.resolve(URL2);
  await clock.advance(0);
  assert.equal(launches, 1);
  rc.stop();
});

test('reconnect: nothing happens before start', async () => {
  const { clock, calls, rc } = setup();
  rc.failLoad(-102);
  await clock.advance(60000);
  assert.deepEqual(calls, []);
  assert.equal(clock.pending(), 0);
});

test('reconnect: stopped (window closed / quitting) → no checks, no launches', async () => {
  const { clock, calls, rc } = setup({ checks: [false, false, false] });
  rc.start(URL1);
  await clock.advance(2000);
  assert.deepEqual(calls, [['check', URL1]]);
  rc.stop();
  assert.equal(clock.pending(), 0);
  rc.failLoad(-102);
  await clock.advance(60000);
  assert.deepEqual(calls, [['check', URL1]]);
});

test('reconnect: stop during the 5 s retry wait → no more launches', async () => {
  const { clock, rc, count } = setup({ launches: [new Error('exit 1')] });
  rc.start(URL1);
  rc.failLoad(-102);
  await clock.advance(1000);
  rc.stop();
  await clock.advance(60000);
  assert.equal(count('launch'), 1);
  assert.equal(clock.pending(), 0);
});

test('reconnect: stop while a launch runs → its URL is not loaded', async () => {
  const d = deferred();
  const { clock, calls, rc } = setup({ launches: [d] });
  rc.start(URL1);
  rc.failLoad(-102);
  await clock.advance(0);
  rc.stop();
  d.resolve(URL2);
  await clock.advance(60000);
  assert.deepEqual(calls, [['launch']]);
  assert.equal(clock.pending(), 0);
});

test('reconnect: a check still in flight at stop is dropped', async () => {
  const clock = fakeClock();
  let answer;
  let checks = 0;
  const rc = createReconnector({
    check: () => {
      checks++;
      return new Promise((res) => {
        answer = res;
      });
    },
    launch: async () => URL2,
    load: async () => {},
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  rc.start(URL1);
  await clock.advance(2000);
  rc.stop();
  answer(false);
  await clock.advance(60000);
  assert.equal(checks, 1);
  assert.equal(clock.pending(), 0);
});

test('reconnect: start after stop resumes checking the new URL', async () => {
  const { clock, calls, rc } = setup();
  rc.start(URL1);
  rc.stop();
  await clock.advance(10000);
  assert.deepEqual(calls, []);
  rc.start(URL2);
  await clock.advance(2000);
  assert.deepEqual(calls, [['check', URL2]]);
});

test('reconnect: start while running keeps one check loop', async () => {
  const { clock, rc, count } = setup();
  rc.start(URL1);
  rc.start(URL1);
  await clock.advance(2000);
  assert.equal(count('check'), 1);
  assert.equal(clock.pending(), 1);
});

test('reconnect: stopped and started again while a launch runs → one launch, then checks resume', async () => {
  const d = deferred();
  const { clock, calls, rc, count } = setup({ launches: [d] });
  rc.start(URL1);
  rc.failLoad(-102);
  await clock.advance(0);
  rc.stop();
  rc.start(URL2);
  rc.failLoad(-102); // still ignored: a launch runs
  await clock.advance(10000);
  assert.equal(count('launch'), 1);
  assert.equal(count('check'), 0);
  d.resolve('http://127.0.0.1:9999/');
  await clock.advance(2000);
  // The stale launch's URL is not loaded; the new window's URL is checked.
  assert.deepEqual(calls, [['launch'], ['check', URL2]]);
});

// fakeFetch answers with status and body (a value to JSON, or an Error for a bad body), or throws
// when given an Error as status.
function fakeFetch(status, body) {
  const seen = [];
  const fetch = async (url, opts) => {
    seen.push({ url, opts });
    if (status instanceof Error) throw status;
    return {
      ok: status >= 200 && status < 300,
      json: async () => {
        if (body instanceof Error) throw body;
        return body;
      },
    };
  };
  return { fetch, seen };
}

test('checkServer: asks /api/hello on the origin with a 1 s timeout', async () => {
  const { fetch, seen } = fakeFetch(200, { app: 'ai-whiteboard', pid: 1 });
  assert.equal(await checkServer({ fetch, url: 'http://127.0.0.1:4747/some/page?x=1' }), true);
  assert.equal(seen[0].url, 'http://127.0.0.1:4747/api/hello');
  assert.ok(seen[0].opts.signal instanceof AbortSignal);
});

test('checkServer: anything but a JSON answer with app ai-whiteboard is a failure', async () => {
  const cases = [
    fakeFetch(200, { app: 'something-else' }),
    fakeFetch(200, null),
    fakeFetch(200, new SyntaxError('Unexpected token <')),
    fakeFetch(502, { app: 'ai-whiteboard' }),
    fakeFetch(new TypeError('fetch failed')),
  ];
  for (const { fetch } of cases) {
    assert.equal(await checkServer({ fetch, url: URL1 }), false);
  }
});

test('checkServer: a server that does not answer within the timeout is a failure', async () => {
  const fetch = (_url, { signal }) =>
    new Promise((_res, rej) => signal.addEventListener('abort', () => rej(signal.reason)));
  const started = Date.now();
  assert.equal(await checkServer({ fetch, url: URL1, timeoutMs: 20 }), false);
  assert.ok(Date.now() - started < 1000);
});

test('findServer: runs launch with the start-up binary and arguments, or uses AIWB_URL', async () => {
  const seen = [];
  const execFile = (bin, args, opts, cb) => {
    seen.push([bin, args]);
    setImmediate(() => cb(null, `${URL1}\n`, ''));
  };
  const bin = '/bin/aiwb';
  const args = ['launch', '-client', '/repo/web/dist'];
  assert.equal(await findServer({ env: {}, bin, args, execFile }), URL1);
  assert.deepEqual(seen, [[bin, args]]);
  assert.equal(await findServer({ env: { AIWB_URL: URL2 }, bin, args, execFile }), URL2);
  assert.equal(seen.length, 1);
  const failing = (_b, _a, _o, cb) => setImmediate(() => cb(new Error('exit 1'), '', 'boom\n'));
  await assert.rejects(findServer({ env: {}, bin, args, execFile: failing }), /boom/);
});
