// The board's selection that goes with a spoken turn (VC-28, goal 3.6): "n selected" shows over the pill while the board on screen has a selection this
// window can write to, and at send the turn's text is the selection's tag and the words, exactly what ⌘L puts in a typed message (`addSelection`). The ×
// leaves the selection out of the turn; the choice is kept for that same selection and is given up once a turn is sent. No React here.
import { serializeRef } from "@aiwb/core/logic/refs.ts";
import { selectedOn } from "@aiwb/core/logic/roles.ts";
import { getState } from "@aiwb/core/state/store.ts";

import { boardApp } from "../../shell/boardside.ts";
import { selectionKey } from "./logic.ts";

/** The selection the person took out of the turn: the board and the selection as it was then. */
let left: { board: string; key: string } | null = null;
const listeners = new Set<() => void>();
const tell = (): void => { for (const l of listeners) l(); };

export const subscribeLeft = (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const leftOut = (): string | null => (left ? `${left.board}\n${left.key}` : null);

/** How many selected elements of `board` the next turn would carry: those of the board on screen, as the composer counts them (a reader's view has none). */
export function selectedCount(board: string): number {
  const s = getState();
  return selectedOn(s.selection.count, board, s.sel.board, s.roles[board]);
}

/** The ×: this selection stays out of the turn. */
export function leaveSelectionOut(board: string): void {
  left = { board, key: selectionKey(getState().selection) };
  tell();
}

/** The tag to put before the words of a turn sent now, with its space, or "" when nothing is selected or the person took it out. */
export function selectionTag(board: string): string {
  if (!selectedCount(board)) return "";
  if (left && left.board === board && left.key === selectionKey(getState().selection)) return "";
  const ref = boardApp.selectionRefOn(board);
  return ref ? serializeRef(ref) + " " : "";
}

/** A turn was sent: the next one starts with the selection in, as a new message does. */
export function selectionSent(): void {
  if (!left) return;
  left = null;
  tell();
}
