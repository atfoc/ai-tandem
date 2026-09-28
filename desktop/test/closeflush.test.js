const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { FLUSH_TIMEOUT_MS, attachCloseFlush, resumeAfterCancelledQuit } = require('../lib');

const DIALOG = {
  type: 'warning',
  message: 'Board changes are not saved.',
  detail: 'The server did not answer. Close anyway and lose them?',
  buttons: ['Cancel', 'Close anyway'],
  defaultId: 0,
  cancelId: 0,
};

// fakes builds an app, window and dialog that record what is done to them. flush is what
// executeJavaScript returns (a function, so each call can get a new promise); responses are the
// dialog's answers, in order.
function fakes({ flush = () => Promise.resolve(true), responses = [], windows = 1 } = {}) {
  const app = new EventEmitter();
  app.quits = 0;
  app.quit = () => app.quits++;

  const dialog = {
    shown: [],
    async showMessageBox(win, opts) {
      dialog.shown.push({ win, opts });
      return { response: responses.shift() ?? 0 };
    },
  };

  const wins = [];
  for (let i = 0; i < windows; i++) {
    const win = new EventEmitter();
    win.closes = 0;
    win.close = () => win.closes++;
    const wc = new EventEmitter();
    wc.reloads = 0;
    wc.reload = () => wc.reloads++;
    wc.scripts = [];
    wc.executeJavaScript = (code, userGesture) => {
      wc.scripts.push({ code, userGesture });
      return flush();
    };
    win.webContents = wc;
    wins.push(win);
  }
  return { app, dialog, win: wins[0], wins };
}

// unload fires will-prevent-unload on win, lets the handler run to its end, and returns whether
// the event's preventDefault was called (= unload anyway).
async function unload(win) {
  let prevented = false;
  const e = { preventDefault: () => (prevented = true) };
  const done = Promise.all(win.webContents.listeners('will-prevent-unload').map((fn) => fn(e)));
  await done;
  return prevented;
}

test('FLUSH_TIMEOUT_MS is 10 s', () => {
  assert.equal(FLUSH_TIMEOUT_MS, 10_000);
});

test('close with pending saves: flush, then close again without a dialog', async () => {
  const f = fakes();
  attachCloseFlush({ app: f.app, win: f.win, dialog: f.dialog });
  f.win.emit('close');
  const prevented = await unload(f.win);
  assert.equal(prevented, false);
  assert.deepEqual(f.win.webContents.scripts, [
    { code: 'window.aiwbFlush ? window.aiwbFlush() : false', userGesture: true },
  ]);
  assert.equal(f.win.closes, 1);
  assert.equal(f.app.quits, 0);
  assert.equal(f.win.webContents.reloads, 0);
  assert.equal(f.dialog.shown.length, 0);
});

test('Cmd+Q with pending saves: flush, then app.quit()', async () => {
  const f = fakes();
  attachCloseFlush({ app: f.app, win: f.win, dialog: f.dialog });
  f.app.emit('before-quit');
  f.win.emit('close');
  await unload(f.win);
  assert.equal(f.app.quits, 1);
  assert.equal(f.win.closes, 0);
  assert.equal(f.win.webContents.reloads, 0);
  assert.equal(f.dialog.shown.length, 0);
});

test('reload with pending saves: flush, then reload', async () => {
  const f = fakes();
  attachCloseFlush({ app: f.app, win: f.win, dialog: f.dialog });
  await unload(f.win);
  assert.equal(f.win.webContents.reloads, 1);
  assert.equal(f.win.closes, 0);
  assert.equal(f.app.quits, 0);
});

test('a cancelled close or quit is forgotten: the next unload alone is a reload', async () => {
  const f = fakes();
  attachCloseFlush({ app: f.app, win: f.win, dialog: f.dialog });
  f.app.emit('before-quit');
  f.win.emit('close');
  await unload(f.win);
  assert.equal(f.app.quits, 1);
  await unload(f.win);
  assert.equal(f.app.quits, 1);
  assert.equal(f.win.closes, 0);
  assert.equal(f.win.webContents.reloads, 1);
});

