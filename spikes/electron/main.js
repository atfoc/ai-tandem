'use strict';

// SPIKE (rn-spike-electron): a separate Electron main script. It reuses desktop/ipcface.js and desktop/lib.js
// unchanged (the real IPC face with its real checks), with a fake client in place of desktop/conn, and loads
// either the contextBridge probe or the Expo web export. It prints one JSON result and exits.
//
//   SPIKE_MODE   probe | app           (default app)
//   SPIKE_SCHEME file | app            how the page is loaded: win.loadFile (file://, as desktop/main.js does today)
//                                      or an app-owned scheme, aiwb-app://app/ served from the same folder
//   SPIKE_CSP    none | strict | strict-wasm | strict-no-inline-style | <a policy string>
//   SPIKE_SITE   the Expo export folder (default app/dist)
//   SPIKE_OUT    where the result JSON goes (default .out/<mode>-<scheme>-<csp>.json)
//   SPIKE_TIMEOUT  ms to wait for the page to finish (default 60000)
//   SPIKE_SHOW   1 shows the window (default: shown, not focused); 0 keeps it hidden
//
// It spends nothing, opens no network, and touches nothing of the user's: AIWB_USER_DATA-style, it gives
// Electron a temporary userData folder.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, protocol, session } = require('electron');
const { createIpcFace } = require('../../desktop/ipcface.js');

const mode = process.env.SPIKE_MODE || 'app';
const scheme = process.env.SPIKE_SCHEME || 'file';
const cspName = process.env.SPIKE_CSP || 'none';
const site = path.resolve(process.env.SPIKE_SITE || path.join(__dirname, 'app/dist'));
const outDir = path.join(__dirname, '.out');
const outFile = process.env.SPIKE_OUT || path.join(outDir, `${mode}-${scheme}-${cspName.replace(/[^a-z0-9-]+/gi, '_').slice(0, 40)}.json`);
const APP_SCHEME = 'aiwb-app';

const POLICIES = {
  none: null,
  // What a locked-down page of the app could carry. 'self' is the scheme the page was loaded from.
  strict: "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: aiwb-picture:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'",
  // The same, with the one addition WebAssembly needs.
  'strict-wasm': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: aiwb-picture:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'",
  'strict-no-inline-style': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: aiwb-picture:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'",
};
const csp = Object.hasOwn(POLICIES, cspName) ? POLICIES[cspName] : cspName;

app.setPath('userData', fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'aiwb-spike-electron-')));
if (scheme === 'app') {
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
}

// ---- the fake client: what desktop/conn is to the real face. Calls are slow or fast by path.
const log = { calls: [], streams: [] };
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
});
const fakeClient = {
  async call({ server, method, path: p, body, signal }) {
    const entry = { server, method, path: p, at: Date.now(), abortedWhileWaiting: false, finished: false, bodyBytes: body && body.bytes ? body.bytes.byteLength : null };
    log.calls.push(entry);
    try {
      if (p.startsWith('/api/slow')) await sleep(30000, signal);
      else if (p.startsWith('/api/many/')) await sleep(400, signal);
      else if (p === '/api/bytes') {
        const b = body && body.bytes;
        const sha = b ? crypto.createHash('sha256').update(b).digest('hex') : null;
        entry.finished = true;
        return { status: 200, text: JSON.stringify({ length: b ? b.byteLength : null, type: body && body.type, sha256: sha }), sceneRev: null };
      }
      entry.finished = true;
      return { status: 200, text: JSON.stringify({ ok: true, path: p, json: body && body.json }), sceneRev: 3 };
    } catch (err) {
      if (err && err.name === 'AbortError') entry.abortedWhileWaiting = true;
      throw err;
    }
  },
  subscribe(cb) {
    // The greeting and then a few events, in order, as the real client does; the last is bigger.
    const n = { v: 0 };
    log.streams.push({ opened: Date.now(), closed: null });
    const rec = log.streams.at(-1);
    const timer = setInterval(() => {
      n.v++;
      cb({ server: 'local', event: { type: 'probe', n: n.v, pad: n.v === 3 ? 'x'.repeat(50000) : '' } });
      if (n.v >= 5) clearInterval(timer);
    }, 40);
    return { close() { clearInterval(timer); rec.closed = Date.now(); } };
  },
  async app(op) { return { status: 200, body: { op } }; },
  localInfo() { return null; },
};

