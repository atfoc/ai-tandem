// The only API the app window gives the web client: open ~/.ai-whiteboard/server.log (the update
// banner's Open log button uses it when present).

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aiwbDesktop', {
  openServerLog: () => ipcRenderer.invoke('aiwb:open-server-log'),
});
