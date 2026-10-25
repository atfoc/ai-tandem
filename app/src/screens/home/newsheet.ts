// "+ New" of Home and of a group's screen (ux-improvements goal 3.4, package H1; plans/ux-improvements/h1-design.md §4). STUB until package H2:
// `openNewSheet(place)` opens a P1 sheet "New" (New chat, New whiteboard, New group) at the place; H2 replaces this file and keeps the name.
// The sheet itself is NewSheetHost (NewSheet.tsx), mounted once by Home.
import { useSyncExternalStore } from "react";

export type NewPlace = {
  /** The entry id of the server the thing is made on. */
  server: string;
  /** The groups browsed to the place, outermost first; empty at the top of the server. */
  groups: string[];
};

let open: NewPlace | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function openNewSheet(place: NewPlace): void {
  open = { server: place.server, groups: [...place.groups] };
  emit();
}

export function closeNewSheet(): void {
  if (open === null) return;
  open = null;
  emit();
}

/** The place the sheet is open at, or null. */
export const useNewSheet = (): NewPlace | null =>
  useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => open, () => null);