// ---- the page's files
// With a CSP, the file way carries it as a meta tag in a copy of the export (a file:// response has no
// headers); the scheme way carries it as a header, and serves the export as it is.
function prepareSite() {
  if (scheme === 'app' || !csp) return site;
  const copy = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'aiwb-spike-site-'));
  fs.cpSync(site, copy, { recursive: true });
  const f = path.join(copy, 'index.html');
  const html = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, html.replace(/<head>/i, `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp.replace(/"/g, '&quot;')}" />`));
  return copy;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.map': 'application/json', '.svg': 'image/svg+xml' };
function handleAppScheme(root) {
  return async (request) => {
    const u = new URL(request.url);
    if (u.host !== 'app') return new Response(null, { status: 404 });
    let rel = decodeURIComponent(u.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.resolve(root, '.' + rel);
    if (file !== root && !file.startsWith(root + path.sep)) return new Response(null, { status: 403 });
    let data;
    try { data = await fs.promises.readFile(file); } catch { return new Response(null, { status: 404 }); }
    const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' };
    if (csp) headers['Content-Security-Policy'] = csp;
    return new Response(data, { headers });
  };
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await app.whenReady();
  const root = mode === 'probe' ? path.join(__dirname, 'probe') : prepareSite();
  const entry = mode === 'probe' || scheme === 'file' ? path.join(root, 'index.html') : null;
  const pageURL = mode === 'probe' || scheme === 'file' ? pathToFileURL(entry).href : `${APP_SCHEME}://app/index.html`;
  if (mode === 'app' && !fs.existsSync(path.join(root, 'index.html'))) throw new Error(`no export at ${root}: run \`npx expo export --platform web\` in spikes/electron/app`);
  if (mode === 'app' && scheme === 'app') session.defaultSession.protocol.handle(APP_SCHEME, handleAppScheme(root));

  const consoleLines = [];
  const loadFailures = [];
  let win = null;
  const face = mode === 'app' ? createIpcFace({
    ipcMain, client: fakeClient, getWindow: () => win, pageURL,
    shell: { openPath: async () => 'no', showItemInFolder() {} }, dialog: {}, home: os.tmpdir(),
  }) : null;

  win = new BrowserWindow({
    width: 900, height: 600, show: false, title: 'spike',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox is left at Electron's default, as desktop/main.js leaves it
      preload: path.join(__dirname, mode === 'probe' ? 'probe/preload.js' : 'bridge/preload.js'),
    },
  });
  if (face) face.watchWindow(win);
  win.webContents.on('console-message', (e) => consoleLines.push(`${e.level}: ${e.message}`.slice(0, 300)));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => loadFailures.push({ code, desc, url }));
  win.webContents.on('preload-error', (_e, p, err) => consoleLines.push(`PRELOAD ERROR ${p}: ${err && err.message}`));
  win.webContents.on('render-process-gone', (_e, d) => consoleLines.push(`render-process-gone ${d.reason}`));
  win.once('ready-to-show', () => { if (process.env.SPIKE_SHOW !== '0') win.showInactive(); });

  if (mode === 'probe' || scheme === 'file') win.loadFile(entry);
  else win.loadURL(pageURL);

  const flag = mode === 'probe' ? '__probeDone' : '__spike && window.__spike.done';
  const dataExpr = mode === 'probe' ? 'window.__probe' : 'window.__spike';
  const deadline = Date.now() + Number(process.env.SPIKE_TIMEOUT || 60000);
  let done = false;
  while (Date.now() < deadline) {
    await sleepMs(100);
    try { if (await win.webContents.executeJavaScript(`!!(window.${flag})`)) { done = true; break; } } catch { /* page not ready yet */ }
  }
  let page = null;
  try { page = await win.webContents.executeJavaScript(`JSON.stringify(${dataExpr} ?? null)`).then(JSON.parse); } catch (e) { page = { error: String(e) }; }
  let boot = null;
  try {
    boot = await win.webContents.executeJavaScript(`JSON.stringify({ href: location.href, title: document.title, bodyText: document.body && document.body.innerText.slice(0, 400), scriptURLs: Array.from(document.scripts).map((s) => s.src).filter(Boolean), hasAiwbApp: typeof window.aiwbApp, keys: window.aiwbApp ? Object.keys(window.aiwbApp).sort() : null, leaks: [typeof window.require, typeof window.process, typeof window.Buffer] })`).then(JSON.parse);
  } catch (e) { boot = { error: String(e) }; }
  await sleepMs(300); // let a cancelled call reach the fake client
  const result = { mode, scheme, csp: cspName, done, pageURL, versions: process.versions, boot, page, main: { log, consoleLines, loadFailures } };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
  console.log(`SPIKE_RESULT ${outFile}`);
  if (face) face.dispose();
  app.exit(done ? 0 : 1);
}

main().catch((err) => { console.error(err); app.exit(2); });
