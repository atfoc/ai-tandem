// SPIKE (rn-spike-electron): runs everything and says what held. Repeatable:
//
//   node spikes/electron/run.mjs            from the repository root (or `npm run spike` in spikes/electron)
//   node spikes/electron/run.mjs --quick    skips the matrix of loading ways and CSPs: tests, probe, one app run
//
// 1. node --test of the bridge (fake ipcRenderer, the real IPC face, a model of contextBridge), no Electron.
// 2. The Expo app is exported for the web (twice: relative paths, and Expo's default absolute paths).
// 3. Electron runs: the contextBridge probe, then the Expo export in the window, in each way of loading it.
// It opens windows for a few seconds each (there is no headless Electron on macOS), spends nothing, touches
// nothing of the user's, and installs only into spikes/electron (node_modules, git-ignored). Results: .out/*.json.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, 'app');
const out = path.join(here, '.out');
const electron = path.join(here, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const quick = process.argv.includes('--quick');
let failures = 0;

const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: opts.quiet ? 'pipe' : 'inherit', encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})${opts.quiet ? '\n' + r.stdout + r.stderr : ''}`);
  return r;
};
async function step(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${String(e && e.message || e).split('\n').join('\n     ')}`); }
}

// runElectron starts main.js with env, kills it after limitMs, and resolves to the result file's JSON.
function runElectron(env, file, limitMs = 90000) {
  fs.rmSync(file, { force: true });
  return new Promise((resolve, reject) => {
    const child = spawn(electron, [path.join(here, 'main.js')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ...env, SPIKE_OUT: file }, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, limitMs);
    child.on('exit', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) { reject(new Error(`no result in ${file}: ${e.message}`)); }
    });
  });
}

// ---------------------------------------------------------------- set up
console.log('== set up');
if (!fs.existsSync(path.join(here, 'node_modules/electron'))) sh('npm', ['install', '--no-audit', '--no-fund'], { cwd: here });
if (!fs.existsSync(electron)) sh('node', [path.join(here, 'node_modules/electron/install.js')]);
if (!fs.existsSync(path.join(appDir, 'node_modules/expo'))) sh('npm', ['install', '--no-audit', '--no-fund'], { cwd: appDir });
fs.mkdirSync(out, { recursive: true });

