// Pure helpers for the Electron main process. Nothing here imports electron, so `node --test` can
// load this file.

const path = require('node:path');

const LAUNCH_TIMEOUT_MS = 40_000;

// serverBin is the Go program to run `launch` with: AIWB_SERVER_BIN when set; in a packaged app the
// ai-whiteboard next to the Electron executable (X.app/Contents/MacOS); with `npm start`, the one
// that `go build -o bin/ai-whiteboard` makes in the repository.
function serverBin({ env, execPath, isPackaged, dirname }) {
  if (env.AIWB_SERVER_BIN) return env.AIWB_SERVER_BIN;
  if (isPackaged) return path.join(path.dirname(execPath), 'ai-whiteboard');
  return path.resolve(dirname, '../bin/ai-whiteboard');
}

// launchArgs are the arguments for serverBin. An unbundled binary serves web/dist relative to its
// working folder, which for the detached server is the home folder, so in development the built
// web client is passed as an absolute path.
function launchArgs({ isPackaged, dirname }) {
  if (isPackaged) return ['launch'];
  return ['launch', '-client', path.resolve(dirname, '../web/dist')];
}

// parseLaunchOutput returns the server URL that `launch` printed as its only line, or throws when
// the output is anything else.
function parseLaunchOutput(stdout) {
  const text = String(stdout ?? '').trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    url = null;
  }
  if (!url || !/^https?:$/.test(url.protocol) || /\s/.test(text)) {
    throw new Error(`ai-whiteboard launch printed no server URL: ${JSON.stringify(text)}`);
  }
  return text;
}

// serverLogPath is where the detached server writes its output.
function serverLogPath(homedir) {
  return path.join(homedir, '.ai-whiteboard', 'server.log');
}

// errorDetail is the text for the start error dialog: launch's stderr, or the error's message when
// stderr is empty.
function errorDetail(err, stderr) {
  const text = String(stderr ?? '').trim();
  if (text) return text;
  return (err && err.message) || String(err);
}

// createStartUp returns start(), which finds or starts the server and loads it in the app window:
//
//   - AIWB_URL set: loads that URL, no launch.
//   - otherwise: shows Starting, runs `bin args` through execFile, loads the URL it printed, and
//     hides Starting once the page has loaded.
//   - on failure: hides Starting and awaits showError(detail), which resolves to 'retry' (run it
//     all again) or 'quit' (call quit).
//   - on failure while isQuitting() is true (the app is quitting, which aborts the load or kills
//     launch): hides Starting and resolves null, with no dialog, no retry and no second quit.
//
// Calls made while a start-up is running share it instead of starting a second one.
function createStartUp({
  env, bin, args, execFile, showStarting, hideStarting, loadURL, showError, quit,
  isQuitting = () => false,
}) {
  let running = null;

  async function attempt() {
    for (;;) {
      showStarting();
      try {
        const url = await findServer({ env, bin, args, execFile });
        await loadURL(url);
        hideStarting();
        return url;
      } catch (e) {
        hideStarting();
        if (isQuitting()) return null;
        const detail = e instanceof StartError ? e.message : errorDetail(e, '');
        const action = await showError(detail);
        if (action !== 'retry') {
          quit();
          return null;
        }
      }
    }
  }

  return function start() {
    if (!running) {
      running = attempt().finally(() => {
        running = null;
      });
    }
    return running;
  };
}

class StartError extends Error {}

// runLaunch runs `bin args` through execFile and resolves to the URL it printed, or rejects with a
// StartError whose message is launch's stderr (or the error's message).
function runLaunch({ bin, args, execFile }) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: LAUNCH_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        reject(new StartError(errorDetail(err, stderr)));
        return;
      }
      try {
        resolve(parseLaunchOutput(stdout));
      } catch (e) {
        reject(new StartError(errorDetail(e, stderr)));
      }
    });
  });
}

// findServer resolves to the server URL the way start-up does: AIWB_URL when set, otherwise what
// `bin args` prints.
async function findServer({ env, bin, args, execFile }) {
  if (env.AIWB_URL) return env.AIWB_URL;
  return runLaunch({ bin, args, execFile });
}

const CHECK_INTERVAL_MS = 2_000;
const CHECK_TIMEOUT_MS = 1_000;
const CHECK_FAILURES = 3;
const RELAUNCH_RETRY_MS = 5_000;
const ERR_ABORTED = -3;

