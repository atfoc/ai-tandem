// `cd web && npm run uicheck:electron [-- <checks>]`: the browser checks of the app (dev/checks, on the mock) with the pages
// drawn by the desktop app's own Chromium (Electron, desktop/node_modules) instead of Playwright's. The desktop app renders with
// Electron's Chromium, and the checks otherwise run on the Chromium of the Playwright they find, so this is where a difference
// between the two would show (dev/electron/index.mjs says how). It is `node dev/uicheck.mjs <checks>` with
// PLAYWRIGHT=dev/electron: the same arguments, limits and build (`DIST`, `PORT`, `LIMIT` as dev/uicheck.mjs lists them). The summary's last
// line names the Chromium: Electron 44's is 152. With no check named it runs L8 (the stream check, the one found to depend on
// the browser's version); `--all` runs every check (about an hour). A check alone: `PLAYWRIGHT=web/dev/electron node web/dev/checks/L8-stream.mjs`.
// It runs the desktop viewport (VIEWPORT=desktop, unless VIEWPORT is set): only that one is the desktop app's. The phone and the tablet
// ones are a window of their size with no touch and no device scale factor (dev/electron/index.mjs), and a check that does not list
// the desktop viewport then names the viewports it has.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const all = args.includes("--all");
const checks = args.filter((a) => a !== "--all");
const real = process.env.AIWB_REAL_PLAYWRIGHT || process.env.PLAYWRIGHT;
const env = { VIEWPORT: "desktop", ...process.env, PLAYWRIGHT: path.join(here, "electron") };
if (real) env.AIWB_REAL_PLAYWRIGHT = path.resolve(real);
const p = spawn(process.execPath, [path.join(here, "uicheck.mjs"), ...(all ? [] : checks.length ? checks : ["L8"])], { env, stdio: "inherit" });
for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => p.kill(s));
p.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