test('flush that never finishes: dialog, Cancel does nothing more', async () => {
  const f = fakes({ flush: () => new Promise(() => {}), responses: [0] });
  attachCloseFlush({ app: f.app, win: f.win, dialog: f.dialog, flushTimeoutMs: 20 });
  f.win.emit('close');
  const prevented = await unload(f.win);
  assert.equal(prevented, false);
  assert.equal(f.dialog.shown.length, 1);
  assert.equal(f.dialog.shown[0].win, f.win);
  assert.deepEqual(f.dialog.shown[0].opts, DIALOG);
  assert.equal(f.win.closes, 0);
  assert.equal(f.app.quits, 0);
  assert.equal(f.win.webContents.reloads, 0);
});

test('flush that never finishes: Close anyway closes and lets the next unload through', async () => {
  const f = fakes({ flush: () => new Promise(() => {}), responses: [1] });
  attachCloseFlush({ app: f.app, win: f.win, dialog: f.dialog, flushTimeoutMs: 20 });
  f.win.emit('close');
  assert.equal(await unload(f.win), false);
  assert.equal(f.dialog.shown.length, 1);
  assert.equal(f.win.closes, 1);
  // The repeated close fires will-prevent-unload again (the saves are still pending).
  f.win.emit('close');
  assert.equal(await unload(f.win), true);
  assert.equal(f.dialog.shown.length, 1);
  assert.equal(f.win.webContents.scripts.length, 1);
  assert.equal(f.win.closes, 1);
  // Only that one unload is let through.
  f.win.emit('close');
  assert.equal(await unload(f.win), false);
  assert.equal(f.dialog.shown.length, 2);
});

test('flush that never finishes on Cmd+Q: Close anyway quits', async () => {
  const f = fakes({ flush: () => new Promise(() => {}), responses: [1] });
  attachCloseFlush({ app: f.app, win: f.win, dialog: f.dialog, flushTimeoutMs: 20 });
  f.app.emit('before-quit');
  f.win.emit('close');
  await unload(f.win);
  assert.equal(f.app.quits, 1);
  assert.equal(f.win.closes, 0);
  f.app.emit('before-quit');
  f.win.emit('close');
  assert.equal(await unload(f.win), true);
  assert.equal(f.app.quits, 1);
});

test('executeJavaScript rejects: treated as not flushed', async () => {
  const f = fakes({ flush: () => Promise.reject(new Error('gone')), responses: [0] });
  attachCloseFlush({ app: f.app, win: f.win, dialog: f.dialog });
  f.win.emit('close');
  await unload(f.win);
  assert.equal(f.dialog.shown.length, 1);
  assert.deepEqual(f.dialog.shown[0].opts, DIALOG);
  assert.equal(f.win.closes, 0);
});

test('executeJavaScript throws: treated as not flushed', async () => {
  const f = fakes({
    flush: () => {
      throw new Error('destroyed');
    },
    responses: [0],
  });
  attachCloseFlush({ app: f.app, win: f.win, dialog: f.dialog });
  f.win.emit('close');
  await unload(f.win);
  assert.equal(f.dialog.shown.length, 1);
  assert.equal(f.win.closes, 0);
});

test('flush resolving false (saves still pending) is treated as not flushed', async () => {
  const f = fakes({ flush: () => Promise.resolve(false), responses: [0] });
  attachCloseFlush({ app: f.app, win: f.win, dialog: f.dialog });
  f.win.emit('close');
  await unload(f.win);
  assert.equal(f.dialog.shown.length, 1);
  assert.equal(f.win.closes, 0);
});

test('before-quit is registered once per app, however many windows', async () => {
  const f = fakes({ windows: 3 });
  for (const win of f.wins) attachCloseFlush({ app: f.app, win, dialog: f.dialog });
  assert.equal(f.app.listenerCount('before-quit'), 1);
  f.app.emit('before-quit');
  f.wins[1].emit('close');
  await unload(f.wins[1]);
  assert.equal(f.app.quits, 1);
  assert.equal(f.wins[1].closes, 0);
});

