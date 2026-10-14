const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createIpcFace, APP_OPS } = require('../ipcface');

const pageURL = 'file:///Applications/AI%20Whiteboard.app/Contents/Resources/web/index.html';
const turn = () => new Promise((r) => setImmediate(r));

// fakes builds the main window (its page loaded), an ipcMain that keeps the handlers, a client that
// records what it is asked, and the shell and dialog the face may use.
function fakes({ home = '/data', info = null } = {}) {
  const mainFrame = { url: pageURL };
  const webContents = new EventEmitter();
  Object.assign(webContents, { id: 3, mainFrame, sent: [], destroyed: false });
  webContents.send = (channel, payload) => webContents.sent.push([channel, payload]);
  webContents.isDestroyed = () => webContents.destroyed;
  const win = new EventEmitter();
  Object.assign(win, { webContents, destroyed: false, isDestroyed: () => win.destroyed });

  const handlers = new Map();
  const listeners = new Map();
  const ipcMain = {
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => listeners.set(ch, fn),
    removeHandler: (ch) => handlers.delete(ch),
    removeAllListeners: (ch) => listeners.delete(ch),
  };

  const client = {
    calls: [],
    subs: [],
    apps: [],
    callAnswer: async () => ({ status: 200, text: '{"ok":true}', sceneRev: null }),
    appAnswer: async () => ({ status: 200, body: { ok: true } }),
    call(req) {
      client.calls.push(req);
      return client.callAnswer(req);
    },
    subscribe(cb) {
      const s = { cb, closed: false, close() { s.closed = true; } };
      client.subs.push(s);
      return s;
    },
    app(op, args) {
      client.apps.push([op, args]);
      return client.appAnswer(op, args);
    },
    localInfo: () => info,
  };
  const shell = { opened: [], revealed: [], openAnswer: '',
    async openPath(p) { shell.opened.push(p); return shell.openAnswer; },
    showItemInFolder(p) { shell.revealed.push(p); } };
  const dialog = {};
  const face = createIpcFace({ ipcMain, client, getWindow: () => win, pageURL, shell, dialog, home });
  const event = () => ({ sender: webContents, senderFrame: mainFrame });
  return {
    win, webContents, mainFrame, handlers, listeners, client, shell, face, event,
    invoke: (ch, payload, ev = event()) => handlers.get(ch)(ev, payload),
    send: (ch, payload, ev = event()) => listeners.get(ch)(ev, payload),
  };
}

const call = (over = {}) => ({ id: 'c1', server: 'local', method: 'GET', path: '/api/state', ...over });

// Each entry changes the fakes so that the caller is not the main frame of the app's window on the page.
const notTheApp = {
  'another window': (f, ev) => { ev.sender = new EventEmitter(); },
  'a frame inside the page': (f, ev) => { ev.senderFrame = { url: pageURL, parent: f.mainFrame }; },
  'a page that has gone elsewhere': (f) => { f.mainFrame.url = 'https://example.com/'; },
  'a frame that is gone': (f, ev) => { ev.senderFrame = null; },
  'a closed window': (f) => { f.win.destroyed = true; },
};

test('every channel is registered, and removed again by dispose', () => {
  const f = fakes();
  assert.deepEqual([...f.handlers.keys()].sort(), ['aiwb:app', 'aiwb:call', 'aiwb:pick-images', 'aiwb:stream']);
  assert.deepEqual([...f.listeners.keys()], ['aiwb:cancel']);
  f.face.dispose();
  assert.equal(f.handlers.size, 0);
  assert.equal(f.listeners.size, 0);
});

for (const [name, change] of Object.entries(notTheApp)) {
  test(`a caller that is not the app's own page (${name}) gets nothing from any channel`, async () => {
    const f = fakes();
    const ev = f.event();
    change(f, ev);
    await assert.rejects(f.invoke('aiwb:call', call(), ev), /not from the app window/);
    await assert.rejects(f.invoke('aiwb:stream', { open: true }, ev), /not from the app window/);
    await assert.rejects(f.invoke('aiwb:app', { op: 'servers.list' }, ev), /not from the app window/);
    await assert.rejects(f.invoke('aiwb:pick-images', undefined, ev), /not from the app window/);
    assert.equal(f.send('aiwb:cancel', { id: 'c1' }, ev), undefined);
    assert.deepEqual(f.client.calls, []);
    assert.deepEqual(f.client.subs, []);
    assert.deepEqual(f.client.apps, []);
    assert.deepEqual(f.webContents.sent, []);
  });
}

test('a hash on the page\'s URL does not turn the page away', async () => {
  const f = fakes();
  f.mainFrame.url = `${pageURL}#/chat/c_1`;
  const a = await f.invoke('aiwb:call', call());
  assert.equal(a.status, 200);
});

