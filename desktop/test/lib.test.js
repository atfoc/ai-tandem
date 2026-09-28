const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  LAUNCH_TIMEOUT_MS,
  serverBin,
  launchArgs,
  parseLaunchOutput,
  serverLogPath,
  createStartUp,
} = require('../lib');

const dirname = '/repo/desktop';
const execPath = '/Applications/AI Whiteboard.app/Contents/MacOS/AI Whiteboard';

test('serverBin: AIWB_SERVER_BIN wins, packaged or not', () => {
  const env = { AIWB_SERVER_BIN: '/tmp/aiwb' };
  assert.equal(serverBin({ env, execPath, isPackaged: true, dirname }), '/tmp/aiwb');
  assert.equal(serverBin({ env, execPath, isPackaged: false, dirname }), '/tmp/aiwb');
});

test('serverBin: packaged → next to process.execPath', () => {
  assert.equal(
    serverBin({ env: {}, execPath, isPackaged: true, dirname }),
    '/Applications/AI Whiteboard.app/Contents/MacOS/ai-whiteboard',
  );
});

test('serverBin: dev → ../bin/ai-whiteboard', () => {
  assert.equal(serverBin({ env: {}, execPath, isPackaged: false, dirname }), '/repo/bin/ai-whiteboard');
});

test('launchArgs: packaged → launch only', () => {
  assert.deepEqual(launchArgs({ isPackaged: true, dirname }), ['launch']);
});

test('launchArgs: dev → launch -client <absolute ../web/dist>', () => {
  const args = launchArgs({ isPackaged: false, dirname: 'desktop' });
  assert.deepEqual(args, ['launch', '-client', path.resolve('web/dist')]);
  assert.ok(path.isAbsolute(args[2]));
});

test('parseLaunchOutput: one URL line', () => {
  assert.equal(parseLaunchOutput('http://127.0.0.1:4747/\n'), 'http://127.0.0.1:4747/');
  assert.equal(parseLaunchOutput('https://localhost:8443/\n'), 'https://localhost:8443/');
});

test('parseLaunchOutput: empty or non-URL output is an error', () => {
  for (const out of ['', '\n', 'AI Whiteboard is already running', 'file:///etc/passwd',
    'http://127.0.0.1:4747/\nhttp://127.0.0.1:4748/', undefined]) {
    assert.throws(() => parseLaunchOutput(out), /no server URL/, JSON.stringify(out));
  }
});

test('serverLogPath', () => {
  assert.equal(serverLogPath('/Users/me'), '/Users/me/.ai-whiteboard/server.log');
});

// fakes records every call made by the start-up runner. results are what execFile answers, in
// order; errorActions are what the error dialog answers, in order. app.quitting is what
// isQuitting() answers; onExec and onLoad run inside execFile and loadURL (e.g. to start a quit).
function fakes({ env = {}, results = [], errorActions = [], loadFails = [], onExec, onLoad } = {}) {
  const calls = [];
  const app = { quitting: false };
  const deps = {
    env,
    bin: '/bin/aiwb',
    args: ['launch', '-client', '/repo/web/dist'],
    execFile(bin, args, opts, cb) {
      calls.push(['execFile', bin, args, opts]);
      if (onExec) onExec(app);
      const r = results.shift() ?? { stdout: 'http://127.0.0.1:4747/\n' };
      setImmediate(() => cb(r.err ?? null, r.stdout ?? '', r.stderr ?? ''));
    },
    showStarting: () => calls.push(['showStarting']),
    hideStarting: () => calls.push(['hideStarting']),
    loadURL: async (url) => {
      calls.push(['loadURL', url]);
      if (onLoad) onLoad(app);
      const fail = loadFails.shift();
      if (fail) throw new Error(fail);
    },
    showError: async (detail) => {
      calls.push(['showError', detail]);
      return errorActions.shift() ?? 'quit';
    },
    quit: () => calls.push(['quit']),
    isQuitting: () => app.quitting,
  };
  return { deps, calls, app };
}

test('start-up: success shows Starting, loads the URL, hides Starting', async () => {
  const { deps, calls } = fakes();
  const url = await createStartUp(deps)();
  assert.equal(url, 'http://127.0.0.1:4747/');
  assert.deepEqual(calls, [
    ['showStarting'],
    ['execFile', '/bin/aiwb', ['launch', '-client', '/repo/web/dist'], { timeout: LAUNCH_TIMEOUT_MS }],
    ['loadURL', 'http://127.0.0.1:4747/'],
    ['hideStarting'],
  ]);
});

