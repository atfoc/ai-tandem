// The owner's things of this computer's section, which the app does with the server program it carries (the app's
// `owner.*` operations): "Restart server" (also to bring the server to the app's build), "Retry" after a start that failed,
// and "Open server log". The page and the app are one build, so the page is never loaded again: a restart makes this
// computer's entry connecting, and its section fills again when the server answers. The section says what it shows of them
// (logic/localsection.ts).
import { ApiError, appCall } from "../api.ts";
import { getState, setState, statesOfChat } from "./store.ts";
import { flushBeforeReload, ui } from "./ports.ts";
import { NO_RESTART } from "../logic/localsection.ts";
import { restartConfirmText, runningChats } from "../logic/version.ts";
import { LOCAL_SERVER } from "../types.ts";
import { transport } from "../transport/index.ts";

declare const __APP_VERSION__: string; // build.mjs: AIWB_VERSION, "dev" by default

/** How long a restart waits for the server to be connected again, and how often it looks (a test lowers both). */
export const restartWaits = { pollMs: 500, giveUpMs: 45_000 };
let busy = false; // a restart runs (from its start, before "Restarting…" shows)

let appVersion: string | null = null;

/** The app's build sets its version at start (the new build has no define: `EXPO_PUBLIC_AIWB_VERSION`, AD-40); the old page's
 *  esbuild define stays what `pageVersion` reads when none is set. */
export function setPageVersion(v: string): void { appVersion = v; }

/** The page's version, which is the app's. */
export const pageVersion = (): string => appVersion ?? (typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev");

const restarting = () => getState().restart.phase === "restarting";
const localEntry = () => getState().servers.find((v) => v.id === LOCAL_SERVER);
const connectedAgain = () => localEntry()?.state === "connected" && getState().connected;

/** "Restart server" and "Retry" of a restart: confirms when agents are running, then restarts. */
export function restartServer() {
  if (busy || restarting()) return;
  const n = runningChats(Object.values(getState().chats), (chat) => statesOfChat(getState(), chat));
  if (!n) { void restart(); return; }
  ui().confirm({
    title: "Restart server", body: restartConfirmText(n),
    actions: [{ label: "Restart", tone: "danger", run: () => { void restart(); } }],
  });
}

async function restart() {
  if (busy || restarting()) return;
  busy = true;
  try { await run(); } finally { busy = false; }
}

async function run() {
  await flushBeforeReload().catch(() => false); // drafts are already on the server
  setState({ restart: { phase: "restarting", why: "" } });
  try {
    await appCall("owner.restart");
  } catch (e) {
    setState({ restart: { phase: "failed", why: e instanceof Error ? e.message : String(e) } });
    return;
  }
  const until = Date.now() + restartWaits.giveUpMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, restartWaits.pollMs));
    if (connectedAgain()) { setState({ restart: NO_RESTART }); return; }
  }
  setState({ restart: { phase: "failed", why: "The server did not come back in time." } });
}

/** "Retry" after a start that failed: the app starts the server again at once (it tries again by itself at growing intervals). */
export function startAgain() { void appCall("owner.retry").catch((e) => { if (!(e instanceof ApiError)) console.error(e); }); }

/** "Open server log": the app opens this computer's server.log. */
export const openServerLog = () => { void appCall("owner.openLog").catch(() => {}); };
/** Whether the page is in the desktop app, which does the owner's things. */
export const inDesktopApp = (): boolean => transport().way === "ipc";
