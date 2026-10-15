// What this computer's section says and offers besides what every section does (logic/sections.ts): the owner's things.
// The app starts this computer's server, and restarts it on the user's word, so this section may say that the start failed
// and why, that the server is older than the app or of another build, and that a restart runs or failed. DOM-free.
import { LOCAL_SERVER } from "../types.ts";
import type { ServerView } from "./servers.ts";

/** A restart of this computer's server (version.ts): none, running, or failed with the app's reason. */
export type Restart = { phase: "idle" | "restarting" | "failed"; why: string };
export const NO_RESTART: Restart = { phase: "idle", why: "" };

/** The lines of a failed start's reason that the section shows: the rest is in the server's log. */
export const REASON_LINES = 12;

/** The reason a start gave, as the preformatted text the section shows: trimmed, its first lines. */
export function reasonText(detail: string | undefined): string {
  const lines = (detail ?? "").trim().split(/\r?\n/);
  const shown = lines.slice(0, REASON_LINES).join("\n").trim();
  return lines.length > REASON_LINES ? `${shown}\n…` : shown;
}

/** Whether the server runs another build than the app. The page's version and the server's are `git describe` strings that cannot
 *  be ordered, and the page is the app's own build: when both are known and differ, the server is the one left behind. */
export const otherBuild = (page: string, server: string | undefined): boolean => !!server && page !== "dev" && server !== "dev" && page !== server;

export const RESTARTING = "Restarting…";
export const RESTART_FAILED = "Restart failed";

/** What the section shows beside its head and rows.
 *  line: a sentence ("" for none). reason: preformatted text under it. again: the button "Retry" and what it does (start the
 *  server again, or restart it again). restart: the button "Restart server". log: the button "Open server log" (the app opens
 *  the file, so only in the app). */
export type LocalExtra = { line: string; reason: string; again: "start" | "restart" | null; restart: boolean; log: boolean };

const NONE: LocalExtra = { line: "", reason: "", again: null, restart: false, log: false };

/** v: this computer's entry. page: the page's version (the app's). inApp: the page runs in the app. */
export function localExtra(v: Pick<ServerView, "state" | "detail" | "version">, restart: Restart, page: string, inApp: boolean): LocalExtra {
  if (restart.phase === "restarting") return { ...NONE, line: RESTARTING };
  if (restart.phase === "failed") return { ...NONE, line: RESTART_FAILED, reason: reasonText(restart.why), again: "restart", log: inApp };
  switch (v.state) {
    case "connecting": return NONE;
    case "too_old": return { ...NONE, restart: true };
    case "connected": return otherBuild(page, v.version) ? { ...NONE, line: `This computer's server runs another build (${v.version})`, restart: true } : NONE;
    // every other state is a server that could not be started or reached: the reason it gave, and a new try
    default: return { ...NONE, reason: reasonText(v.detail), again: "start", log: inApp };
  }
}

/** The entry of this computer in a server list. */
export const localOf = (servers: readonly ServerView[]): ServerView | undefined => servers.find((v) => v.local || v.id === LOCAL_SERVER);

/** Whether this computer's section has a notice that shows nowhere else, for the control that shows a hidden sidebar: its server is
 *  not connected, runs another build than the app, or a restart runs or failed. */
export function localNotice(s: { servers: readonly ServerView[]; restart: Restart }, page: string): boolean {
  const v = localOf(s.servers);
  return !v || v.state !== "connected" || s.restart.phase !== "idle" || otherBuild(page, v.version);
}