test('call: the client gets the request and a signal; the answer is status, text and sceneRev', async () => {
  const f = fakes();
  f.client.callAnswer = async () => ({ status: 201, text: '{"id":"g"}', sceneRev: 7, extra: 'dropped' });
  const a = await f.invoke('aiwb:call', call({ method: 'POST', path: '/api/groups', body: { json: '{"name":"g"}' } }));
  assert.deepEqual(a, { status: 201, text: '{"id":"g"}', sceneRev: 7 });
  const [req] = f.client.calls;
  assert.equal(req.server, 'local');
  assert.equal(req.method, 'POST');
  assert.equal(req.path, '/api/groups');
  assert.deepEqual(req.body, { json: '{"name":"g"}' });
  assert.ok(req.signal instanceof AbortSignal);
});

test('call: a bytes body arrives as a Uint8Array with its type', async () => {
  const f = fakes();
  await f.invoke('aiwb:call', call({ method: 'POST', path: '/api/chats/c/images', body: { bytes: Buffer.from([1, 2, 3]), type: 'image/png' } }));
  const { body } = f.client.calls[0];
  assert.ok(body.bytes instanceof Uint8Array);
  assert.deepEqual([...body.bytes], [1, 2, 3]);
  assert.equal(body.type, 'image/png');
});

test('call: a request of the wrong shape is rejected and not passed on', async () => {
  const f = fakes();
  const bad = [
    undefined, null, 'x', {},
    call({ id: '' }), call({ id: 5 }), call({ id: 'x'.repeat(201) }),
    call({ server: 5 }), call({ path: 5 }), call({ method: 'TRACE' }), call({ method: 'get' }),
    call({ body: 'x' }), call({ body: {} }), call({ body: { json: 5 } }),
    call({ body: { bytes: 'abc', type: 'x' } }), call({ body: { bytes: new Uint8Array(1) } }),
    call({ body: { json: '{}', bytes: new Uint8Array(1), type: 'x' } }),
  ];
  for (const b of bad) await assert.rejects(f.invoke('aiwb:call', b), /bad call/, JSON.stringify(b));
  assert.deepEqual(f.client.calls, []);
});

test('call: an answer of the client that is a refusal passes as it is', async () => {
  const f = fakes();
  f.client.callAnswer = async () => ({ status: 404, text: '{"error":"This server is not in the list.","code":"no_server"}', sceneRev: null });
  const a = await f.invoke('aiwb:call', call({ server: 's_000000000000' }));
  assert.equal(a.status, 404);
  assert.match(a.text, /no_server/);
});

