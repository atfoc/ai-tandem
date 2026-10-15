// Pure helpers for the Electron main process. Nothing here imports electron, so `node --test` can
// load this file.

const path = require('node:path');
const fsPromises = require('node:fs/promises');

// serverBin is the Go program the app runs for this computer's server: AIWB_SERVER_BIN when set; in a
// packaged app the ai-whiteboard next to the Electron executable (X.app/Contents/MacOS); with
// `npm start`, the one that `go build -o bin/ai-whiteboard` makes in the repository.
function serverBin({ env, execPath, isPackaged, dirname }) {
  if (env.AIWB_SERVER_BIN) return env.AIWB_SERVER_BIN;
  if (isPackaged) return path.join(path.dirname(execPath), 'ai-whiteboard');
  return path.resolve(dirname, '../bin/ai-whiteboard');
}

// pagePath is the page's file: AIWB_PAGE when set (tests: another build's index.html);
// in a packaged app web/index.html in the app's resources (the app's web build, app/dist-web); with `npm start`, the
// app/dist-web/index.html that `npm run build:web` makes in app/ (AD-41).
function pagePath({ env, resourcesPath, isPackaged, dirname }) {
  if (env.AIWB_PAGE) return path.resolve(env.AIWB_PAGE);
  if (isPackaged) return path.join(resourcesPath, 'web', 'index.html');
  return path.resolve(dirname, '../app/dist-web/index.html');
}

// serverLogPath is where the detached server writes its output, in the data folder home.
function serverLogPath(home) {
  return path.join(home, 'server.log');
}

// withoutHash is url as a string without its fragment; null when it is not a URL.
function withoutHash(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

// atPage says whether url is the page's own URL, whatever its hash. The page is a file, so no origin
// tells it from another file.
function atPage(url, pageURL) {
  const page = withoutHash(pageURL);
  return page !== null && withoutHash(url) === page;
}

// linkAction decides what happens to a link the app window would follow or open, given the page's
// URL:
//
//   - 'stay': the page's own URL, with any hash; the window may navigate to it.
//   - 'open': an http, https or mailto URL; it goes to the default browser.
//   - 'drop': anything else (file:, javascript:, data:, aiwb-picture:, …) and unparsable URLs.
function linkAction(url, pageURL) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return 'drop';
  }
  if (atPage(url, pageURL)) return 'stay';
  if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') return 'open';
  return 'drop';
}

// attachLinkHandlers keeps a main window on the page. window.open (chat links, links on whiteboard
// elements) never opens an app window: allowed URLs go to shell.openExternal, the user's default
// browser. A navigation to anything but the page is prevented and, when allowed, opened there too.
// Call setPageURL with the page's URL before the window loads it.
function attachLinkHandlers(webContents, shell) {
  let pageURL = null;
  const openOutside = (url) => {
    if (linkAction(url, pageURL) !== 'drop') shell.openExternal(url);
  };
  webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });
  webContents.on('will-navigate', (event, url) => {
    if (linkAction(url, pageURL) === 'stay') return;
    event.preventDefault();
    openOutside(url);
  });
  return {
    setPageURL(url) {
      pageURL = url;
    },
  };
}

const FLUSH_TIMEOUT_MS = 10_000;

// quitStates holds, per app, whether a quit (Cmd+Q) is under way. Its before-quit listener is
// registered once per app, however many windows attachCloseFlush is called for.
const quitStates = new WeakMap();

function quitState(app) {
  let state = quitStates.get(app);
  if (!state) {
    state = { quitting: false };
    quitStates.set(app, state);
    app.on('before-quit', () => {
      state.quitting = true;
    });
  }
  return state;
}

// flushed resolves to true once window.aiwbFlush() in win's page resolves true (every board is
// written), and to false when it resolves anything else, rejects, or takes longer than timeoutMs.
function flushed(win, timeoutMs) {
  let done;
  try {
    done = win.webContents.executeJavaScript('window.aiwbFlush ? window.aiwbFlush() : false', true);
  } catch (e) {
    done = Promise.reject(e);
  }
  let timer;
  const timeout = new Promise((r) => {
    timer = setTimeout(() => r(false), timeoutMs);
  });
  return Promise.race([done, timeout])
    .then((v) => v === true, () => false)
    .finally(() => clearTimeout(timer));
}

