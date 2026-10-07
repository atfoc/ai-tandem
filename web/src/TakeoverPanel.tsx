// The panel shown in place of one board's canvas while this window does not hold the board:
// another window holds it, or took it, or is handing it over. The rest of the window (the
// sidebar, the board's chats, every other board) stays in use.
import React from "react";
import { setDropped } from "./store.ts";
import { takeBoard } from "./board.ts";
import type { BoardRole } from "./logic/roles.ts";

/** Said in the panel, and in the note on the canvas of a board that is held (Canvas.tsx). */
export const DROPPED_TEXT = "A change made here was not saved in time and was dropped.";

/** "Use here": the board is taken from the window that holds it. What the panel said of a dropped change is seen by then. */
function useHere(board: string) {
  setDropped(board, false);
  void takeBoard(board);
}

export function TakeoverPanel({ board, role, dropped }: { board: string; role: Exclude<BoardRole, "held">; dropped: boolean }): React.JSX.Element {
  if (role === "taking") return (
    <div className="takeover-panel quiet">
      <span className="spin" />
      <p>Taking over from the other window…</p>
    </div>
  );
  return (
    <div className="takeover-panel">
      <h2>Open in another window</h2>
      <p>This whiteboard is in use in another tab or window. Only one can draw on it at a time.</p>
      {dropped && <p className="takeover-dropped">{DROPPED_TEXT}</p>}
      <button className="btn primary" onClick={() => useHere(board)}>Use here</button>
    </div>
  );
}
