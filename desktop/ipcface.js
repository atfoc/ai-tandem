'use strict';

// The IPC face of the app: what the main process answers the page (plan C4.2, C4.3). Each channel
// first checks who is asking: only the main frame of the app's main window, while it is on the page,
// is answered. The face holds no connection of its own; the client (@aiwb/conn) does. Nothing here
// imports electron, so `node --test` can load this file with fakes.

const fs = require('node:fs');
const path = require('node:path');
const { fromAppWindow, pickImages, serverLogPath } = require('./lib');

// The operations the page may ask for (plan C3.10). Anything else answers 404 no_op.
const APP_OPS = new Set([
  'servers.list', 'servers.add', 'servers.edit', 'servers.remove', 'servers.test', 'servers.testSaved',
  'servers.accept', 'owner.restart', 'owner.retry', 'owner.status', 'owner.openLog', 'owner.reveal',
]);

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_BATCH = 500;
const MAX_ID = 200;
const BOARD = /^b_[0-9a-z]{8}$/;

class Refused extends Error {}

// createIpcFace registers the handlers on ipcMain and returns
//
//   endSubscription()  ends the window's subscription, as a navigation of the page does
//   watchWindow(win)   ends it when win's page navigates away, reloads, crashes, or win closes
//   close()            tells the page the stream is closed, ends the subscription (at quit)
//   dispose()          removes the handlers
//
// getWindow answers the main window, or null; pageURL is the page's URL; home is the data folder
// when the client does not know this computer's yet.
function createIpcFace({
  ipcMain, client, getWindow, pageURL, shell, dialog, home,
  fsImpl = fs, setImmediate: later = setImmediate,
}) {
  // pending holds the calls under way by the page's id, to cancel them.
  const pending = new Map();
  let sub = null;
  let queue = [];
  let flushScheduled = false;

  const senderOk = (event) => fromAppWindow({ event, win: getWindow(), pageURL });
  const check = (event) => {
    if (!senderOk(event)) throw new Refused('the call is not from the app window');
  };

  function send(channel, payload) {
    const win = getWindow();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send(channel, payload);
  }

  function flush() {
    flushScheduled = false;
    if (queue.length === 0) return;
    send('aiwb:events', queue.splice(0, MAX_BATCH));
    if (queue.length > 0) schedule();
  }

  function schedule() {
    if (flushScheduled) return;
    flushScheduled = true;
    later(flush);
  }

  function endSubscription() {
    const old = sub;
    sub = null;
    queue = [];
    if (old) old.close();
  }

  function parseBody(body) {
    if (body === undefined || body === null) return undefined;
    if (typeof body !== 'object') throw new Refused('bad call body');
    if ('json' in body && !('bytes' in body)) {
      if (typeof body.json !== 'string') throw new Refused('bad call body');
      return { json: body.json };
    }
    if ('bytes' in body && !('json' in body) && ArrayBuffer.isView(body.bytes) && typeof body.type === 'string') {
      const b = body.bytes;
      return { bytes: new Uint8Array(b.buffer, b.byteOffset, b.byteLength), type: body.type };
    }
    throw new Refused('bad call body');
  }

  // parseCall reads what the page asked for into the client's request, or throws. The client
  // checks the server and the path; this only makes sure the shape is the one the page's
  // preload sends.
  function parseCall(req) {
    if (!req || typeof req !== 'object') throw new Refused('bad call');
    const { id, server, method, path: p, body } = req;
    if (typeof id !== 'string' || id === '' || id.length > MAX_ID) throw new Refused('bad call id');
    if (typeof server !== 'string' || typeof p !== 'string' || !METHODS.has(method)) throw new Refused('bad call');
    return { id, server, method, path: p, body: parseBody(body) };
  }

  ipcMain.handle('aiwb:call', async (event, req) => {
    check(event);
    const { id, server, method, path: p, body } = parseCall(req);
    if (pending.has(id)) throw new Refused('call id in use');
    const ac = new AbortController();
    pending.set(id, ac);
    try {
      const a = await client.call({ server, method, path: p, ...(body ? { body } : {}), signal: ac.signal });
      return { status: a.status, text: a.text, sceneRev: a.sceneRev ?? null };
    } catch (err) {
      if (err && err.name === 'AbortError') {
        return { status: 499, text: JSON.stringify({ error: 'The call was cancelled.', code: 'cancelled' }), sceneRev: null };
      }
      throw err;
    } finally {
      pending.delete(id);
    }
  });

  ipcMain.on('aiwb:cancel', (event, payload) => {
    if (!senderOk(event) || !payload || typeof payload.id !== 'string') return;
    const ac = pending.get(payload.id);
    if (ac) ac.abort();
  });

  ipcMain.handle('aiwb:stream', async (event, payload) => {
    check(event);
    if (!payload || typeof payload.open !== 'boolean') throw new Refused('bad stream request');
    endSubscription();
    if (payload.open) {
      const mine = {};
      mine.handle = client.subscribe((envelope) => {
        if (sub !== mine) return;
        queue.push(envelope);
        schedule();
      });
      mine.close = () => mine.handle.close();
      sub = mine;
      send('aiwb:stream-state', 'open');
    }
    return { ok: true };
  });

  ipcMain.handle('aiwb:app', async (event, payload) => {
    check(event);
    if (!payload || typeof payload.op !== 'string') throw new Refused('bad app request');
    const { op, args } = payload;
    if (!APP_OPS.has(op)) return answer(404, { error: 'this app does not know that operation', code: 'no_op' });
    if (op === 'owner.openLog') return answer(...(await openLog()));
    if (op === 'owner.reveal') return answer(...(await reveal(args)));
    const a = await client.app(op, args);
    return answer(a.status, a.body);
  });

  ipcMain.handle('aiwb:pick-images', (event) =>
    pickImages({ event, win: getWindow(), pageURL, dialog }));

  const answer = (status, body) => ({ status, text: JSON.stringify(body === undefined ? null : body) });

  // dataFolder is the data folder of this computer's server: what its launch printed, else the one
  // the app was told.
  const dataFolder = () => {
    const info = client.localInfo();
    return (info && info.home) || home;
  };

  async function openLog() {
    const err = await shell.openPath(serverLogPath(dataFolder()));
    if (err) return [500, { error: err, code: 'open_failed' }];
    return [200, { ok: true }];
  }

  async function reveal(args) {
    const board = args && typeof args === 'object' ? args.board : undefined;
    if (typeof board !== 'string' || !BOARD.test(board)) return [400, { error: 'not a board', code: 'bad_board' }];
    const file = path.join(dataFolder(), 'boards', board, 'drawing.excalidraw');
    let isFile = false;
    try {
      isFile = (await fsImpl.promises.stat(file)).isFile();
    } catch { /* no such file */ }
    if (!isFile) return [404, { error: 'That board has no file here.', code: 'not_found' }];
    shell.showItemInFolder(file);
    return [200, { ok: true }];
  }

  function watchWindow(win) {
    const wc = win.webContents;
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) endSubscription();
    });
    wc.on('render-process-gone', endSubscription);
    win.on('closed', endSubscription);
  }

  return {
    endSubscription,
    watchWindow,
    close() {
      if (sub) send('aiwb:stream-state', 'closed');
      endSubscription();
    },
    dispose() {
      for (const ch of ['aiwb:call', 'aiwb:stream', 'aiwb:app', 'aiwb:pick-images']) ipcMain.removeHandler(ch);
      ipcMain.removeAllListeners('aiwb:cancel');
      endSubscription();
    },
  };
}

module.exports = { createIpcFace, APP_OPS };
