// The width the phone's bottom row (BottomRow.tsx: Edit here and the orb) takes at the right end of Excalidraw's footer band: the
// `inset` of the phone chrome sent to the board view (package B1, b1-design.md §4). No React Native here, so Node loads it.
import { useSyncExternalStore } from "react";

/** The orb's box at the band's right end (goal 3.4: a 64 pt right inset). */
export const ORB_INSET = 64;

let inset = ORB_INSET;
const listeners = new Set<() => void>();

export function setRowInset(px: number): void {
  const v = Math.max(ORB_INSET, Math.round(px));
  if (v === inset) return;
  inset = v;
  for (const l of [...listeners]) l();
}

export const rowInset = (): number => inset;

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export const useRowInset = (): number => useSyncExternalStore(subscribe, rowInset, rowInset);
