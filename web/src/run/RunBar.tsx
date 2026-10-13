// The bar above a run's stage: where the run is, its status, and its chats (the board bar's
// pattern). What the follow view adds to it (meters, stop and resume) is RunBarStatus.
import React, { useRef } from "react";
import "./shell.css";
import { useStore, getState, setState, closeRunAgent, groupsOn } from "../store.ts";
import { serverOfKey } from "../logic/keys.ts";
import { reachable } from "../logic/sections.ts";
import { sectionName } from "../logic/serverlists.ts";
import { newChat, openRun } from "../Sidebar.tsx";
import { groupPath } from "../logic/tree.ts";
import { runChats } from "../logic/run.ts";
import { offersChatOn } from "../logic/runserver.ts";
import { RunIcon } from "../icons.tsx";
import { RunBarStatus } from "./RunBarStatus.tsx";
import { TIGHT, useSize } from "./actions.ts";

export function RunBar({ run, chatOpen }: { run: string; chatOpen: boolean }) {
  // What the bar shows of the run, not its record: that changes with every task, the bar does not.
  const name = useStore((s) => s.runs[run]?.name);
  const group = useStore((s) => s.runs[run]?.group);
  const archived = useStore((s) => !!s.runs[run]?.archived);
  // As the sidebar row's "+": no chat can be made on an archived run, nor on a run whose server is not connected or no longer has it.
  const offersChat = useStore((s) => { const r = s.runs[run]; return !!r && offersChatOn(r) && reachable(s, run); });
  const count = useStore((s) => runChats(s.chats, run, s.showArchived).length);
  const groups = useStore((s) => groupsOn(s, serverOfKey(run))); // the run's path is in the groups of its own server
  const section = useStore((s) => sectionName(s, run));
  const bar = useRef<HTMLDivElement>(null);
  // In a tight stage (the side panel open in a small window) the chat button says less, so that the status can stay.
  const tight = (useSize(bar, (el) => el.closest<HTMLElement>(".board-stage"), name !== undefined).w || 1000) < TIGHT;
  if (name === undefined) return null;
  const r = { name, archived };
  const chats = { length: count };
  const path = [...(section ? [section] : []), ...groupPath(groups, group ?? "")];
  const showChats = () => {
    const { sel, chats: all } = getState();
    if (!(sel.chat && all[sel.chat]?.run === run)) openRun(run);
    closeRunAgent(); // an agent's transcript in the panel gives way to the chat
    setState({ panel: true });
  };
  return (
    <div className="board-bar run-bar" ref={bar}>
      <span className="board-crumb">
        {path.length > 0 && <span className="run-crumb-path">{path.map((name, i) => <React.Fragment key={i}>{name} <span className="sep">/</span> </React.Fragment>)}</span>}
        <RunIcon /> <b>{r.name}</b>
      </span>
      {r.archived && <span className="archived-note">Archived — read-only</span>}
      <RunBarStatus runId={run} />
      <span className="grow" />
      {!chatOpen && chats.length > 0 && (
        <button className="btn ghost sm" onClick={showChats} title="Show chat (⌘J)">
          Chats <span className="pill">{chats.length}</span>
        </button>
      )}
      {offersChat && (
        <button className="btn sm run-bar-chat" title={tight ? "+ Chat on this run" : undefined} onClick={() => void newChat({ run })}>{tight ? "+ Chat" : "+ Chat on this run"}</button>
      )}
    </div>
  );
}