// checkServer resolves to true when GET <origin of url>/api/hello answers, within timeoutMs, with
// JSON whose app is "ai-whiteboard"; to false on anything else. It never rejects.
async function checkServer({ fetch, url, timeoutMs = CHECK_TIMEOUT_MS }) {
  try {
    const res = await fetch(new URL('/api/hello', url).href, {
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const body = await res.json();
    return !!body && body.app === 'ai-whiteboard';
  } catch {
    return false;
  }
}

// createReconnector brings the main window back when the server goes away. Once start(url) is
// called (the main window has loaded url), it calls check(url) every intervalMs. After
// failuresToLaunch failed checks in a row, or at once on failLoad(code) for any code but -3 (an
// aborted load), it calls launch() and, when that resolves to a URL, load(url); the failure count
// resets. When launch or load fails it tries again retryMs later. A trigger while a launch runs is
// ignored, so launch never runs twice at once. stop() (no main window, or quitting) cancels every
// timer; nothing happens until start is called again.
//
// check resolves to a boolean; launch resolves to a URL or rejects; load resolves or rejects.
function createReconnector({
  check,
  launch,
  load,
  setTimeout,
  clearTimeout,
  intervalMs = CHECK_INTERVAL_MS,
  failuresToLaunch = CHECK_FAILURES,
  retryMs = RELAUNCH_RETRY_MS,
}) {
  let running = false;
  let url = null;
  let failures = 0;
  let timer = null;
  let launching = false;
  // generation changes on every start, stop and launch, so a check or launch that finishes after
  // one is dropped.
  let generation = 0;

  function clearTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function schedule(fn, ms) {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  }

  async function tick() {
    const gen = generation;
    let ok;
    try {
      ok = await check(url);
    } catch {
      ok = false;
    }
    if (gen !== generation || !running || launching) return;
    if (ok) {
      failures = 0;
    } else {
      failures++;
      if (failures >= failuresToLaunch) {
        relaunch();
        return;
      }
    }
    schedule(tick, intervalMs);
  }

  async function relaunch() {
    if (!running || launching) return;
    launching = true;
    clearTimer();
    failures = 0;
    const gen = ++generation; // drops a check still in flight
    let ok = false;
    try {
      const next = await launch();
      if (gen === generation && running) {
        url = next;
        await load(next);
        ok = true;
      }
    } catch {
      ok = false;
    }
    launching = false;
    if (!running) return;
    if (gen !== generation) {
      // Stopped and started again while launch ran: start's check was held back, so begin it now.
      schedule(tick, intervalMs);
      return;
    }
    failures = 0;
    schedule(ok ? tick : relaunch, ok ? intervalMs : retryMs);
  }

  return {
    // start begins (or keeps) checking url. While a launch runs it only records url.
    start(nextURL) {
      url = nextURL;
      if (running) return;
      running = true;
      generation++;
      failures = 0;
      if (!launching) schedule(tick, intervalMs);
    },
    stop() {
      if (!running) return;
      running = false;
      generation++;
      failures = 0;
      clearTimer();
    },
    // failLoad reports a did-fail-load of the main frame with its error code.
    failLoad(code) {
      if (code === ERR_ABORTED) return;
      relaunch();
    },
  };
}

// linkAction decides what happens to a link the app window would follow or open, given the origin
// of the server URL the window loaded:
//
//   - 'stay': an http(s) URL on the app's origin; the window may navigate to it.
//   - 'open': an http, https or mailto URL anywhere else; it goes to the default browser.
//   - 'drop': anything else (file:, javascript:, data:, …) and unparsable URLs.
function linkAction(url, appOrigin) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return 'drop';
  }
  const web = u.protocol === 'http:' || u.protocol === 'https:';
  if (web && appOrigin && u.origin === appOrigin) return 'stay';
  if (web || u.protocol === 'mailto:') return 'open';
  return 'drop';
}

// attachLinkHandlers keeps a main window on the server's origin. window.open (chat links,
// links on whiteboard elements) never opens an app window: allowed URLs go to shell.openExternal,
// the user's default browser. A navigation to another origin is prevented and, when allowed, opened
// there too. Call setAppURL with every server URL before the window loads it.
function attachLinkHandlers(webContents, shell) {
  let appOrigin = null;
  const openOutside = (url) => {
    if (linkAction(url, appOrigin) !== 'drop') shell.openExternal(url);
  };
  webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });
  webContents.on('will-navigate', (event, url) => {
    if (linkAction(url, appOrigin) === 'stay') return;
    event.preventDefault();
    openOutside(url);
  });
  return {
    setAppURL(url) {
      appOrigin = new URL(url).origin;
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
// will-prevent-unload through. When "Cancel" is picked for a quit (and no new quit has begun
// meanwhile), onQuitCancelled is called: the quit did not go through and win stays open. With no
// pending saves none of this runs. Nothing here touches the server.
function attachCloseFlush({ app, win, dialog, flushTimeoutMs = FLUSH_TIMEOUT_MS, onQuitCancelled }) {
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
      if (response !== 1) {
        if (wasQuitting && !quit.quitting && onQuitCancelled) onQuitCancelled();
        return;
      }
      force = true;
    }
    if (wasQuitting) app.quit();
    else if (wasClosing) win.close();
    else win.webContents.reload();
  });
}

// resumeAfterCancelledQuit restarts the reconnector after a cancelled quit (before-quit stopped
// it): when win is still open and has loaded url, it calls reconnector.start(url) and returns true;
// otherwise it does nothing and returns false.
function resumeAfterCancelledQuit({ win, url, reconnector }) {
  if (!win || win.isDestroyed() || !url) return false;
  reconnector.start(url);
  return true;
}

module.exports = {
  LAUNCH_TIMEOUT_MS,
  serverBin,
  launchArgs,
  parseLaunchOutput,
  serverLogPath,
  errorDetail,
  createStartUp,
  runLaunch,
  findServer,
  CHECK_INTERVAL_MS,
  CHECK_TIMEOUT_MS,
  CHECK_FAILURES,
  RELAUNCH_RETRY_MS,
  checkServer,
  createReconnector,
  linkAction,
  attachLinkHandlers,
  FLUSH_TIMEOUT_MS,
  attachCloseFlush,
  resumeAfterCancelledQuit,
};
