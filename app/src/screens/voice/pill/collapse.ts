// Whether the pill is collapsed to the orb, kept in the kv port ("aiwb.voice.pill"): a setting, one value for every board.
import { safeGet, safeSet } from "@aiwb/core/state/store.ts";
import { useSyncExternalStore } from "react";

const PILL_KEY = "aiwb.voice.pill";

let collapsed: boolean | null = null; // (read at the first use: the kv port is set by the bootstrap, after this module loads)
const now = (): boolean => (collapsed ??= safeGet(PILL_KEY) === "orb");
const listeners = new Set<() => void>();

export function setPillCollapsed(on: boolean): void {
  if (on === now()) return;
  collapsed = on;
  safeSet(PILL_KEY, on ? "orb" : "full");
  for (const l of listeners) l();
}

export function usePillCollapsed(): boolean {
  const get = now;
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, get, get);
}
