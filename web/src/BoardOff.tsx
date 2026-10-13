// A board of a section (a remote server of the server list): what shows in place of its canvas
// while that server is not connected and no scene of it is kept here, or once the board is gone
// there; and the banner over a canvas whose edit could not be saved there yet.
import React from "react";
import { useStore } from "./store.ts";
import { openServers } from "./Servers.tsx";
import { bannerText, offText, serverNameOf } from "./logic/boardsave.ts";
import { serverOfKey } from "./logic/keys.ts";
import { serverConnected } from "./logic/serverlists.ts";
import "./remoteboard.css";

/** board: the board's key. */
export function BoardOff({ board, view }: { board: string; view: "unreachable" | "gone" }): React.JSX.Element {
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
  const name = useStore((s) => serverNameOf(board, s.servers));
  const connected = useStore((s) => serverConnected(s, serverOfKey(board))); // the edit waits though the server is connected: the board is being taken again there
  const said = useStore((s) => s.saveSaid[board] ?? ""); // a save the server does not take as it is (a drawing over its limit)
  if (said) return <div className="save-banner" role="status">{said}</div>;
  if (!on) return null;
  return <div className="save-banner" role="status">{bannerText(name, connected)}</div>;
}
