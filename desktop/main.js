// Electron main process. The app is the client of every server, this computer's included: it holds
// the server list and the secrets, keeps one pinned HTTPS connection per server (@aiwb/conn) and
// answers the page over IPC (ipcface.js) and, for pictures, over the aiwb-picture scheme. The page
// is a file of the app, loaded at once; it waits for no server. This computer's server is the Go
// program: `ai-whiteboard launch` finds the running one or starts one detached (its own session),
// so the server is never a child of this app, and quitting the app never stops it.

const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, dialog, ipcMain, protocol, session, shell, systemPreferences } = require('electron');
const windowStateKeeper = require('electron-window-state');
const { createNodeClient: createClient, parseAppWaits } = require('@aiwb/conn/node');
const { createIpcFace } = require('./ipcface');
const { makePermissionHandler } = require('./voice');
const {
  serverBin,
  pagePath,
  attachLinkHandlers,
  attachCloseFlush,
  watchBlankPage,
  pictureAllowed,
  makePictureResponse,
  PICTURE_SCHEME,
} = require('./lib');

// Tests run the app with its own user data folder, so that it takes no part in the single-instance
// lock of the user's own app and touches none of its files.
if (process.env.AIWB_USER_DATA) app.setPath('userData', process.env.AIWB_USER_DATA);

// The scheme must be registered before the app is ready. It answers pictures and nothing else.
protocol.registerSchemesAsPrivileged([
  { scheme: PICTURE_SCHEME, privileges: { standard: true, secure: true } },
]);

const bin = serverBin({
  env: process.env,
  execPath: process.execPath,
  isPackaged: app.isPackaged,
  dirname: __dirname,
});
const page = pagePath({
  env: process.env,
  resourcesPath: process.resourcesPath,
  isPackaged: app.isPackaged,
  dirname: __dirname,
});
const pageURL = pathToFileURL(page).href;
const dataFolder = process.env.AIWB_HOME || path.join(os.homedir(), '.ai-whiteboard');

let mainWindow = null;
let windowState = null;
let client = null;
let face = null;

// createWindow makes the main window and loads the page. The window shows once the page can be
// drawn; no server is waited for.
function createWindow() {
  if (!windowState) windowState = windowStateKeeper({ defaultWidth: 1280, defaultHeight: 800 });
  const win = new BrowserWindow({
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
  mainWindow = win;
  windowState.manage(win);
  attachLinkHandlers(win.webContents, shell).setPageURL(pageURL);
  attachCloseFlush({ app, win, dialog });
  watchBlankPage({ webContents: win.webContents, dialog });
  face.watchWindow(win);
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });
  win.webContents.on('did-fail-load', (_event, code, desc, url, isMainFrame) => {
    // -3 is a load that was cancelled by another one.
    if (isMainFrame && code !== -3) dialog.showErrorBox('AI Whiteboard', `The page could not be loaded: ${desc}\n${url}`);
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  win.loadFile(page);
}

// showWindow brings the open window forward, or makes one (macOS keeps the app running with none).
function showWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function start() {
  let timing;
  try {
    timing = parseAppWaits(process.env.AIWB_APP_WAITS);
  } catch (err) {
    dialog.showErrorBox('AI Whiteboard', `AIWB_APP_WAITS: ${err.message}`);
    app.exit(1);
    return;
  }
  client = createClient({
    stateDir: path.join(app.getPath('userData'), 'client'),
    local: { bin, home: process.env.AIWB_HOME || null, env: process.env },
    timing,
    log: (line) => console.log(`[conn] ${line}`),
  });
  face = createIpcFace({
    ipcMain,
    client,
    getWindow: () => mainWindow,
    pageURL,
    shell,
    dialog,
    home: dataFolder,
    // The voice service's calls and the microphone (voice.js); the key file is in the same folder as the server list.
    voice: { app, systemPreferences, userData: app.getPath('userData'), env: process.env },
  });

  const ses = session.defaultSession;
  // The microphone (audio only) for the app's own page; any other camera or microphone request is refused, and every other
  // permission is answered as Electron does with no handler.
  ses.setPermissionRequestHandler(makePermissionHandler({ getWindow: () => mainWindow, pageURL }));
  // protocol.handle is given no frame, so the check of who asks is made here, before the request
  // reaches the handler.
  ses.webRequest.onBeforeRequest({ urls: [`${PICTURE_SCHEME}://*/*`] }, (details, callback) => {
    callback({ cancel: !pictureAllowed({ details, win: mainWindow, pageURL }) });
  });
  ses.protocol.handle(PICTURE_SCHEME, makePictureResponse(client));

  createWindow();
  // macOS: clicking the Dock icon with no window open makes one.
  app.on('activate', () => {
    if (!mainWindow) createWindow();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(start);

  // macOS convention: closing the last window keeps the app running; Cmd+Q quits it. The server
  // keeps running either way.
  app.on('window-all-closed', () => {});

  // will-quit comes only when the quit goes through (the unsaved-changes dialog can still cancel it
  // before). The connections end; no server is stopped.
  app.on('will-quit', () => {
    if (face) face.close();
    if (client) client.close();
  });
}
