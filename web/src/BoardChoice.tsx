// Where a new whiteboard is to live: shown in the main area while the sidebar has its "Untitled"
// draft row (logic/boarddraft.ts). A pick makes the board on that server and opens it; Escape,
// or selecting anything else, drops the draft. The server cannot be changed afterwards.
import React, { useEffect, useRef } from "react";
import { useStore, getState } from "./store.ts";
import { dropBoardDraft, pickBoardServer } from "./Sidebar.tsx";
import { openServers } from "./Servers.tsx";
import { CHOICE_TITLE, boardOptions, createError, type BoardDraft } from "./logic/boarddraft.ts";
import { BoardIcon } from "./icons.tsx";
import "./boardchoice.css";

/** The server choice of a board's draft: this computer first and focused, so Enter picks it; a
 *  server that is not connected is disabled with its state; "Servers…" opens the Servers dialog.
 *  A creation the server refused is said under the options, which stay usable. */
export function BoardChoice({ draft }: { draft: BoardDraft }) {
  const servers = useStore((s) => s.servers);
  const list = useRef<HTMLDivElement>(null);
  const options = boardOptions(servers);
  useEffect(() => { list.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus(); }, []);
  useEffect(() => {
    // (a dialog over the choice takes its own Escape)
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented && !getState().serversDialog && !getState().confirm) dropBoardDraft(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  const move = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const all = [...(list.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (!all.length) return;
    e.preventDefault();
    all[(at + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length].focus();
  };
  return (
    <main className="board-choice">
      <div className="board-choice-box" aria-busy={!!draft.busy}>
        <BoardIcon size={26} />
        <h2>{CHOICE_TITLE}</h2>
        <div ref={list} className={`board-choice-list ${draft.busy ? "busy" : ""}`} role="group" aria-label={CHOICE_TITLE} onKeyDown={move}>
          {options.map((o) => (
            <button key={o.id} type="button" className="board-choice-item" disabled={o.disabled} aria-disabled={o.disabled || draft.busy || undefined}
              title={o.reason} onClick={() => void pickBoardServer(o.id)}>
              <span className="board-choice-name">{o.label}</span>
              {o.reason && <span className="board-choice-reason">{o.reason}</span>}
            </button>
          ))}
        </div>
        {draft.error !== undefined && <div className="board-choice-error" role="alert">{createError(draft.error)}</div>}
        <div className="board-choice-foot">
          {draft.busy ? <span className="spin" /> : <button type="button" className="link" onClick={() => openServers()}>Servers…</button>}
        </div>
      </div>
    </main>
  );
}
