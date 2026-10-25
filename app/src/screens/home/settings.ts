// The gear of Home (ux-improvements goal 3.5, package H1; plans/ux-improvements/h1-design.md §6): Settings' screen when package S1 has registered
// it, else the stop-gap sheet (SettingsStopgap.tsx) that holds today's sidebar foot, so Show archived, Servers, Library, voice settings and the
// theme stay reachable on the phone.
import { useSyncExternalStore } from "react";

import { pushScreen, screenSpec } from "../shell/screens.ts";

let stopgap = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function openSettings(): void {
  if (screenSpec("settings")) { pushScreen("settings", {}); return; }
  stopgap = true;
  emit();
}

export function closeSettingsStopgap(): void {
  if (!stopgap) return;
  stopgap = false;
  emit();
}

export const useSettingsStopgap = (): boolean =>
  useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => stopgap, () => false);
