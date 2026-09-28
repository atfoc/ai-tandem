const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { linkAction, attachLinkHandlers } = require('../lib');

const appOrigin = 'http://127.0.0.1:4747';

test('linkAction: other origins with http, https or mailto → open', () => {
  assert.equal(linkAction('https://example.com/', appOrigin), 'open');
  assert.equal(linkAction('http://127.0.0.1:9999/', appOrigin), 'open');
  assert.equal(linkAction('mailto:a@b.c', appOrigin), 'open');
});

test('linkAction: other schemes and unparsable URLs → drop', () => {
  assert.equal(linkAction('file:///etc/hosts', appOrigin), 'drop');
  assert.equal(linkAction('javascript:alert(1)', appOrigin), 'drop');
  assert.equal(linkAction('data:text/html,x', appOrigin), 'drop');
  assert.equal(linkAction('not a url', appOrigin), 'drop');
});

test('linkAction: the app origin → stay', () => {
  assert.equal(linkAction('http://127.0.0.1:4747/?x=1', appOrigin), 'stay');
  assert.equal(linkAction('http://127.0.0.1:4747/', appOrigin), 'stay');
});

function fakeWindow() {
  const webContents = new EventEmitter();
  webContents.openHandlers = [];
  webContents.setWindowOpenHandler = (h) => webContents.openHandlers.push(h);
  const shell = { opened: [], openExternal: (u) => shell.opened.push(u) };
  const links = attachLinkHandlers(webContents, shell);
  links.setAppURL(`${appOrigin}/`);
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

test('will-navigate on the app origin → neither prevented nor opened', () => {
  const { webContents, shell } = fakeWindow();
  const event = navigate(webContents, `${appOrigin}/?x=1`);
  assert.equal(event.prevented, 0);
  assert.deepEqual(shell.opened, []);
});

test('setAppURL moves the origin the window stays on', () => {
  const { webContents, shell, links } = fakeWindow();
  links.setAppURL('http://127.0.0.1:5858/');
  assert.equal(navigate(webContents, 'http://127.0.0.1:5858/x').prevented, 0);
  const old = navigate(webContents, `${appOrigin}/`);
  assert.equal(old.prevented, 1);
  assert.deepEqual(shell.opened, [`${appOrigin}/`]);
});
