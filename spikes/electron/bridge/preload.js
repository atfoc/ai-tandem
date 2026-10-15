'use strict';

// SPIKE (rn-spike-electron): the window's bridge that BUILDS the transport, instead of forwarding calls to a
// page-side translator (react-native-rewrite-goal 4.6). It is one self-contained file on purpose: a sandboxed
// preload (Electron's default) can require 'electron' and a few built-ins and nothing of the app's own files.
//
// It talks to the main process over the channels desktop/ipcface.js already answers (aiwb:call, aiwb:cancel,
// aiwb:stream, aiwb:events, aiwb:stream-state, aiwb:app, aiwb:pick-images), so the IPC face is unchanged.
//
// What the page gets, as window.aiwbApp: the page's Transport (web/src/transport/types.ts) minus what cannot
// cross contextBridge. An AbortSignal cannot cross (it arrives as {}), so a call takes `abort`, a plain
// object of functions, in its place:
//
//   call(req)  req = { server, method, path, body?, abort? }   (no signal, no keepalive, no Blob)
//              abort = { aborted: boolean, listen(cb): () => void }   listen(cb) runs cb once when the page aborts.
//              The call gets an identifier here; the cancel goes to the main process as { id } on aiwb:cancel.
//              Resolves to { status, text, sceneRev }; rejects with an Error named AbortError or TransportError.
//   stream(onEnvelope, onState) -> { close() }
//   pictureURL(server, chat, image) -> string
//   app(op, args) -> Promise<{ status, text }>
//   pickImages() -> Promise<{ files, skipped }>

function buildBridge(ipcRenderer, { randomUUID }) {
  const named = (name, message, cause) => {
    const e = new Error(message);
    e.name = name;
    if (cause !== undefined) e.cause = cause;
    return e;
  };
  const aborted = () => named('AbortError', 'The call was aborted.');
  const failed = (what, e) => named('TransportError', `${what}: ${e instanceof Error ? e.message : String(e)}`);

  // listen adds a listener for one channel of the main process and returns the function that removes
  // it. The listener gets the payload and never the IPC event.
  function listen(channel, cb) {
    const on = (_event, payload) => cb(payload);
    ipcRenderer.on(channel, on);
    return () => ipcRenderer.removeListener(channel, on);
  }

  // What reaches the preload of a body is a copy made by contextBridge. Bytes come best as an ArrayBuffer or a Blob
  // (a Blob crosses by reference; an ArrayBuffer is a fast copy; a Uint8Array is copied element by element, about
  // 20 times slower, see plans/rn-rewrite/spikes/electron.md). A view is cut to its own bytes first, because IPC
  // would otherwise clone the whole buffer under it. The face takes { json } or { bytes: Uint8Array, type }.
  async function bodyOf(b) {
    if (b === undefined || b === null) return undefined;
    if (typeof b !== 'object') throw new TypeError('bad call body');
    if (typeof b.json === 'string') return { json: b.json };
    const { bytes, type } = b;
    if (typeof type !== 'string') throw new TypeError('bad call body');
    if (typeof Blob !== 'undefined' && bytes instanceof Blob) return { bytes: new Uint8Array(await bytes.arrayBuffer()), type };
    if (bytes instanceof ArrayBuffer) return { bytes: new Uint8Array(bytes), type };
    if (ArrayBuffer.isView(bytes)) {
      const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
      return { bytes: whole ? new Uint8Array(bytes.buffer) : new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), type };
    }
    throw new TypeError('bad call body');
  }

  return {
    way: 'ipc',

    async call(req) {
      if (!req || typeof req !== 'object') throw failed('the call did not reach the app', 'bad call');
      const abort = req.abort;
      if (abort && abort.aborted) throw aborted();
      const id = randomUUID();
      // The identifier is the call's from the start: a cancel that comes while the body is still being read
      // (a Blob) is remembered and ends the call before anything is sent.
      let cancelled = false;
      let cancel = () => { cancelled = true; };
      let off = null;
      const aborts = new Promise((_, reject) => {
        if (abort && typeof abort.listen === 'function') {
          off = abort.listen(() => { if (cancelled) return; cancel(); reject(aborted()); });
        }
      });
      aborts.catch(() => {}); // a rejection nobody is waiting for is not an error
      try {
        let body;
        try { body = await Promise.race([bodyOf(req.body), aborts]); } catch (e) { if (e && e.name === 'AbortError') throw e; throw failed('the call did not reach the app', e); }
        if (cancelled) throw aborted();
        const out = { id, server: req.server, method: req.method, path: req.path };
        if (body !== undefined) out.body = body;
        cancel = () => { cancelled = true; ipcRenderer.send('aiwb:cancel', { id }); };
        const asked = ipcRenderer.invoke('aiwb:call', out).then(
          (a) => ({ status: a.status, text: a.text, sceneRev: a.sceneRev ?? null }),
          (e) => { throw failed('the call did not reach the app', e); },
        );
        return await Promise.race([asked, aborts]);
      } finally {
        if (off) { try { off(); } catch { /* the page's own remover */ } }
      }
    },

    stream(onEnvelope, onState) {
      let open = true;
      const offEvents = listen('aiwb:events', (batch) => { if (open) for (const e of batch) onEnvelope(e); });
      const offState = listen('aiwb:stream-state', (s) => { if (open) onState(s); });
      void ipcRenderer.invoke('aiwb:stream', { open: true }).catch(() => { if (open) onState('closed'); });
      return {
        close() {
          if (!open) return;
          open = false;
          offEvents();
          offState();
          void ipcRenderer.invoke('aiwb:stream', { open: false }).catch(() => {});
        },
      };
    },

    pictureURL: (server, chat, image) =>
      `aiwb-picture://p/${encodeURIComponent(server)}/${encodeURIComponent(chat)}/${encodeURIComponent(image)}`,

    app: (op, args) =>
      ipcRenderer.invoke('aiwb:app', { op, args }).catch((e) => { throw failed('the app did not answer', e); }),

    pickImages: () => ipcRenderer.invoke('aiwb:pick-images'),
  };
}

if (typeof module !== 'undefined') module.exports = { buildBridge };

// Under Electron: expose the bridge. Under `node --test` the test requires this file with a fake
// 'electron' module (see test/), or only uses buildBridge.
let electron;
try { electron = require('electron'); } catch { /* not under Electron */ }
if (electron && electron.contextBridge && electron.ipcRenderer) {
  const { contextBridge, ipcRenderer } = electron;
  const randomUUID = () => globalThis.crypto.randomUUID();
  contextBridge.exposeInMainWorld('aiwbApp', buildBridge(ipcRenderer, { randomUUID }));
}
