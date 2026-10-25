// Chat info (ux-improvements goal 3.5): the one sheet of a chat's facts and actions, opened from the header's title and its ⋯. The sheet is
// drawn by a host mounted once in the shell's `Overlays` slot (ChatInfo.tsx), which reads which chat it is open for from here.
//
// Contract of package T1 for package T3: `setChatInfo` registers what opens the sheet (T3 does, once, at import in `chat/index.ts`); until
// something is registered `openChatInfo` answers false and the header does what it did before (its title renames the chat in place).
import { useSyncExternalStore } from "react";

let opener: ((chat: string) => void) | null = null;
let open: string | null = null;
let rename: string | null = null; // a chat whose header is asked to start its in-place rename (the Name row's Rename, until the rename sheet is there)
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** Registers what opens Chat info (T3, once, at import). */
export function setChatInfo(open: (chat: string) => void): void {
  opener = open;
}

/** Opens Chat info for the chat (its key). false: nothing is registered yet. */
export function openChatInfo(chat: string): boolean {
  if (!opener) return false;
  opener(chat);
  return true;
}

/** What `setChatInfo` registers: shows the sheet for the chat. */
export function showChatInfo(chat: string): void {
  open = chat;
  emit();
}

export function closeChatInfo(): void {
  if (open === null) return;
  open = null;
  emit();
}

/** The chat Chat info is open for, or null. */
export const useChatInfoOpen = (): string | null => useSyncExternalStore(subscribe, () => open, () => null);

/** Asks the chat's header to start renaming in place. */
export function requestRename(chat: string): void {
  rename = chat;
  emit();
}

/** The chat whose header has been asked to rename, until it takes the request (`takeRename`). */
export const useRenameRequest = (): string | null => useSyncExternalStore(subscribe, () => rename, () => null);

export function takeRename(): void {
  if (rename === null) return;
  rename = null;
  emit();
}
