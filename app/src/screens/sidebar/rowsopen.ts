// Whether a board's row in the sidebar shows its chats. The state is a small map outside the row, so that something other than the row
// (a chat made on the board from the voice pill, which does not open it) can open the row, and so that a row drawn anew keeps its state.
// A board nobody has closed or opened is open. Not saved: it is the state of this window's rows, as the row's own state was.
import { useSyncExternalStore } from "react";

const closed = new Set<string>(); // the boards whose row was closed (an open row is the rule, so only the exceptions are kept)
let version = 0; // changes with the map, for the subscribers
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** True when the board's row shows its chats. */
export const boardRowOpen = (board: string): boolean => !closed.has(board);

/** Opens or closes the row of a board. */
export function setBoardRowOpen(board: string, open: boolean): void {
  if (open === boardRowOpen(board)) return;
  if (open) closed.delete(board); else closed.add(board);
  version++;
  listeners.forEach((l) => l());
}

/** The row's open state, and the call that changes it; the row is drawn anew when it changes. */
export function useBoardRowOpen(board: string): [boolean, (open: boolean) => void] {
  useSyncExternalStore(subscribe, () => version, () => version);
  return [boardRowOpen(board), (open) => setBoardRowOpen(board, open)];
}
