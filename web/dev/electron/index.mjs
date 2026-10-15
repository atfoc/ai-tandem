// A Playwright that draws in the desktop app's own Chromium. web/dev/shot.mjs takes its Playwright from the folder named by
// PLAYWRIGHT (the first it finds with an index.mjs); with PLAYWRIGHT=web/dev/electron, `chromium.launch()` starts Electron (the one
// of desktop/node_modules, or AIWB_ELECTRON) through Playwright's `_electron`, and each context a check makes opens its pages as
// windows of that Electron; everything else is the real Playwright's (AIWB_REAL_PLAYWRIGHT: its folder; web/node_modules/playwright
// when unset). The checks then run their pages in Electron's Chromium instead of Playwright's, so a difference between the two shows
// (the desktop renders with Electron's Chromium, a few versions older than the checks': the parity report, "For D2 and R1").
// Run it with `cd web && npm run uicheck:electron` (web/dev/uicheck-electron.mjs).
//
// What it is: the browser only. The page is served by the check's mock over HTTP, with no preload, no bridge and no app window
// (desktop/e2e/app.e2e.mjs is that); a window opens for each page, and the last line of the summary names this Chromium.
// Why windows: Electron over CDP makes no browser context and no target (`Target.createBrowserContext` and `Target.createTarget`
// fail), so a page can only be a BrowserWindow that the main process opens.
// Known: `A6.3-markdown` (a page for each theme and stage, one after the other, each with a clock and the still style) fails here, its
// `goto` is aborted by a window that is gone (a race of this shim's windows that was not found: 84 of the 85 checks of dev/checks pass).
// What it does not do: a context here is a name for its windows.
//   - The viewport is the window's content size; `isMobile`, touch and a device scale factor are not emulated (the desktop app has a
//     mouse), so the desktop viewport is the faithful one.
//   - The init scripts of a context belong to its own pages, and the profile's storage is cleared at each new context.
//   - One Electron context holds every window's clock: a clock set in one context stays set in the next ones of the run (the three
//     checks that set one set the same time).
//   - `route`, `grantPermissions` and `newCDPSession` are the Electron session's, shared by all windows.
//   - The windows are not throttled (`backgroundThrottling: false`): an unfocused window is, and a check that waits for frames then
//     fails by the machine's focus, not the browser.
//   - A page that prevents its unload is let go (main.cjs: Electron shows no dialog, the app answers `will-prevent-unload` itself).
// Known: `A6.3-markdown` (a page for each theme and stage, one after the other, each with a clock and the still style) fails here: its
// `goto` is aborted because the window is gone, a race of this shim's windows that was not found. The other 84 checks of
// dev/checks pass in Electron 44's Chromium (152) (in the last full run P0.4 timed out a click once; it passes alone).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, "../..");
const realDir = process.env.AIWB_REAL_PLAYWRIGHT || path.join(web, "node_modules/playwright");
if (!fs.existsSync(path.join(realDir, "index.mjs"))) throw new Error(`no Playwright in ${realDir}: install it in web/ (AGENTS.md) or set AIWB_REAL_PLAYWRIGHT`);
const pw = await import(pathToFileURL(path.join(realDir, "index.mjs")).href);

function electronPath() {
  if (process.env.AIWB_ELECTRON) return process.env.AIWB_ELECTRON;
  try { return createRequire(path.join(web, "../desktop/package.json"))("electron"); }
  catch { throw new Error("no Electron: run `cd desktop && npm install` (and `node node_modules/electron/install.js` if its binary is missing), or set AIWB_ELECTRON"); }
}

/** A context: opens its pages as windows of `eapp`, and carries its own init scripts. The rest is the Electron context's.
 *  Every window of the app shares one profile, and a context of Playwright starts with none of another's storage, so the
 *  profile's storage is cleared when a context is made (the page of the round before has been closed by then). */
async function context(eapp, options) {
  await eapp.evaluate(({ session }) => session.defaultSession.clearStorageData());
  const real = eapp.context();
  const pages = [], scripts = [];
  let wrapper;
  // (the windows of this context: the ones it opened, and the popups of those, a link's new window)
  const track = (page) => {
    page.context = () => wrapper; // (the real one's `close` ends the whole app)
    pages.push(page);
    page.on("close", () => { pages.splice(pages.indexOf(page), 1); });
    page.on("popup", track);
  };
  const open = async () => {
    const { width, height } = options.viewport ?? { width: 1280, height: 800 };
    const win = eapp.waitForEvent("window");
    await eapp.evaluate(async ({ BrowserWindow }, [w, h]) => { await new BrowserWindow({ width: w, height: h, useContentSize: true, show: true, webPreferences: { backgroundThrottling: false } }).loadURL("about:blank"); }, [width, height]); // (the first load ends before the check navigates: a goto in the middle of it is aborted)
    const page = await win;
    // (a new document: the init scripts that the Electron context already holds, a clock's among them, run in it; the window's first
    // blank page was made before Playwright held it, and a clock set in a context after the first one's needs them in the page)
    await page.goto("data:text/html,");
    let size = { width, height };
    const handle = await eapp.browserWindow(page);
    page.viewportSize = () => size;
    page.setViewportSize = async (s) => { size = { ...s }; await handle.evaluate((w, [a, b]) => w.setContentSize(a, b), [s.width, s.height]); };
    for (const [fn, arg] of scripts) await page.addInitScript(fn, arg);
    track(page);
    return page;
  };
  const own = {
    newPage: open,
    pages: () => [...pages],
    addInitScript: async (fn, arg) => { scripts.push([fn, arg]); for (const p of pages) await p.addInitScript(fn, arg); },
    close: async () => { for (const p of [...pages]) await p.close().catch(() => {}); },
  };
  return (wrapper = new Proxy(real, { get(t, k) { if (k in own) return own[k]; const v = t[k]; return typeof v === "function" ? v.bind(t) : v; } }));
}

async function launch() {
  const data = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "aiwb-electron-check-"));
  const env = { ...process.env, AIWB_ESHIM_DATA: data };
  delete env.ELECTRON_RUN_AS_NODE;
  const eapp = await pw._electron.launch({ executablePath: electronPath(), args: [path.join(here, "main.cjs")], env, timeout: 60000 });
  const chrome = await eapp.evaluate(() => process.versions.chrome);
  return {
    version: () => chrome,
    contexts: () => [eapp.context()],
    newContext: async (options = {}) => context(eapp, options),
    newPage: async (options = {}) => (await context(eapp, options)).newPage(),
    close: async () => { try { await eapp.close(); } finally { fs.rmSync(data, { recursive: true, force: true }); } },
  };
}

export const chromium = new Proxy(pw.chromium, { get(t, k) { if (k === "launch") return launch; const v = t[k]; return typeof v === "function" ? v.bind(t) : v; } });
export const devices = pw.devices;
export default { ...pw, chromium };
