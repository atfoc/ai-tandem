// The app itself, driven without a person (plan 7.3): the page over IPC with a call, a stream that is
// cut and comes back, and a picture shown from the app's own scheme, from a server whose certificate
// is self-signed. Run with `npm run e2e` in desktop/ after `cd app && npm run build:web` (the web build, the default since D2: AD-44);
// with AIWB_PAGE=<a path to another build's index.html> it runs that page;
// with AIWB_E2E_APP="/path/AI Whiteboard.app/Contents/MacOS/AI Whiteboard" it runs a built app instead (and its
// own page). It is not part of `npm test`: it starts Electron, which opens a window for a few seconds.
//
// It spends nothing and touches nothing of the user's: the app gets a temporary AIWB_USER_DATA (so
// the single-instance lock is its own), and AIWB_SERVER_BIN is a small script that stands in for the
// server program. The server is J1's stand-in (packages/conn/test/standin.js) with its fixture
// certificate, which the app accepts by fingerprint only.
//
// How far the app can be run by tests without a screen (goal 9): Playwright's `_electron` drives
// Electron 44 on this Mac, but the window is a real one; there is no headless Electron on macOS.
// Playwright is not a dependency: it is taken from PLAYWRIGHT (a folder), desktop/node_modules, or the
// newest of the npx cache (`npx -y playwright install chromium` puts it there).
//
// The page is observed through the preload surface itself (window.aiwbTransport, the one the web build
// is made on: its stream, its calls), which is what the IPC layer and the window's functions are for;
// nothing else of the app is exposed (the old page's bridge was retired with it). The page's own
// screens are checked by the browser checks of web/dev.
//
// On the web build the page is also checked for what the window gives it that a browser does not:
// that it started (window.aiwbReady), that the Content-Security-Policy of its index.html broke nothing,
// and that its board (Excalidraw, from ./board/ under file://, with connect-src 'none') draws.
//
// The window itself (A.13): where it opens the first time (1280 × 800) and where the person left it (the app is quit and started again on one
// AIWB_USER_DATA), the error box of a page that cannot be loaded (its `dialog.showErrorBox` is replaced by a recorder), the server log offered in the
// section of this computer, and the page's `window.aiwbFlush`.

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
// AIWB_PAGE picks the page (a path from this folder or an absolute one); the default is the web build, as the app's own.
const pageFile = process.env.AIWB_PAGE ? path.resolve(process.env.AIWB_PAGE) : path.resolve(desktop, '../app/dist-web/index.html');
const { standin } = require('../../packages/conn/test/standin.js');

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
  state: 'running', address: s.address, fingerprint: s.fingerprint, version: s.version, featureLevel: 7,
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
  else delete env.AIWB_PAGE; // the packaged app has its own page
  const executablePath = packaged || path.join(desktop, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  const args = packaged ? [] : [desktop];
  let app = await _electron.launch({ executablePath, args, env, timeout: 60000 });
  // relaunch closes the app (as a person quits it) and starts it again with the same user data; it resolves to the new app and its page.
  const relaunch = async () => {
    await app.close();
    app = await _electron.launch({ executablePath, args, env, timeout: 60000 });
    const again = await app.firstWindow();
    await again.waitForLoadState('load');
    return { app, page: again };
  };
  // startAgain starts the app a second time, with the same user data; it resolves to its exit code.
  const startAgain = () => new Promise((resolve, reject) => {
    const child = spawn(executablePath, args, { env, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('the second start did not end')); }, 30000);
    child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  try {
    const page = await app.firstWindow();
    const pageErrors = [];
    // Console errors that are the page's policy at work: a Content-Security-Policy refusal is logged, not thrown.
    const policyErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' && /Content[- ]Security[- ]Policy/i.test(m.text())) policyErrors.push(m.text()); });
    await page.waitForLoadState('load');
    await body({ app, page, s, server, dir, home, pageErrors, policyErrors, startAgain, relaunch });
  } finally {
    await app.close().catch(() => {});
    await s.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// watch makes the page record what the app sends it, through the transport of the bridge (the stream the
// web build is made on), and opens the stream again so that the record begins with the whole greeting.
// The page's own subscription is the main process's one: opening it again gives every listener the greeting.
// The record begins at the "open" of this new subscription: a batch the main process sent for the page's own
// one before it took the request (its greeting, while the page is still starting) reaches these listeners too,
// ahead of that "open", and is not part of the greeting this one is given.
async function watch(page) {
  await page.evaluate(() => {
    window.__seen = [];
    let on = false;
    window.__stream = window.aiwbTransport.stream(
      (envelope) => { if (on) window.__seen.push(envelope); },
      (state) => { if (state === 'open') on = true; if (on) window.__seen.push({ streamState: state }); },
    );
  });
}
const seen = (page) => page.evaluate(() => window.__seen);
const localStates = (all) => all.filter((e) => e.app && e.app.type === 'server_state' && e.app.server.id === 'local').map((e) => e.app.server);

async function main() {
  if (!fs.existsSync(pageFile)) throw new Error(`no ${pageFile}: run \`cd app && npm run build:web\` first`);
  const pw = await playwright();

  // 1. This computer's server did not start: the window is open, the section's state says why, and
  //    Retry starts it. The retry of the app itself is far away (a long back-off), so it is Retry.
  await withApp(pw, {
    waits: 'backoff=600s',
    config: () => ({ fail: 'AI Whiteboard is not set up on this machine. Set it up once with: "/x/ai-whiteboard" remote setup' }),
  }, async ({ app, page, s, server, home, policyErrors }) => {
    await step('the window opens at once, from the page file, whatever the server does', async () => {
      assert.match(page.url(), /^file:\/\/.*\/index\.html/);
      assert.equal(await page.title(), 'AI Whiteboard');
      const exposed = await page.evaluate(() => ({
        aiwbGlobals: Object.keys(window).filter((k) => k.startsWith('aiwb') && k !== 'aiwbReady' && k !== 'aiwbBoardView' && k !== 'aiwbFlush').sort(),
        transportKeys: Object.keys(window.aiwbTransport).sort(),
        way: window.aiwbTransport.way,
        node: [typeof window.require, typeof window.Buffer, typeof window.aiwbDesktop],
        // Node's process is not there. The web build's bundle puts a shim `{ env }` at window.process, so the
        // test is for what only Node's has (AD-44), not for `typeof window.process`.
        nodeProcess: window.process?.versions === undefined && window.process?.binding === undefined,
      }));
      assert.deepEqual(exposed.aiwbGlobals, ['aiwbTransport'], 'the preload gives the page one surface');
      assert.deepEqual(exposed.transportKeys, ['app', 'call', 'pickImages', 'picture', 'stream', 'way']);
      assert.equal(exposed.way, 'ipc');
      assert.deepEqual(exposed.node, ['undefined', 'undefined', 'undefined']);
      assert.equal(exposed.nodeProcess, true);
    });

    await step('the page started: it drew something and said so (window.aiwbReady)', async () => {
      await until(() => page.evaluate(() => window.aiwbReady === true), 'window.aiwbReady');
      await until(() => page.evaluate(() => document.body.innerText.trim().length > 0), 'something drawn in the window');
    });

    // What the window asks before it closes or reloads (lib.js flushed): the page answers whether every board is
    // written, and with none open that is at once.
    await step('the page answers the window\'s flush before closing (window.aiwbFlush)', async () => {
      assert.equal(await page.evaluate(() => typeof window.aiwbFlush), 'function');
      assert.equal(await page.evaluate(() => window.aiwbFlush()), true);
    });

    // With nothing waiting the window's reload is its own: the page's beforeunload prevents nothing, so Electron never fires
    // will-prevent-unload, the window never asks the page to flush and never shows its dialog (D-DW-07). With a drawing waiting the
    // same event starts lib.js's flush and its dialog: desktop/test/closeflush.test.js (a drawing waiting needs a server with boards).
    await step('a reload with nothing waiting is immediate: no flush asked of the page, no dialog, the page is up again (D-DW-07)', async () => {
      await app.evaluate(({ BrowserWindow, dialog }) => {
        const win = BrowserWindow.getAllWindows()[0];
        globalThis.__unload = { prevented: 0, dialogs: 0 };
        win.webContents.on('will-prevent-unload', () => { globalThis.__unload.prevented++; });
        const show = dialog.showMessageBox.bind(dialog);
        dialog.showMessageBox = (...args) => { globalThis.__unload.dialogs++; return show(...args); };
      });
      const asked = [];
      const onDialog = (d) => { asked.push(d.type()); d.dismiss().catch(() => {}); }; // (the page's own `beforeunload` dialog: none is to come)
      page.on('dialog', onDialog);
      try {
        await page.reload();
        await page.waitForLoadState('load');
        await until(() => page.evaluate(() => window.aiwbReady === true), 'the page drawn again after its reload');
      } finally { page.off('dialog', onDialog); }
      assert.deepEqual(asked, []);
      assert.deepEqual(await app.evaluate(() => globalThis.__unload), { prevented: 0, dialogs: 0 });
    });

    // The board of the web build (AD-40): board-view's Excalidraw, loaded from ./board/ next to the page, in the
    // page itself. Under file:// and the page's policy (connect-src 'none') it must draw, with its fonts, and break
    // no rule.
    await step('the board draws in the window: Excalidraw from ./board/, its fonts, under the page\'s policy', async () => {
      await page.evaluate(() => {
        window.__violations = [];
        document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(`${e.violatedDirective}: ${e.blockedURI}`));
        const el = document.createElement('div');
        el.id = 'e2e-board';
        el.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:420px;z-index:9999';
        document.body.appendChild(el);
        const out = [];
        window.__boardOut = out;
        window.__board = window.aiwbBoardView.mount(el, (m) => out.push(m));
      });
      const told = (t) => until(() => page.evaluate((t) => window.__boardOut.some((m) => m.t === t), t), `the board's ${t}`);
      await told('ready');
      const send = (m) => page.evaluate((m) => window.__board.receive(m), m);
      await send({ t: 'load', board: 'b1', viewMode: false, theme: { mode: 'light', filter: null }, style: {}, scene: { elements: [], files: {}, appState: {} } });
      await told('loaded');
      // A rectangle and a text in the hand-drawn font (a font file of ./board/fonts/), drawn into a picture.
      await send({ t: 'req', id: 1, op: { op: 'apply', target: 'live', rev: 1, params: { create: [
        { type: 'rectangle', key: 'box', x: 20, y: 20, width: 160, height: 80 },
        { type: 'text', key: 'hand', x: 40, y: 140, text: 'Hello', fontFamily: 'hand' },
      ] } } });
      await until(() => page.evaluate(() => window.__boardOut.some((m) => m.t === 'res' && m.id === 1)), 'the reply to apply');
      const applied = await page.evaluate(() => window.__boardOut.find((m) => m.t === 'res' && m.id === 1));
      assert.equal(applied.ok, true, JSON.stringify(applied));
      await send({ t: 'req', id: 2, op: { op: 'export', target: 'live', ids: [], scale: 1, background: true } });
      await until(() => page.evaluate(() => window.__boardOut.some((m) => m.t === 'res' && m.id === 2)), 'the picture of the board');
      const exported = await page.evaluate(() => window.__boardOut.find((m) => m.t === 'res' && m.id === 2));
      assert.equal(exported.ok, true, JSON.stringify(exported));
      assert.equal(exported.value.count, 2);
      assert.ok(exported.value.width > 100 && exported.value.height > 100);
      assert.equal(Buffer.from(exported.value.png, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      const found = await page.evaluate(() => ({
        canvas: !!document.querySelector('#e2e-board canvas'),
        fonts: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family),
        errors: window.__boardOut.filter((m) => m.t === 'error'),
        violations: window.__violations,
      }));
      assert.ok(found.canvas, 'the board has a canvas');
      assert.ok(found.fonts.includes('Assistant') && found.fonts.includes('Excalifont'), `fonts loaded: ${found.fonts}`);
      assert.deepEqual(found.errors, []);
      assert.deepEqual(found.violations, [], 'the board broke the policy of the page');
      await page.evaluate(() => { window.__board.unmount(); document.getElementById('e2e-board').remove(); });
    });
    await step('the page\'s policy is in force in the window: connect-src \'none\' refuses even a fetch of its own file', async () => {
      const r = await page.evaluate(async () => {
        const seen = new Promise((resolve) => document.addEventListener('securitypolicyviolation', (e) => resolve(e.violatedDirective), { once: true }));
        const refused = await fetch('./index.html').then(() => false, () => true);
        return { refused, directive: await Promise.race([seen, new Promise((r) => setTimeout(() => r(null), 5000))]) };
      });
      assert.deepEqual(r, { refused: true, directive: 'connect-src' });
      policyErrors.length = 0; // that refusal was asked for
    });

    await watch(page);
    await step('a server that did not start: this computer says so, with the reason', async () => {
      await until(async () => localStates(await seen(page)).some((v) => v.state === 'not_started'), 'not_started');
      const v = localStates(await seen(page)).find((x) => x.state === 'not_started');
      assert.equal(v.local, true);
      assert.match(v.detail, /not set up on this machine.*remote setup/);
    });

    // The web build draws the owner's things of this computer's section; in the window it offers the server's log besides Retry (A-OW-01).
    await step('the section of this computer shows the reason, Retry and Open server log (A-OW-01)', async () => {
      const extra = () => page.evaluate(() => {
        const e = document.querySelector('[data-testid="side-section-extra"]');
        return e ? { reason: e.querySelector('[data-testid="side-section-reason"]')?.textContent ?? '', buttons: [...e.querySelectorAll('[data-testid="btn"]')].map((b) => b.textContent.trim()) } : null;
      });
      const got = await until(extra, 'the notice of this computer\'s section');
      await until(async () => (await extra()).buttons.length > 0, 'its buttons');
      const now = await extra();
      assert.match(now.reason, /not set up on this machine/);
      assert.deepEqual(now.buttons, ['Retry', 'Open server log'], JSON.stringify(got));
    });

    await step('Retry starts the server', async () => {
      server.configure({ launch: launchOutput(s, home), secret: s.secret });
      const before = server.runs().length;
      const a = await page.evaluate(() => window.aiwbTransport.app('owner.retry'));
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
  }, async ({ app, page, s, server, home, pageErrors, policyErrors, startAgain }) => {
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
      const a = await page.evaluate(() => window.aiwbTransport.call({
        server: 'local', method: 'POST', path: '/api/groups', body: { json: '{"name":"g"}' },
      }));
      assert.equal(a.status, 201);
      assert.deepEqual(JSON.parse(a.text), { id: 'g_1', echo: { name: 'g' } });
      const r = s.requests.findLast((x) => x.path === '/api/groups');
      assert.equal(r.headers['x-aiwb-secret'], s.secret);
      assert.match(r.headers['x-aiwb-client'], /^[0-9a-f-]{36}$/);
      assert.equal(r.headers['x-aiwb-level'], '7');
    });

    await step('the transport of the bridge: a call with its own identifier, a Blob body, a picture address', async () => {
      const a = await page.evaluate(() => window.aiwbTransport.call({
        server: 'local', method: 'POST', path: '/api/groups', body: { json: '{"name":"t"}' },
      }));
      assert.equal(a.status, 201);
      assert.deepEqual(JSON.parse(a.text).echo, { name: 't' });
      assert.equal(await page.evaluate(() => window.aiwbTransport.picture('local', 'c 1', 'ab')), 'aiwb-picture://p/local/c%201/ab');
      const cancelled = await page.evaluate(async () => {
        let cb = () => {};
        const abort = { aborted: false, listen: (f) => { cb = f; return () => {}; } };
        const p = window.aiwbTransport.call({ server: 'local', method: 'GET', path: '/api/state', abort }).then(() => 'answered', (e) => e.message);
        cb();
        return p;
      });
      assert.match(cancelled, /aborted/);
    });

    await step('a call names a server of the list and a path of the client API, and nothing else', async () => {
      const ask = (server, p) => page.evaluate(([sv, path]) => window.aiwbTransport.call({ server: sv, method: 'GET', path }), [server, p]);
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
      // From a frame inside the page. The picture is added from here, once the frame is up: the web build's
      // Content-Security-Policy allows no inline handler, so the frame's own markup could not tell.
      const frame = document.createElement('iframe');
      await new Promise((resolve) => {
        frame.onload = resolve;
        frame.srcdoc = '<body></body>';
        document.body.appendChild(frame);
      });
      return load(frame.contentDocument, frame.contentDocument.body);
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
      const st = await page.evaluate(() => window.aiwbTransport.app('owner.status'));
      assert.equal(st.status, 200);
      assert.equal(JSON.parse(st.text).running.mcp.listener.up, true);
      const bad = await page.evaluate(() => window.aiwbTransport.app('owner.reveal', { board: '../b_00000000' }));
      assert.equal(bad.status, 400);
      const missing = await page.evaluate(() => window.aiwbTransport.app('owner.reveal', { board: 'b_00000000' }));
      assert.equal(missing.status, 404);
      const unknown = await page.evaluate(() => window.aiwbTransport.app('servers.secret'));
      assert.equal(unknown.status, 404);
      const r = await page.evaluate(() => window.aiwbTransport.app('owner.restart'));
      assert.equal(r.status, 200, r.text);
      assert.ok(server.runs().some((c) => c[0] === 'relaunch'));
      await until(async () => localStates(await seen(page)).at(-1).state === 'connected', 'connected after the restart');
    });

    await step('a second start of the app ends at once and leaves the one window', async () => {
      assert.equal(await startAgain(), 0);
      assert.equal(app.windows().length, 1);
    });

    await step('the page raised no uncaught error and broke no rule of its policy', async () => {
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(policyErrors, []);
    });

    await step('every secret stays out of everything the page saw', async () => {
      assert.ok(!JSON.stringify(await seen(page)).includes(s.secret));
    });
  });

  // 3. The window itself (A.13): where it opens the first time and where the person left it, and the error box of a page that cannot be loaded.
  await withApp(pw, {
    waits: 'backoff=600s',
    config: () => ({ fail: 'not needed here' }),
  }, async ({ app, page, relaunch }) => {
    const bounds = (a) => a.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
    await step('a first start opens the window at 1280 × 800 (A-DK-02)', async () => {
      const room = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workAreaSize);
      const b = await bounds(app);
      // (a screen smaller than that holds the window to itself)
      assert.equal(b.width, Math.min(1280, room.width));
      assert.equal(b.height, Math.min(800, room.height));
    });

    let moved = { x: 90, y: 70, width: 900, height: 620 };
    await step('a window the person moved and resized opens there again at the next start (A-DK-02)', async () => {
      await app.evaluate(({ BrowserWindow }, to) => BrowserWindow.getAllWindows()[0].setBounds(to), moved);
      await until(async () => { const b = await bounds(app); return b.x === moved.x && b.y === moved.y && b.width === moved.width && b.height === moved.height; }, 'the window at its new bounds');
      const next = await relaunch();
      assert.deepEqual(await bounds(next.app), moved);
      assert.equal(await next.page.title(), 'AI Whiteboard');
      app = next.app;
      page = next.page;
    });

    // The window tells a page that cannot be loaded in a box of the system (A-DK-09). The box would wait for a click: its function is
    // replaced by one that notes what it was given. A page file that is not there fails the main frame's load.
    await step('a page that cannot be loaded is told in an error box with its address (A-DK-09)', async () => {
      await app.evaluate(({ dialog }) => { globalThis.__boxes = []; dialog.showErrorBox = (title, content) => { globalThis.__boxes.push([title, content]); }; });
      const missing = path.join(desktop, 'e2e', 'no-such-page.html');
      await app.evaluate(({ BrowserWindow }, file) => { BrowserWindow.getAllWindows()[0].loadFile(file).catch(() => {}); }, missing);
      const boxes = await until(() => app.evaluate(() => (globalThis.__boxes.length ? globalThis.__boxes : null)), 'the error box');
      assert.equal(boxes[0][0], 'AI Whiteboard');
      assert.match(boxes[0][1], /^The page could not be loaded: /);
      assert.ok(boxes[0][1].includes(pathToFileURL(missing).href), boxes[0][1]);
    });
  });

  if (failures) throw new Error(`${failures} step(s) failed`);
}

main().then(() => console.log('app e2e: done'), (err) => { console.error(err); process.exit(1); });
