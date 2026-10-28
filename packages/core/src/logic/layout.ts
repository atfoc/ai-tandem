// Widths of the resizable panes: the sidebar, and a board's chat panel; and whether the sidebar is
// shown, with the shortcut that hides it. DOM-free.
import type { ServerView } from "./servers.ts";
import { localNotice, type Restart } from "./localsection.ts";

export type Pane = "side" | "panel";
export type Widths = Record<Pane, number>;

export const PANES: Record<Pane, { def: number; min: number; max: number }> = {
  side: { def: 264, min: 200, max: 480 },
  panel: { def: 400, min: 300, max: 760 },
};

/** What is always left for the canvas or the chat page right of the panes. */
export const MIN_STAGE = 320;

export const DEFAULT_WIDTHS: Widths = { side: PANES.side.def, panel: PANES.panel.def };

/**
 * Clamps a pane's width to its min and max, and to `room` (the space the window leaves it,
 * when known). The pane's min wins over a room too small for it.
 */
export function clampWidth(pane: Pane, w: number, room = Infinity): number {
  const { def, min, max } = PANES[pane];
  if (!Number.isFinite(w)) return def;
  return Math.round(Math.max(min, Math.min(max, room, w)));
}

/** Widths saved as JSON; anything missing or unreadable falls back to the default. */
export function parseWidths(saved: string | null): Widths {
  let v: any = null;
  try { v = JSON.parse(saved ?? ""); } catch {}
  const one = (p: Pane) => (typeof v?.[p] === "number" ? clampWidth(p, v[p]) : PANES[p].def);
  return { side: one("side"), panel: one("panel") };
}

/** Whether the sidebar is hidden, as saved in localStorage "aiwb.side": only what sideSaved wrote for a hidden one
 *  hides it. Nothing saved, or anything else, is a sidebar that shows. */
export const parseSideHidden = (saved: string | null): boolean => saved === "hidden";

/** What is saved for a sidebar that is hidden, or shown. */
export const sideSaved = (hidden: boolean) => (hidden ? "hidden" : "shown");

/** Whether the control that shows a hidden sidebar has its mark: the sidebar has a notice that shows nowhere else, which
 *  is this computer's section having something to say (logic/localsection.ts localNotice). Not for another server of the
 *  list that is not connected: that is the Servers button's own dot. page: the page's version. */
export const sideNotice = (s: { servers: readonly ServerView[]; restart: Restart }, page: string): boolean => localNotice(s, page);

/** macOS, iOS and iPadOS (navigator.platform): where the shortcuts take ⌘ rather than Ctrl. */
export const isMac = (platform: string) => /Mac|iPhone|iPad/.test(platform);

/** ⌘B on macOS, Ctrl+B elsewhere, with nothing else held: hides the sidebar, or shows it. platform: navigator.platform.
 *  Never with Shift: ⌘⇧B is the chat's tree (logic/treepopup.ts). Ctrl+B is not taken on macOS: there it moves the caret
 *  a character back in a text field. */
export const isSideKey = (e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; code: string }, platform: string) =>
  e.code === "KeyB" && !e.shiftKey && !e.altKey && (isMac(platform) ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);

/** The shortcut's name, for titles. */
export const sideKeyName = (platform: string) => (isMac(platform) ? "⌘B" : "Ctrl+B");