test('cancel aborts the call with that id and answers it 499; other ids and other senders do not', async () => {
  const f = fakes();
  f.client.callAnswer = (req) => new Promise((resolve, reject) => {
    req.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const one = f.invoke('aiwb:call', call({ id: 'one' }));
  const two = f.invoke('aiwb:call', call({ id: 'two' }));
  await turn();
  f.send('aiwb:cancel', { id: 'none' });
  f.send('aiwb:cancel', { id: 'two' }, { sender: new EventEmitter(), senderFrame: f.mainFrame });
  f.send('aiwb:cancel', undefined);
  assert.equal(f.client.calls[0].signal.aborted, false);
  assert.equal(f.client.calls[1].signal.aborted, false);
  f.send('aiwb:cancel', { id: 'one' });
  const a = await one;
  assert.equal(a.status, 499);
  assert.equal(JSON.parse(a.text).code, 'cancelled');
  assert.equal(f.client.calls[1].signal.aborted, false);
  f.send('aiwb:cancel', { id: 'two' });
  assert.equal((await two).status, 499);
});

test('a call goes on when the page unloads, and the id is free again after the answer', async () => {
  const f = fakes();
  let finish;
  f.client.callAnswer = () => new Promise((r) => { finish = r; });
  const p = f.invoke('aiwb:call', call({ method: 'PUT', path: '/api/boards/b_00000001/scene' }));
  await turn();
  f.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  assert.equal(f.client.calls[0].signal.aborted, false);
  finish({ status: 200, text: '{}', sceneRev: 3 });
  assert.deepEqual(await p, { status: 200, text: '{}', sceneRev: 3 });
  f.client.callAnswer = async () => ({ status: 200, text: '{}', sceneRev: null });
  assert.equal((await f.invoke('aiwb:call', call())).status, 200); // id c1 is used again
});

test('call: an id that is in use is rejected', async () => {
  const f = fakes();
  f.client.callAnswer = () => new Promise(() => {});
  f.invoke('aiwb:call', call());
  await turn();
  await assert.rejects(f.invoke('aiwb:call', call()), /in use/);
  assert.equal(f.client.calls.length, 1);
});

test('stream: opens a subscription, tells the page "open", and sends the envelopes in order, batched per turn', async () => {
  const f = fakes();
  assert.deepEqual(await f.invoke('aiwb:stream', { open: true }), { ok: true });
  assert.equal(f.client.subs.length, 1);
  assert.deepEqual(f.webContents.sent, [['aiwb:stream-state', 'open']]);
  const { cb } = f.client.subs[0];
  cb({ app: { type: 'servers', servers: [], notice: '' } });
  cb({ server: 'local', event: { type: 'hello' } });
  cb({ server: 'local', event: { type: 'snapshot' } });
  assert.equal(f.webContents.sent.length, 1); // nothing before the turn ends
  await turn();
  assert.equal(f.webContents.sent.length, 2);
  const [channel, batch] = f.webContents.sent[1];
  assert.equal(channel, 'aiwb:events');
  assert.deepEqual(batch.map((e) => (e.app ? e.app.type : `${e.server}:${e.event.type}`)), ['servers', 'local:hello', 'local:snapshot']);
  cb({ server: 's_000000000001', event: { type: 'x' } });
  await turn();
  assert.equal(f.webContents.sent.length, 3);
  assert.equal(f.webContents.sent[2][1].length, 1);
});

test('stream: a batch holds at most 500 envelopes, and all of them arrive in order', async () => {
  const f = fakes();
  await f.invoke('aiwb:stream', { open: true });
  const { cb } = f.client.subs[0];
  for (let i = 0; i < 1203; i++) cb({ server: 'local', event: { type: 'e', i } });
  for (let i = 0; i < 5; i++) await turn();
  const batches = f.webContents.sent.filter(([c]) => c === 'aiwb:events').map(([, b]) => b);
  assert.deepEqual(batches.map((b) => b.length), [500, 500, 203]);
  assert.deepEqual(batches.flat().map((e) => e.event.i), [...Array(1203).keys()]);
});

test('stream: opening again ends the first subscription, and what it still says is dropped', async () => {
  const f = fakes();
  await f.invoke('aiwb:stream', { open: true });
  const [first] = f.client.subs;
  first.cb({ server: 'local', event: { type: 'old' } }); // queued, not yet sent
  await f.invoke('aiwb:stream', { open: true });
  const second = f.client.subs[1];
  assert.equal(first.closed, true);
  assert.equal(second.closed, false);
  first.cb({ server: 'local', event: { type: 'late' } });
  second.cb({ server: 'local', event: { type: 'new' } });
  await turn();
  const events = f.webContents.sent.filter(([c]) => c === 'aiwb:events').flatMap(([, b]) => b);
  assert.deepEqual(events.map((e) => e.event.type), ['new']);
});

test('stream: open false ends the subscription and sends no state', async () => {
  const f = fakes();
  await f.invoke('aiwb:stream', { open: true });
  assert.deepEqual(await f.invoke('aiwb:stream', { open: false }), { ok: true });
  assert.equal(f.client.subs[0].closed, true);
  assert.deepEqual(f.webContents.sent, [['aiwb:stream-state', 'open']]);
  await assert.rejects(f.invoke('aiwb:stream', {}), /bad stream request/);
  await assert.rejects(f.invoke('aiwb:stream', { open: 'yes' }), /bad stream request/);
  await assert.rejects(f.invoke('aiwb:stream'), /bad stream request/);
});

test('stream: the subscription ends when the main frame navigates, reloads, crashes, or the window closes', async () => {
  const ends = {
    'a navigation of the main frame': (f) => f.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }),
    'the render process gone': (f) => f.webContents.emit('render-process-gone', {}, f.webContents, { reason: 'crashed' }),
    'the window closed': (f) => f.win.emit('closed'),
  };
  for (const [name, end] of Object.entries(ends)) {
    const f = fakes();
    f.face.watchWindow(f.win);
    await f.invoke('aiwb:stream', { open: true });
    f.client.subs[0].cb({ server: 'local', event: { type: 'queued' } });
    end(f);
    assert.equal(f.client.subs[0].closed, true, name);
    await turn();
    assert.deepEqual(f.webContents.sent, [['aiwb:stream-state', 'open']], name); // the queued one is gone
  }
});

test('stream: a navigation inside the page, or of a frame inside it, keeps the subscription', async () => {
  const f = fakes();
  f.face.watchWindow(f.win);
  await f.invoke('aiwb:stream', { open: true });
  f.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  f.webContents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  assert.equal(f.client.subs[0].closed, false);
});

test('close tells the page the stream is closed and ends the subscription; with none it says nothing', async () => {
  const f = fakes();
  f.face.close();
  assert.deepEqual(f.webContents.sent, []);
  await f.invoke('aiwb:stream', { open: true });
  f.face.close();
  assert.deepEqual(f.webContents.sent, [['aiwb:stream-state', 'open'], ['aiwb:stream-state', 'closed']]);
  assert.equal(f.client.subs[0].closed, true);
});

