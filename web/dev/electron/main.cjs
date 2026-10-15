// The main process of the Electron that web/dev/electron/index.mjs starts: no window of its own, no page, nothing of the
// app (desktop/main.js is not loaded). It stays up while the shim, through Playwright's `_electron`, opens a window for each page
// a check asks for; its Chromium is the desktop app's. Its own user data folder (AIWB_ESHIM_DATA, a temporary one) keeps it
// clear of every real app's files.
const { app } = require("electron");
if (process.env.AIWB_ESHIM_DATA) app.setPath("userData", process.env.AIWB_ESHIM_DATA);
app.on("window-all-closed", () => {});
// Electron shows no "Leave this page?" dialog: a page that prevents its unload is cancelled silently, and `will-prevent-unload` is the
// only sign (the desktop app answers it itself, desktop/lib.js attachCloseFlush). Here the unload goes on, so a check that reloads a page
// that asked is not left waiting; what the check asserts of the browser's dialog is not Electron's to show.
app.on("browser-window-created", (_e, win) => { win.webContents.on("will-prevent-unload", (e) => e.preventDefault()); });
