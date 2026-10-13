// The API the app window gives the web client:
//
//   - openServerLog(): open ~/.ai-whiteboard/server.log (the update banner's Open log button uses
//     it when present).
//   - pickImages(): the app's own open dialog for image files (the composer's attach button).
//     Resolves to { files: [{ name, type, data: Uint8Array }], skipped: [{ name, reason }] }; see
//     pickImages in lib.js. It takes no argument: the page names no path.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aiwbDesktop', {
  openServerLog: () => ipcRenderer.invoke('aiwb:open-server-log'),
  pickImages: () => ipcRenderer.invoke('aiwb:pick-images'),
});
