// The ways into a server's screens on the phone (ux-improvements goal 3.2, 3.8.2–3.8.4; package S2). A server has one place, its
// detail (`openServer`): Home's problem card, a chip's sheet ("Server settings"), the composer's "Servers" button and Chat info's Server
// row all go there. The chip's long press opens the server's sheet (`openServerSheet`), the Servers list's "+" and Home's first run open
// the add flow (`openAddServer`). On the wide layouts every one of them opens the Servers dialog, as today (goal 4.2).
//
// The sheet and the add flow are drawn by hosts mounted once in the shell's `Overlays` slot (index.ts), so they open from any screen;
// this file holds which one is open, as a small store (no React state of a screen), and imports no react-native components.
import { useSyncExternalStore } from "react";

import { openServers } from "@aiwb/core/state/serversdialog.ts";

import { windowLayout } from "../../ui/useLayout.ts";
import { pushScreen } from "../shell/screens.ts";

/** The registered screens of the package (index.ts registers them; their params). */
export const SCREEN = { servers: "servers", server: "server", cert: "server-cert" } as const;
export type ServerParams = { id: string };

/** How the add flow starts: its first sheet ("Choose how"), or one way straight away (Home's first run offers "Scan the server's code"). */
export type AddHow = "choose" | "scan" | "paste" | "manual";

type Open = { sheet: string | null; edit: string | null; add: { how: AddHow; n: number } | null };
let open: Open = { sheet: null, edit: null, add: null };
let n = 0;
const listeners = new Set<() => void>();
const set = (next: Partial<Open>) => { open = { ...open, ...next }; listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const read = () => open;

const phone = () => windowLayout() === "phone";

/** The Servers list (Settings' "Servers" row). */
export function openServersList(): void {
  if (phone()) pushScreen(SCREEN.servers, {});
  else openServers();
}

/** A server's detail: the one place for a server. */
export function openServer(id: string): void {
  if (phone()) pushScreen<ServerParams>(SCREEN.server, { id });
  else openServers();
}

/** A server's certificate: the fingerprint it is trusted by, or, when it changed, the comparison and the way to trust the new one. */
export function openServerCert(id: string): void {
  if (phone()) pushScreen<ServerParams>(SCREEN.cert, { id });
  else openServers();
}

/** The server's sheet of a chip's long press (phone only; nothing on the wide layouts, which have no chips). */
export function openServerSheet(id: string): void { if (phone()) set({ sheet: id }); }
export function closeServerSheet(): void { set({ sheet: null }); }
export const useServerSheet = (): string | null => useSyncExternalStore(subscribe, read, read).sheet;

/** A server's edit form (P3: Cancel · Edit server · Save): the detail's "Edit" and the sheet's "Name" row. Phone only. */
export function openServerEdit(id: string): void { if (phone()) set({ edit: id }); }
export function closeServerEdit(): void { set({ edit: null }); }
export const useServerEdit = (): string | null => useSyncExternalStore(subscribe, read, read).edit;

/** The add flow; on the wide layouts the dialog's add form. */
export function openAddServer(how: AddHow = "choose"): void {
  if (phone()) set({ add: { how, n: ++n } });
  else openServers({ name: "", address: "", secret: "", selfSigned: false, pin: "" });
}
export function closeAddServer(): void { set({ add: null }); }
/** The add flow open now (`n` counts the openings, so a second one starts anew), or null. */
export const useAddFlow = (): { how: AddHow; n: number } | null => useSyncExternalStore(subscribe, read, read).add;
