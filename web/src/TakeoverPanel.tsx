// The panel shown in place of one board's canvas while this window does not hold the board:
// another window holds it, or took it, or is handing it over. The rest of the window (the
// sidebar, the board's chats, every other board) stays in use.
import React from "react";
import { setDropped, useStore } from "./store.ts";
import { takeBoard } from "./board.ts";
import type { BoardRole } from "./logic/roles.ts";
import { DROPPED_TEXT, serverNameOf, takeoverText } from "./logic/boardsave.ts";

/** "Use here": the board is taken from the window that holds it. What the panel said of a dropped change is seen by then. */
function useHere(board: string) {
  setDropped(board, false);
  void takeBoard(board);
}

export function TakeoverPanel({ board, role, dropped }: { board: string; role: Exclude<BoardRole, "held">; dropped: boolean }): React.JSX.Element {
  const b = useStore((s) => s.boards[board]);
  const name = useStore((s) => serverNameOf(s.boards[board], s.servers));
  if (role === "taking") return (
    <div className="takeover-panel quiet">
      <span className="spin" />
      <p>Taking over from the other window…</p>
    </div>
  );
  const text = takeoverText(b ?? { id: board, name: "", group: "", created: "" }, name);
  return (
    <div className="takeover-panel">
      <h2>{text.title}</h2>
      <p>{text.body}</p>
      {dropped && <p className="takeover-dropped">{DROPPED_TEXT}</p>}
      <button className="btn primary" onClick={() => useHere(board)}>Use here</button>
    </div>
  );
}
