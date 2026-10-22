const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  serverBin,
  quitsWithLastWindow,
  pagePath,
  serverLogPath,
  pictureAllowed,
  parsePictureURL,
  fromAppWindow,
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
    serverBin({ env: {}, execPath, isPackaged: true, dirname, platform: 'darwin' }),
    '/Applications/AI Whiteboard.app/Contents/MacOS/ai-whiteboard',
  );
});

test('serverBin: dev → ../bin/ai-whiteboard', () => {
  assert.equal(serverBin({ env: {}, execPath, isPackaged: false, dirname, platform: 'darwin' }), '/repo/bin/ai-whiteboard');
});

test('serverBin: win32 → ai-whiteboard.exe, next to the executable when packaged, in ../bin in dev', () => {
  const winExec = path.join('C:\\Users\\me\\AI Whiteboard', 'AI Whiteboard.exe');
  assert.equal(
    serverBin({ env: {}, execPath: winExec, isPackaged: true, dirname, platform: 'win32' }),
    path.join(path.dirname(winExec), 'ai-whiteboard.exe'),
  );
  assert.equal(
    serverBin({ env: {}, execPath, isPackaged: false, dirname, platform: 'win32' }),
    path.resolve(dirname, '../bin', 'ai-whiteboard.exe'),
  );
  assert.ok(serverBin({ env: {}, execPath, isPackaged: false, dirname, platform: 'win32' }).endsWith('ai-whiteboard.exe'));
});

test('serverBin: AIWB_SERVER_BIN wins on win32 too; linux has no .exe', () => {
  assert.equal(serverBin({ env: { AIWB_SERVER_BIN: 'X:\\s.exe' }, execPath, isPackaged: true, dirname, platform: 'win32' }), 'X:\\s.exe');
  assert.equal(serverBin({ env: {}, execPath: '/opt/aiwb/aiwb', isPackaged: true, dirname, platform: 'linux' }), '/opt/aiwb/ai-whiteboard');
});

test('serverBin: the platform defaults to the running one', () => {
  const want = process.platform === 'win32' ? 'ai-whiteboard.exe' : 'ai-whiteboard';
  assert.equal(path.basename(serverBin({ env: {}, execPath, isPackaged: false, dirname })), want);
});

test('quitsWithLastWindow: not on macOS, on Windows and Linux', () => {
  assert.equal(quitsWithLastWindow('darwin'), false);
  assert.equal(quitsWithLastWindow('win32'), true);
  assert.equal(quitsWithLastWindow('linux'), true);
});

test('pagePath: AIWB_PAGE wins, packaged or not', () => {
  const env = { AIWB_PAGE: '/tmp/dist/index.html' };
  for (const isPackaged of [true, false]) {
    assert.equal(pagePath({ env, resourcesPath: '/res', isPackaged, dirname }), '/tmp/dist/index.html');
  }
});

test('pagePath: packaged → web/index.html in the resources', () => {
  assert.equal(pagePath({ env: {}, resourcesPath: '/res', isPackaged: true, dirname }), '/res/web/index.html');
});

test('pagePath: dev → ../app/dist-web/index.html, the web build', () => {
  assert.equal(pagePath({ env: {}, resourcesPath: '/res', isPackaged: false, dirname }), '/repo/app/dist-web/index.html');
});

test('serverLogPath: server.log in the data folder', () => {
  assert.equal(serverLogPath('/Users/me/.ai-whiteboard'), '/Users/me/.ai-whiteboard/server.log');
});

const pageURL = 'file:///Applications/AI%20Whiteboard.app/Contents/Resources/web/index.html';
const image = 'ab'.repeat(32);

test('parsePictureURL: the good form', () => {
  assert.deepEqual(parsePictureURL(`aiwb-picture://p/local/c_1-x/${image}`), { server: 'local', chat: 'c_1-x', image });
  assert.deepEqual(
    parsePictureURL(`aiwb-picture://p/s_0123456789ab/chat/${image}`),
    { server: 's_0123456789ab', chat: 'chat', image },
  );
});

