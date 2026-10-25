// Home's search (ux-improvements goal 3.3, package H2; plans/ux-improvements/h2-design.md §6): a mode of Home. While it is open Home draws
// Search.tsx in place of its top row, title, chips and list. STUB (contract fixed): chunk 5 of H2 draws it.
import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function openSearch(): void {
  if (open) return;
  open = true;
  emit();
}

export function closeSearch(): void {
  if (!open) return;
  open = false;
  emit();
}

export const isSearchOpen = (): boolean => open;

export const useSearch = (): boolean =>
  useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => open, () => false);