// attachCloseFlush makes closing, quitting or reloading win wait for the page's board saves. When
// saves are pending, the page's beforeunload calls preventDefault; Electron then cancels the close,
// Cmd+Q or reload silently and fires will-prevent-unload. On that event the action stays cancelled
// while window.aiwbFlush() runs; once it resolves true the same action is done again (win.close(),
// app.quit() or reload), and this time nothing is pending. When the flush does not finish within
// flushTimeoutMs (server down), a dialog asks whether to close anyway; "Close anyway" lets the next
// will-prevent-unload through. When "Cancel" is picked the action is dropped and win stays open.
// With no pending saves none of this runs. Nothing here touches the server.
function attachCloseFlush({ app, win, dialog, flushTimeoutMs = FLUSH_TIMEOUT_MS }) {
  const quit = quitState(app);
  let closing = false;
  let force = false;
  win.on('close', () => {
    closing = true; // fires before beforeunload
  });
  win.webContents.on('will-prevent-unload', async (e) => {
    if (force) {
      force = false;
      e.preventDefault(); // preventDefault = unload anyway
      return;
    }
    const wasClosing = closing;
    const wasQuitting = quit.quitting;
    closing = false; // the close/quit was cancelled
    quit.quitting = false;
    if (!(await flushed(win, flushTimeoutMs))) {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        message: 'Board changes are not saved.',
        detail: 'The server did not answer. Close anyway and lose them?',
        buttons: ['Cancel', 'Close anyway'],
        defaultId: 0,
        cancelId: 0,
      });
      if (response !== 1) return;
      force = true;
    }
    if (wasQuitting) app.quit();
    else if (wasClosing) win.close();
    else win.webContents.reload();
  });
}

const BLANK_PAGE_WAIT_MS = 10_000;

// watchBlankPage reports a page that loaded and did not start (AD-41). A page whose script is
// missing or fails fires did-finish-load all the same, and did-fail-load never: the window would stay
// empty and say nothing. The page sets window.aiwbReady = true once it has drawn; waitMs after
// did-finish-load, if that is not so, the error dialog says which page it was. A new load starts the
// wait again, and a window that is gone ends it. It returns { stop }.
function watchBlankPage({ webContents, dialog, waitMs = BLANK_PAGE_WAIT_MS }) {
  let timer = null;
  const stop = () => {
    clearTimeout(timer);
    timer = null;
  };
  const check = async () => {
    timer = null;
    if (webContents.isDestroyed()) return;
    let ready = false;
    try {
      ready = (await webContents.executeJavaScript('window.aiwbReady === true', true)) === true;
    } catch {
      // The page went away between the timer and the question: another load will start the wait again.
      return;
    }
    if (ready || webContents.isDestroyed()) return;
    dialog.showErrorBox(
      'AI Whiteboard',
      `The page loaded but did not start (it was not ready ${waitMs / 1000} seconds after loading).\n${webContents.getURL()}`,
    );
  };
  webContents.on('did-start-loading', stop);
  webContents.on('did-finish-load', () => {
    stop();
    timer = setTimeout(check, waitMs);
  });
  webContents.on('destroyed', stop);
  return { stop };
}

// The limits on the images of a chat message, as the server has them (model.ImageMaxBytes and
// model.ImagesPerMessage), and the types taken, by file extension.
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const IMAGES_PER_MESSAGE = 10;
const IMAGE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

// imageType is the MIME type a file name's extension stands for, or null when it is not one of
// IMAGE_TYPES.
function imageType(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  return Object.hasOwn(IMAGE_TYPES, ext) ? IMAGE_TYPES[ext] : null;
}

// fromAppWindow says whether an IPC call (event is what ipcMain hands its handler) comes from the
// main frame of win, the app's main window, while that frame is on the page, pageURL (a hash does
// not matter). False for another window, a frame inside the page, a frame that is gone or has
// navigated since the call, another page, and when there is no window or no URL.
function fromAppWindow({ event, win, pageURL }) {
  if (!win || win.isDestroyed() || !pageURL) return false;
  const frame = event.senderFrame;
  if (!frame || event.sender !== win.webContents || frame !== win.webContents.mainFrame) return false;
  return atPage(frame.url, pageURL);
}

// pictureAllowed says whether a request for an address of the picture scheme (details is what
// session.webRequest.onBeforeRequest hands its listener) comes from the main frame of win while
// that frame is on the page. protocol.handle gets no frame, so this is where an iframe, another
// window or a page that has gone elsewhere is turned away.
function pictureAllowed({ details, win, pageURL }) {
  if (!win || win.isDestroyed() || !pageURL) return false;
  const frame = details.frame;
  if (!frame || details.webContentsId !== win.webContents.id || frame !== win.webContents.mainFrame) return false;
  return atPage(frame.url, pageURL);
}

const PICTURE_SCHEME = 'aiwb-picture';
const PICTURE_ENTRY = /^(local|s_[0-9a-f]{12})$/;
const PICTURE_CHAT = /^[A-Za-z0-9_-]{1,100}$/;
const PICTURE_IMAGE = /^[0-9a-f]{64}$/;

