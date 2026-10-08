// The name of a board's server after its title in the sidebar row, grey while that server is not
// connected. Nothing for a board of this computer.
import React from "react";
import { useStore } from "./store.ts";
import { boardRow } from "./logic/boardrow.ts";
import type { Board } from "./types.ts";
import "./boardrow.css";

export function BoardTag({ board }: { board: Board }) {
  const servers = useStore((s) => s.servers);
  const row = boardRow(board, { servers });
  if (!row.server) return null;
  return <span className={`board-tag ${row.off ? "off" : ""} ${row.gone ? "gone" : ""}`} title={row.title}>{row.server}</span>;
}
