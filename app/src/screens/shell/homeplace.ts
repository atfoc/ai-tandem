// Home's place on the phone (ux-improvements goal 3.2; package F2 holds it, H1 draws it): the server Home shows and the groups browsed
// over it. A tiny store outside the app's store, because it is the phone's alone, saved in the kv as "aiwb.home" so the app opens where
// it was left. Opening a board or a chat does not change it: a back from content lands on the content's place (stack.ts `planPopTo`),
// which sets it.
import { useSyncExternalStore } from "react";

import { safeGet, safeSet } from "@aiwb/core/state/store.ts";

import { NO_PLACE, type HomePlace } from "./stack.ts";

export type { HomePlace };

const KEY = "aiwb.home";

let place: HomePlace = NO_PLACE;
const listeners = new Set<() => void>();

/** The place saved as JSON; anything unreadable is the default (no server chosen, no group). */
export function parseHomePlace(saved: string | null): HomePlace {
  try {
    const v = JSON.parse(saved ?? "null");
    if (!v || typeof v !== "object") return NO_PLACE;
    const server = typeof v.server === "string" && v.server ? v.server : null;
    const groups = Array.isArray(v.groups) && v.groups.every((g: unknown) => typeof g === "string" && g) ? (v.groups as string[]) : [];
    return { server, groups };
  } catch { return NO_PLACE; }
}

const same = (a: HomePlace, b: HomePlace): boolean => a.server === b.server && a.groups.length === b.groups.length && a.groups.every((g, i) => b.groups[i] === g);

/** Reads the saved place; called once at start (bootstrap.ts), after the kv is set. */
export function loadHomePlace(): void {
  place = parseHomePlace(safeGet(KEY));
  listeners.forEach((l) => l());
}

export const getHomePlace = (): HomePlace => place;

export function subscribeHomePlace(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export const useHomePlace = (): HomePlace => useSyncExternalStore(subscribeHomePlace, getHomePlace, getHomePlace);

/** Sets the place (and saves it); nothing when it is the same. */
export function setHomePlace(p: HomePlace): void {
  if (same(p, place)) return;
  place = { server: p.server, groups: [...p.groups] };
  safeSet(KEY, JSON.stringify(place));
  listeners.forEach((l) => l());
}

/** Chooses the server Home shows; its groups start over. Nothing when it is the same. */
export function setHomeServer(id: string): void {
  if (id === place.server) return;
  setHomePlace({ server: id, groups: [] });
}

/** Forgets a server whose entry left the list: Home that showed it goes back to "not chosen" (nothing of it stays in the kv). */
export function forgetHomeServer(id: string): void {
  if (place.server === id) setHomePlace(NO_PLACE);
}

/** Browses into a group, over the ones already pushed. */
export function pushGroup(key: string): void {
  setHomePlace({ server: place.server, groups: [...place.groups, key] });
}

/** Browses back to the group at `index` of the pushed ones (kept with the ones before it); -1 is Home. */
export function popToGroup(index: number): void {
  setHomePlace({ server: place.server, groups: place.groups.slice(0, index + 1) });
}