test('Cmd+Q, flush that never finishes, Cancel: onQuitCancelled fires once, no quit', async () => {
  const f = fakes({ flush: () => new Promise(() => {}), responses: [0] });
  let cancelled = 0;
  attachCloseFlush({
    app: f.app,
    win: f.win,
    dialog: f.dialog,
    flushTimeoutMs: 20,
    onQuitCancelled: () => cancelled++,
  });
  f.app.emit('before-quit');
  f.win.emit('close');
  assert.equal(await unload(f.win), false);
  assert.equal(f.dialog.shown.length, 1);
  assert.deepEqual(f.dialog.shown[0].opts, DIALOG);
  assert.equal(cancelled, 1);
  assert.equal(f.app.quits, 0);
  assert.equal(f.win.closes, 0);
  assert.equal(f.win.webContents.reloads, 0);
});

test('a quit that goes through does not fire onQuitCancelled', async () => {
  for (const opts of [{}, { flush: () => new Promise(() => {}), responses: [1] }]) {
    const f = fakes(opts);
    let cancelled = 0;
    attachCloseFlush({
      app: f.app,
      win: f.win,
      dialog: f.dialog,
      flushTimeoutMs: 20,
      onQuitCancelled: () => cancelled++,
    });
    f.app.emit('before-quit');
    f.win.emit('close');
    await unload(f.win);
    assert.equal(f.app.quits, 1);
    // The repeated quit.
    f.app.emit('before-quit');
    f.win.emit('close');
    await unload(f.win);
    assert.equal(cancelled, 0);
  }
});

test('a cancelled close or reload does not fire onQuitCancelled', async () => {
  const f = fakes({ flush: () => new Promise(() => {}), responses: [0, 0] });
  let cancelled = 0;
  attachCloseFlush({
    app: f.app,
    win: f.win,
    dialog: f.dialog,
    flushTimeoutMs: 20,
    onQuitCancelled: () => cancelled++,
  });
  f.win.emit('close');
  await unload(f.win);
  await unload(f.win);
  assert.equal(f.dialog.shown.length, 2);
  assert.equal(cancelled, 0);
});

test('Cancel after a new quit began during the dialog does not fire onQuitCancelled', async () => {
  const f = fakes({ flush: () => new Promise(() => {}) });
  let answer;
  f.dialog.showMessageBox = () => new Promise((r) => (answer = r));
  let cancelled = 0;
  attachCloseFlush({
    app: f.app,
    win: f.win,
    dialog: f.dialog,
    flushTimeoutMs: 20,
    onQuitCancelled: () => cancelled++,
  });
  f.app.emit('before-quit');
  f.win.emit('close');
  const done = unload(f.win);
  while (!answer) await new Promise((r) => setTimeout(r, 5));
  f.app.emit('before-quit'); // Cmd+Q again, while the dialog is open
  answer({ response: 0 });
  await done;
  assert.equal(cancelled, 0);
  assert.equal(f.app.quits, 0);
});

test('Cancel without onQuitCancelled is fine', async () => {
  const f = fakes({ flush: () => new Promise(() => {}), responses: [0] });
  attachCloseFlush({ app: f.app, win: f.win, dialog: f.dialog, flushTimeoutMs: 20 });
  f.app.emit('before-quit');
  f.win.emit('close');
  await unload(f.win);
  assert.equal(f.app.quits, 0);
});

// fakeReconnector records the URLs start is called with.
function fakeReconnector() {
  const r = { started: [] };
  r.start = (url) => r.started.push(url);
  return r;
}

test('resumeAfterCancelledQuit restarts the reconnector on the open window\'s URL', () => {
  const reconnector = fakeReconnector();
  const win = { isDestroyed: () => false };
  assert.equal(resumeAfterCancelledQuit({ win, url: 'http://127.0.0.1:4747/', reconnector }), true);
  assert.deepEqual(reconnector.started, ['http://127.0.0.1:4747/']);
});

test('resumeAfterCancelledQuit does nothing without an open window or a URL', () => {
  const reconnector = fakeReconnector();
  const url = 'http://127.0.0.1:4747/';
  assert.equal(resumeAfterCancelledQuit({ win: null, url, reconnector }), false);
  assert.equal(resumeAfterCancelledQuit({ win: { isDestroyed: () => true }, url, reconnector }), false);
  assert.equal(resumeAfterCancelledQuit({ win: { isDestroyed: () => false }, url: null, reconnector }), false);
  assert.deepEqual(reconnector.started, []);
});
