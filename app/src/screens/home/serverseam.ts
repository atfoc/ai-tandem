// Where Home hands a server over to the screens of package S2 (plans/ux-improvements/h1-design.md §2, §4): the sheet a chip's long press
// opens, a server's detail (the problem card's Details and Review), and adding a server (the first run's two buttons). Each goes to S2's
// screen when S2 has registered it, else to what the app has today: the Servers dialog, on its add form for an add. The sheet is S2's
// component once S2 calls `setServerSheet`; until then a placeholder sheet (StopgapServerSheet.tsx, mounted by Home) is drawn.
import { useSyncExternalStore } from "react";

import { openServers } from "@aiwb/core/state/serversdialog.ts";

import { pushScreen, screenSpec } from "../shell/screens.ts";

export type AddHow = "paste" | "scan";

let serverSheet: ((id: string) => void) | null = null;
let stopgap: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Package S2 gives the function that opens its server sheet for an entry id; Home's chips call it from then on. */
export function setServerSheet(fn: ((id: string) => void) | null): void {
  serverSheet = fn;
}

/** Opens the sheet of the server `id` (an entry id): S2's, or the placeholder until S2 gives its own. */
export function openServerSheet(id: string): void {
  if (serverSheet) serverSheet(id);
  else { stopgap = id; emit(); }
}

/** The entry the placeholder sheet is open on, or null. */
export const useStopgapServerSheet = (): string | null =>
  useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => stopgap, () => null);

export function closeStopgapServerSheet(): void {
  if (stopgap === null) return;
  stopgap = null;
  emit();
}

/** A server's detail: S2's screen `server` {id}, else today's Servers dialog. */
export function openServerDetail(id: string): void {
  if (screenSpec("server")) pushScreen("server", { id });
  else openServers();
}

let addServer: ((how: AddHow) => void) | null = null;

/** Package S2 gives the function that opens its add flow (sheets over any screen, not a screen); the first run's buttons call it from then on. */
export function setAddServer(fn: ((how: AddHow) => void) | null): void {
  addServer = fn;
}

/** Adds a server: S2's add flow, or its screen `add-server` {how}, else today's Servers dialog on its add form (whose phone form pastes and scans). */
export function openAddServer(how: AddHow): void {
  if (addServer) addServer(how);
  else if (screenSpec("add-server")) pushScreen("add-server", { how });
  else openServers({ name: "", address: "", secret: "", selfSigned: false, pin: "" });
}
