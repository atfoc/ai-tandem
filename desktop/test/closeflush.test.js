const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { FLUSH_TIMEOUT_MS, attachCloseFlush } = require('../lib');

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

test('nothing pending: the page does not prevent the unload, so no flush is asked, no dialog is shown and the close, the quit and the reload are the window\'s own (D-DW-07)', async () => {
  const f = fakes();
  attachCloseFlush({ app: f.app, win: f.win, dialog: f.dialog });
  // (the page\'s beforeunload only prevents while a board waits: with none, will-prevent-unload is never emitted)
  f.win.emit('close');
  f.app.emit('before-quit');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(f.win.webContents.scripts, []);
  assert.equal(f.win.closes, 0, 'nothing is done again: the first close was not cancelled');
  assert.equal(f.app.quits, 0);
  assert.equal(f.win.webContents.reloads, 0);
  assert.equal(f.dialog.shown.length, 0);
});

test('a flush that answers true at once is one question and one close: no dialog, no wait for the timeout (D-DW-07)', async () => {
  const f = fakes({ flush: () => Promise.resolve(true) });
  attachCloseFlush({ app: f.app, win: f.win, dialog: f.dialog, flushTimeoutMs: 600_000 });
  const t0 = Date.now();
  f.win.emit('close');
  assert.equal(await unload(f.win), false);
  assert.ok(Date.now() - t0 < 5000, 'it did not wait for the timeout');
  assert.equal(f.win.webContents.scripts.length, 1, 'the page was asked once');
  assert.equal(f.win.closes, 1);
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

test('Cmd+Q, flush that never finishes, Cancel: no quit, no close, no reload', async () => {
  const f = fakes({ flush: () => new Promise(() => {}), responses: [0] });
  attachCloseFlush({ app: f.app, win: f.win, dialog: f.dialog, flushTimeoutMs: 20 });
  f.app.emit('before-quit');
  f.win.emit('close');
  assert.equal(await unload(f.win), false);
  assert.equal(f.dialog.shown.length, 1);
  assert.deepEqual(f.dialog.shown[0].opts, DIALOG);
  assert.equal(f.app.quits, 0);
  assert.equal(f.win.closes, 0);
  assert.equal(f.win.webContents.reloads, 0);
});
