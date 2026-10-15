// ⌘⇧L, the board's half of the reference keys (the old page's Composer.tsx on the old page): it waits for a point clicked on the board
// of the chat that is open beside it, and ends that wait again. It is taken before Excalidraw hears it (whose ⌘⇧L locks the
// selected shapes), but only while a chat of the board on screen is there to take the point: with the chat panel away (⌘J) the
// canvas hears the key, as it did. ⌘L (a quote of the text selected in a message, else the selection on the board) is the
// composer's: it decides between the two, and puts the selection in with `addSelection`.
// No React and no react-native here, so Node loads it.
import { isLegacy, getState, type State } from "@aiwb/core/state/store.ts";
import { reachable } from "@aiwb/core/logic/sections.ts";

import type { KeyLike } from "../../platform/keys.types.ts";
import { awayNow, pickPoint, startPick } from "./refs.ts";

/** The chat whose point the board waits for when ⌘⇧L is pressed, or null: a chat of the board on screen, in the panel, that
 *  takes a change (not archived or legacy, its server connected and still holding it). */
export function pickableChat(s: State): string | null {
  const id = s.sel.chat, c = id ? s.chats[id] : undefined;
  if (!id || !c?.board || s.sel.board !== c.board || !s.panel) return null;
  if (c.archived || isLegacy(c) || !reachable(s, id)) return null;
  if (s.boards[c.board]?.archived || s.roles[c.board] !== "held") return null; // (a board that cannot be drawn on has no point to give)
  return id;
}

/** `phone`: whether the window is the phone's now, where the chat is a screen over the board and the wait for a point takes the user to the
 *  board (refs.ts `startPick`). The phone's wait is on the board screen, with no chat open: the key ends it there too. */
export function boardKeyHandler(phone: () => boolean = () => false): (e: KeyLike) => void {
  return (e) => {
    if (e.code !== "KeyL" || !(e.metaKey || e.ctrlKey) || e.altKey) return;
    if (!e.shiftKey) return; // ⌘L: the composer's
    const s = getState();
    const chat = pickableChat(s) ?? (s.picking && awayNow()?.chat === s.picking ? s.picking : null);
    if (!chat) return;
    e.preventDefault(); e.stopPropagation(); // before Excalidraw, whose ⌘⇧L locks shapes
    if (e.repeat) return;
    startPick(chat, phone());
  };
}

/** Esc ends the wait for a point. */
export function pickEscape(e: KeyLike): boolean {
  if (e.key !== "Escape" || !getState().picking) return false;
  e.preventDefault(); e.stopPropagation();
  pickPoint(null);
  return true;
}
