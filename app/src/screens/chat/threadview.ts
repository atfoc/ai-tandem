// Which rows of a chat's thread are in view now (ux T2: the permission dock shows while the request's card is not). The phone's thread tells
// it through StickyList's `onViewable`; a short thread, which has nothing to scroll, says every row is in view. A tiny store, read by
// `useViewable`; `null` until the thread told anything (then nothing that depends on it shows), and again once the thread is gone.
import { useSyncExternalStore } from "react";

const views = new Map<string, ReadonlySet<string>>();
const listeners = new Set<() => void>();

const same = (a: ReadonlySet<string> | undefined, b: ReadonlySet<string>): boolean => !!a && a.size === b.size && [...b].every((k) => a.has(k));

/** The row keys in view in a chat's thread, as the list told them. Nothing changes (and nobody is woken) when the set is the same. */
export function setViewable(chat: string, keys: readonly string[]): void {
  const next = new Set(keys);
  if (same(views.get(chat), next)) return;
  views.set(chat, next);
  listeners.forEach((l) => l());
}

/** The thread of a chat is gone (it unmounted): what it said about its rows no longer holds. */
export function clearViewable(chat: string): void {
  if (views.delete(chat)) listeners.forEach((l) => l());
}

/** The keys now in view in a chat's thread; null while the list has told nothing. */
export const viewableNow = (chat: string): ReadonlySet<string> | null => views.get(chat) ?? null;

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function useViewable(chat: string): ReadonlySet<string> | null {
  return useSyncExternalStore(subscribe, () => viewableNow(chat), () => null);
}
