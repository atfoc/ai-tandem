// The API the app window gives the page, as window.aiwbApp, and nothing else (plan C4.1):
//
//   - call(req): a call of the client API to a server of the list; req is { id, server, method,
//     path, body? }. Resolves to { status, text, sceneRev }. cancel(id) stops the call with that id.
//   - stream(open): opens (true) or closes (false) the one subscription to the events of every
//     server; opening ends the page's earlier one. onEvents(cb) gets the envelopes in batches, in
//     order; onStreamState(cb) gets "open" and "closed". Each returns the function that removes it.
//   - app(op, args): an operation of the app itself: the server list ("servers.*") and the owner's
//     things ("owner.*"). Resolves to { status, text } with the body's JSON as text.
//   - pickImages(): the app's own open dialog for image files (the composer's attach button).
//     Resolves to { files: [{ name, type, data: Uint8Array }], skipped: [{ name, reason }] }; see
//     pickImages in lib.js. It takes no argument: the page names no path.
//
// Pictures are not here: the page shows them from addresses of the aiwb-picture scheme.

const { contextBridge, ipcRenderer } = require('electron');

// listen adds a listener for one channel of the main process and returns the function that removes
// it. The listener gets the payload and never the IPC event.
function listen(channel, cb) {
  const on = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, on);
  return () => ipcRenderer.removeListener(channel, on);
}

contextBridge.exposeInMainWorld('aiwbApp', {
  call: (req) => {
    const out = { id: req.id, server: req.server, method: req.method, path: req.path };
    if (req.body !== undefined) out.body = req.body;
    return ipcRenderer.invoke('aiwb:call', out);
  },
  cancel: (id) => ipcRenderer.send('aiwb:cancel', { id }),
  stream: (open) => ipcRenderer.invoke('aiwb:stream', { open: open === true }),
  onEvents: (cb) => listen('aiwb:events', cb),
  onStreamState: (cb) => listen('aiwb:stream-state', cb),
  app: (op, args) => ipcRenderer.invoke('aiwb:app', { op, args }),
  pickImages: () => ipcRenderer.invoke('aiwb:pick-images'),
});
