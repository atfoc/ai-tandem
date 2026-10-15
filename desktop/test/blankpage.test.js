const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { BLANK_PAGE_WAIT_MS, watchBlankPage } = require('../lib');

// fakes builds a webContents and a dialog that record what is done to them. ready is what the page's
// window.aiwbReady is (a function, so each question can get its own answer or a rejection).
function fakes({ ready = () => true } = {}) {
  const wc = new EventEmitter();
  wc.scripts = [];
  wc.destroyed = false;
  wc.isDestroyed = () => wc.destroyed;
  wc.getURL = () => 'file:///app/dist-web/index.html';
  wc.executeJavaScript = async (code, userGesture) => {
    wc.scripts.push({ code, userGesture });
    return ready();
  };
  const dialog = { errors: [], showErrorBox: (title, content) => dialog.errors.push({ title, content }) };
  return { wc, dialog };
}

const WAIT = 40;
const later = (ms) => new Promise((r) => setTimeout(r, ms));
// Long enough for the wait and the question after it, generous against a slow machine.
const pastWait = () => later(WAIT + 300);

test('BLANK_PAGE_WAIT_MS is 10 s', () => {
  assert.equal(BLANK_PAGE_WAIT_MS, 10_000);
});

test('a page that never set aiwbReady is reported once, with its address, after the wait', async () => {
  const { wc, dialog } = fakes({ ready: () => undefined });
  watchBlankPage({ webContents: wc, dialog, waitMs: WAIT });
  wc.emit('did-finish-load');
  assert.deepEqual(dialog.errors, []); // not before the wait
  await pastWait();
  assert.equal(dialog.errors.length, 1);
  assert.equal(dialog.errors[0].title, 'AI Whiteboard');
  assert.match(dialog.errors[0].content, /did not start/);
  assert.ok(dialog.errors[0].content.includes('file:///app/dist-web/index.html'));
  assert.deepEqual(wc.scripts, [{ code: 'window.aiwbReady === true', userGesture: true }]);
});

test('a page that set aiwbReady is not reported', async () => {
  const { wc, dialog } = fakes({ ready: () => true });
  watchBlankPage({ webContents: wc, dialog, waitMs: WAIT });
  wc.emit('did-finish-load');
  await pastWait();
  assert.equal(wc.scripts.length, 1);
  assert.deepEqual(dialog.errors, []);
});

test('only true is ready: another value is a blank page', async () => {
  for (const v of [false, 1, 'yes', null]) {
    const { wc, dialog } = fakes({ ready: () => v });
    watchBlankPage({ webContents: wc, dialog, waitMs: WAIT });
    wc.emit('did-finish-load');
    await pastWait();
    assert.equal(dialog.errors.length, 1, String(v));
  }
});

test('nothing happens before the page has loaded', async () => {
  const { wc, dialog } = fakes({ ready: () => false });
  watchBlankPage({ webContents: wc, dialog, waitMs: WAIT });
  await pastWait();
  assert.deepEqual(wc.scripts, []);
  assert.deepEqual(dialog.errors, []);
});

test('a new load starts the wait again, and a reload that is under way ends the old one', async () => {
  const { wc, dialog } = fakes({ ready: () => false });
  watchBlankPage({ webContents: wc, dialog, waitMs: WAIT });
  wc.emit('did-finish-load');
  await later(WAIT / 2);
  wc.emit('did-start-loading'); // a reload begins: the first wait is over
  await pastWait();
  assert.deepEqual(wc.scripts, []);
  wc.emit('did-finish-load');
  wc.emit('did-finish-load'); // two loads in a row make one wait
  await pastWait();
  assert.equal(wc.scripts.length, 1);
  assert.equal(dialog.errors.length, 1);
});

test('a window that is gone before the wait ends, or while the page is asked, is not reported', async () => {
  let a = fakes({ ready: () => false });
  watchBlankPage({ webContents: a.wc, dialog: a.dialog, waitMs: WAIT });
  a.wc.emit('did-finish-load');
  a.wc.emit('destroyed');
  await pastWait();
  assert.deepEqual(a.wc.scripts, []);
  assert.deepEqual(a.dialog.errors, []);

  a = fakes({ ready: () => false });
  watchBlankPage({ webContents: a.wc, dialog: a.dialog, waitMs: WAIT });
  a.wc.emit('did-finish-load');
  a.wc.destroyed = true; // destroyed with the timer running and no event heard yet
  await pastWait();
  assert.deepEqual(a.wc.scripts, []);
  assert.deepEqual(a.dialog.errors, []);
});

test('a page that cannot be asked (it navigated away) is not reported', async () => {
  const { wc, dialog } = fakes({
    ready: () => {
      throw new Error('Script failed to execute');
    },
  });
  watchBlankPage({ webContents: wc, dialog, waitMs: WAIT });
  wc.emit('did-finish-load');
  await pastWait();
  assert.equal(wc.scripts.length, 1);
  assert.deepEqual(dialog.errors, []);
});

test('stop ends the wait', async () => {
  const { wc, dialog } = fakes({ ready: () => false });
  const w = watchBlankPage({ webContents: wc, dialog, waitMs: WAIT });
  wc.emit('did-finish-load');
  w.stop();
  await pastWait();
  assert.deepEqual(wc.scripts, []);
  assert.deepEqual(dialog.errors, []);
});
