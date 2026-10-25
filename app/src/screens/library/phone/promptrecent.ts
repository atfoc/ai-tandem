// The recent prompts of the Prompt sheet (the composer's Insert a prompt on the phone), as screens/composer/recent.ts keeps the recent folders: this computer's are kept in
// the app's storage (a JSON list of prompt ids, newest first), a remote server's in the page's memory alone (nothing of a remote server is kept on this device). No React here.
import { recentFrom } from "@aiwb/core/logic/chatserver.ts";
import { safeGet, safeSet } from "@aiwb/core/state/store.ts";
import { LOCAL_SERVER } from "@aiwb/core/types.ts";

export const PROMPT_RECENT_KEY = "aiwb.prompts.recent";
/** How many recent prompts a server keeps, and the sheet shows. */
export const RECENT_PROMPTS = 3;

export type RecentRef = { server: string; id: string };

const there = new Map<string, string[]>();
const stamped = new Map<string, number>(); // when, in this session, a prompt was inserted last (a prompt kept from an earlier session has none)
let tick = 0;
const stampKey = (server: string, id: string): string => `${server}\n${id}`;

/** A server's recent prompt ids, last inserted first. */
export const recentIds = (server: string = LOCAL_SERVER): string[] =>
  (server === LOCAL_SERVER ? recentFrom(safeGet(PROMPT_RECENT_KEY)) : there.get(server) ?? []).slice(0, RECENT_PROMPTS);

/** Every server's recent prompts together, last inserted first: those inserted in this session by when, then those this computer kept from before, in their order. */
export function recentPrompts(): RecentRef[] {
  const all = [LOCAL_SERVER, ...there.keys()].flatMap((server) => recentIds(server).map((id, at) => ({ server, id, at })));
  const when = (r: RecentRef) => stamped.get(stampKey(r.server, r.id)) ?? 0;
  return all.sort((a, b) => when(b) - when(a) || a.at - b.at).map(({ server, id }) => ({ server, id }));
}

export function rememberPrompt(server: string, id: string): void {
  const next = [id, ...recentIds(server).filter((x) => x !== id)].slice(0, RECENT_PROMPTS);
  stamped.set(stampKey(server, id), ++tick);
  if (server === LOCAL_SERVER) safeSet(PROMPT_RECENT_KEY, JSON.stringify(next)); else there.set(server, next);
}

/** Forgets what this session kept in memory (a test's). */
export function forgetRecentPrompts(): void { there.clear(); stamped.clear(); tick = 0; }