test('stream: nothing is sent to a window that is gone', async () => {
  const f = fakes();
  await f.invoke('aiwb:stream', { open: true });
  f.webContents.destroyed = true;
  f.client.subs[0].cb({ server: 'local', event: {} });
  await turn();
  assert.deepEqual(f.webContents.sent, [['aiwb:stream-state', 'open']]);
});

test('app: a listed operation goes to the client with its arguments; the body comes back as JSON text', async () => {
  const f = fakes();
  f.client.appAnswer = async () => ({ status: 409, body: { error: 'x', code: 'local_entry' } });
  const a = await f.invoke('aiwb:app', { op: 'servers.edit', args: { id: 'local', patch: {} } });
  assert.deepEqual(a, { status: 409, text: '{"error":"x","code":"local_entry"}' });
  assert.deepEqual(f.client.apps, [['servers.edit', { id: 'local', patch: {} }]]);
});

test('app: operations outside the list answer 404 no_op and reach nothing', async () => {
  const f = fakes();
  for (const op of ['servers', 'servers.secret', 'owner.shell', 'owner.', '__proto__', 'constructor', 'servers.list ', 'call']) {
    const a = await f.invoke('aiwb:app', { op });
    assert.equal(a.status, 404, op);
    assert.equal(JSON.parse(a.text).code, 'no_op', op);
  }
  for (const bad of [undefined, null, {}, { op: 5 }]) await assert.rejects(f.invoke('aiwb:app', bad), /bad app request/);
  assert.deepEqual(f.client.apps, []);
  assert.equal(f.shell.opened.length + f.shell.revealed.length, 0);
});

test('app: the listed operations are the ones of the plan', () => {
  assert.deepEqual([...APP_OPS].sort(), [
    'owner.openLog', 'owner.restart', 'owner.retry', 'owner.reveal', 'owner.status',
    'servers.accept', 'servers.add', 'servers.edit', 'servers.list', 'servers.remove', 'servers.test', 'servers.testSaved',
  ]);
});

test('owner.openLog: opens server.log in the data folder the launch printed, else the one the app was told', async () => {
  const f = fakes({ home: '/told', info: { home: '/printed' } });
  assert.deepEqual(await f.invoke('aiwb:app', { op: 'owner.openLog' }), { status: 200, text: '{"ok":true}' });
  assert.deepEqual(f.shell.opened, ['/printed/server.log']);
  assert.deepEqual(f.client.apps, []);
  const g = fakes({ home: '/told', info: null });
  await g.invoke('aiwb:app', { op: 'owner.openLog' });
  assert.deepEqual(g.shell.opened, ['/told/server.log']);
});

test('owner.openLog: a log that cannot be opened is an error the page can show', async () => {
  const f = fakes();
  f.shell.openAnswer = 'Failed to open path';
  const a = await f.invoke('aiwb:app', { op: 'owner.openLog' });
  assert.equal(a.status, 500);
  assert.deepEqual(JSON.parse(a.text), { error: 'Failed to open path', code: 'open_failed' });
});

test('owner.reveal: shows the board\'s file in the file manager, and only a board that has one', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'aiwb-reveal-'));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  await fsp.mkdir(path.join(home, 'boards', 'b_0a1b2c3d'), { recursive: true });
  await fsp.writeFile(path.join(home, 'boards', 'b_0a1b2c3d', 'drawing.excalidraw'), '{}');
  await fsp.mkdir(path.join(home, 'boards', 'b_nofile00'), { recursive: true });
  const f = fakes({ home, info: null });
  const ask = (args) => f.invoke('aiwb:app', { op: 'owner.reveal', args });

  assert.deepEqual(await ask({ board: 'b_0a1b2c3d' }), { status: 200, text: '{"ok":true}' });
  assert.deepEqual(f.shell.revealed, [path.join(home, 'boards', 'b_0a1b2c3d', 'drawing.excalidraw')]);

  for (const args of [{ board: 'b_nofile00' }, { board: 'b_12345678' }]) {
    const a = await ask(args);
    assert.equal(a.status, 404);
    assert.equal(JSON.parse(a.text).code, 'not_found');
  }
  for (const args of [undefined, null, 'b_0a1b2c3d', {}, { board: 5 }, { board: '../b_0a1b2c3d' }, { board: 'b_0a1b2c3d/..' },
    { board: 'b_0A1B2C3D' }, { board: 'b_0a1b2c3' }, { board: 'b_0a1b2c3de' }, { board: '/etc/passwd' }]) {
    const a = await ask(args);
    assert.equal(a.status, 400, JSON.stringify(args));
    assert.equal(JSON.parse(a.text).code, 'bad_board');
  }
  assert.equal(f.shell.revealed.length, 1);
});
