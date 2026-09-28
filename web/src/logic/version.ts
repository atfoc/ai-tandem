// Versions after an update: which banner the page shows, and what a server restart ends.
// The page's own version, the running server's and the one on disk (the served client folder's
// version.json) are `git describe` strings, which can't be ordered; the files on disk always come
// from the newest install, so they tell which side is stale.
import type { Status } from "../types.ts";

export type Banner = "none" | "restart" | "reload";

/** What the sidebar's version banner shows: a Banner, or a restart in progress or failed
 *  (missing = the server's program is gone, so it can't start `relaunch`). */
export type UpdateBanner = Banner | "restarting" | "failed" | "missing";

/** The banner for the page's, the running server's and the on-disk version: none when any is
 *  "dev" or all are equal; reload when the page isn't the one on disk (loaded before the server
 *  was replaced); otherwise restart (a new app is installed, the old server still runs). */
export function bannerFor(page: string, server: string, disk: string): Banner {
  if (page === "dev" || server === "dev" || disk === "dev") return "none";
  if (page === server && server === disk) return "none";
  if (page !== disk) return "reload";
  return "restart";
}

const RUNNING: ReadonlySet<Status> = new Set<Status>(["thinking", "writing", "tool", "approval"]);

/** How many chats have an agent running: a restart ends them. */
export const runningChats = (chats: Iterable<{ status: Status }>): number => {
  let n = 0;
  for (const c of chats) if (RUNNING.has(c.status)) n++;
  return n;
};

/** The restart confirmation's body for n running agent chats. */
export const restartConfirmText = (n: number): string =>
  `Restart ends ${n} running agent chat${n === 1 ? "" : "s"}.`;
