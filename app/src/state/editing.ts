// The composer's editing settings, live (core logic/editing.ts): read from the kv port when first asked for, kept there at each
// change, and told at once to every box and to Settings. `useEditingSettings` is what a component reads; `getEditingSettings`
// what code outside React reads.
import { useSyncExternalStore } from "react";

import { clampEditing, EDITING_KEY, parseEditing, sameEditing, stringifyEditing, type EditingSettings } from "@aiwb/core/logic/editing.ts";
import { safeGet, safeSet } from "@aiwb/core/state/store.ts";

let value: EditingSettings | null = null;
const listeners = new Set<() => void>();

export const getEditingSettings = (): EditingSettings => (value ??= parseEditing(safeGet(EDITING_KEY)));

/** Changes some settings: clamped, kept in the kv port (a storage that refuses: they hold for this run), told to every subscriber.
 *  A patch that changes nothing tells nobody. */
export function setEditingSettings(patch: Partial<EditingSettings>): void {
  const cur = getEditingSettings(), next = clampEditing({ ...cur, ...patch });
  if (sameEditing(cur, next)) return;
  safeSet(EDITING_KEY, stringifyEditing(next));
  value = next;
  for (const f of [...listeners]) f();
}

export function subscribeEditing(f: () => void): () => void {
  listeners.add(f);
  return () => { listeners.delete(f); };
}

/** The settings; the component renders again when they change. */
export const useEditingSettings = (): EditingSettings => useSyncExternalStore(subscribeEditing, getEditingSettings, getEditingSettings);
