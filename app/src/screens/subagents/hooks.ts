// What the subagent rows, the drawer and the chip read from the store (the old page's Subagents.tsx's openSub, closeSub, toggleSub, useSubNav,
// useSubThread, useNow). The drawer is the store's `subDrawer`; a row opens it, a second press on the same row closes it.
import { useEffect, useState } from "react";

import { loadSubItems } from "@aiwb/core/state/conn.ts";
import { getState, setDrawer, subThreadOf } from "@aiwb/core/state/store.ts";
import type { Item } from "@aiwb/core/types.ts";

import { useStore } from "../../state/useStore.ts";
import { useOffWhy } from "../chat/hooks.ts";

export const openSub = (chat: string, sub: string): void => setDrawer(chat, sub);
export const closeSub = (): void => setDrawer(getState().subDrawer?.chat ?? "", null);
export function toggleSub(chat: string, sub: string): void {
  const d = getState().subDrawer;
  if (d?.chat === chat && d.sub === sub) closeSub(); else openSub(chat, sub);
}

/** Whether a row's subagent is the one open in the drawer, and its press. Rows inside a drawer's thread use it too, so a nested subagent
 *  opens in the same drawer. */
export function useSubNav(chat: string, sid: string): { on: boolean; toggle(): void } {
  const on = useStore((s) => !!sid && s.subDrawer?.chat === chat && s.subDrawer.sub === sid);
  return { on, toggle: () => toggleSub(chat, sid) };
}

/** A subagent's own thread, fetched the first time it is wanted; undefined until loaded. Nothing is asked for a chat that takes no call
 *  (its server is not connected, or no longer has it): a thread the app keeps shows, and one it does not is fetched when the chat takes
 *  calls again (B-SA-12). */
export function useSubThread(chat: string, sid: string, want: boolean): Item[] | undefined {
  const items = useStore((s) => (sid ? subThreadOf(s, chat, sid)?.items : undefined));
  const off = !!useOffWhy(chat);
  useEffect(() => { if (want && sid && !items && !off) void loadSubItems(chat, sid); }, [want, chat, sid, !items, off]);
  return items;
}

/** Date.now(), drawn again every second while active. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return active ? now : Date.now();
}