// parsePictureURL reads aiwb-picture://p/<entry>/<chat>/<image> into { server, chat, image }, or
// null when the address is anything else: another host, a missing or an extra segment, a query, a
// segment that is no entry id, chat id or image id.
function parsePictureURL(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${PICTURE_SCHEME}:` || u.host !== 'p' || u.search !== '' || u.username || u.password) return null;
  const parts = u.pathname.split('/');
  if (parts.length !== 4 || parts[0] !== '') return null;
  let server, chat, image;
  try {
    [server, chat, image] = parts.slice(1).map(decodeURIComponent);
  } catch {
    return null;
  }
  if (!PICTURE_ENTRY.test(server) || !PICTURE_CHAT.test(chat) || !PICTURE_IMAGE.test(image)) return null;
  return { server, chat, image };
}

// makePictureResponse makes what the scheme answers a picture's address: the bytes the connection
// module has looked at, or the status it could not give them with and no body. client is the
// connection module's client; main.js hands the result to protocol.handle.
function makePictureResponse(client) {
  return async function pictureResponse(request) {
    const want = parsePictureURL(request.url);
    if (request.method !== 'GET' || !want) return new Response(null, { status: 400 });
    const a = await client.picture({ ...want, signal: request.signal });
    if (!a.ok) {
      const status = Number.isInteger(a.status) && a.status >= 400 && a.status <= 599 ? a.status : 502;
      return new Response(null, { status });
    }
    return new Response(a.data, {
      headers: {
        'Content-Type': a.type,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=31536000, immutable',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    });
  };
}

// readUpTo reads the file open as handle to its end and resolves to its bytes, or to null once it
// has more than maxBytes: no more than maxBytes + 1 bytes are ever read.
async function readUpTo(handle, maxBytes) {
  const chunks = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(Math.min(1 << 20, maxBytes + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
    if (total > maxBytes) return null;
  }
  // A Uint8Array on a buffer of its own, which is what crosses to the page.
  const data = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    data.set(chunk, at);
    at += chunk.length;
  }
  return data;
}

// readImage reads the image file at filePath and resolves to { data } with its bytes, or to
// { reason } when it is left out: 'size' when it is over maxBytes (seen from its size, or while
// reading when it grew since), 'read' when it is not a file or cannot be opened or read.
async function readImage({ fs, filePath, maxBytes }) {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) return { reason: 'read' };
    if (stat.size > maxBytes) return { reason: 'size' };
    const data = await readUpTo(handle, maxBytes);
    return data ? { data } : { reason: 'size' };
  } catch {
    return { reason: 'read' };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

// pickImages answers the page's pickImages() (the bridge's, preload.js): it opens the app's own open
// dialog on win for several image files and resolves to
//
//   { files: [{ name, type, data }], skipped: [{ name, reason }] }
//
// in the order the dialog gave them. name is the file's base name, never its path; type is the MIME
// type its extension stands for (the server finds the real one from the bytes); data is a
// Uint8Array. A cancelled dialog answers both lists empty.
//
// The only files read are those the dialog returned: the call carries no argument, so the page
// names no path. A call that fromAppWindow does not accept is refused (it rejects) before the
// dialog opens, and again after it, when the page went away while the dialog was open: nothing is
// read then.
//
// A file is left out, and named in skipped with the reason, in this order:
//
//   - 'type': its extension is none of IMAGE_TYPES. Not opened.
//   - 'count': maxFiles files are in the answer already. Not opened.
//   - 'read': it is not a file, or cannot be opened or read.
//   - 'size': it is over maxBytes. Its bytes are not read.
async function pickImages({
  event, win, pageURL, dialog,
  fs = fsPromises,
  maxBytes = IMAGE_MAX_BYTES,
  maxFiles = IMAGES_PER_MESSAGE,
}) {
  const refuse = () => {
    throw new Error('pickImages: the call is not from the app window');
  };
  if (!fromAppWindow({ event, win, pageURL })) refuse();
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Add images',
    buttonLabel: 'Add',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: Object.keys(IMAGE_TYPES) }],
  });
  const files = [];
  const skipped = [];
  if (canceled || !filePaths || filePaths.length === 0) return { files, skipped };
  if (!fromAppWindow({ event, win, pageURL })) refuse();
  for (const filePath of filePaths) {
    const name = path.basename(filePath);
    const type = imageType(name);
    if (!type) {
      skipped.push({ name, reason: 'type' });
      continue;
    }
    if (files.length >= maxFiles) {
      skipped.push({ name, reason: 'count' });
      continue;
    }
    const { data, reason } = await readImage({ fs, filePath, maxBytes });
    if (reason) skipped.push({ name, reason });
    else files.push({ name, type, data });
  }
  return { files, skipped };
}

module.exports = {
  serverBin,
  pagePath,
  serverLogPath,
  withoutHash,
  atPage,
  linkAction,
  attachLinkHandlers,
  FLUSH_TIMEOUT_MS,
  attachCloseFlush,
  BLANK_PAGE_WAIT_MS,
  watchBlankPage,
  IMAGE_MAX_BYTES,
  IMAGES_PER_MESSAGE,
  IMAGE_TYPES,
  imageType,
  fromAppWindow,
  pictureAllowed,
  PICTURE_SCHEME,
  parsePictureURL,
  makePictureResponse,
  pickImages,
};
