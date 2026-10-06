// The version banner's side (logic/version.ts decides): compares the page's, the server's and the
// on-disk version on every connect, and runs "Restart server". The server only starts `relaunch`
// (stop + launch); the page then waits for a server with a new version and reloads.
import { api, ApiError } from "./api.ts";
import { getState, setState, statesOfChat } from "./store.ts";
import { confirm } from "./Dialogs.tsx";
import { bannerFor, restartConfirmText, runningChats, type UpdateBanner } from "./logic/version.ts";
import { runningRuns } from "./logic/run.ts";

declare const __APP_VERSION__: string; // build.mjs: AIWB_VERSION, "dev" by default

declare global {
  interface Window {
    aiwbFlush?: () => Promise<boolean>;                // main.tsx
    aiwbDesktop?: { openServerLog: () => void };       // the desktop app's preload; absent in a browser tab
  }
}

const POLL_MS = 500;
const WAIT_MS = 45_000;
let busy = false; // a restart runs (from its start, before "Restarting…" shows)

const show = (banner: UpdateBanner) => setState({ update: { banner, hidden: false } });
const restarting = () => getState().update.banner === "restarting";

/** On every connect and reconnect: the banner for page, server and disk versions. A restart in
 *  progress keeps its "Restarting…". */
export async function checkVersion() {
  let h;
  try { h = await api.hello(); } catch { return; }
  if (restarting()) return;
  show(bannerFor(__APP_VERSION__, h.version || "dev", h.webVersion || "dev"));
}

/** "Restart server" and "Retry": confirms when agents are running or a run works, then restarts. */
export function restartServer() {
  if (busy || restarting()) return;
  const n = runningChats(Object.values(getState().chats), (chat) => statesOfChat(getState(), chat)); // a run's own agents are not among them
  const runs = runningRuns(Object.values(getState().runs));
  if (!n && !runs) { void restart(); return; }
  confirm({
    title: "Restart server", body: restartConfirmText(n, runs),
    actions: [{ label: "Restart", tone: "danger", run: () => { void restart(); } }],
  });
}

async function restart() {
  if (busy || restarting()) return;
  busy = true;
  try { await run(); } finally { busy = false; }
}

async function run() {
  let old: string;
  try { old = (await api.hello()).version; } catch { show("failed"); return; }
  await window.aiwbFlush?.().catch(() => false); // drafts are already on the server
  show("restarting");
  try {
    await api.restart();
  } catch (e) {
    show(e instanceof ApiError && e.status === 409 ? "missing" : "failed");
    return;
  }
  const until = Date.now() + WAIT_MS;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    try {
      if ((await api.hello()).version !== old) { location.reload(); return; }
    } catch {} // down between the old server and the new one
  }
  show("failed");
}

/** "Open log": the desktop app opens server.log. */
export const openServerLog = () => window.aiwbDesktop?.openServerLog();
export const inDesktopApp = () => !!window.aiwbDesktop;
