// Electron main process. The server is the Go program: `ai-whiteboard launch` finds the running
// server or starts one detached (its own session), prints its URL and exits. So the server is never
// a child of this app, and quitting the app never stops it.

const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const windowStateKeeper = require('electron-window-state');
const {
  serverBin,
  launchArgs,
  serverLogPath,
  createStartUp,
  findServer,
  checkServer,
  createReconnector,
  attachLinkHandlers,
  attachCloseFlush,
  resumeAfterCancelledQuit,
} = require('./lib');

const logPath = serverLogPath(os.homedir());

let mainWindow = null;
let mainLinks = null; // attachLinkHandlers for mainWindow
let mainURL = null; // the server URL mainWindow last loaded
let startingWindow = null;
let windowState = null;
let quitting = false;

const bin = serverBin({
  env: process.env,
  execPath: process.execPath,
  isPackaged: app.isPackaged,
  dirname: __dirname,
});
const args = launchArgs({ isPackaged: app.isPackaged, dirname: __dirname });

function showStarting() {
  if (startingWindow) return;
  startingWindow = new BrowserWindow({
    width: 320,
    height: 120,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'AI Whiteboard',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const win = startingWindow;
  win.on('closed', () => {
    if (startingWindow === win) startingWindow = null;
  });
  const html = `<!doctype html><meta charset="utf-8"><title>AI Whiteboard</title>
<style>
  :root { color-scheme: light dark; }
  html, body { height: 100%; margin: 0; }
  body { display: flex; align-items: center; justify-content: center;
         font: 15px -apple-system, BlinkMacSystemFont, sans-serif; user-select: none; }
</style>
<body>Starting…</body>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

function hideStarting() {
  const win = startingWindow;
  startingWindow = null;
  if (win && !win.isDestroyed()) win.close();
}

// loadURL loads url in the main window, created hidden if there is none, and shows the window once
// the page has loaded.
async function loadURL(url) {
  if (!mainWindow) {
    if (!windowState) windowState = windowStateKeeper({ defaultWidth: 1280, defaultHeight: 800 });
    mainWindow = new BrowserWindow({
      x: windowState.x,
      y: windowState.y,
      width: windowState.width,
      height: windowState.height,
      show: false,
      title: 'AI Whiteboard',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, 'preload.js'),
      },
    });
    windowState.manage(mainWindow);
    mainLinks = attachLinkHandlers(mainWindow.webContents, shell);
    attachCloseFlush({ app, win: mainWindow, dialog, onQuitCancelled });
    mainWindow.webContents.on('did-fail-load', (_event, code, _desc, _url, isMainFrame) => {
      if (isMainFrame) reconnector.failLoad(code);
    });
    mainWindow.on('closed', () => {
      mainWindow = null;
      mainLinks = null;
      mainURL = null;
      reconnector.stop();
    });
  }
  const win = mainWindow;
  mainLinks.setAppURL(url);
  mainURL = url;
  await win.loadURL(url);
  if (!win.isDestroyed()) win.show();
}

// reloadURL loads url in the open main window without showing or focusing it; the reconnector uses
// it after running launch again.
async function reloadURL(url) {
  const win = mainWindow;
  if (!win || win.isDestroyed()) throw new Error('no main window');
  mainLinks.setAppURL(url);
  mainURL = url;
  await win.loadURL(url);
}

// The reconnector checks the server while the main window is open and, when it stays down or the
// page fails to load, runs launch again (restarting a crashed server) and reloads. No dialog: the
// page already shows that it is disconnected.
const reconnector = createReconnector({
  check: (url) => checkServer({ fetch, url }),
  launch: () => findServer({ env: process.env, bin, args, execFile }),
  load: reloadURL,
  setTimeout,
  clearTimeout,
});

// onQuitCancelled runs when the user cancels a quit in the unsaved-changes dialog: the app stays
// open, so it is no longer quitting and the reconnector (stopped by before-quit) checks the main
// window's server again.
function onQuitCancelled() {
  quitting = false;
  resumeAfterCancelledQuit({ win: mainWindow, url: mainURL, reconnector });
}

// showError shows the start error until the user picks Retry or Quit. Open server log opens
// ~/.ai-whiteboard/server.log and asks again.
async function showError(detail) {
  for (;;) {
    const { response } = await dialog.showMessageBox({
      type: 'error',
      message: 'AI Whiteboard could not start its server',
      detail,
      buttons: ['Retry', 'Open server log', 'Quit'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (response === 0) return 'retry';
    if (response === 1) {
      await shell.openPath(logPath);
      continue;
    }
    return 'quit';
  }
}

const startUp = createStartUp({
  env: process.env,
  bin,
  args,
  execFile,
  showStarting,
  hideStarting,
  loadURL: async (url) => {
    await loadURL(url);
    if (!quitting && mainWindow) reconnector.start(url);
  },
  showError,
  quit: () => app.quit(),
  isQuitting: () => quitting,
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) {
      startUp();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  ipcMain.handle('aiwb:open-server-log', () => shell.openPath(logPath));

  app.whenReady().then(() => {
    startUp();
    // macOS: clicking the Dock icon with no window open runs the start-up again.
    app.on('activate', () => {
      if (!mainWindow) startUp();
    });
  });

  // macOS convention: closing the last window keeps the app running; Cmd+Q quits it. The server
  // keeps running either way.
  app.on('window-all-closed', () => {});

  app.on('before-quit', () => {
    quitting = true;
    reconnector.stop();
  });
}
