// The API the app window gives the page, over the channels desktop/ipcface.js answers:
//
// window.aiwbTransport (AD-22): the page's Transport minus what cannot cross contextBridge. An
// AbortSignal arrives in the preload as {} and an Error loses its name, so the page's adapter
// (packages/core/src/transport/desktop.ts) hands over `abort`, a plain object of functions, and makes the real
// errors again. Everything else is made here: the call's identifier, the body, the IPC messages, the cancel.
//
//   way: "ipc"
//   call({ server, method, path, body?, abort? })   body: { json } | { bytes: ArrayBuffer | Blob | Uint8Array, type };
//                abort: { aborted: boolean, listen(cb) -> off }, cb runs once when the page aborts. The call gets its
//                identifier here (never seen by the page); the cancel crosses as { id } on aiwb:cancel, once.
//                Resolves to { status, text, sceneRev }; rejects with an Error (only its message crosses).
//   stream(onEnvelope, onState) -> { close() }
//   picture(server, chat, image) -> Promise<"aiwb-picture://p/...">
//   app(op, args) -> Promise<{ status, text }>
//   pickImages() -> Promise<{ files, skipped }>
//
// A sandboxed preload can require 'electron' and nothing of the app's own files, so this is one file.
// Pictures are shown from addresses of the aiwb-picture scheme.

const { contextBridge, ipcRenderer } = require('electron');

// listen adds a listener for one channel of the main process and returns the function that removes
// it. The listener gets the payload and never the IPC event.
function listen(channel, cb) {
  const on = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, on);
  return () => ipcRenderer.removeListener(channel, on);
}

// buildTransport makes the page's transport; randomUUID makes a call's identifier.
function buildTransport(randomUUID) {
  const named = (name, message) => {
    const e = new Error(message);
    e.name = name;
    return e;
  };
  const aborted = () => named('AbortError', 'The call was aborted.');
  const failed = (what, e) => named('TransportError', `${what}: ${e instanceof Error ? e.message : String(e)}`);

  // What reaches the preload of a body is a copy made by contextBridge. Bytes come best as an ArrayBuffer or a Blob
  // (a Blob crosses by reference, an ArrayBuffer is a fast copy, a Uint8Array is copied element by element, about 20
  // times slower). A view is cut to its own bytes first, because IPC would otherwise clone the whole buffer under
  // it. The face takes { json } or { bytes: Uint8Array, type }.
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

    picture: async (server, chat, image) =>
      `aiwb-picture://p/${encodeURIComponent(server)}/${encodeURIComponent(chat)}/${encodeURIComponent(image)}`,

    app: (op, args) =>
      ipcRenderer.invoke('aiwb:app', { op, args }).catch((e) => { throw failed('the app did not answer', e); }),

    pickImages: () => ipcRenderer.invoke('aiwb:pick-images'),
  };
}

contextBridge.exposeInMainWorld('aiwbTransport', buildTransport(() => globalThis.crypto.randomUUID()));
