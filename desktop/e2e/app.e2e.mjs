// The app itself, driven without a person (plan 7.3): the page over IPC with a call, a stream that is
// cut and comes back, and a picture shown from the app's own scheme, from a server whose certificate
// is self-signed. Run with `npm run e2e` in desktop/ after `cd web && npm run build`; with
// AIWB_E2E_APP="/path/AI Whiteboard.app/Contents/MacOS/AI Whiteboard" it runs a built app instead. It is not part
// of `npm test`: it starts Electron, which opens a window for a few seconds.
//
// It spends nothing and touches nothing of the user's: the app gets a temporary AIWB_USER_DATA (so
// the single-instance lock is its own), and AIWB_SERVER_BIN is a small script that stands in for the
// server program. The server is J1's stand-in (desktop/test/conn/standin.js) with its fixture
// certificate, which the app accepts by fingerprint only.
//
// How far the app can be run by tests without a screen (goal 9): Playwright's `_electron` drives
// Electron 44 on this Mac, but the window is a real one; there is no headless Electron on macOS.
// Playwright is not a dependency: it is taken from PLAYWRIGHT (a folder), desktop/node_modules, or the
// newest of the npx cache (`npx -y playwright install chromium` puts it there).
//
// The page is observed through the preload surface itself (window.aiwbApp.onEvents), which is what
// the IPC layer and the window's functions are for; the page's own screens are checked by the
// browser checks of web/dev.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const pageFile = path.resolve(desktop, '../web/dist/index.html');
const { standin } = require('../test/conn/standin.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// until polls pred for up to ms (generous: seconds, not milliseconds).
async function until(pred, what, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

async function playwright() {
  const dirs = [process.env.PLAYWRIGHT, path.join(desktop, 'node_modules/playwright')].filter(Boolean);
  const npx = path.join(os.homedir(), '.npm/_npx');
  const versionIn = (d) => { try { return JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')).version; } catch { return ''; } };
  if (fs.existsSync(npx)) {
    dirs.push(...fs.readdirSync(npx).map((d) => path.join(npx, d, 'node_modules/playwright'))
      .sort((a, b) => versionIn(b).localeCompare(versionIn(a), 'en', { numeric: true })));
  }
  const dir = dirs.find((d) => fs.existsSync(path.join(d, 'index.mjs')));
  if (!dir) throw new Error(`playwright not found in:\n  ${dirs.join('\n  ')}\nrun once: npx -y playwright install chromium`);
  return import(pathToFileURL(path.join(dir, 'index.mjs')).href);
}

// A 1x1 PNG, and an SVG that claims to be one.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
const imageId = (n) => crypto.createHash('sha256').update(`image ${n}`).digest('hex');

// fakeServer writes the program the app runs for this computer's server: a Node script that answers
// `launch -json`, `relaunch -json`, `secret` and `status -json` from a config file the test changes,
// and logs every run.
function fakeServer(dir) {
  const script = path.join(dir, 'ai-whiteboard');
  fs.writeFileSync(script, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
fs.appendFileSync(path.join(__dirname, 'runs.log'), JSON.stringify(process.argv.slice(2)) + '\\n');
const [cmd] = process.argv.slice(2);
if (cmd === 'launch' || cmd === 'relaunch') {
  if (config.fail) { process.stderr.write(config.fail + '\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify(config.launch) + '\\n');
} else if (cmd === 'secret') {
  process.stdout.write(config.secret + '\\n');
} else if (cmd === 'status') {
  process.stdout.write(JSON.stringify(config.status) + '\\n');
} else { process.stderr.write('unknown command\\n'); process.exit(2); }
`, { mode: 0o755 });
  const configure = (c) => fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(c));
  const runs = () => (fs.existsSync(path.join(dir, 'runs.log'))
    ? fs.readFileSync(path.join(dir, 'runs.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []);
  return { script, configure, runs };
}

const launchOutput = (s, home) => ({
  state: 'running', address: s.address, fingerprint: s.fingerprint, version: s.version, featureLevel: 6,
  instanceId: s.instanceId, pid: 4242, home,
});

let failures = 0;
async function step(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}\n     ${String(err && err.stack || err).split('\n').join('\n     ')}`);
  }
}

// run starts the app against the stand-in and hands the page to body.
async function withApp({ _electron }, { waits, config }, body) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'aiwb-app-e2e-'));
  const s = await standin({ secret: 'e2e-secret-' + crypto.randomBytes(6).toString('hex') });
  const server = fakeServer(dir);
  const home = path.join(dir, 'home');
  server.configure(config(s, home));
  const userData = path.join(dir, 'userData');
  const env = { ...process.env, AIWB_USER_DATA: userData, AIWB_SERVER_BIN: server.script, AIWB_APP_WAITS: waits, AIWB_HOME: home };
  delete env.ELECTRON_RUN_AS_NODE;
  // AIWB_E2E_APP, the executable inside a built AI Whiteboard.app, runs the packaged app (and its own
  // page) instead of the checkout.
  const packaged = process.env.AIWB_E2E_APP;
  if (!packaged) env.AIWB_PAGE = pageFile;
  const executablePath = packaged || path.join(desktop, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  const args = packaged ? [] : [desktop];
  const app = await _electron.launch({ executablePath, args, env, timeout: 60000 });
  // startAgain starts the app a second time, with the same user data; it resolves to its exit code.
  const startAgain = () => new Promise((resolve, reject) => {
    const child = spawn(executablePath, args, { env, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('the second start did not end')); }, 30000);
    child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  try {
    const page = await app.firstWindow();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await page.waitForLoadState('load');
    await body({ app, page, s, server, dir, home, pageErrors, startAgain });
  } finally {
    await app.close().catch(() => {});
    await s.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// watch makes the page record what the app sends it, and opens the stream again so that the record
// begins with the whole greeting.
async function watch(page) {
  await page.evaluate(() => {
    window.__seen = [];
    window.aiwbApp.onEvents((batch) => window.__seen.push(...batch));
    window.aiwbApp.onStreamState((state) => window.__seen.push({ streamState: state }));
    return window.aiwbApp.stream(true);
  });
}
const seen = (page) => page.evaluate(() => window.__seen);
const localStates = (all) => all.filter((e) => e.app && e.app.type === 'server_state' && e.app.server.id === 'local').map((e) => e.app.server);

async function main() {
  if (!fs.existsSync(pageFile)) throw new Error(`no ${pageFile}: run \`cd web && npm run build\` first`);
  const pw = await playwright();

  // 1. This computer's server did not start: the window is open, the section's state says why, and
  //    Retry starts it. The retry of the app itself is far away (a long back-off), so it is Retry.
  await withApp(pw, {
    waits: 'backoff=600s',
    config: () => ({ fail: 'AI Whiteboard is not set up on this machine. Set it up once with: "/x/ai-whiteboard" remote setup' }),
  }, async ({ page, s, server, home }) => {
    await step('the window opens at once, from the page file, whatever the server does', async () => {
      assert.match(page.url(), /^file:\/\/.*\/index\.html/);
      assert.equal(await page.title(), 'AI Whiteboard');
      const exposed = await page.evaluate(() => ({
        keys: Object.keys(window.aiwbApp).sort(),
        node: [typeof window.require, typeof window.process, typeof window.Buffer, typeof window.aiwbDesktop],
      }));
      assert.deepEqual(exposed.keys, ['app', 'call', 'cancel', 'onEvents', 'onStreamState', 'pickImages', 'stream']);
      assert.deepEqual(exposed.node, ['undefined', 'undefined', 'undefined', 'undefined']);
    });

    await watch(page);
    await step('a server that did not start: this computer says so, with the reason', async () => {
      await until(async () => localStates(await seen(page)).some((v) => v.state === 'not_started'), 'not_started');
      const v = localStates(await seen(page)).find((x) => x.state === 'not_started');
      assert.equal(v.local, true);
      assert.match(v.detail, /not set up on this machine.*remote setup/);
    });

    await step('Retry starts the server', async () => {
      server.configure({ launch: launchOutput(s, home), secret: s.secret });
      const before = server.runs().length;
      const a = await page.evaluate(() => window.aiwbApp.app('owner.retry'));
      assert.equal(a.status, 200);
      await until(async () => localStates(await seen(page)).at(-1).state === 'connected', 'connected after Retry');
      assert.ok(server.runs().length > before);
      assert.deepEqual(server.runs().at(-2), ['launch', '-json', '-home', home]);
      assert.deepEqual(server.runs().at(-1), ['secret', '-home', home]);
    });

    await step('the page was never given the secret', async () => {
      const text = JSON.stringify(await seen(page));
      assert.ok(!text.includes(s.secret));
    });
  });

  // 2. This computer's server runs: a call, a stream that is cut, pictures, the owner's things.
  await withApp(pw, {
    waits: 'backoff=1s',
    config: (s, home) => ({
      launch: launchOutput(s, home),
      secret: s.secret,
      status: { running: { build: 'this', mcp: { listener: { port: 6006, url: 'http://localhost:6006/mcp', up: true }, chats: [] } } },
    }),
  }, async ({ app, page, s, server, home, pageErrors, startAgain }) => {
    const good = imageId(1);
    const bad = imageId(2);
    const framed = imageId(3);
    s.routes.set('POST /api/groups', async (req, res, body) => ({ status: 201, json: { id: 'g_1', echo: JSON.parse(body.toString()) } }));
    s.routes.set(`GET /api/chats/c1/images/${good}`, () => ({ bytes: PNG, type: 'image/png' }));
    s.routes.set(`GET /api/chats/c1/images/${bad}`, () => ({ bytes: SVG, type: 'image/png' }));
    s.routes.set(`GET /api/chats/c1/images/${framed}`, () => ({ bytes: PNG, type: 'image/png' }));

    await watch(page);
    await step('this computer connects: the greeting, then connected, with no secret in it', async () => {
      await until(async () => localStates(await seen(page)).at(-1)?.state === 'connected', 'connected');
      const all = await seen(page);
      const kinds = all.map((e) => (e.app ? `app:${e.app.type}` : e.server ? `${e.server}:${e.event.type}` : `state:${e.streamState}`));
      assert.equal(kinds[0], 'state:open');
      assert.equal(kinds[1], 'app:servers');
      const i = kinds.indexOf('local:hello');
      assert.ok(i > 1 && kinds[i + 1] === 'local:snapshot', kinds.join(' '));
      assert.ok(i < kinds.lastIndexOf('app:server_state'));
      const v = localStates(all).at(-1);
      assert.equal(v.name, 'This computer');
      assert.equal(v.version, s.version);
      assert.ok(!JSON.stringify(all).includes(s.secret));
    });

    await step('a call goes to the server with the secret, and the answer comes back', async () => {
      const a = await page.evaluate(() => window.aiwbApp.call({
        id: 'e2e-1', server: 'local', method: 'POST', path: '/api/groups', body: { json: '{"name":"g"}' },
      }));
      assert.equal(a.status, 201);
      assert.deepEqual(JSON.parse(a.text), { id: 'g_1', echo: { name: 'g' } });
      const r = s.requests.findLast((x) => x.path === '/api/groups');
      assert.equal(r.headers['x-aiwb-secret'], s.secret);
      assert.match(r.headers['x-aiwb-client'], /^[0-9a-f-]{36}$/);
      assert.equal(r.headers['x-aiwb-level'], '6');
    });

    await step('a call names a server of the list and a path of the client API, and nothing else', async () => {
      const ask = (server, p) => page.evaluate(([sv, path]) => window.aiwbApp.call({ id: crypto.randomUUID(), server: sv, method: 'GET', path }), [server, p]);
      const unknown = await ask('s_000000000000', '/api/state');
      assert.equal(unknown.status, 404);
      assert.equal(JSON.parse(unknown.text).code, 'no_server');
      const outside = await ask('local', '/api/restart');
      assert.equal(outside.status, 400);
      assert.equal(JSON.parse(outside.text).code, 'not_client_api');
      const other = await ask('local', 'https://example.com/api/state');
      assert.equal(other.status, 400);
      assert.ok(!s.requests.some((x) => x.path === '/api/restart'));
    });

    await step('a stream that is cut comes back: not connected, then the greeting again, then connected', async () => {
      const before = (await seen(page)).length;
      const opened = s.streamsOpened;
      s.cut();
      await until(async () => {
        const st = localStates((await seen(page)).slice(before)).map((v) => v.state);
        return st.length >= 2 && st.at(-1) === 'connected';
      }, 'connected again after the cut');
      const after = (await seen(page)).slice(before);
      const states = localStates(after).map((v) => v.state);
      assert.notEqual(states[0], 'connected');
      const kinds = after.map((e) => (e.app ? `app:${e.app.type}` : `${e.server}:${e.event.type}`));
      const h = kinds.indexOf('local:hello');
      assert.ok(h >= 0 && kinds[h + 1] === 'local:snapshot', kinds.join(' '));
      assert.ok(s.streamsOpened > opened);
      // The server's events come through after the return, in order.
      s.emit({ type: 'probe', n: 1 });
      s.emit({ type: 'probe', n: 2 });
      await until(async () => (await seen(page)).filter((e) => e.event?.type === 'probe').length === 2, 'the events after the return');
      assert.deepEqual((await seen(page)).filter((e) => e.event?.type === 'probe').map((e) => e.event.n), [1, 2]);
    });

    const show = (url, where = 'main') => page.evaluate(async ([u, w]) => {
      const load = (doc, parent) => new Promise((resolve) => {
        const img = doc.createElement('img');
        img.onload = () => resolve({ loaded: true, w: img.naturalWidth });
        img.onerror = () => resolve({ loaded: false, w: 0 });
        img.src = u;
        parent.appendChild(img);
      });
      if (w === 'main') return load(document, document.body);
      // From a frame inside the page.
      const frame = document.createElement('iframe');
      document.body.appendChild(frame);
      return new Promise((resolve) => {
        frame.srcdoc = `<body><img src="${u}" onload="parent.postMessage({l:true},'*')" onerror="parent.postMessage({l:false},'*')"></body>`;
        window.addEventListener('message', (m) => resolve({ loaded: m.data.l }), { once: true });
      });
    }, [url, where]);

    await step('a picture is shown from the app\'s own scheme, from a self-signed server', async () => {
      const r = await show(`aiwb-picture://p/local/c1/${good}`);
      assert.deepEqual(r, { loaded: true, w: 1 });
      const req = s.requests.findLast((x) => x.path === `/api/chats/c1/images/${good}`);
      assert.equal(req.headers['x-aiwb-secret'], s.secret);
    });

    await step('bytes that are not an image of the taken types never reach the page', async () => {
      assert.equal((await show(`aiwb-picture://p/local/c1/${bad}`)).loaded, false);
      assert.ok(s.requests.some((x) => x.path === `/api/chats/c1/images/${bad}`)); // it was fetched, and refused
    });

    await step('the scheme answers a server of the list and a picture address, nothing else', async () => {
      for (const url of [
        `aiwb-picture://p/s_000000000000/c1/${good}`, // no such server
        `aiwb-picture://p/local/c1/${'0'.repeat(63)}`, // not an image id
        `aiwb-picture://q/local/c1/${good}`, // another host
        `aiwb-picture://p/local/c1/${good}/x`, // another path form
        `aiwb-picture://p/local/c1/${good}?x=1`,
      ]) assert.equal((await show(url)).loaded, false, url);
    });

    await step('an iframe the test adds to the page cannot load a picture', async () => {
      const n = s.requests.filter((x) => x.path === `/api/chats/c1/images/${framed}`).length;
      const r = await show(`aiwb-picture://p/local/c1/${framed}`, 'frame');
      assert.equal(r.loaded, false);
      assert.equal(s.requests.filter((x) => x.path === `/api/chats/c1/images/${framed}`).length, n); // never asked the server
      // The same picture, from the page itself, loads.
      assert.equal((await show(`aiwb-picture://p/local/c1/${framed}`)).loaded, true);
    });

    await step('the owner\'s things: the MCP listener\'s state, the server log, a restart', async () => {
      const st = await page.evaluate(() => window.aiwbApp.app('owner.status'));
      assert.equal(st.status, 200);
      assert.equal(JSON.parse(st.text).running.mcp.listener.up, true);
      const bad = await page.evaluate(() => window.aiwbApp.app('owner.reveal', { board: '../b_00000000' }));
      assert.equal(bad.status, 400);
      const missing = await page.evaluate(() => window.aiwbApp.app('owner.reveal', { board: 'b_00000000' }));
      assert.equal(missing.status, 404);
      const unknown = await page.evaluate(() => window.aiwbApp.app('servers.secret'));
      assert.equal(unknown.status, 404);
      const r = await page.evaluate(() => window.aiwbApp.app('owner.restart'));
      assert.equal(r.status, 200, r.text);
      assert.ok(server.runs().some((c) => c[0] === 'relaunch'));
      await until(async () => localStates(await seen(page)).at(-1).state === 'connected', 'connected after the restart');
    });

    await step('a second start of the app ends at once and leaves the one window', async () => {
      assert.equal(await startAgain(), 0);
      assert.equal(app.windows().length, 1);
    });

    await step('the page raised no uncaught error', async () => {
      assert.deepEqual(pageErrors, []);
    });

    await step('every secret stays out of everything the page saw', async () => {
      assert.ok(!JSON.stringify(await seen(page)).includes(s.secret));
    });
  });

  if (failures) throw new Error(`${failures} step(s) failed`);
}

main().then(() => console.log('app e2e: done'), (err) => { console.error(err); process.exit(1); });
