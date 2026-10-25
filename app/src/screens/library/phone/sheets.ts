// The sheets of the prompt library's phone screens (package S4): which one is open and on what. The screens open them by these
// functions; LibrarySheets.tsx draws them, mounted once in the Overlays slot (LibraryPopups) on the phone. A sheet over a sheet is the
// move picker over the editor or the group form only (the editor's Group row); that one is the form's own, not this store's.
// No React here but the hook; no react-native.
import { useSyncExternalStore } from "react";

import type { Place } from "@aiwb/core/logic/libraryview.ts";

/** The editor on a saved prompt, or on a new one that goes into `at` (its Group row can change where). */
export type EditorOpen = { mode: "edit"; server: string; id: string } | { mode: "new"; at: Place };
/** The move picker on a prompt or a group: a pick moves it at once (libraryApi), then the picker closes. */
export type MoveOpen = { kind: "prompt" | "group"; server: string; id: string };
/** The group form: a new group in `at` (its Group row can change where), or a group's new name. */
export type GroupFormOpen = { mode: "new"; at: Place } | { mode: "rename"; server: string; id: string };

export type LibSheets = { editor: EditorOpen | null; move: MoveOpen | null; groupForm: GroupFormOpen | null };

let now: LibSheets = { editor: null, move: null, groupForm: null };
const listeners = new Set<() => void>();
const set = (next: Partial<LibSheets>) => { now = { ...now, ...next }; listeners.forEach((l) => l()); };

/** One sheet at a time: opening one closes the others. */
export const openEditor = (o: EditorOpen): void => set({ editor: o, move: null, groupForm: null });
export const openMove = (o: MoveOpen): void => set({ editor: null, move: o, groupForm: null });
export const openGroupForm = (o: GroupFormOpen): void => set({ editor: null, move: null, groupForm: o });
export const closeSheet = (name: keyof LibSheets): void => set({ [name]: null });
export const closeAllSheets = (): void => set({ editor: null, move: null, groupForm: null });
export const libSheets = (): LibSheets => now;

export function subscribeLibSheets(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export const useLibSheets = (): LibSheets => useSyncExternalStore(subscribeLibSheets, libSheets, libSheets);
