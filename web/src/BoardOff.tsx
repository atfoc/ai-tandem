// A board on another server: what shows in place of its canvas while that server is not
// connected and no scene of it is kept here, or once the board is gone there; and the banner over
// a canvas whose edit could not be saved there yet.
import React from "react";
import { useStore } from "./store.ts";
import { openServers } from "./Servers.tsx";
import { notSaved, offText, serverNameOf } from "./logic/boardsave.ts";
import type { Board } from "./types.ts";
import "./remoteboard.css";

export function BoardOff({ board, view }: { board: Board; view: "unreachable" | "gone" }): React.JSX.Element {
  const name = useStore((s) => serverNameOf(board, s.servers));
  const t = offText(view, name);
  return (
    <div className="board-off">
      <h2>{t.title}</h2>
      <p>{t.body}</p>
      {view === "unreachable" && <button className="btn" onClick={() => openServers()}>Servers…</button>}
    </div>
  );
}

/** Over the canvas, while an edit of the board waits for its server; the canvas stays in use. */
export function SaveBanner({ board }: { board: string }): React.JSX.Element | null {
  const on = useStore((s) => !!s.outage[board]);
  const name = useStore((s) => serverNameOf(s.boards[board], s.servers));
  if (!on) return null;
  return <div className="save-banner" role="status">{notSaved(name)}</div>;
}