test('parsePictureURL: anything else is refused', () => {
  const bad = [
    `aiwb-picture://q/local/c/${image}`, // another host
    `aiwb-picture://p/local/c`, // a segment short
    `aiwb-picture://p/local/c/${image}/x`, // a segment over
    `aiwb-picture://p/local/c/${image}/`,
    `aiwb-picture://p//c/${image}`,
    `aiwb-picture://p/local/c/${image}?x=1`,
    `aiwb-picture://u:p@p/local/c/${image}`,
    `aiwb-picture://p/other/c/${image}`, // no such kind of entry
    `aiwb-picture://p/s_0123456789AB/c/${image}`,
    `aiwb-picture://p/s_0123456789a/c/${image}`,
    `aiwb-picture://p/local/c%2F..%2Fx/${image}`, // a chat id with a slash
    `aiwb-picture://p/local/c/${image.toUpperCase()}`,
    `aiwb-picture://p/local/c/${image.slice(2)}`,
    `aiwb-picture://p/local/${'c'.repeat(101)}/${image}`,
    `aiwb-picture://p/local/c/%zz`,
    `https://p/local/c/${image}`,
    `file:///local/c/${image}`,
    'not a url',
    '',
  ];
  for (const url of bad) assert.equal(parsePictureURL(url), null, url);
});

// win is the main window; frames are its main frame, an iframe of it, and a frame of another window.
function pictureFakes() {
  const mainFrame = { url: pageURL };
  const win = { webContents: { id: 7, mainFrame }, isDestroyed: () => win.destroyed, destroyed: false };
  return { win, mainFrame, details: { webContentsId: 7, frame: mainFrame } };
}

test('pictureAllowed: the main frame of the main window on the page: yes, with any hash', () => {
  const f = pictureFakes();
  assert.equal(pictureAllowed({ details: f.details, win: f.win, pageURL }), true);
  f.mainFrame.url = `${pageURL}#/board/b_1`;
  assert.equal(pictureAllowed({ details: f.details, win: f.win, pageURL }), true);
});

test('pictureAllowed: an iframe, another webContents, another URL, no frame: no', () => {
  const cases = {
    'an iframe of the page': (f) => { f.details.frame = { url: 'about:srcdoc', parent: f.mainFrame }; },
    'an iframe with the page\'s own URL': (f) => { f.details.frame = { url: pageURL, parent: f.mainFrame }; },
    'another webContents': (f) => { f.details.webContentsId = 8; },
    'a main frame on another file': (f) => { f.mainFrame.url = 'file:///tmp/x.html'; },
    'a main frame on a site': (f) => { f.mainFrame.url = 'https://example.com/'; },
    'a main frame on a query of the page': (f) => { f.mainFrame.url = `${pageURL}?x=1`; },
    'no frame': (f) => { f.details.frame = null; },
    'a closed window': (f) => { f.win.destroyed = true; },
  };
  for (const [name, change] of Object.entries(cases)) {
    const f = pictureFakes();
    assert.equal(pictureAllowed({ details: f.details, win: f.win, pageURL }), true, name);
    change(f);
    assert.equal(pictureAllowed({ details: f.details, win: f.win, pageURL }), false, name);
  }
  const f = pictureFakes();
  assert.equal(pictureAllowed({ details: f.details, win: null, pageURL }), false);
  assert.equal(pictureAllowed({ details: f.details, win: f.win, pageURL: null }), false);
});

test('fromAppWindow: file URL page, hash allowed, others refused', () => {
  const mainFrame = { url: pageURL };
  const webContents = { mainFrame };
  const win = { webContents, isDestroyed: () => false };
  const event = { sender: webContents, senderFrame: mainFrame };
  assert.equal(fromAppWindow({ event, win, pageURL }), true);
  mainFrame.url = `${pageURL}#/x`;
  assert.equal(fromAppWindow({ event, win, pageURL }), true);
  mainFrame.url = 'file:///elsewhere/index.html';
  assert.equal(fromAppWindow({ event, win, pageURL }), false);
  mainFrame.url = pageURL;
  assert.equal(fromAppWindow({ event: { sender: {}, senderFrame: mainFrame }, win, pageURL }), false);
  assert.equal(fromAppWindow({ event: { sender: webContents, senderFrame: { url: pageURL } }, win, pageURL }), false);
});
