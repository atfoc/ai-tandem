// Which chat the phone's "Context and usage" sheet is open for (ux-improvements goal 3.5; package T3). The sheet opens from the composer's
// meter and from Chat info's Context row, so its state is a small store here, not a screen's: the sheet is drawn by a host mounted once in the
// shell's `Overlays` slot and reads it. On the wide layouts the meter keeps its own popover and nothing calls this.
//
// Contract of package T3 (chunks 1 and 2): `openUsage(chat)` with the chat's key, `closeUsage()`, `useUsageOpen()`.
import { useSyncExternalStore } from "react";

let open: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** Opens the sheet for the chat (its key). */
export function openUsage(chat: string): void {
  open = chat;
  emit();
}

export function closeUsage(): void {
  if (open === null) return;
  open = null;
  emit();
}

/** The chat the sheet is open for, or null. */
export const usageOpen = (): string | null => open;
export const useUsageOpen = (): string | null => useSyncExternalStore(subscribe, usageOpen, () => null);
