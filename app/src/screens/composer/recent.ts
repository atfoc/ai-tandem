// The recent folders of the folder browser (the old page's Composer.tsx recentDirs / rememberDir): this computer's are kept in the app's storage,
// a remote server's in memory alone (nothing of a remote server is kept on this device). No React and no react-native here.
import { recentFrom, withRecent } from "@aiwb/core/logic/chatserver.ts";
import { RECENT_KEY } from "@aiwb/core/logic/serverlists.ts";
import { safeGet, safeSet } from "@aiwb/core/state/store.ts";
import { LOCAL_SERVER } from "@aiwb/core/types.ts";

const recentThere = new Map<string, string[]>();

/** A server's recent folders, last used first: each server has its own list. */
export const recentDirs = (server: string = LOCAL_SERVER): string[] => (server === LOCAL_SERVER ? recentFrom(safeGet(RECENT_KEY)) : recentThere.get(server) ?? []);

export function rememberDir(d: string, server: string): void {
  const next = withRecent(recentDirs(server), d);
  if (server === LOCAL_SERVER) safeSet(RECENT_KEY, JSON.stringify(next)); else recentThere.set(server, next);
}