test('start-up: failure hides Starting and shows the error with the stderr text', async () => {
  const { deps, calls } = fakes({
    results: [{ err: new Error('Command failed'), stderr: 'the server did not answer within 30 seconds\n' }],
  });
  assert.equal(await createStartUp(deps)(), null);
  assert.deepEqual(calls.slice(2), [
    ['hideStarting'],
    ['showError', 'the server did not answer within 30 seconds'],
    ['quit'],
  ]);
  assert.ok(!calls.some((c) => c[0] === 'loadURL'));
});

test('start-up: failure with empty stderr shows the error message', async () => {
  const { deps, calls } = fakes({ results: [{ err: new Error('spawn /bin/aiwb ENOENT') }] });
  await createStartUp(deps)();
  assert.deepEqual(calls.find((c) => c[0] === 'showError'), ['showError', 'spawn /bin/aiwb ENOENT']);
});

test('start-up: output that is not a URL is an error', async () => {
  const { deps, calls } = fakes({ results: [{ stdout: 'hello\n' }] });
  await createStartUp(deps)();
  const shown = calls.find((c) => c[0] === 'showError');
  assert.match(shown[1], /no server URL/);
  assert.ok(!calls.some((c) => c[0] === 'loadURL'));
});

test('start-up: a page that fails to load is an error', async () => {
  const { deps, calls } = fakes({ loadFails: ['ERR_CONNECTION_REFUSED'] });
  await createStartUp(deps)();
  assert.deepEqual(calls.slice(3), [['hideStarting'], ['showError', 'ERR_CONNECTION_REFUSED'], ['quit']]);
});

test('start-up: Retry runs execFile again with the same binary and arguments', async () => {
  const { deps, calls } = fakes({
    results: [{ err: new Error('exit 1'), stderr: 'boom' }, { stdout: 'http://127.0.0.1:4748/\n' }],
    errorActions: ['retry'],
  });
  const url = await createStartUp(deps)();
  assert.equal(url, 'http://127.0.0.1:4748/');
  const execs = calls.filter((c) => c[0] === 'execFile');
  assert.equal(execs.length, 2);
  assert.deepEqual(execs[1], execs[0]);
  assert.deepEqual(calls.slice(-4), [
    ['showStarting'],
    execs[1],
    ['loadURL', 'http://127.0.0.1:4748/'],
    ['hideStarting'],
  ]);
  assert.ok(!calls.some((c) => c[0] === 'quit'));
});

test('start-up: AIWB_URL loads that URL without execFile', async () => {
  const { deps, calls } = fakes({ env: { AIWB_URL: 'http://127.0.0.1:5000/' } });
  const url = await createStartUp(deps)();
  assert.equal(url, 'http://127.0.0.1:5000/');
  assert.ok(!calls.some((c) => c[0] === 'execFile'));
  assert.deepEqual(calls.find((c) => c[0] === 'loadURL'), ['loadURL', 'http://127.0.0.1:5000/']);
});

test('start-up: a second call while one runs shares it', async () => {
  const { deps, calls } = fakes();
  const start = createStartUp(deps);
  const [a, b] = await Promise.all([start(), start()]);
  assert.equal(a, b);
  assert.equal(calls.filter((c) => c[0] === 'execFile').length, 1);
  await start();
  assert.equal(calls.filter((c) => c[0] === 'execFile').length, 2);
});

test('start-up: a load aborted by quitting shows no error and does not quit again', async () => {
  const { deps, calls } = fakes({
    loadFails: ["ERR_FAILED (-2) loading 'http://127.0.0.1:4747/'"],
    onLoad: (app) => { app.quitting = true; },
  });
  assert.equal(await createStartUp(deps)(), null);
  assert.deepEqual(calls.slice(3), [['hideStarting']]);
  assert.ok(!calls.some((c) => c[0] === 'showError'));
  assert.ok(!calls.some((c) => c[0] === 'quit'));
});

test('start-up: a launch killed by quitting shows no error, does not retry or quit again', async () => {
  const { deps, calls } = fakes({
    results: [{ err: new Error('Command failed: killed'), stderr: '' }],
    errorActions: ['retry'],
    onExec: (app) => { app.quitting = true; },
  });
  assert.equal(await createStartUp(deps)(), null);
  assert.deepEqual(calls.slice(2), [['hideStarting']]);
  assert.equal(calls.filter((c) => c[0] === 'execFile').length, 1);
  assert.ok(!calls.some((c) => c[0] === 'showError'));
  assert.ok(!calls.some((c) => c[0] === 'quit'));
  assert.ok(!calls.some((c) => c[0] === 'loadURL'));
});

test('start-up: a load failure when not quitting still shows the error', async () => {
  const { deps, calls, app } = fakes({ loadFails: ['ERR_FAILED (-2)'] });
  assert.equal(app.quitting, false);
  assert.equal(await createStartUp(deps)(), null);
  assert.deepEqual(calls.slice(3), [['hideStarting'], ['showError', 'ERR_FAILED (-2)'], ['quit']]);
});