// ---------------------------------------------------------------- 1. the bridge without Electron
console.log('== 1. bridge tests (node --test, no Electron)');
await step('node --test spikes/electron/test', async () => {
  const r = spawnSync('node', ['--test', ...fs.readdirSync(path.join(here, 'test')).filter((f) => f.endsWith('.test.mjs')).map((f) => path.join('test', f))], { cwd: here, encoding: 'utf8' });
  const tail = (r.stdout + r.stderr).split('\n').filter((l) => /^ℹ (tests|pass|fail)/.test(l)).join(' | ');
  console.log(`     ${tail}`);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// ---------------------------------------------------------------- 2. the Expo web export
console.log('== 2. Expo web export (npx expo export --platform web)');
await step('export with relative paths (experiments.baseUrl ".") -> app/dist', async () => {
  fs.rmSync(path.join(appDir, 'dist'), { recursive: true, force: true });
  sh('npx', ['expo', 'export', '--platform', 'web'], { cwd: appDir, quiet: true });
  const html = fs.readFileSync(path.join(appDir, 'dist/index.html'), 'utf8');
  assert.match(html, /src="\.\/_expo\/static\/js\/web\//);
});
await step('export with Expo\'s default absolute paths (baseUrl "/") -> app/dist-abs', async () => {
  fs.rmSync(path.join(appDir, 'dist-abs'), { recursive: true, force: true });
  sh('npx', ['expo', 'export', '--platform', 'web', '--output-dir', 'dist-abs'], { cwd: appDir, quiet: true, env: { ...process.env, SPIKE_BASE_URL: '/' } });
  assert.match(fs.readFileSync(path.join(appDir, 'dist-abs/index.html'), 'utf8'), /src="\/_expo\/static\/js\/web\//);
});

// ---------------------------------------------------------------- 3. what contextBridge does
console.log('== 3. contextBridge probe (Electron, a window for a few seconds)');
await step('probe: what crosses contextBridge and what does not', async () => {
  const r = await runElectron({ SPIKE_MODE: 'probe' }, path.join(out, 'probe.json'));
  assert.equal(r.done, true);
  const p = r.page;
  const get = (k) => { assert.ok(p[k], `no probe ${k}`); return p[k]; };
  // the preload is sandboxed: no local requires
  assert.equal(get('info').preload.sandboxed, true);
  assert.match(String(p.info.preload.hasRequireLocal), /module not found/);
  // an AbortSignal arrives as an empty plain object: no aborted, no addEventListener
  const sig = get('in.abortSignal').preloadSaw;
  assert.deepEqual([sig.ctor, sig.keys, sig.isAbortSignal, sig.hasAddEventListener], ['Object', [], false, 'undefined']);
  assert.equal(get('in.abortSignalAborted').preloadSaw.keys.length, 0);
  // ... but a plain object with a function in it works, in both directions, now and later
  assert.equal(get('in.signalLikePlainObject').abortHeardInSide, 1);
  assert.equal(get('in.callbackLater').got, 'later');
  assert.equal(get('in.keptFunctionStillWorks').out, 'page:kept');
  // objects are copied, not shared
  assert.equal(get('in.objectIdentity').mutatedInPage, false);
  // bytes
  assert.equal(get('in.uint8').preloadSaw.isUint8Array, true);
  assert.equal(get('in.blob').preloadSaw.isBlob, true);
  assert.equal(get('in.arrayBuffer').preloadSaw.isArrayBuffer, true);
  assert.equal(get('in.uint8View').preloadSaw.bufferByteLength, 1000, 'a view brings its whole buffer');
  assert.equal(get('out.uint8').sameRealm, true);
  assert.equal(get('out.nodeBuffer').isUint8Array, true);
  // errors: only the message survives
  assert.deepEqual([get('out.promiseReject.RangeError').name, p['out.promiseReject.RangeError'].message, p['out.promiseReject.RangeError'].code], ['Error', 'boom', undefined]);
  assert.equal(get('out.promiseReject.customNamedError').name, 'Error');
  assert.equal(get('out.promiseReject.DOMException').instanceofError, false);
  // promises: only the promise itself; properties on it do not cross, a nested one does
  assert.equal(get('out.promiseWithProps').cancelType, 'undefined');
  assert.equal(get('out.objectWithPromiseAndCancel').awaitedDone, 'done!');
  // iteration: real generators do not cross; an object with own functions does
  assert.equal(get('out.asyncGenerator').ok, false);
  assert.equal(get('out.syncGenerator').ok, false);
  assert.deepEqual(get('out.asyncIterableObject').iterated, [1, 2, 3]);
  assert.deepEqual(get('out.handRolledIteratorObject').manualNext, [1, 2, 3]);
  // streams, ports, class methods
  assert.equal(get('out.readableStream').hasGetReader, 'undefined');
  assert.equal(get('out.classInstance').m, 'undefined');
  // cost of bytes page -> preload: a Uint8Array is copied element by element
  const ms = (k) => get(k).crossingMs ?? get(k).totalMs;
  console.log(`     page->preload 50 MB: Uint8Array ${ms('cost.in.50MB (page sends bytes to preload)')} ms, ArrayBuffer ${ms('cost.in.50MB as ArrayBuffer')} ms, Blob read by the preload ${ms('cost.in.50MB as Blob, preload reads it with blob.arrayBuffer()')} ms; preload->page 50 MB: ${ms('cost.out.50MB (preload makes bytes, page receives)')} ms`);
  assert.ok(ms('cost.in.50MB (page sends bytes to preload)') > 3 * ms('cost.in.50MB as ArrayBuffer'), 'a Uint8Array is expected to be much slower than an ArrayBuffer');
});

// ---------------------------------------------------------------- 4. the Expo export in the window
const BASE_CHECKS = ['call.fast', 'call.json', 'call.bytes.uint8array', 'call.bytes.blob', 'cancel.slowCall', 'stream', 'lazy chunk (import())', 'font (expo-font, Ionicons.ttf)'];
function assessApp(r, { wasm }) {
  assert.equal(r.done, true, `the page did not finish (${JSON.stringify(r.boot && r.boot.scriptURLs)})`);
  const p = r.page;
  assert.equal(r.boot.hasAiwbApp, 'object', 'the page does not see window.aiwbApp');
  assert.deepEqual(p.bridge.keys, ['app', 'call', 'pickImages', 'pictureURL', 'stream', 'way']);
  assert.deepEqual(p.bridge.leaks, ['undefined', 'undefined']);
  assert.equal(p.bridge.processGlobal.versions, null, 'window.process is the bundle\'s shim, not Node\'s');
  const failed = Object.entries(p).filter(([k, v]) => v && v.ok === false).map(([k]) => k);
  const expectedFailed = wasm ? [] : ['wasm (a 8-byte empty module)'];
  assert.deepEqual(failed, expectedFailed, `checks that failed: ${failed.join(', ')}`);
  assert.equal(p['call.fast'].status, 200);
  assert.equal(p['call.fast'].sceneRev, 3);
  for (const k of ['call.bytes.uint8array', 'call.bytes.view (1000 bytes at offset 5000 of a 1 MB buffer)', 'call.bytes.blob', 'call.bytes.20MB (as a Uint8Array)']) assert.equal(p[k].intact, true, k);
  const b = p['bench.calls (500 in a row, then 500 at once; fast path)'];
  console.log(`     one call through page -> preload -> IPC -> face -> fake client: ${b.perCallMsInARow} ms in a row, ${b.perCallMsAtOnce} ms each at once; 20 MB body ${p['call.bytes.20MB (as a Uint8Array)'].ms} ms`);
  // the cancel
  const c = p['cancel.slowCall'];
  assert.deepEqual([c.rejected, c.error.name, c.isSignalReason], [true, 'AbortError', true]);
  assert.ok(c.afterMs < 3000, `a cancel took ${c.afterMs} ms`);
  assert.equal(p['cancel.withReason'].isMyReason, true);
  assert.equal(p['cancel.alreadyAborted (never sent)'].rejected, true);
  assert.equal(p['cancel.afterFinished (no effect)'].status, 200);
  assert.equal(p['cancel.duringBlobRead (abort while the body is still being read)'].rejected, true);
  const cc = p['cancel.concurrent (40 calls, the odd ones cancelled)'];
  assert.deepEqual([cc.evensAnswered, cc.oddsRejectedAsAbort], [true, true]);
  assert.deepEqual([p.stream.n, p.stream.order, p.stream.bigPad, p.stream.afterClose], [5, [1, 2, 3, 4, 5], 50000, 0]);
  // what the MAIN process saw: the requests were aborted there, the ones never sent never arrived
  const calls = r.main.log.calls;
  const by = (path) => calls.filter((x) => x.path === path);
  for (const s of ['/api/slow/1', '/api/slow/2']) assert.deepEqual(by(s).map((x) => x.abortedWhileWaiting), [true], `main did not abort ${s}`);
  assert.equal(by('/api/slow/3-never-sent').length + by('/api/bytes-never-sent').length, 0);
  for (let i = 0; i < 40; i++) {
    const [x] = by(`/api/many/${i}`);
    assert.ok(x, `no call /api/many/${i} in main`);
    assert.equal(x.abortedWhileWaiting, i % 2 === 1, `/api/many/${i}`);
    assert.equal(x.finished, i % 2 === 0, `/api/many/${i}`);
  }
  assert.equal(r.main.log.streams.length, 1);
  assert.ok(r.main.log.streams[0].closed, 'the stream was not closed in main');
  assert.deepEqual(r.main.loadFailures, []);
  return p;
}

console.log('== 4. the Expo export in the Electron window');
const runs = [];
const matrix = [
  { id: 'file-none', scheme: 'file', csp: 'none', site: 'dist', note: 'win.loadFile, as desktop/main.js does today, no CSP (as today)', wasm: true },
  { id: 'file-strict-wasm', scheme: 'file', csp: 'strict-wasm', site: 'dist', note: 'file://, CSP as a meta tag', wasm: true, quick: false },
  { id: 'file-strict', scheme: 'file', csp: 'strict', site: 'dist', note: 'file://, the same CSP without wasm-unsafe-eval: wasm is blocked', wasm: false, quick: false },
  { id: 'file-strict-no-inline-style', scheme: 'file', csp: 'strict-no-inline-style', site: 'dist', note: 'file://, style-src without unsafe-inline: react-native-web gets no styles', wasm: false, unstyled: true, quick: false },
  { id: 'app-none', scheme: 'app', csp: 'none', site: 'dist', note: 'aiwb-app://app/ (a standard, secure scheme the main process serves), no CSP', wasm: true, quick: false },
  { id: 'app-strict-wasm', scheme: 'app', csp: 'strict-wasm', site: 'dist', note: 'aiwb-app://, CSP as a header', wasm: true, quick: false },
  { id: 'app-none-abs', scheme: 'app', csp: 'none', site: 'dist-abs', note: 'aiwb-app://, the export with Expo\'s default absolute /_expo paths: loads', wasm: true, quick: false },
  { id: 'file-none-abs', scheme: 'file', csp: 'none', site: 'dist-abs', note: 'file://, the export with absolute /_expo paths: does NOT load', wasm: true, expectLoadFailure: true, quick: false },
];
for (const m of matrix) {
  if (quick && m.quick === false) continue;
  await step(`${m.id}: ${m.note}`, async () => {
    const r = await runElectron({ SPIKE_MODE: 'app', SPIKE_SCHEME: m.scheme, SPIKE_CSP: m.csp, SPIKE_SITE: path.join(appDir, m.site), SPIKE_TIMEOUT: m.expectLoadFailure ? '8000' : '60000' }, path.join(out, `${m.id}.json`));
    runs.push({ ...m, r });
    if (m.expectLoadFailure) {
      assert.equal(r.done, false, 'the page was expected NOT to run');
      assert.ok(r.boot.scriptURLs.some((u) => u.startsWith('file:///_expo/')), `scripts: ${r.boot.scriptURLs}`);
      assert.equal(r.boot.bodyText, '');
      return;
    }
    const p = assessApp(r, m);
    const v = p.cspViolations.map((x) => x.directive);
    if (m.unstyled) {
      assert.ok(v.includes('style-src-elem') || v.includes('style-src') || r.main.consoleLines.some((l) => /Applying inline style violates/.test(l)), 'expected inline style violations');
      assert.equal(p.load.cssRulesAfter, null, 'react-native-web got no stylesheet');
    } else {
      assert.equal(p.load.cssRulesAfter > 0, true, 'react-native-web has its rules');
    }
    // the one violation allowed is the page's own deliberate `new Function` probe: the app itself needs no eval
    if (m.csp === 'strict-wasm' || m.csp === 'none') assert.deepEqual(p.cspViolations.filter((x) => x.blocked !== 'eval'), []);
  });
}

console.log(failures ? `\nspike: ${failures} step(s) FAILED` : '\nspike: all steps held. Results in spikes/electron/.out/*.json; the findings are in plans/rn-rewrite/spikes/electron.md');
process.exit(failures ? 1 : 0);
