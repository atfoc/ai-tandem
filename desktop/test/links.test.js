const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { linkAction, attachLinkHandlers } = require('../lib');

const pageURL = 'file:///Applications/AI%20Whiteboard.app/Contents/Resources/web/index.html';

test('linkAction: other origins with http, https or mailto → open', () => {
  assert.equal(linkAction('https://example.com/', pageURL), 'open');
  assert.equal(linkAction('http://127.0.0.1:9999/', pageURL), 'open');
  assert.equal(linkAction('mailto:a@b.c', pageURL), 'open');
});

test('linkAction: other schemes and unparsable URLs → drop', () => {
  assert.equal(linkAction('file:///etc/hosts', pageURL), 'drop');
  assert.equal(linkAction('javascript:alert(1)', pageURL), 'drop');
  assert.equal(linkAction('data:text/html,x', pageURL), 'drop');
  assert.equal(linkAction('not a url', pageURL), 'drop');
});

test('linkAction: the page itself, with or without a hash → stay', () => {
  assert.equal(linkAction(pageURL, pageURL), 'stay');
  assert.equal(linkAction(`${pageURL}#/chat/c_1`, pageURL), 'stay');
  assert.equal(linkAction(pageURL, `${pageURL}#x`), 'stay');
});

test('linkAction: another file, the page with a query, or a picture address → drop', () => {
  assert.equal(linkAction('file:///Applications/other.html', pageURL), 'drop');
  assert.equal(linkAction(`${pageURL}?x=1`, pageURL), 'drop');
  assert.equal(linkAction('aiwb-picture://p/local/c/i', pageURL), 'drop');
});

function fakeWindow() {
  const webContents = new EventEmitter();
  webContents.openHandlers = [];
  webContents.setWindowOpenHandler = (h) => webContents.openHandlers.push(h);
  const shell = { opened: [], openExternal: (u) => shell.opened.push(u) };
  const links = attachLinkHandlers(webContents, shell);
  links.setPageURL(pageURL);
  return { webContents, shell, links };
}

function navigate(webContents, url) {
  const event = { prevented: 0, preventDefault() { this.prevented++; } };
  webContents.emit('will-navigate', event, url);
  return event;
}

test('window.open of an allowed URL → openExternal once, deny', () => {
  const { webContents, shell } = fakeWindow();
  assert.equal(webContents.openHandlers.length, 1);
  const res = webContents.openHandlers[0]({ url: 'https://example.com/' });
  assert.deepEqual(res, { action: 'deny' });
  assert.deepEqual(shell.opened, ['https://example.com/']);
});

test('window.open of a file: URL → no openExternal, deny', () => {
  const { webContents, shell } = fakeWindow();
  const res = webContents.openHandlers[0]({ url: 'file:///etc/hosts' });
  assert.deepEqual(res, { action: 'deny' });
  assert.deepEqual(shell.opened, []);
});

test('will-navigate to another origin → prevented and opened outside', () => {
  const { webContents, shell } = fakeWindow();
  const event = navigate(webContents, 'https://example.com/page');
  assert.equal(event.prevented, 1);
  assert.deepEqual(shell.opened, ['https://example.com/page']);
});

test('will-navigate to a disallowed scheme → prevented, not opened', () => {
  const { webContents, shell } = fakeWindow();
  const event = navigate(webContents, 'file:///etc/hosts');
  assert.equal(event.prevented, 1);
  assert.deepEqual(shell.opened, []);
});

test('will-navigate to the page with another hash → neither prevented nor opened', () => {
  const { webContents, shell } = fakeWindow();
  const event = navigate(webContents, `${pageURL}#/board/b_1`);
  assert.equal(event.prevented, 0);
  assert.deepEqual(shell.opened, []);
});

test('will-navigate to a reload of another file or to the picture scheme → prevented, not opened', () => {
  const { webContents, shell } = fakeWindow();
  assert.equal(navigate(webContents, 'file:///tmp/other.html').prevented, 1);
  assert.equal(navigate(webContents, 'aiwb-picture://p/local/c/i').prevented, 1);
  assert.deepEqual(shell.opened, []);
});

test('setPageURL moves the page the window stays on', () => {
  const { webContents, shell, links } = fakeWindow();
  links.setPageURL('file:///tmp/dev/index.html');
  assert.equal(navigate(webContents, 'file:///tmp/dev/index.html#x').prevented, 0);
  assert.equal(navigate(webContents, pageURL).prevented, 1);
  assert.deepEqual(shell.opened, []);
});
