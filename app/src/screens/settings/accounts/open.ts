// Which part of Settings › Claude accounts is open (multiple-claude goal §1.1–§1.3): the wide layouts' dialog, and the add/edit sheet (the
// phone's FormSheet, the form inside the dialog on the wide layouts), as a small store of its own, so the screens and the host in the
// shell's `Overlays` slot read the same. `takeNav` carries out the store's `accountsNav` (core state/aliases.ts openAccounts, which the chat
// side calls: "Log in…", "Add it in Settings"): the list shown, then the account's sheet, the add sheet with a folder in its list, or the
// account's login started. No react-native components here.
import { useSyncExternalStore } from "react";

import { closeAccounts, startLogin } from "@aiwb/core/state/aliases.ts";
import type { AccountsNav } from "@aiwb/core/logic/aliases.ts";

import { openLater } from "../../../platform/openlink";
import { windowLayout } from "../../../ui/useLayout.ts";
import { pushScreen, pushedScreens } from "../../shell/screens.ts";
import { ACCOUNTS_SCREEN } from "./ids.ts";

/** The sheet open: the server's section, the account edited (none: the add sheet), a folder put in its list; n counts the openings, so a
 *  second one starts anew. */
export type SheetOpen = { server: string; id?: string; prefill?: string; n: number };
type Open = { dialog: boolean; sheet: SheetOpen | null };

let open: Open = { dialog: false, sheet: null };
let n = 0;
const listeners = new Set<() => void>();
const set = (next: Partial<Open>) => { open = { ...open, ...next }; listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const read = () => open;

const phone = () => windowLayout() === "phone";

/** The list: the phone's screen pushed (unless it is on top), the dialog on the wide layouts. */
export function openAccountsList(): void {
  if (phone()) { if (pushedScreens().at(-1)?.name !== ACCOUNTS_SCREEN) pushScreen(ACCOUNTS_SCREEN, {}); }
  else set({ dialog: true });
}
export function closeAccountsDialog(): void { set({ dialog: false, sheet: null }); }

/** The add sheet (no id) or an account's edit sheet, with `prefill` put in its folders. */
export function openSheet(server: string, id?: string, prefill?: string): void {
  set({ sheet: { server, ...(id ? { id } : {}), ...(prefill ? { prefill } : {}), n: ++n } });
}
export function closeSheet(): void { set({ sheet: null }); }

export const useAccountsOpen = (): Open => useSyncExternalStore(subscribe, read, read);

/** Starts an account's login; the URL it answers opens on this device. Call it synchronously in the press handler: the window the URL
 *  goes to is readied now (openLater; a browser blocks one opened when the call answers). A failure is the flow's own (the login row says it). */
export const logIn = (server: string, id: string): void => { startLogin(server, id, openLater()).catch(() => { /* (the flow failed: its row says why) */ }); };

/** Carries out a request to show the accounts (each seq once: the caller remembers the last one taken), and takes it from the store. */
export function takeNav(nav: AccountsNav): void {
  openAccountsList();
  if (nav.login && nav.id) logIn(nav.server, nav.id); // (the list, with the account's login row under its row: no sheet over it)
  else if (nav.add || nav.id || nav.prefill) openSheet(nav.server, nav.add ? undefined : nav.id, nav.prefill);
  closeAccounts();
}
